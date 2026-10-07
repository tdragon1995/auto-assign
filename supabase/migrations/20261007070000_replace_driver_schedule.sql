-- Config and recurring Schedule Setup replacements commit together.
create function public.master_replace_config_driver(changes jsonb,from_driver uuid,to_driver uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare saved jsonb; schedules jsonb;
begin
 if from_driver is null or to_driver is null or from_driver=to_driver then raise exception 'Invalid driver replacement'; end if;
 if not exists(select 1 from public.master_drivers where driver_id=from_driver)
   or not exists(select 1 from public.master_drivers where driver_id=to_driver and is_active)
   or to_driver='6437bace-6578-11f1-9378-fa163ee8d8ac'::uuid then raise exception 'Invalid replacement driver'; end if;
 if jsonb_typeof(changes) is distinct from 'array' or jsonb_array_length(changes)=0 then raise exception 'Select at least one config row'; end if;
 saved:=public.master_write_rules(changes);
 -- Same lock order as the existing config and schedule writers.
 perform pg_advisory_xact_lock(873652905);
 with replaced as (
  update public.master_schedule_jobs set driver_id=to_driver where active and driver_id=from_driver returning id
 ) select coalesce(jsonb_agg(id),'[]'::jsonb) into schedules from replaced;
 insert into public.master_action_logs(action,occurred_at,driver_id,details)
 values('Driver replacement',now(),to_driver,jsonb_build_object('from_driver_id',from_driver,'to_driver_id',to_driver,'schedule_ids',schedules,'rules',saved));
 return jsonb_build_object('rules',saved,'scheduled_replaced',jsonb_array_length(schedules));
end $$;
revoke all on function public.master_replace_config_driver(jsonb,uuid,uuid) from public,anon,authenticated;
grant execute on function public.master_replace_config_driver(jsonb,uuid,uuid) to service_role;
