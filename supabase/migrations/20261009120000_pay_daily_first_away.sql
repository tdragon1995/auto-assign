-- v_pay_daily: first stop completed AWAY from D001, same VN date.
-- A BO runner based at D001 (pay.ts BO_RUNNERS) loses the BO rate for a morning
-- only when he actually LEFT D001 before the window closed — picking up the
-- 14:5x sendout at D001 itself is the handover into his driving shift, not a
-- morning spent driving. Column appended, so existing readers are untouched.
create or replace view public.v_pay_daily as
select driver_id,
  trip_date,
  max(driver_name) as driver_name,
  count(*) as jobs_total,
  count(*) filter (where distance_km is not null) as jobs_priced,
  round(coalesce(sum(distance_km), 0::numeric), 2) as total_km,
  min(pickup_completed_ts) filter (where (pickup_completed_ts at time zone 'Asia/Ho_Chi_Minh')::date = trip_date) as first_pickup_ts,
  max(dropoff_completed_ts) filter (where (dropoff_completed_ts at time zone 'Asia/Ho_Chi_Minh')::date = trip_date) as last_dropoff_ts,
  least(
    min(pickup_completed_ts) filter (where (pickup_completed_ts at time zone 'Asia/Ho_Chi_Minh')::date = trip_date and pickup_name !~ '\mD001$'),
    min(dropoff_completed_ts) filter (where (dropoff_completed_ts at time zone 'Asia/Ho_Chi_Minh')::date = trip_date and dropoff_name !~ '\mD001$')
  ) as first_away_ts
from pay_jobs
group by driver_id, trip_date;
