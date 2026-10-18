-- /qr "Chuyến đến từ PSC khác": how long a trip from each pickup takes to reach one
-- drop-off, measured on the last 30 days of pay_jobs (pickup finished -> delivered).
--
-- p80, not the median: the ETA is a promise to a branch waiting for samples, and 8 in
-- 10 trips on the route made it within this. Same reasoning as the portal pickup ETA.
-- A delivery more than 6 hours after its pickup is a parked or rolled-over job, not a
-- ride, and is left out. Routes with fewer than 5 trips come back too, flagged by
-- `trips`, so the caller decides what counts as enough.
create or replace function public.route_eta_into(p_dropoff text)
returns table (pickup_customer_id text, trips int, p80_mins int, km numeric)
language sql stable
set search_path = public
as $$
  select pickup_customer_id,
         count(*)::int,
         round(percentile_cont(0.8) within group (order by extract(epoch from dropoff_completed_ts - pickup_completed_ts) / 60))::int,
         round(avg(distance_km), 1)
  from pay_jobs
  where trip_date >= current_date - 30
    and dropoff_customer_id = p_dropoff
    and pickup_customer_id is not null
    and dropoff_completed_ts > pickup_completed_ts
    and dropoff_completed_ts - pickup_completed_ts < interval '6 hours'
  group by pickup_customer_id
$$;

revoke all on function public.route_eta_into(text) from public, anon, authenticated;
grant execute on function public.route_eta_into(text) to service_role;
