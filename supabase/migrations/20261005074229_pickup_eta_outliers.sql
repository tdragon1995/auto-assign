-- Reject unusual trips before calculating the promise, per pickup customer.
-- MAD uses the median, so an isolated delayed trip cannot widen its own fence.
-- The 15-minute floor keeps ordinary variation when repeated times make MAD zero.
create or replace view public.pickup_eta_stats_30d with (security_invoker=true) as
with samples as (
  select pickup_customer_id, pickup_name, trip_date,
    extract(epoch from (arrived_ts - scheduled_ts)) / 60 as mins
  from public.pickup_eta
  where is_eta_sample and not has_window and arrived_ts > scheduled_ts
    and (scheduled_ts at time zone 'Asia/Ho_Chi_Minh')::time >= '06:00:00'
    and dropoff_date = trip_date
    and trip_date >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - 30
    and trip_date < (now() at time zone 'Asia/Ho_Chi_Minh')::date
    and trip_date >= public.cartrack_history_cutoff()
), medians as (
  select pickup_customer_id, percentile_cont(0.5) within group (order by mins) as median
  from samples group by pickup_customer_id
), fences as (
  select s.pickup_customer_id, m.median,
    greatest(15, 3 * 1.4826 * percentile_cont(0.5) within group (order by abs(s.mins - m.median))) as radius
  from samples s join medians m using (pickup_customer_id)
  group by s.pickup_customer_id, m.median
)
select s.pickup_customer_id, count(*)::integer as n,
  round(percentile_cont(0.5) within group (order by s.mins)::numeric, 1) as median_mins,
  round(percentile_cont(0.8) within group (order by s.mins)::numeric, 1) as p80_mins,
  max(s.pickup_name) as pickup_name,
  count(distinct s.trip_date)::integer as sample_days
from samples s join fences f using (pickup_customer_id)
where abs(s.mins - f.median) <= f.radius
group by s.pickup_customer_id having count(*) > 5;

revoke all on public.pickup_eta_stats_30d from public, anon, authenticated;
grant select on public.pickup_eta_stats_30d to service_role;
notify pgrst, 'reload schema';
