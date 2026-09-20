-- Pickup ETA: what a pickup really takes vs what the customer portal promises.
--
-- Labcenter's pick-drop setup gives every client place a default drop-off and an
-- `estimate_pick_up` (minutes) that the portal shows when a pickup is requested.
-- pickup_setup is OUR master copy of that setup: changes are proposed from the
-- measured medians, approved in the dashboard, pushed to Labcenter, and only
-- then written here. Labcenter's live values are never stored — drift is
-- computed by comparing the two at read time.
--
-- RLS: enabled with NO policies, so only the service-role key reaches these.

-- One row per completed ad-hoc client pickup. Written by the nightly archive.
create table if not exists public.pickup_eta (
  job_id              bigint      primary key,
  trip_date           date        not null,
  pickup_customer_id  text        not null,
  pickup_name         text,
  -- When the pickup was DUE (scheduled_delivery_ts), not when the row was made.
  -- On the scored population the two are the same minute at both the median and
  -- the 90th percentile; the day-long gaps sit in WINDOWED bookings, which are
  -- filtered out anyway. Reading it off the route timeline is what this buys.
  scheduled_ts        timestamptz not null,
  arrived_ts          timestamptz not null,
  arrived_basis       text        not null check (arrived_basis in ('arrived', 'completed')),
  has_window          boolean     not null default false,
  archived_at         timestamptz not null default now()
);
create index if not exists pickup_eta_customer_date on public.pickup_eta (pickup_customer_id, trip_date);
alter table public.pickup_eta enable row level security;

-- The master setup, one row per Labcenter pickup place. The Cartrack ids are
-- what Labcenter's write endpoint takes; they are resolved once per place (one
-- Labcenter detail call each) and may be null until then.
create table if not exists public.pickup_setup (
  lc_location_id       integer     primary key,
  pick_id              text,
  pick_name            text,
  drop_location_id     integer     not null,
  drop_id              text,
  drop_name            text,
  eta_mins             integer     not null,
  updated_at           timestamptz not null default now(),
  updated_reason       text        not null default 'adopt'
);
create index if not exists pickup_setup_pick_id on public.pickup_setup (pick_id);
alter table public.pickup_setup enable row level security;

-- Append-only history. Labcenter keeps only updated_at, so this is the only
-- record of what changed and why.
create table if not exists public.pickup_setup_changes (
  id                    bigint      generated always as identity primary key,
  lc_location_id        integer     not null,
  kind                  text        not null check (kind in ('approve_eta', 'repush', 'accept_lc')),
  old_drop_location_id  integer,
  new_drop_location_id  integer,
  old_eta               integer,
  new_eta               integer,
  basis_mins            numeric,  -- the p80 the approved ETA was based on
  n                     integer,
  changed_at            timestamptz not null default now()
);
alter table public.pickup_setup_changes enable row level security;

-- Request→arrival per client over the last 30 days, windowed trips out.
-- The PROPOSAL uses p80, not the median: the portal ETA is a promise, and on
-- 2026-09-18 data the fleet median was 36 min with 1 pickup in 10 over 95 —
-- an ETA set to the median would be broken on half of all pickups.
-- The proposal caps the p80 at twice the median (see targetMins) — some clients
-- are bimodal and their raw p80 describes no pickup they have ever had.
-- Computed here so the dashboard receives a few hundred rows, not every pickup.
create or replace view public.pickup_eta_stats_30d
with (security_invoker = true) as
select
  pickup_customer_id,
  count(*)::int as n,
  round((percentile_cont(0.5) within group (order by extract(epoch from (arrived_ts - scheduled_ts)) / 60))::numeric, 1) as median_mins,
  round((percentile_cont(0.8) within group (order by extract(epoch from (arrived_ts - scheduled_ts)) / 60))::numeric, 1) as p80_mins,
  -- Only steers WHICH places get their Cartrack id looked up first; the join
  -- itself is always on the id.
  max(pickup_name) as pickup_name
from public.pickup_eta
where not has_window
  and arrived_ts > scheduled_ts
  and trip_date >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - 30
group by pickup_customer_id
having count(*) > 5;
