-- =============================================================================
-- Add driver_name to the daily TAT rollup.
--
-- WHY: the supervisor view ranks every driver for a chosen month. Without a name
-- on the rollup it would have to either pull the whole month of legs just to
-- recover names (tens of thousands of rows to learn ~80 strings) or cross-check
-- against Cartrack's live driver list — which silently loses anyone who has since
-- left the company, exactly the people a month-end evaluation still needs.
--
-- max() rather than grouping by the name: a driver whose recorded name changed
-- mid-month must stay ONE row, not split into two half-months. Grouping by both
-- columns would do precisely that, and the split would be invisible in the UI —
-- it would just look like two drivers each doing half the work.
--
-- ── COLUMN ORDER IS LOAD-BEARING HERE ────────────────────────────────────────
-- driver_name is APPENDED LAST, which looks untidy beside driver_id but is the
-- only shape that works. CREATE OR REPLACE VIEW may only add columns to the END
-- of an existing view; it cannot insert one in the middle or reorder. Putting
-- driver_name second — the natural place — makes Postgres read the change as
-- "rename column 2 from trip_date to driver_name" and refuse:
--
--     ERROR: 42P16: cannot change name of view column "trip_date" to "driver_name"
--
-- Every existing column below therefore keeps its exact original position. The
-- app selects by name, not position, so nothing downstream cares.
--
-- Safe to re-run; replaces the view in place and touches no data.
-- =============================================================================

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
  -- into the mean would move the number a driver is judged on by more than their
  -- driving does.
  round(avg(tat_mins) filter (where not long_gap))::int  as avg_tat_mins,
  coalesce(sum(tat_mins) filter (where not long_gap), 0) as total_tat_mins,
  round(coalesce(sum(distance_km), 0)::numeric, 1)       as total_km,
  -- ── new column, appended last on purpose (see note above) ──
  max(driver_name)                               as driver_name
from public.tat_legs
group by driver_id, trip_date;
