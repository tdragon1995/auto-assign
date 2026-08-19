-- =============================================================================
-- Legs that are ridden but not graded.
--
-- The run from the central lab OUT to a branch carries no samples and has no
-- deadline: the driver is repositioning, and how long it takes is a routing
-- decision rather than a performance one. Over August that is 2,457 legs, ~15%
-- of everything, each measured against a target describing nothing anyone
-- manages. Branch → lab is the sample run and stays graded, so this is
-- one-directional.
--
-- WHY A FLAG AND NOT A DELETE
--   Dropping the row would take those kilometres off the driver's mileage too.
--   Distance is the one figure on this report that is a record rather than a
--   judgement, and the one a driver is least willing to watch shrink. So the leg
--   stays, keeps its distance, and simply carries no verdict.
--
-- Every performance column below therefore filters on `not unscored`, while
-- total_km deliberately does not.
-- =============================================================================

alter table public.tat_legs
  add column if not exists unscored boolean not null default false;

comment on column public.tat_legs.unscored is
  'Ridden but not graded (lab → branch repositioning). Counts toward total_km, excluded from every performance count.';

-- Partial index: the archiver and the report both read the scored subset, which
-- is ~85% of the table, but the flag is what every count now filters on.
create index if not exists tat_legs_scored_idx
  on public.tat_legs (trip_date desc) where not unscored;

-- ---------------------------------------------------------------------------
-- Column ORDER and NAMES below are unchanged — CREATE OR REPLACE VIEW may only
-- append, never reorder or rename (42P16). Only the expressions move.
-- ---------------------------------------------------------------------------
create or replace view public.v_tat_daily
with (security_invoker = on) as
select
  driver_id,
  trip_date,
  count(*) filter (where not unscored)                          as trips_total,
  count(*) filter (where tat_mins is not null and not unscored) as trips_measured,
  count(*) filter (where on_time is not null)                   as trips_graded,
  count(*) filter (where on_time)                               as trips_on_time,
  count(*) filter (where long_gap)                              as long_gaps,
  -- Averages exclude long gaps: a lunch break is not a slow ride, and letting it
  -- into the mean would move the number a driver is judged on by more than their
  -- driving does.
  round(avg(tat_mins) filter (where not long_gap and not unscored))::int  as avg_tat_mins,
  coalesce(sum(tat_mins) filter (where not long_gap and not unscored), 0) as total_tat_mins,
  -- NOT filtered. Every kilometre ridden counts, graded or not.
  round(coalesce(sum(distance_km), 0)::numeric, 1)              as total_km,
  max(driver_name)                                              as driver_name,
  coalesce(sum(idle_mins), 0)                                   as total_idle_mins
from public.tat_legs
group by driver_id, trip_date;
