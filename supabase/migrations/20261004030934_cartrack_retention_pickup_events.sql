-- One pickup-event archive serves both total volume and ETA samples.
-- Keep its existing name so deployed ETA writers remain compatible during rollout.
alter table public.pickup_eta alter column scheduled_ts drop not null;
alter table public.pickup_eta add column pickup_completed_ts timestamptz;
alter table public.pickup_eta add column is_eta_sample boolean not null default true;

create or replace function public.cartrack_history_cutoff(reference_date date default (now() at time zone 'Asia/Ho_Chi_Minh')::date)
returns date language sql stable set search_path = '' as $$
  select (date_trunc('month', reference_date::timestamp) - interval '2 months' + interval '14 days')::date;
$$;
revoke all on function public.cartrack_history_cutoff(date) from public, anon, authenticated;
grant execute on function public.cartrack_history_cutoff(date) to service_role;

-- Preserve ETA's existing population as the archive expands to all pickups.
create or replace view public.pickup_eta_stats_30d with (security_invoker=true) as
select pickup_customer_id, count(*)::integer as n,
  round(percentile_cont(0.5) within group (order by extract(epoch from (arrived_ts-scheduled_ts))/60)::numeric, 1) as median_mins,
  round(percentile_cont(0.8) within group (order by extract(epoch from (arrived_ts-scheduled_ts))/60)::numeric, 1) as p80_mins,
  max(pickup_name) as pickup_name
from public.pickup_eta
where is_eta_sample and not has_window and arrived_ts > scheduled_ts
  and (scheduled_ts at time zone 'Asia/Ho_Chi_Minh')::time >= '06:00:00'
  and dropoff_date=trip_date
  and trip_date >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - 30
  and trip_date >= public.cartrack_history_cutoff()
group by pickup_customer_id having count(*) > 5;

-- Store the small grouped result; pickup events remain the only raw source.
create materialized view public.pickup_volume_stats as
with period as (
  select public.cartrack_history_cutoff() as period_from,
    (now() at time zone 'Asia/Ho_Chi_Minh')::date - 1 as period_to
), totals as (
  select pickup_customer_id, count(*) as total_pickups
  from public.pickup_eta, period
  where trip_date between period_from and period_to and pickup_completed_ts is not null
  group by pickup_customer_id
)
select c.customer_id::text as pickup_customer_id,
  coalesce(t.total_pickups, 0) as total_pickups,
  round(coalesce(t.total_pickups, 0)::numeric / (period_to-period_from+1), 2) as average_per_day,
  period_from, period_to, period_to-period_from+1 as calendar_days
from public.master_clients c cross join period
left join totals t on t.pickup_customer_id=c.customer_id::text;
create unique index pickup_volume_stats_customer on public.pickup_volume_stats(pickup_customer_id);
revoke all on public.pickup_volume_stats from public, anon, authenticated;
grant select, maintain on public.pickup_volume_stats to service_role;

create or replace function public.refresh_pickup_volume_stats()
returns void language sql security invoker set search_path = '' as $$
  refresh materialized view public.pickup_volume_stats;
$$;
revoke all on function public.refresh_pickup_volume_stats() from public, anon, authenticated;
grant execute on function public.refresh_pickup_volume_stats() to service_role;
