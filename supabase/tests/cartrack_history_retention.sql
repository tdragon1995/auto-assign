-- Run against the migrated database; all test writes are rolled back.
begin;
do $$
declare
  cutoff date := public.cartrack_history_cutoff();
  cutoff_ts timestamptz := cutoff::timestamp at time zone 'Asia/Ho_Chi_Minh';
  test_id bigint;
  customer text;
  rejected boolean := false;
  column_info record;
  expired bigint;
begin
  assert public.cartrack_history_cutoff('2026-01-01') = '2025-11-15'::date;
  assert public.cartrack_history_cutoff('2026-10-04') = '2026-08-15'::date;
  select least(coalesce(min(job_id), 0), 0) - 1 into test_id from public.pickup_eta;
  select pickup_customer_id into strict customer from public.pickup_eta limit 1;
  insert into public.pickup_eta(job_id, trip_date, pickup_customer_id, arrived_basis, scheduled_ts, arrived_ts, pickup_completed_ts, is_eta_sample)
    values(test_id, cutoff, customer, 'completed', cutoff_ts - interval '1 second', cutoff_ts, cutoff_ts, false);
  assert (select scheduled_ts is null and arrived_ts = cutoff_ts from public.pickup_eta where job_id = test_id), 'Boundary or optional timestamp retention failed';
  begin
    update public.pickup_eta set trip_date = cutoff - 1 where job_id = test_id;
  exception when raise_exception then
    if sqlerrm not like 'Cartrack archive date is before retained history%' then raise; end if;
    rejected := true;
  end;
  assert rejected, 'Expired event was accepted';
  for column_info in
    select table_name, column_name, data_type from information_schema.columns
    where table_schema = 'public' and table_name in ('tat_legs', 'pay_jobs', 'pay_punches', 'pickup_eta', 'pay_days', 'photo_reviews')
      and (data_type like 'timestamp%' or data_type = 'date')
  loop
    execute format('select count(*) from public.%I where %I < $1', column_info.table_name, column_info.column_name)
      into expired using case when column_info.data_type = 'date' then cutoff::timestamptz else cutoff_ts end;
    assert expired = 0, format('Expired timestamp in %s.%s', column_info.table_name, column_info.column_name);
  end loop;
end;
$$;
rollback;
