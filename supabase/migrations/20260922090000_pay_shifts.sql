-- =============================================================================
-- Part-time SHIFTS, imported once a month from payroll's own records file.
--
-- WHY A FILE AND NOT THE ROSTER GRID. Reconciled against payroll's 15/08–14/09
-- file (1,042 driver-days), the roster grid agreed with the shift payroll
-- actually used on only 52% of days: 186 paid days blank in the grid, 221 with no
-- grid row at all (39 people), 89 with different hours. The file is what payroll
-- pays against, so it is the source — decided 2026-09-22.
--
-- One row per shift WINDOW, not per day: a split day (08:00–12:00 then
-- 15:00–21:00) is two rows, and the gap between them is not paid time.
--
-- driver_id is resolved at import from the account name, which is the Cartrack
-- driver label the file carries in "Tài khoản nhân viên". It is nullable because
-- an account payroll names but the app has never seen still has to be stored
-- and reported rather than dropped.
--
-- Written only by POST /api/pay/shifts, which REPLACES a whole payroll period:
-- re-importing a corrected file is the way to correct it.
-- =============================================================================

create table if not exists public.pay_shifts (
  id            bigint generated always as identity primary key,
  trip_date     date        not null,
  driver_id     uuid,
  staff_code    text,
  account_name  text        not null,
  shift_start   time        not null,
  shift_end     time        not null,
  source        text        not null default 'payroll-file',
  imported_at   timestamptz not null default now(),
  unique (trip_date, account_name, shift_start)
);

create index if not exists pay_shifts_driver_date_idx on public.pay_shifts (driver_id, trip_date);
create index if not exists pay_shifts_date_idx on public.pay_shifts (trip_date);

-- Service-role only, like every pay table.
alter table public.pay_shifts enable row level security;

-- The day's first pickup and last dropoff, for the hours rule: the last completed
-- trip extends a shift, and a driver who never tapped in starts at their first
-- pickup. APPENDED LAST — create or replace view may only add columns at the end
-- (see 20260819120000_tat_daily_driver_name.sql).
create or replace view public.v_pay_daily
with (security_invoker = on) as
select
  driver_id,
  trip_date,
  max(driver_name)                                       as driver_name,
  count(*)                                               as jobs_total,
  count(*) filter (where distance_km is not null)        as jobs_priced,
  round(coalesce(sum(distance_km), 0)::numeric, 2)       as total_km,
  -- Same VN date only: a job finished the next morning (seen 25/08) would
  -- otherwise stretch this day's shift overnight.
  min(pickup_completed_ts) filter (where (pickup_completed_ts at time zone 'Asia/Ho_Chi_Minh')::date = trip_date)   as first_pickup_ts,
  max(dropoff_completed_ts) filter (where (dropoff_completed_ts at time zone 'Asia/Ho_Chi_Minh')::date = trip_date) as last_dropoff_ts
from public.pay_jobs
group by driver_id, trip_date;
