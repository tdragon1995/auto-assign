-- =============================================================================
-- Part-time driver pay — the two records a monthly earnings figure is built from.
--
-- WHAT A PART-TIME DRIVER IS PAID
--   30.000đ per hour, clocked from their own chấm-công check-in/check-out taps.
--   2.000đ per kilometre, measured pickup → dropoff on each completed job.
--
--   Both rates and the hours arithmetic live in the application
--   (dashboard/src/lib/pay.ts), NOT here — see WHY HOURS ARE NOT STORED below.
--
-- WHY TWO TABLES AND NOT ONE
--   The two halves of the pay have nothing in common but a driver and a day. A
--   punch is an event with no distance; a job is a distance with no clock. Forcing
--   them into one row would leave every row half-null and every query filtering on
--   which half it got.
--
-- WHY THIS RIDES THE TAT ARCHIVE
--   Both tables are written by archiveDay() in the same pass that writes tat_legs,
--   off the SAME day of Cartrack routes it had already fetched. There is no second
--   cron, no second day-fetch and no second seal — see footgun 8 in CLAUDE.md, and
--   do not add a schedule for this either.
--
-- WHY DISTANCE IS FROZEN AND HOURS ARE NOT
--   distance_km costs a billed Goong request the first time a pickup→dropoff pair
--   is ever seen, so it is resolved once and stored. Recomputing it would re-spend
--   real money to arrive at the same number.
--
--   Hours cost nothing to recompute, and the payroll formula for pairing punches
--   is still being settled — several check-in/check-out pairs a day are normal, and
--   a forgotten check-out is not rare. So the raw taps are stored (all three
--   activity stamps, exactly as Cartrack reported them) and the minutes are derived
--   on READ. Changing the formula is then a code change: no re-archive, no
--   day-fetch, no Goong call, and every past month re-reads correctly the moment
--   it ships.
--
-- RLS: enabled with NO policies, so only the service-role key reaches these
-- tables. A driver reads their own rows through /api/pay/me, which takes the
-- driver_id from the signed HttpOnly nv_session cookie and never from client
-- input — the same rule /api/tat/me follows, and for the same reason: this is
-- somebody's pay, and a readable id in the request would be every driver's
-- earnings readable by every other driver.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- The kilometre half. One row per COMPLETED job carrying a real pickup and a
-- real dropoff.
--
-- A job's pickup→dropoff pair is deliberately NOT a tat_legs leg, and the two
-- must not be confused (footgun 7): a leg is the ride between two consecutive
-- stops, so a driver collecting at three clinics before the lab run rides three
-- legs and is paid for three jobs, and the two sets of kilometres differ. The
-- legs are what the driver actually rode; THIS is what payroll pays, and it is
-- the same measure the /api/export-completed payroll CSV has always used.
-- ---------------------------------------------------------------------------
create table if not exists public.pay_jobs (
  id                   bigint generated always as identity primary key,

  trip_date            date        not null,
  driver_id            uuid        not null,
  driver_name          text,

  job_id               bigint      not null,
  reference_number     text,

  pickup_customer_id   text,
  pickup_name          text,
  pickup_lat           double precision,
  pickup_lng           double precision,
  pickup_completed_ts  timestamptz,

  dropoff_customer_id  text,
  dropoff_name         text,
  dropoff_lat          double precision,
  dropoff_lng          double precision,
  dropoff_completed_ts timestamptz,

  -- Goong road distance, pickup → dropoff. Null when the lookup failed or a stop
  -- carried no coordinates: the job is still listed, earning no kilometres, so a
  -- missing distance shows up as a visible gap rather than silently shrinking the
  -- month. The coordinates above are kept precisely so such a row can be re-priced
  -- later without going back to Cartrack for the day.
  distance_km          numeric(6,2),

  archived_at          timestamptz not null default now(),

  -- Per DAY, not per job outright: the rollover re-dates an unfinished job into
  -- today, so one job_id can legitimately belong to a later day than it started
  -- on. Keyed this way the archiver's per-day replace stays the thing that
  -- decides, exactly as it does for tat_legs.
  unique (trip_date, job_id)
);

create index if not exists pay_jobs_driver_date_idx
  on public.pay_jobs (driver_id, trip_date desc);

create index if not exists pay_jobs_date_idx
  on public.pay_jobs (trip_date desc);

alter table public.pay_jobs enable row level security;

-- ---------------------------------------------------------------------------
-- The hours half. One row per chấm-công tap.
--
-- ALL THREE activity stamps are stored rather than one chosen "punch time". They
-- disagree by a few minutes (a chấm-công stop carries a 5-minute duration), and
-- which one payroll counts from is part of the formula that is still being
-- settled. Storing the choice would bake it in; storing the three leaves it open.
--
-- job_status_id travels too, so a tap the driver started and never finished can
-- be told from a completed one without a second guess about why a stamp is null.
-- ---------------------------------------------------------------------------
create table if not exists public.pay_punches (
  id             bigint generated always as identity primary key,

  trip_date      date        not null,
  driver_id      uuid        not null,
  driver_name    text,

  job_id         bigint      not null,
  -- 'in' = check_in, 'out' = check_out. Read off the job's labels, with the
  -- reference-number prefix as the fallback for a payload carrying none.
  kind           text        not null check (kind in ('in', 'out')),

  customer_id    text,
  location_name  text,

  started_ts     timestamptz,
  arrived_ts     timestamptz,
  completed_ts   timestamptz,
  job_status_id  smallint,

  archived_at    timestamptz not null default now(),

  unique (trip_date, job_id)
);

create index if not exists pay_punches_driver_date_idx
  on public.pay_punches (driver_id, trip_date desc);

create index if not exists pay_punches_date_idx
  on public.pay_punches (trip_date desc);

alter table public.pay_punches enable row level security;

-- ---------------------------------------------------------------------------
-- Daily kilometre rollup. A month of earnings needs ~30 numbers, not ~450 job
-- rows on a phone, so the month view reads this and only a day the driver
-- actually opens reads the jobs underneath it.
--
-- There is deliberately no hours column here: the minutes are derived in the
-- application from pay_punches (see WHY DISTANCE IS FROZEN AND HOURS ARE NOT),
-- and a stored duplicate in SQL would be a second answer free to drift from it.
--
-- security_invoker so the view can never become a way around the base tables'
-- RLS: it runs as whoever queries it.
-- ---------------------------------------------------------------------------
create or replace view public.v_pay_daily
with (security_invoker = on) as
select
  driver_id,
  trip_date,
  max(driver_name)                                       as driver_name,
  count(*)                                               as jobs_total,
  count(*) filter (where distance_km is not null)        as jobs_priced,
  round(coalesce(sum(distance_km), 0)::numeric, 2)       as total_km
from public.pay_jobs
group by driver_id, trip_date;
