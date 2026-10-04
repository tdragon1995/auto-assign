-- All mutations are rolled back. No Cartrack jobs are created or assigned.
begin;
set local lock_timeout='3s';set local statement_timeout='45s';
do $$
declare rule public.master_rules_read; leave_row public.master_leave_read; saved jsonb; before_state jsonb; payload jsonb; rid uuid; rejected boolean; changes_before bigint; setup public.pickup_setup;
begin
 if exists(select 1 from information_schema.columns where table_schema='public' and table_name in ('master_config_rules','master_leave_rows') and column_name='row_data') then raise exception 'Legacy row_data remains'; end if;
 if exists(select 1 from public.master_rules_read r where
 r.row_data->>'customer_id'<>coalesce(r.pickup_customer_id::text,'') or
 (select coalesce(jsonb_agg(x.driver_id::text order by x.selection_order),'[]') from public.master_rule_drivers x where x.rule_id=r.id) <>
 (select coalesce(jsonb_agg(x->>'driver_id' order by (x->>'selection_order')::integer),'[]') from jsonb_array_elements(r.master_rule_drivers) x)) then raise exception 'Canonical rule adapter drift'; end if;
 if exists(select 1 from public.master_clients_read c join public.master_accounts a on a.id=c.account_id where c.sales_email is distinct from a.sales_email or c.supervisor_email is distinct from a.supervisor_email) then raise exception 'Account contact drift'; end if;
 if exists(select 1 from public.master_clients_read c join public.pickup_setup p on p.lc_location_id=c.labcenter_location_id where c.eta_minutes is distinct from p.eta_mins or c.default_dropoff_id is distinct from public.master_uuid_or_null(p.drop_id)) then raise exception 'Pickup setup drift'; end if;
 select * into strict rule from public.master_rules_read where active and day_type='weekday' and review_issues='[]' and pickup_customer_id is not null order by id limit 1;
 saved:=public.master_write_rules(jsonb_build_array(jsonb_build_object('id',rule.id,'revision',rule.revision,'pickup_customer_id',rule.pickup_customer_id,'dropoff_customer_id',rule.dropoff_customer_id,'alternate_dropoff_customer_id',rule.alternate_dropoff_customer_id,'shift_start',rule.shift_start,'shift_end',rule.shift_end,'assignment_mode',rule.assignment_mode,'driver_ids',(select coalesce(jsonb_agg(x->>'driver_id' order by (x->>'selection_order')::int),'[]') from jsonb_array_elements(rule.master_rule_drivers) x),'row_data',jsonb_build_object('chat_id','rollback-check'))));
 if (select chat_id from public.master_config_rules where id=rule.id)<>'rollback-check' then raise exception 'Notification write failed'; end if;
 rejected:=false;
 begin perform public.master_write_rules(jsonb_build_array(jsonb_build_object('id',rule.id,'revision',rule.revision,'active',false)));
 exception when others then if sqlerrm not like '%Stale rule revision%' then raise; end if; rejected:=true; end;
 if not rejected then raise exception 'Stale rule write accepted'; end if;
 select * into strict leave_row from public.master_leave_read where active and review_issues='[]' and linked_driver_id is not null and starts_on is not null order by id limit 1;
 perform public.master_write_leave(jsonb_build_array(jsonb_build_object('id',leave_row.id,'revision',leave_row.revision,'linked_driver_id',leave_row.linked_driver_id,'starts_on',leave_row.starts_on,'ends_on',leave_row.ends_on,'starts_at',leave_row.starts_at,'ends_at',leave_row.ends_at,'review_issues','[]'::jsonb,'substitutes',leave_row.master_leave_substitutes,'row_data',leave_row.row_data||'{"note":"rollback-note"}'::jsonb)));
 if (select note from public.master_leave_rows where id=leave_row.id)<>'rollback-note' then raise exception 'Leave note write failed'; end if;
 select * into strict setup from public.pickup_setup where pick_id is not null and drop_id is not null and exists(select 1 from public.master_clients c where c.customer_id=public.master_uuid_or_null(pick_id)) and exists(select 1 from public.master_clients c where c.customer_id=public.master_uuid_or_null(drop_id)) order by lc_location_id limit 1;
 select count(*) into changes_before from public.pickup_setup_changes;
 perform public.commit_pickup_setup(to_jsonb(setup)||'{"kind":"client_edit"}'::jsonb,jsonb_build_object('drop_location_id',setup.drop_location_id,'eta_mins',setup.eta_mins,'drop_id',setup.drop_id,'pick_id',setup.pick_id));
 if (select count(*) from public.pickup_setup_changes)<>changes_before+1 then raise exception 'Setup audit was not atomic'; end if;
 before_state:=public.master_review_state();
 select jsonb_build_object('rules',(select jsonb_agg(to_jsonb(r)||jsonb_build_object('driver_ids',(select coalesce(jsonb_agg(x->>'driver_id' order by (x->>'selection_order')::int),'[]') from jsonb_array_elements(r.master_rule_drivers) x))) from public.master_rules_read r where active and day_type='weekday'),
 'leave',(select jsonb_agg(to_jsonb(l)||jsonb_build_object('substitutes',l.master_leave_substitutes)) from public.master_leave_read l where active)) into payload;
 rid:=public.master_begin_import('rollback-check','{}',before_state,'{"test":true}');
 perform public.master_commit_import(rid,payload,'rollback-check');
 if public.master_review_state()<>before_state then raise exception 'Canonical import was not idempotent'; end if;
 if has_table_privilege('anon','public.master_rules_read','SELECT') or has_table_privilege('authenticated','public.master_leave_read','SELECT') then raise exception 'Master view exposed'; end if;
end $$;
rollback;
select 'passed' as checks;
