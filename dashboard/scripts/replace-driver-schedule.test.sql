begin;
do $$
declare rule public.master_config_rules; before_schedule public.master_schedule_jobs; other uuid; from_id uuid; to_id uuid; pickup uuid; dropoff uuid; selected jsonb; changes jsonb; saved jsonb; sid bigint; inactive_id bigint; untouched_id bigint; pending_id bigint;
begin
 select r.* into strict rule from public.master_config_rules r where r.active and r.day_type='weekday' and r.pickup_customer_id is not null and exists(select 1 from public.master_rule_drivers d where d.rule_id=r.id) order by r.id limit 1;
 select driver_id into from_id from public.master_rule_drivers where rule_id=rule.id order by selection_order limit 1;
 select driver_id into strict to_id from public.master_drivers where is_active and driver_id<>from_id and driver_id<>'6437bace-6578-11f1-9378-fa163ee8d8ac'::uuid order by driver_id limit 1;
 pickup:=rule.pickup_customer_id;
 select customer_id into strict dropoff from public.master_clients where customer_id<>pickup order by customer_id limit 1;
 select jsonb_agg(id::text order by pos) into selected from (select case when driver_id=from_id then to_id else driver_id end as id,min(selection_order) as pos from public.master_rule_drivers where rule_id=rule.id group by case when driver_id=from_id then to_id else driver_id end) d;
 changes:=jsonb_build_array(jsonb_build_object('id',rule.id,'revision',rule.revision,'assignment_mode',rule.assignment_mode,'pickup_customer_id',rule.pickup_customer_id,'dropoff_customer_id',rule.dropoff_customer_id,'alternate_dropoff_customer_id',rule.alternate_dropoff_customer_id,'shift_start',rule.shift_start,'shift_end',rule.shift_end,'driver_ids',selected));
 insert into public.master_schedule_jobs(source_row,pickup_id,dropoff_id,driver_id,delivery_window,reference,days) values(999999,pickup,dropoff,from_id,'12:00','replacement-test-'||gen_random_uuid(),array[false,true,true,true,true,true,false]) returning * into before_schedule;
 sid:=before_schedule.id;
 insert into public.master_schedule_jobs(source_row,pickup_id,dropoff_id,driver_id,delivery_window,reference,days,active) values(999999,pickup,dropoff,from_id,'13:00','replacement-test-'||gen_random_uuid(),array[false,true,true,true,true,true,false],false) returning id into inactive_id;
 insert into public.master_schedule_jobs(source_row,pickup_id,dropoff_id,driver_id,delivery_window,reference,days) values(999999,pickup,dropoff,to_id,'14:00','replacement-test-'||gen_random_uuid(),array[false,true,true,true,true,true,false]) returning id into untouched_id;
 saved:=public.master_replace_config_driver(changes,from_id,to_id);
 if (saved->>'scheduled_replaced')::int<1 or (select driver_id from public.master_schedule_jobs where id=sid)<>to_id then raise exception 'Schedule driver not replaced';end if;
 if exists(select 1 from public.master_rule_drivers where rule_id=rule.id and driver_id=from_id) or not exists(select 1 from public.master_rule_drivers where rule_id=rule.id and driver_id=to_id) then raise exception 'Config driver not replaced';end if;
 if (select to_jsonb(s)-'driver_id'-'revision'-'updated_at' from public.master_schedule_jobs s where id=sid)<>to_jsonb(before_schedule)-'driver_id'-'revision'-'updated_at' then raise exception 'Schedule fields changed';end if;
 if (select revision from public.master_schedule_jobs where id=sid)<>before_schedule.revision+1 then raise exception 'Schedule revision did not advance';end if;
 if (select driver_id from public.master_schedule_jobs where id=inactive_id)<>from_id or (select revision from public.master_schedule_jobs where id=untouched_id)<>1 then raise exception 'Inactive or other driver schedule changed';end if;
 begin perform public.master_write_schedule(to_jsonb(before_schedule));raise exception 'Stale schedule edit accepted';exception when others then if sqlerrm='Stale schedule edit accepted' then raise;end if;end;
 insert into public.master_schedule_jobs(source_row,pickup_id,dropoff_id,driver_id,delivery_window,reference,days) values(999999,pickup,dropoff,from_id,'15:00','replacement-test-'||gen_random_uuid(),array[false,true,true,true,true,true,false]) returning id into pending_id;
 begin perform public.master_replace_config_driver(changes,from_id,to_id);raise exception 'Stale config edit accepted';exception when others then if sqlerrm='Stale config edit accepted' then raise;end if;end;
 if (select driver_id from public.master_schedule_jobs where id=pending_id)<>from_id then raise exception 'Failed config replacement changed schedule';end if;
 raise notice 'PASS: atomic Config and Schedule Setup replacement, stable hours/days, revisions, inactive protection and stale rollback';
end $$;
rollback;
