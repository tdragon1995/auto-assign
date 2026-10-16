-- When the driver REACHED the first pickup, not when they completed it: payroll's
-- "Ghi nhận vào" for a driver who taps in late is the pickup ARRIVAL (Lê Minh
-- Triết 26/09: arrived 17:04, completed 17:07, tapped in 18:15). Days archived
-- before this column existed fall back to the completion time.
alter table public.pay_jobs add column if not exists pickup_arrived_ts timestamptz;

create or replace view public.v_pay_daily as
 SELECT driver_id,
    trip_date,
    max(driver_name) AS driver_name,
    count(*) AS jobs_total,
    count(*) FILTER (WHERE distance_km IS NOT NULL) AS jobs_priced,
    round(COALESCE(sum(distance_km), 0::numeric), 2) AS total_km,
    min(COALESCE(pickup_arrived_ts, pickup_completed_ts)) FILTER (WHERE (COALESCE(pickup_arrived_ts, pickup_completed_ts) AT TIME ZONE 'Asia/Ho_Chi_Minh'::text)::date = trip_date) AS first_pickup_ts,
    max(dropoff_completed_ts) FILTER (WHERE (dropoff_completed_ts AT TIME ZONE 'Asia/Ho_Chi_Minh'::text)::date = trip_date) AS last_dropoff_ts,
    LEAST(min(pickup_completed_ts) FILTER (WHERE (pickup_completed_ts AT TIME ZONE 'Asia/Ho_Chi_Minh'::text)::date = trip_date AND pickup_name !~ '\mD001$'::text), min(dropoff_completed_ts) FILTER (WHERE (dropoff_completed_ts AT TIME ZONE 'Asia/Ho_Chi_Minh'::text)::date = trip_date AND dropoff_name !~ '\mD001$'::text)) AS first_away_ts
   FROM pay_jobs
  GROUP BY driver_id, trip_date;
