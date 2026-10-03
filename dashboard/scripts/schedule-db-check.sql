-- Run against Supabase with execute_sql. All write checks roll back; no jobs are created.
begin;
set local role service_role;
do $$
declare original public.master_schedule_jobs; saved jsonb; changed jsonb; item jsonb; caught boolean;
begin
  select s.* into strict original from public.master_schedule_jobs s
  join public.master_clients p on p.customer_id=s.pickup_id and p.is_active
  join public.master_clients d on d.customer_id=s.dropoff_id and d.is_active order by s.id limit 1;
  item:=jsonb_build_object('pickup_id',original.pickup_id,'dropoff_id',original.dropoff_id,
    'driver_id',original.driver_id,'delivery_window',original.delivery_window,'sent_to_driver_before',original.sent_to_driver_before,
    'reference','__codex_schedule_transaction_check__','days',original.days);
  saved:=public.master_write_schedule(item);
  changed:=public.master_write_schedule(item||jsonb_build_object('id',saved->'id','revision',saved->'revision','driver_id',''));
  if (select driver_id is not null from public.master_schedule_jobs where id=(saved->>'id')::bigint) then raise exception 'Clear driver failed'; end if;
  caught:=false;
  begin perform public.master_write_schedule(item||jsonb_build_object('id',saved->'id','revision',saved->'revision'));
  exception when raise_exception then caught:=true; end;
  if not caught then raise exception 'Stale write accepted'; end if;
  caught:=false;
  begin perform public.master_write_schedule(item); exception when unique_violation then caught:=true; end;
  if not caught then raise exception 'Duplicate reference accepted'; end if;
  caught:=false;
  begin update public.master_schedule_jobs set days='{}' where id=(saved->>'id')::bigint;
  exception when check_violation then caught:=true; end;
  if not caught then raise exception 'Empty weekday array accepted'; end if;
  caught:=false;
  begin update public.master_schedule_jobs set pickup_id='00000000-0000-0000-0000-000000000000' where id=(saved->>'id')::bigint;
  exception when foreign_key_violation then caught:=true; end;
  if not caught then raise exception 'Unknown pickup accepted'; end if;
  perform public.master_write_schedule(jsonb_build_object('id',changed->'id','revision',changed->'revision','active',false));
  if (select active from public.master_schedule_jobs where id=(saved->>'id')::bigint) then raise exception 'Soft delete failed'; end if;
end $$;
rollback;
select count(*) as schedules, count(distinct source_uid) as permanent_ids,
  array[count(*) filter(where days[1]),count(*) filter(where days[2]),count(*) filter(where days[3]),
    count(*) filter(where days[4]),count(*) filter(where days[5]),count(*) filter(where days[6]),count(*) filter(where days[7])] as weekday_counts
from public.master_schedule_jobs where active;
