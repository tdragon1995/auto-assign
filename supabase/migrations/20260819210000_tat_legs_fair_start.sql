-- =============================================================================
-- Fair start: a leg's clock may not begin before the work existed.
--
-- THE PROBLEM
--   A leg is timed from completion at one stop to arrival at the next. When the
--   next job was only created an hour after the driver finished the last one,
--   that clock charges them an hour they could not possibly have used — and since
--   waits are graded (not excused), it counts against them. The effect is
--   backwards: the quieter the day, the worse the driver scores.
--
--   Measured over three days: 256 flagged waits, of which 172 (67%) were the job
--   not existing yet, at a median 91 minutes wrongly charged each.
--
-- THE RULE
--   fair start = max(departed_previous_stop, became_available)
--   where became_available is the LATEST of the destination stop's
--   sendToDriverAt, allowedToStartAt, scheduledDeliveryTs and delivery-window
--   opening — every condition that had to be met before the driver could set off.
--
--   Availability that post-dates the ARRIVAL is ignored entirely. The driver got
--   there ahead of it, so it says nothing about when they could have left, and
--   honouring it would hand a free pass to every planned job whose slot time sits
--   after the run that served it.
--
-- WHAT THE COLUMNS HOLD
--   available_at — the instant actually applied, null when nothing was deducted.
--                  A verdict a driver disputes has to be explainable, and "we
--                  started your clock at 10:14" is only an answer if the row says
--                  where 10:14 came from.
--   idle_mins    — minutes excluded, i.e. fair start − departure. The raw elapsed
--                  time is NOT lost: departed_ts and arrived_ts are both on the
--                  row, so raw = arrived − departed and tat_mins + idle_mins
--                  reconstructs it.
--
-- Both are additive and nullable; existing rows read as "nothing deducted" until
-- they are re-archived, which is correct rather than merely convenient.
-- =============================================================================

alter table public.tat_legs
  add column if not exists available_at timestamptz,
  add column if not exists idle_mins    integer;

comment on column public.tat_legs.available_at is
  'When the destination job became available to the driver, if that moved the leg''s start. Null = the clock started at departure.';
comment on column public.tat_legs.idle_mins is
  'Minutes excluded from tat_mins because the job did not exist yet. tat_mins + idle_mins = raw elapsed.';

-- ---------------------------------------------------------------------------
-- Daily rollup: carry the excluded time so a day can say how much of it was
-- waiting for work rather than riding. Without it the correction is invisible —
-- the numbers simply improve, with nothing on screen to say why.
--
-- APPENDED LAST, like driver_name before it. CREATE OR REPLACE VIEW may only add
-- columns to the END; inserting one mid-list makes Postgres read the change as a
-- rename and refuse with 42P16. Every existing column keeps its exact position.
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
  -- into the mean would move the number a driver is judged on by more than their
  -- driving does.
  round(avg(tat_mins) filter (where not long_gap))::int  as avg_tat_mins,
  coalesce(sum(tat_mins) filter (where not long_gap), 0) as total_tat_mins,
  round(coalesce(sum(distance_km), 0)::numeric, 1)       as total_km,
  max(driver_name)                               as driver_name,
  -- ── new column, appended last on purpose (see note above) ──
  coalesce(sum(idle_mins), 0)                    as total_idle_mins
from public.tat_legs
group by driver_id, trip_date;
