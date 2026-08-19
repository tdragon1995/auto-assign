-- =============================================================================
-- Driver TAT (turnaround time) archive — one row per ROUTE LEG.
--
-- WHY THIS TABLE EXISTS
--   The day's routes already live in Redis (day:v1:* — see dashboard/src/lib/
--   day-snapshot.ts), but that hash carries a 900-second TTL: it is a cache for
--   today's operational reads, not a record. Nothing in the system remembers what
--   a driver's day looked like once it has passed, so no trend, no week-on-week
--   comparison and no appraisal conversation is possible. This table is the
--   durable half, written by /api/tat/archive and kept indefinitely.
--
-- WHAT ONE ROW IS — A LEG, NOT A JOB
--   A driver's day is a sequence of stops. The thing that takes time and can be
--   measured against a distance is the ride BETWEEN two consecutive stops, which
--   is not the same as a job's pickup→dropoff pair: a driver who collects at
--   three clinics before running to the lab drives three legs, while the
--   job-shaped view would see three trips that all started somewhere they had
--   already left. Legs are cut from the actual order the driver worked (sorted by
--   completion time), not the planned order, so a re-sequenced day measures what
--   really happened.
--
-- THE CLOCK
--   tat_mins = arrival at the next stop − completion at this one. Time on the
--   road, with loading and paperwork at either end left out: those are neither
--   the driver's choice nor their pace.
--
--   Drivers who never tap "đã đến" would otherwise have no measurable legs at
--   all, so the archiver falls back to the next stop's completion stamp and
--   records which was used in tat_basis. The basis travels with the row, so an
--   inferred leg can always be told from a measured one.
--
-- THE TARGET
--   target_mins = max(1, ceil(distance_km)) * 4 — an effective 15 km/h, which is
--   what a loaded two-wheeler averages across HCMC once traffic, lights, parking
--   and the walk inside are all inside the same number. The max(1, …) floor stops
--   two stops at one address from getting a 0-minute target nothing could meet.
--
--   distance_km and target_mins are FROZEN onto the row at archive time rather
--   than recomputed on read. A report is a record of what the driver was measured
--   against on the day; recomputing later from a tuned formula would silently
--   turn met targets into missed ones.
--
-- LONG GAPS
--   A leg spanning a lunch break or a wait at a clinic is real elapsed time but
--   not a slow ride. Those rows are marked long_gap and excluded from the on-time
--   percentage (they are still stored and still shown, labelled as a wait), so
--   one lunch cannot read as a 130-minute delay and discredit the whole report.
--
-- RLS: enabled with NO policies, so only the service-role key reaches this table.
-- Drivers read their own rows through /api/tat/me, which takes the driver_id from
-- a signed HttpOnly session cookie and never from client input.
-- =============================================================================

create table if not exists public.tat_legs (
  id                bigint generated always as identity primary key,

  trip_date         date        not null,
  driver_id         uuid        not null,
  driver_name       text,
  -- Position of this leg within the driver's day, 1-based. Lets the report list a
  -- day in order without re-sorting on timestamps that may be null.
  seq               smallint    not null,

  -- ── Leg start: the stop the driver departed from ──
  from_stop_id      bigint,
  from_job_id       bigint,
  from_customer_id  text,
  from_name         text,
  from_lat          double precision,
  from_lng          double precision,
  departed_ts       timestamptz,

  -- ── Leg end: the next stop they reached ──
  to_stop_id        bigint,
  to_job_id         bigint,
  to_customer_id    text,
  to_name           text,
  to_lat            double precision,
  to_lng            double precision,
  arrived_ts        timestamptz,

  -- ── Derived on archive, never on read (see THE TARGET above) ──
  tat_mins          integer,
  tat_basis         text        check (tat_basis in ('arrived', 'completed')),
  distance_km       numeric(6,2),
  target_mins       integer,
  on_time           boolean,
  long_gap          boolean     not null default false,

  archived_at       timestamptz not null default now(),

  -- A leg is identified by the pair of stops it joins. Unique so a re-run cannot
  -- double-write a day even if the delete-then-insert below is interrupted.
  unique (from_stop_id, to_stop_id)
);

-- The driver report's only access path: one driver, one date range.
create index if not exists tat_legs_driver_date_idx
  on public.tat_legs (driver_id, trip_date desc, seq);

-- The archiver's own per-day replace, and supervisor-side whole-day queries.
create index if not exists tat_legs_date_idx
  on public.tat_legs (trip_date desc);

alter table public.tat_legs enable row level security;

-- ---------------------------------------------------------------------------
-- Daily rollup. A month view needs 20-odd numbers, not 600 rows, so the week and
-- month spans read this instead of the base table.
--
-- security_invoker so the view can never become a way around the base table's
-- RLS: it runs as whoever queries it. Only the service role reads it today, but a
-- view that quietly ran as its owner would be a hole waiting for the first person
-- to point the anon key at it.
--
-- Note trips_graded counts only legs that were actually graded — a long_gap leg
-- has no on_time verdict, so it lands in trips_total and stays out of the
-- percentage, which is the whole point of the flag.
-- ---------------------------------------------------------------------------
create or replace view public.v_tat_daily
with (security_invoker = on) as
select
  driver_id,
  trip_date,
  count(*)                                       as trips_total,
  count(*) filter (where tat_mins is not null)   as trips_measured,
  count(*) filter (where on_time is not null)    as trips_graded,
  count(*) filter (where on_time)                as trips_on_time,
  count(*) filter (where long_gap)               as long_gaps,
  -- Averages exclude long gaps: a lunch break is not a slow ride, and letting it
  -- into the mean would move the number the driver is judged on by more than
  -- their driving does.
  round(avg(tat_mins) filter (where not long_gap))::int as avg_tat_mins,
  coalesce(sum(tat_mins) filter (where not long_gap), 0) as total_tat_mins,
  round(coalesce(sum(distance_km), 0)::numeric, 1)      as total_km
from public.tat_legs
group by driver_id, trip_date;
