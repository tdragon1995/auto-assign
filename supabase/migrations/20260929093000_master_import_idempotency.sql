create or replace function public.master_commit_import(run_id uuid, payload jsonb, verified_source_hash text)
returns jsonb language plpgsql set search_path = '' as $$
declare run public.master_import_runs; item jsonb; sub jsonb; rid bigint; changed integer:=0;
begin
  -- One transaction covers weekday configuration and leave. Retry the same run safely.
  perform pg_advisory_xact_lock(873652901);
  select * into strict run from public.master_import_runs where id=run_id for update;
  if run.committed_at is not null then return run.report; end if;
  lock table public.master_config_rules, public.master_leave_rows, public.master_rule_drivers,
    public.master_leave_substitutes in share row exclusive mode;
  if public.master_review_state() <> run.database_snapshot then raise exception 'Master changed; repeat reconciliation'; end if;
  if run.source_hash <> verified_source_hash then raise exception 'Sheet changed; repeat reconciliation'; end if;
  if jsonb_array_length(payload->'rules')<100 or jsonb_array_length(payload->'leave')<100 then raise exception 'Incomplete import'; end if;
  if exists(select 1 from jsonb_array_elements(payload->'rules') x group by x->>'source_uid' having count(*)>1)
     or exists(select 1 from jsonb_array_elements(payload->'leave') x group by x->>'source_uid' having count(*)>1)
    then raise exception 'Duplicate source UID'; end if;

  for item in select * from jsonb_array_elements(payload->'rules') loop
    if exists(select 1 from public.master_config_rules where source_uid=(item->>'source_uid')::uuid and day_type<>'weekday') then
      raise exception 'Sunday identity cannot be used for a weekday rule';
    end if;
    if exists(select 1 from public.master_config_rules r where r.source_uid=(item->>'source_uid')::uuid and r.active
      and r.row_data=item->'row_data' and r.source_row=(item->>'source_row')::integer
      and r.assignment_mode=item->>'assignment_mode' and r.review_issues=item->'review_issues'
      and coalesce((select jsonb_agg(d.driver_id::text order by d.selection_order) from public.master_rule_drivers d where d.rule_id=r.id),'[]')=item->'driver_ids')
      then continue; end if;
    if item->>'assignment_mode'='fixed' and jsonb_array_length(item->'driver_ids')>1 then raise exception 'Fixed mode needs at most one driver'; end if;
    if item->'driver_ids' ? '6437bace-6578-11f1-9378-fa163ee8d8ac' then raise exception '3PL proxy cannot be selected'; end if;
    insert into public.master_config_rules(source_uid,day_type,source_row,row_data,assignment_mode,active,
      pickup_customer_id,dropoff_customer_id,alternate_dropoff_customer_id,shift_start,shift_end,review_issues,
      smart_driver_id,smart_driver_id_manual,fixed_driver_id)
    values((item->>'source_uid')::uuid,'weekday',(item->>'source_row')::integer,item->'row_data',item->>'assignment_mode',true,
      (item->>'pickup_customer_id')::uuid,(item->>'dropoff_customer_id')::uuid,(item->>'alternate_dropoff_customer_id')::uuid,
      (item->>'shift_start')::time,(item->>'shift_end')::time,item->'review_issues',
      case when item->>'assignment_mode'='smart' then (select string_agg(v,',') from jsonb_array_elements_text(item->'driver_ids') v) end,
      null,case when item->>'assignment_mode'='fixed' then (item->'driver_ids'->>0)::uuid end)
    on conflict(source_uid) do update set source_row=excluded.source_row,row_data=excluded.row_data,
      assignment_mode=excluded.assignment_mode,active=true,pickup_customer_id=excluded.pickup_customer_id,
      dropoff_customer_id=excluded.dropoff_customer_id,alternate_dropoff_customer_id=excluded.alternate_dropoff_customer_id,
      shift_start=excluded.shift_start,shift_end=excluded.shift_end,review_issues=excluded.review_issues,
      smart_driver_id=excluded.smart_driver_id,smart_driver_id_manual=null,fixed_driver_id=excluded.fixed_driver_id,
      revision=public.master_config_rules.revision+1,updated_at=now()
    returning id into rid;
    delete from public.master_rule_drivers where rule_id=rid;
    insert into public.master_rule_drivers(rule_id,driver_id,selection_order)
    select rid,value::uuid,ordinality from jsonb_array_elements_text(item->'driver_ids') with ordinality;
    changed:=changed+1;
  end loop;
  update public.master_config_rules set active=false,revision=revision+1,updated_at=now()
  where day_type='weekday' and active and source_uid not in
    (select (x->>'source_uid')::uuid from jsonb_array_elements(payload->'rules') x);

  for item in select * from jsonb_array_elements(payload->'leave') loop
    if exists(select 1 from public.master_leave_rows l where l.source_uid=(item->>'source_uid')::uuid and l.active
      and l.row_data=item->'row_data' and l.source_row=(item->>'source_row')::integer
      and l.review_issues=item->'review_issues' and l.starts_on is not distinct from (item->>'starts_on')::date
      and l.linked_driver_id is not distinct from (item->>'linked_driver_id')::uuid) then continue; end if;
    insert into public.master_leave_rows(source_uid,source_row,row_data,linked_driver_id,linked_sub1_driver_id,
      starts_on,ends_on,starts_at,ends_at,review_issues,active)
    values((item->>'source_uid')::uuid,(item->>'source_row')::integer,item->'row_data',(item->>'linked_driver_id')::uuid,
      (item->'substitutes'->0->>'driver_id')::uuid,(item->>'starts_on')::date,(item->>'ends_on')::date,
      (item->>'starts_at')::time,(item->>'ends_at')::time,item->'review_issues',true)
    on conflict(source_uid) do update set source_row=excluded.source_row,row_data=excluded.row_data,
      linked_driver_id=excluded.linked_driver_id,linked_sub1_driver_id=excluded.linked_sub1_driver_id,
      starts_on=excluded.starts_on,ends_on=excluded.ends_on,starts_at=excluded.starts_at,ends_at=excluded.ends_at,
      review_issues=excluded.review_issues,active=true,revision=public.master_leave_rows.revision+1,synced_at=now()
    returning id into rid;
    delete from public.master_leave_substitutes where leave_id=rid;
    for sub in select * from jsonb_array_elements(item->'substitutes') loop
      insert into public.master_leave_substitutes(leave_id,selection_order,coverage_kind,driver_id,starts_at,ends_at)
      values(rid,(sub->>'selection_order')::integer,sub->>'coverage_kind',(sub->>'driver_id')::uuid,
        (sub->>'starts_at')::time,(sub->>'ends_at')::time);
    end loop;
  end loop;
  update public.master_leave_rows set active=false,revision=revision+1,synced_at=now()
  where active and source_uid not in(select (x->>'source_uid')::uuid from jsonb_array_elements(payload->'leave') x);
  update public.master_import_runs set committed_at=now() where id=run_id;
  return run.report;
end $$;
revoke all on function public.master_commit_import(uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.master_commit_import(uuid,jsonb,text) to service_role;
