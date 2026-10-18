-- Pay past the shift end: what the rule and the "Nghi vấn" list need per day.
--  * pay_jobs.*_force_completed — Cartrack's isForceCompleted: an ADMIN completed
--    the stop, so its time is the click, not the driver's work. Null on rows
--    archived before 2026-10-19.
--  * v_pay_daily.dropoff_ts — every same-date drop-off, so a trip completed after
--    the check-out can be set aside without losing the ones before it.
--  * v_pay_daily.last_leg_* — the day's last ride from tat_legs (when it ends at
--    the last drop-off): its fair start, normal time for the distance and actual
--    time. last_leg_due_ts = when it should have arrived.
alter table public.pay_jobs add column if not exists pickup_force_completed boolean;
alter table public.pay_jobs add column if not exists dropoff_force_completed boolean;

create or replace view public.v_pay_daily as
with d as (
 SELECT driver_id,
    trip_date,
    max(driver_name) AS driver_name,
    count(*) AS jobs_total,
    count(*) FILTER (WHERE distance_km IS NOT NULL) AS jobs_priced,
    round(COALESCE(sum(distance_km), 0::numeric), 2) AS total_km,
    min(COALESCE(pickup_arrived_ts, pickup_completed_ts)) FILTER (WHERE (COALESCE(pickup_arrived_ts, pickup_completed_ts) AT TIME ZONE 'Asia/Ho_Chi_Minh'::text)::date = trip_date) AS first_pickup_ts,
    max(dropoff_completed_ts) FILTER (WHERE (dropoff_completed_ts AT TIME ZONE 'Asia/Ho_Chi_Minh'::text)::date = trip_date) AS last_dropoff_ts,
    LEAST(min(pickup_completed_ts) FILTER (WHERE (pickup_completed_ts AT TIME ZONE 'Asia/Ho_Chi_Minh'::text)::date = trip_date AND pickup_name !~ '\mD001$'::text), min(dropoff_completed_ts) FILTER (WHERE (dropoff_completed_ts AT TIME ZONE 'Asia/Ho_Chi_Minh'::text)::date = trip_date AND dropoff_name !~ '\mD001$'::text)) AS first_away_ts,
    array_agg(dropoff_completed_ts ORDER BY dropoff_completed_ts) FILTER (WHERE (dropoff_completed_ts AT TIME ZONE 'Asia/Ho_Chi_Minh'::text)::date = trip_date) AS dropoff_ts,
    (array_agg(dropoff_force_completed ORDER BY dropoff_completed_ts DESC NULLS LAST))[1] AS last_dropoff_forced
   FROM pay_jobs
  GROUP BY driver_id, trip_date
)
select d.*,
  l.fair_start AS last_leg_start,
  l.target_mins AS last_leg_target,
  l.tat_mins AS last_leg_tat,
  CASE WHEN l.target_mins IS NOT NULL AND l.fair_start IS NOT NULL
       THEN l.fair_start + make_interval(mins => l.target_mins) END AS last_leg_due_ts
from d
left join lateral (
  select greatest(t.departed_ts, coalesce(t.available_at, t.departed_ts)) fair_start, t.target_mins, t.tat_mins
  from public.tat_legs t
  where t.driver_id = d.driver_id and t.trip_date = d.trip_date
    and t.arrived_ts is not null and d.last_dropoff_ts is not null
    and abs(extract(epoch from (t.arrived_ts - d.last_dropoff_ts))) <= 600
  order by t.seq desc limit 1
) l on true;
