-- Approved operational retention: shared VN cutoff, six fixed archive tables.
-- Master/config tables, road-distance caches and backup tables are untouched.
alter table public.pickup_eta alter column arrived_ts drop not null;

create or replace function public.retain_cartrack_event()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  cutoff date := public.cartrack_history_cutoff();
  cutoff_ts timestamptz := cutoff::timestamp at time zone 'Asia/Ho_Chi_Minh';
  field text;
  row_data jsonb := to_jsonb(new);
begin
  if (row_data ->> tg_argv[0])::date < cutoff or (row_data ->> tg_argv[1])::timestamptz < cutoff_ts then
    raise exception 'Cartrack archive date is before retained history (%)', cutoff;
  end if;
  -- Keep a recent event (and its pickup count), but forget older optional stamps.
  foreach field in array string_to_array(tg_argv[2], ',') loop
    if (row_data ->> field)::timestamptz < cutoff_ts then
      row_data := jsonb_set(row_data, array[field], 'null'::jsonb);
    end if;
  end loop;
  new := jsonb_populate_record(new, row_data);
  return new;
end;
$$;
revoke all on function public.retain_cartrack_event() from public, anon, authenticated;
grant execute on function public.retain_cartrack_event() to service_role;

create or replace function public.purge_cartrack_history()
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  cutoff date := public.cartrack_history_cutoff();
  cutoff_ts timestamptz := cutoff::timestamp at time zone 'Asia/Ho_Chi_Minh';
  target record;
  field text;
  removed bigint;
  result jsonb := '{}'::jsonb;
begin
  for target in select * from (values
    ('tat_legs', 'trip_date', 'archived_at', 'departed_ts,arrived_ts,available_at'),
    ('pay_jobs', 'trip_date', 'archived_at', 'pickup_completed_ts,dropoff_completed_ts'),
    ('pay_punches', 'trip_date', 'archived_at', 'started_ts,arrived_ts,completed_ts'),
    ('pickup_eta', 'trip_date', 'archived_at', 'scheduled_ts,arrived_ts,pickup_completed_ts,dropoff_date'),
    ('pay_days', 'trip_date', 'archived_at', ''),
    ('photo_reviews', 'review_date', 'reviewed_at', '')
  ) as targets(table_name, date_column, archive_column, fields) loop
    execute format('delete from public.%I where %I < $1 or %I < $2', target.table_name, target.date_column, target.archive_column) using cutoff, cutoff_ts;
    get diagnostics removed = row_count;
    result := result || jsonb_build_object(target.table_name, removed);
    foreach field in array string_to_array(target.fields, ',') loop
      execute format('update public.%I set %I = null where %I::timestamptz < $1', target.table_name, field, field) using cutoff_ts;
    end loop;
  end loop;
  perform public.refresh_pickup_volume_stats();
  return result;
end;
$$;
revoke all on function public.purge_cartrack_history() from public, anon, authenticated;
grant execute on function public.purge_cartrack_history() to service_role;

do $$
declare target record;
begin
  for target in select * from (values
    ('tat_legs', 'trip_date', 'archived_at', 'departed_ts,arrived_ts,available_at'),
    ('pay_jobs', 'trip_date', 'archived_at', 'pickup_completed_ts,dropoff_completed_ts'),
    ('pay_punches', 'trip_date', 'archived_at', 'started_ts,arrived_ts,completed_ts'),
    ('pickup_eta', 'trip_date', 'archived_at', 'scheduled_ts,arrived_ts,pickup_completed_ts,dropoff_date'),
    ('pay_days', 'trip_date', 'archived_at', ''),
    ('photo_reviews', 'review_date', 'reviewed_at', '')
  ) as targets(table_name, date_column, archive_column, fields) loop
    execute format('create trigger cartrack_retention before insert or update on public.%I for each row execute function public.retain_cartrack_event(%L, %L, %L)', target.table_name, target.date_column, target.archive_column, target.fields);
  end loop;
end;
$$;

create extension if not exists pg_cron;
-- 17:00 UTC is midnight Vietnam: also advances the cutoff on the first of a month.
select cron.schedule('cartrack-history-retention', '0 17 * * *', 'select public.purge_cartrack_history();');

select public.purge_cartrack_history();
