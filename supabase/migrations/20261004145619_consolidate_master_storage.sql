-- Preserve original source-only fields and pre-migration settings in an existing service-only audit table.
select pg_advisory_xact_lock(873652901);
insert into public.master_import_runs(source_hash,source_snapshot,database_snapshot,report,committed_at)
values('schema-consolidation-20261004',
 jsonb_build_object('rules',(select jsonb_agg(to_jsonb(r) order by id) from public.master_config_rules r),
 'leave',(select jsonb_agg(to_jsonb(l) order by id) from public.master_leave_rows l),
 'clients',(select jsonb_agg(to_jsonb(c) order by customer_id) from public.master_clients c),
 'drivers',(select jsonb_agg(to_jsonb(d) order by driver_id) from public.master_drivers d),
 'schedule',(select jsonb_agg(to_jsonb(s) order by id) from public.master_schedule_jobs s),
 'pickup_setup',(select jsonb_agg(to_jsonb(p) order by lc_location_id) from public.pickup_setup p)),
 public.master_review_state(),'{"kind":"schema_checkpoint","reason":"legacy columns removed; source-only evidence retained"}',now());
alter table public.master_config_rules add column bot_token text,add column chat_id text;
update public.master_config_rules set bot_token=row_data->>'bot_token',chat_id=row_data->>'chat_id';
alter table public.master_leave_rows alter column submitted_at drop expression,alter column leave_type drop expression,alter column note drop expression;
alter table public.master_leave_rows add column review_input jsonb not null default '{}';
create or replace function public.master_leave_review_input(item jsonb)
returns jsonb language sql immutable set search_path='' as $$
select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each_text(coalesce(item->'row_data','{}')) f
where coalesce(value,'')<>'' and (
 (key='driver' and item->>'linked_driver_id' is null) or
 (key='leave_from' and item->>'starts_on' is null) or (key='leave_to' and item->>'ends_on' is null) or
 (key='leave_from_hr' and item->>'starts_at' is null) or (key='leave_to_hr' and item->>'ends_at' is null) or
 (key ~ '^sub[1-4]_(name|from|to)$' and not exists(
 select 1 from jsonb_array_elements(coalesce(item->'substitutes','[]')) s
 where (s->>'selection_order')::integer=substring(key from 4 for 1)::integer
 and (key like '%_name' or (key like '%_from' and s->>'starts_at' is not null) or (key like '%_to' and s->>'ends_at' is not null)))));
$$;
revoke all on function public.master_leave_review_input(jsonb) from public,anon,authenticated;
grant execute on function public.master_leave_review_input(jsonb) to service_role;

update public.master_leave_rows l set review_input=public.master_leave_review_input(to_jsonb(l)||jsonb_build_object('substitutes',coalesce((select jsonb_agg(to_jsonb(s)-'leave_id') from public.master_leave_substitutes s where s.leave_id=l.id),'[]'::jsonb)));

create or replace function public.master_rule_source(r public.master_config_rules)
returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object(
 'bot_token',coalesce(r.bot_token,''),'chat_id',coalesce(r.chat_id,''),
 '_master_record_id',r.source_uid::text,'customer_id',coalesce(r.pickup_customer_id::text,''),
 'dropoff_id',coalesce(r.dropoff_customer_id::text,''),'alt_drop_off_id',coalesce(r.alternate_dropoff_customer_id::text,''),
 'shift_start',coalesce(to_char(r.shift_start,'HH24:MI'),''),'shift_end',coalesce(to_char(r.shift_end,'HH24:MI'),''),
 'driver_id',case when r.assignment_mode='fixed' then coalesce((select driver_id::text from public.master_rule_drivers where rule_id=r.id order by selection_order limit 1),'') else '' end,
 'smart_driver_id',case when r.assignment_mode='smart' then coalesce((select string_agg(driver_id::text,',' order by selection_order) from public.master_rule_drivers where rule_id=r.id),'') else '' end,
 'Điểm Pick-up',coalesce((select customer_name from public.master_clients where customer_id=r.pickup_customer_id),''),
 'Điểm Drop-off',coalesce((select customer_name from public.master_clients where customer_id=r.dropoff_customer_id),''),
 'Điểm Drop-off thay thế',coalesce((select customer_name from public.master_clients where customer_id=r.alternate_dropoff_customer_id),''));
$$;
create or replace function public.master_leave_source(l public.master_leave_rows)
returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object(
 '_master_record_id',l.source_uid::text,'Ngày Nộp Đơn',coalesce(l.submitted_at,''),
 'Loại Nghỉ',coalesce(l.leave_type,''),'note',coalesce(l.note,''),
 'driver_id',coalesce(l.linked_driver_id::text,''),'driver',coalesce((select trim(coalesce(first_name,'')||' '||coalesce(last_name,'')) from public.master_drivers where driver_id=l.linked_driver_id),l.review_input->>'driver',''),
 'leave_from',coalesce(l.starts_on::text,l.review_input->>'leave_from',''),'leave_to',coalesce(l.ends_on::text,l.review_input->>'leave_to',''),
 'leave_from_hr',coalesce(to_char(l.starts_at,'HH24:MI'),l.review_input->>'leave_from_hr',''),'leave_to_hr',coalesce(to_char(l.ends_at,'HH24:MI'),l.review_input->>'leave_to_hr',''))
 || coalesce((select jsonb_object_agg(key,value) from (
 select 'sub'||i||'_'||suffix as key,coalesce(case when s.leave_id is null then l.review_input->> ('sub'||i||'_'||suffix) else case suffix
 when 'id' then case when s.coverage_kind='3pl' then '6437bace-6578-11f1-9378-fa163ee8d8ac' else s.driver_id::text end
 when 'name' then case when s.coverage_kind='3pl' then '3PL' else trim(coalesce(d.first_name,'')||' '||coalesce(d.last_name,'')) end
 when 'from' then coalesce(to_char(s.starts_at,'HH24:MI'),l.review_input->>('sub'||i||'_from')) when 'to' then coalesce(to_char(s.ends_at,'HH24:MI'),l.review_input->>('sub'||i||'_to')) end end,'') as value
 from generate_series(1,4) i cross join unnest(array['id','name','from','to']) suffix
 left join public.master_leave_substitutes s on s.leave_id=l.id and s.selection_order=i
 left join public.master_drivers d on d.driver_id=s.driver_id) fields),'{}'::jsonb);
$$;
revoke all on function public.master_rule_source(public.master_config_rules),public.master_leave_source(public.master_leave_rows) from public,anon,authenticated;
grant execute on function public.master_rule_source(public.master_config_rules),public.master_leave_source(public.master_leave_rows) to service_role;
create or replace view public.master_rules_read with(security_invoker=true) as
select r.id,r.day_type,r.source_row,r.updated_at,r.pickup_customer_id,r.dropoff_customer_id,r.alternate_dropoff_customer_id,r.shift_start,r.shift_end,r.source_uid,r.assignment_mode,r.active,r.revision,r.review_issues, public.master_rule_source(r) as row_data,
coalesce((select jsonb_agg(jsonb_build_object('driver_id',d.driver_id,'selection_order',d.selection_order) order by d.selection_order) from public.master_rule_drivers d where d.rule_id=r.id),'[]'::jsonb) as master_rule_drivers
from public.master_config_rules r;
revoke all on public.master_rules_read from public,anon,authenticated;
grant select on public.master_rules_read to service_role;

create or replace view public.master_leave_read with(security_invoker=true) as
select l.source_row,l.linked_driver_id,l.synced_at,l.id,l.source_uid,l.active,l.revision,l.starts_on,l.ends_on,l.starts_at,l.ends_at,l.review_issues, public.master_leave_source(l) as row_data,
coalesce((select jsonb_agg(jsonb_build_object('selection_order',s.selection_order,'coverage_kind',s.coverage_kind,'driver_id',s.driver_id,'starts_at',s.starts_at,'ends_at',s.ends_at) order by s.selection_order) from public.master_leave_substitutes s where s.leave_id=l.id),'[]'::jsonb) as master_leave_substitutes
from public.master_leave_rows l;
revoke all on public.master_leave_read from public,anon,authenticated;
grant select on public.master_leave_read to service_role;

create or replace view public.master_clients_read with(security_invoker=true) as
select c.customer_id,c.cartrack,c.client_code,c.new_ward,c.nearest_psc_id,c.nearest_psc_km,c.labcenter_location_id,c.synced_at,c.customer_name,c.address_line_1,c.address_line_2,c.client_reference,c.contact_code,c.contact_number,c.country_id,c.create_ts,c.email,c.is_address_locked,c.latitude,c.longitude,c.postal_code,c.subuser_id,c.update_ts,c.user_id,c.detail_synced_at,c.account_id,c.geo_calculated_at,c.geo_dataset_version,c.is_active,
coalesce(public.master_uuid_or_null(p.drop_id),c.default_dropoff_id) as default_dropoff_id,
case when p.lc_location_id is not null then p.eta_mins else c.eta_minutes end as eta_minutes,
a.sales_name,a.sales_email,a.supervisor_name,a.supervisor_email,
n.customer_name as nearest_psc_name,coalesce(d.customer_name,p.drop_name) as default_dropoff_name
from public.master_clients c
left join public.master_accounts a on a.id=c.account_id
left join public.master_clients n on n.customer_id=c.nearest_psc_id
left join public.pickup_setup p on p.lc_location_id=c.labcenter_location_id
left join public.master_clients d on d.customer_id=coalesce(public.master_uuid_or_null(p.drop_id),c.default_dropoff_id);
revoke all on public.master_clients_read from public,anon,authenticated;
grant select on public.master_clients_read to service_role;
CREATE OR REPLACE FUNCTION public.master_write_rules(changes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare item jsonb; before_row public.master_config_rules; after_row public.master_config_rules;
  result jsonb:='[]'; selected jsonb; before_ids jsonb; next_source integer;
begin
  -- ponytail: one lock for manual rule writes; split by rule only if edit throughput warrants it.
  perform pg_advisory_xact_lock(873652901);
  if jsonb_typeof(changes) is distinct from 'array' or jsonb_array_length(changes)>500 then raise exception 'Invalid change batch'; end if;
  for item in select * from jsonb_array_elements(changes) loop
    before_row:=null; before_ids:='[]'; selected:='[]';
    if item->>'id' is not null then
      select * into strict before_row from public.master_config_rules where id=(item->>'id')::bigint for update;
      if before_row.day_type<>'weekday' then raise exception 'Sunday remains on Google Sheet'; end if;
      if not before_row.active or (item->>'revision')::bigint is distinct from before_row.revision then
        raise exception 'Stale rule revision; reload before editing';
      end if;
    end if;
    select coalesce(jsonb_agg(driver_id::text order by selection_order),'[]') into before_ids
      from public.master_rule_drivers where rule_id=before_row.id;
    selected:=before_ids;
    if item->>'active'='false' then
      if before_row.id is null then raise exception 'Delete requires a rule ID'; end if;
      update public.master_config_rules set active=false,revision=revision+1,updated_at=now()
      where id=before_row.id returning * into after_row;
    else
      selected:=item->'driver_ids';
      if jsonb_typeof(selected) is distinct from 'array' or jsonb_array_length(selected)>20 then raise exception 'Invalid selected drivers'; end if;
      if item->>'assignment_mode' not in ('fixed','smart') or item->>'assignment_mode' is null then raise exception 'Invalid assignment mode'; end if;
      if item->>'assignment_mode'='fixed' and jsonb_array_length(selected)>1 then raise exception 'Fixed mode allows one driver'; end if;
      if selected ? '6437bace-6578-11f1-9378-fa163ee8d8ac' then raise exception '3PL proxy cannot be assigned'; end if;
      if (select count(*)<>count(distinct value) from jsonb_array_elements_text(selected)) then raise exception 'Duplicate selected driver'; end if;
      if item->>'pickup_customer_id' is null then raise exception 'Pickup ID required'; end if;
      if item->>'shift_start'=item->>'shift_end' then raise exception 'Empty shift'; end if;
      if ((item->>'shift_start') is null) <> ((item->>'shift_end') is null) then raise exception 'Incomplete shift'; end if;
      select coalesce(max(source_row),1)+1 into next_source from public.master_config_rules where day_type='weekday';
      if before_row.id is null then
        insert into public.master_config_rules(day_type,source_row,bot_token,chat_id,assignment_mode,pickup_customer_id,
          dropoff_customer_id,alternate_dropoff_customer_id,shift_start,shift_end)
        values('weekday',next_source,item->'row_data'->>'bot_token',item->'row_data'->>'chat_id',item->>'assignment_mode',(item->>'pickup_customer_id')::uuid,
          (item->>'dropoff_customer_id')::uuid,(item->>'alternate_dropoff_customer_id')::uuid,
          (item->>'shift_start')::time,(item->>'shift_end')::time) returning * into after_row;
      else
        update public.master_config_rules set
          bot_token=case when item->'row_data' ? 'bot_token' then item->'row_data'->>'bot_token' else before_row.bot_token end,
          chat_id=case when item->'row_data' ? 'chat_id' then item->'row_data'->>'chat_id' else before_row.chat_id end,assignment_mode=item->>'assignment_mode',
          pickup_customer_id=(item->>'pickup_customer_id')::uuid,dropoff_customer_id=(item->>'dropoff_customer_id')::uuid,
          alternate_dropoff_customer_id=(item->>'alternate_dropoff_customer_id')::uuid,
          shift_start=(item->>'shift_start')::time,shift_end=(item->>'shift_end')::time,
          review_issues='[]',revision=revision+1,updated_at=now()
        where id=before_row.id returning * into after_row;
      end if;
      select coalesce(jsonb_agg(driver_id::text order by selection_order),'[]') into before_ids
        from public.master_rule_drivers where rule_id=after_row.id;
      delete from public.master_rule_drivers where rule_id=after_row.id;
      insert into public.master_rule_drivers(rule_id,driver_id,selection_order)
        select after_row.id,value::uuid,ordinality from jsonb_array_elements_text(selected) with ordinality;

    end if;
    insert into public.master_record_changes(rule_id,before_data,after_data)
    values(after_row.id,
      case when before_row.id is not null then (to_jsonb(before_row)-'row_data') || jsonb_build_object('driver_ids',before_ids) end,
      (to_jsonb(after_row)-'row_data') || jsonb_build_object('driver_ids',selected));
    result:=result || jsonb_build_array(jsonb_build_object('id',after_row.id,'revision',after_row.revision,'source_row',after_row.source_row));
  end loop;
  return result;
end $function$;

CREATE OR REPLACE FUNCTION public.master_write_leave(changes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare item jsonb; sub jsonb; before_row public.master_leave_rows; after_row public.master_leave_rows;
  result jsonb:='[]'; next_source integer; before_subs jsonb; after_subs jsonb;
begin
  perform pg_advisory_xact_lock(873652901);
  if jsonb_typeof(changes) is distinct from 'array' or jsonb_array_length(changes)>500 then raise exception 'Invalid change batch'; end if;
  for item in select * from jsonb_array_elements(changes) loop
    before_row:=null;
    if item->>'id' is not null then
      select * into strict before_row from public.master_leave_rows where id=(item->>'id')::bigint for update;
      if not before_row.active or before_row.revision is distinct from (item->>'revision')::bigint then raise exception 'Stale leave revision'; end if;
    end if;
    select coalesce(jsonb_agg(to_jsonb(s)-'leave_id' order by selection_order),'[]') into before_subs
      from public.master_leave_substitutes s where leave_id=before_row.id;
    if item->>'active'='false' then
      if before_row.id is null then raise exception 'Delete requires leave ID'; end if;
      update public.master_leave_rows set active=false,revision=revision+1,synced_at=now()
      where id=before_row.id returning * into after_row;
    else
      if item->>'linked_driver_id' is null or item->>'starts_on' is null or jsonb_array_length(item->'review_issues')>0 then
        raise exception 'Unresolved leave values; review before saving';
      end if;
      if item->>'linked_driver_id'='6437bace-6578-11f1-9378-fa163ee8d8ac' then raise exception '3PL is coverage, not an employee'; end if;
      if before_row.id is null then
        select coalesce(max(source_row),1)+1 into next_source from public.master_leave_rows;
        insert into public.master_leave_rows(source_row,submitted_at,leave_type,note,review_input,linked_driver_id,starts_on,ends_on,starts_at,ends_at)
        values(next_source,item->'row_data'->>'Ngày Nộp Đơn',item->'row_data'->>'Loại Nghỉ',item->'row_data'->>'note',public.master_leave_review_input(item),(item->>'linked_driver_id')::uuid,(item->>'starts_on')::date,
          (item->>'ends_on')::date,(item->>'starts_at')::time,(item->>'ends_at')::time) returning * into after_row;
      else
        update public.master_leave_rows set submitted_at=item->'row_data'->>'Ngày Nộp Đơn',leave_type=item->'row_data'->>'Loại Nghỉ',note=item->'row_data'->>'note',review_input=public.master_leave_review_input(item),linked_driver_id=(item->>'linked_driver_id')::uuid,
          starts_on=(item->>'starts_on')::date,ends_on=(item->>'ends_on')::date,starts_at=(item->>'starts_at')::time,
          ends_at=(item->>'ends_at')::time,review_issues='[]',revision=revision+1,synced_at=now()
        where id=before_row.id returning * into after_row;
      end if;
      delete from public.master_leave_substitutes where leave_id=after_row.id;
      for sub in select * from jsonb_array_elements(item->'substitutes') loop
        insert into public.master_leave_substitutes(leave_id,selection_order,coverage_kind,driver_id,starts_at,ends_at)
        values(after_row.id,(sub->>'selection_order')::integer,sub->>'coverage_kind',(sub->>'driver_id')::uuid,
          (sub->>'starts_at')::time,(sub->>'ends_at')::time);
      end loop;

    end if;
    select coalesce(jsonb_agg(to_jsonb(s)-'leave_id' order by selection_order),'[]') into after_subs
      from public.master_leave_substitutes s where leave_id=after_row.id;
    insert into public.master_record_changes(leave_id,before_data,after_data)
    values(after_row.id,(to_jsonb(before_row)-'row_data')||jsonb_build_object('substitutes',before_subs),(to_jsonb(after_row)-'row_data')||jsonb_build_object('substitutes',after_subs));
    result:=result||jsonb_build_array(jsonb_build_object('id',after_row.id,'revision',after_row.revision));
  end loop;
  return result;
end $function$;

CREATE OR REPLACE FUNCTION public.master_commit_import(run_id uuid, payload jsonb, verified_source_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
      and coalesce(r.bot_token,'')=coalesce(item->'row_data'->>'bot_token','')
      and coalesce(r.chat_id,'')=coalesce(item->'row_data'->>'chat_id','')
      and r.pickup_customer_id is not distinct from (item->>'pickup_customer_id')::uuid
      and r.dropoff_customer_id is not distinct from (item->>'dropoff_customer_id')::uuid
      and r.alternate_dropoff_customer_id is not distinct from (item->>'alternate_dropoff_customer_id')::uuid
      and r.shift_start is not distinct from (item->>'shift_start')::time
      and r.shift_end is not distinct from (item->>'shift_end')::time and r.source_row=(item->>'source_row')::integer
      and r.assignment_mode=item->>'assignment_mode' and r.review_issues=item->'review_issues'
      and coalesce((select jsonb_agg(d.driver_id::text order by d.selection_order) from public.master_rule_drivers d where d.rule_id=r.id),'[]')=item->'driver_ids')
      then continue; end if;
    if item->>'assignment_mode'='fixed' and jsonb_array_length(item->'driver_ids')>1 then raise exception 'Fixed mode needs at most one driver'; end if;
    if item->'driver_ids' ? '6437bace-6578-11f1-9378-fa163ee8d8ac' then raise exception '3PL proxy cannot be selected'; end if;
    insert into public.master_config_rules(source_uid,day_type,source_row,bot_token,chat_id,assignment_mode,active,
      pickup_customer_id,dropoff_customer_id,alternate_dropoff_customer_id,shift_start,shift_end,review_issues)
    values((item->>'source_uid')::uuid,'weekday',(item->>'source_row')::integer,item->'row_data'->>'bot_token',item->'row_data'->>'chat_id',item->>'assignment_mode',true,
      (item->>'pickup_customer_id')::uuid,(item->>'dropoff_customer_id')::uuid,(item->>'alternate_dropoff_customer_id')::uuid,
      (item->>'shift_start')::time,(item->>'shift_end')::time,item->'review_issues')
    on conflict(source_uid) do update set source_row=excluded.source_row,bot_token=excluded.bot_token,chat_id=excluded.chat_id,
      assignment_mode=excluded.assignment_mode,active=true,pickup_customer_id=excluded.pickup_customer_id,
      dropoff_customer_id=excluded.dropoff_customer_id,alternate_dropoff_customer_id=excluded.alternate_dropoff_customer_id,
      shift_start=excluded.shift_start,shift_end=excluded.shift_end,review_issues=excluded.review_issues,
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
      and coalesce(l.submitted_at,'')=coalesce(item->'row_data'->>'Ngày Nộp Đơn','')
      and coalesce(l.leave_type,'')=coalesce(item->'row_data'->>'Loại Nghỉ','')
      and coalesce(l.note,'')=coalesce(item->'row_data'->>'note','')
      and l.review_input=public.master_leave_review_input(item)
      and l.ends_on is not distinct from (item->>'ends_on')::date
      and l.starts_at is not distinct from (item->>'starts_at')::time
      and l.ends_at is not distinct from (item->>'ends_at')::time
      and coalesce((select jsonb_agg(to_jsonb(s)-'leave_id' order by selection_order) from public.master_leave_substitutes s where s.leave_id=l.id),'[]'::jsonb)=item->'substitutes' and l.source_row=(item->>'source_row')::integer
      and l.review_issues=item->'review_issues' and l.starts_on is not distinct from (item->>'starts_on')::date
      and l.linked_driver_id is not distinct from (item->>'linked_driver_id')::uuid) then continue; end if;
    insert into public.master_leave_rows(source_uid,source_row,submitted_at,leave_type,note,review_input,linked_driver_id,
      starts_on,ends_on,starts_at,ends_at,review_issues,active)
    values((item->>'source_uid')::uuid,(item->>'source_row')::integer,item->'row_data'->>'Ngày Nộp Đơn',item->'row_data'->>'Loại Nghỉ',item->'row_data'->>'note',
      public.master_leave_review_input(item),(item->>'linked_driver_id')::uuid,(item->>'starts_on')::date,(item->>'ends_on')::date,
      (item->>'starts_at')::time,(item->>'ends_at')::time,item->'review_issues',true)
    on conflict(source_uid) do update set source_row=excluded.source_row,submitted_at=excluded.submitted_at,leave_type=excluded.leave_type,note=excluded.note,review_input=excluded.review_input,
      linked_driver_id=excluded.linked_driver_id,
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
end $function$;
CREATE OR REPLACE FUNCTION public.master_review_state()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
select jsonb_build_object(
  'rules',coalesce((select jsonb_agg(to_jsonb(r) order by id) from public.master_rules_read r),'[]'),
  'leave',coalesce((select jsonb_agg(to_jsonb(l) order by id) from public.master_leave_read l),'[]'))
$function$;
alter table public.master_config_rules drop column row_data,drop column fixed_driver_id,drop column smart_driver_id,drop column smart_driver_id_manual;
alter table public.master_leave_rows drop column driver_id,drop column driver_name,drop column leave_from,drop column leave_to,drop column leave_from_hr,drop column leave_to_hr,drop column day,drop column sub1_name,drop column sub1_id,drop column sub1_from,drop column sub1_to,drop column position,drop column row_data,drop column linked_sub1_driver_id;
alter table public.master_schedule_jobs drop column source_data;
-- Four unapproved copies disagree with the read-only Labcenter snapshot. Never change existing approved decisions.
with actual(lc_location_id,old_drop,old_eta,new_drop,new_eta) as (values(424,561,45,681,45),(2212,681,60,681,45),(1634,556,66,1634,70),(1886,562,120,554,120)),
changed as (
 update public.pickup_setup p set drop_location_id=a.new_drop,eta_mins=a.new_eta,
 drop_id=(select customer_id::text from public.master_clients where labcenter_location_id=a.new_drop),
 drop_name=(select customer_name from public.master_clients where labcenter_location_id=a.new_drop),
 updated_at=now(),updated_reason='reconcile_lc'
 from actual a where p.lc_location_id=a.lc_location_id and p.drop_location_id=a.old_drop and p.eta_mins=a.old_eta
 and not exists(select 1 from public.pickup_setup_changes h where h.lc_location_id=p.lc_location_id)
 and coalesce(p.updated_reason,'') not in ('approve_eta','repush','accept_lc','client_edit')
 returning p.lc_location_id,p.drop_location_id,p.eta_mins
)
insert into public.pickup_setup_changes(lc_location_id,kind,old_drop_location_id,new_drop_location_id,old_eta,new_eta)
select a.lc_location_id,'reconcile_lc',a.old_drop,c.drop_location_id,a.old_eta,c.eta_mins from changed c join actual a using(lc_location_id);
create or replace function public.master_refresh_metadata(updates jsonb, accounts jsonb default '[]')
returns void language plpgsql set search_path='' as $$
begin
 if jsonb_typeof(updates) is distinct from 'array' or jsonb_array_length(updates)>5000 then raise exception 'Invalid metadata updates'; end if;
 if exists(select 1 from jsonb_array_elements(updates) u cross join lateral jsonb_object_keys(u) k
 where k not in ('customer_id','labcenter_location_id','default_dropoff_id','default_dropoff_name','eta_minutes','sales_name','sales_email','supervisor_name','supervisor_email'))
 then raise exception 'Unexpected metadata field'; end if;
 if exists(select 1 from jsonb_array_elements(updates) u group by u->>'customer_id' having count(*)>1) then raise exception 'Duplicate metadata identity'; end if;
 if exists(select 1 from jsonb_array_elements(updates) u left join public.master_clients c on c.customer_id=(u->>'customer_id')::uuid where c.customer_id is null) then raise exception 'Unknown metadata identity'; end if;
 perform public.master_sync_accounts(accounts);
 update public.master_clients c set labcenter_location_id=case when u.item ? 'labcenter_location_id' then (u.item->>'labcenter_location_id')::bigint else c.labcenter_location_id end
 from jsonb_array_elements(updates) u(item) where c.customer_id=(u.item->>'customer_id')::uuid;
 -- Adopt verified, previously unseen setup only. Existing approved values stay unchanged; drift is reviewed explicitly.
 insert into public.pickup_setup(lc_location_id,pick_id,pick_name,drop_location_id,drop_id,drop_name,eta_mins,updated_reason)
 select c.labcenter_location_id,c.customer_id::text,c.customer_name,d.labcenter_location_id,d.customer_id::text,d.customer_name,
 (u.item->>'eta_minutes')::integer,'adopt'
 from jsonb_array_elements(updates) u(item) join public.master_clients c on c.customer_id=(u.item->>'customer_id')::uuid
 join public.master_clients d on d.customer_id=(u.item->>'default_dropoff_id')::uuid
 where c.labcenter_location_id is not null and d.labcenter_location_id is not null and u.item->>'eta_minutes' is not null
 on conflict(lc_location_id) do nothing;
 update public.master_clients c set default_dropoff_id=null,eta_minutes=null
 where c.labcenter_location_id is not null and exists(select 1 from public.pickup_setup p where p.lc_location_id=c.labcenter_location_id);
end $$;
-- Fill only missing UUID links from verified Labcenter identity links; approved drop/ETA values are untouched.
update public.pickup_setup p set pick_id=c.customer_id::text from public.master_clients c where p.lc_location_id=c.labcenter_location_id and coalesce(p.pick_id,'')='';
update public.pickup_setup p set drop_id=c.customer_id::text from public.master_clients c where p.drop_location_id=c.labcenter_location_id and coalesce(p.drop_id,'')='';
update public.master_clients c set default_dropoff_id=null,eta_minutes=null where exists(select 1 from public.pickup_setup p where p.lc_location_id=c.labcenter_location_id);
alter table public.master_clients drop column sales_name,drop column sales_email,drop column supervisor_name,drop column supervisor_email,drop column nearest_psc_name,drop column default_dropoff_name;
alter table public.master_drivers drop column delivery_driver_id;
update public.master_drivers set roster=roster-'driver_zalo_id'-'bot_token'-'phone_number_update' where roster ?| array['driver_zalo_id','bot_token','phone_number_update'];
create or replace view public.tat_legs_linked with(security_invoker=true) as
select r.id,r.trip_date,r.driver_id,r.driver_name,r.seq,r.from_stop_id,r.from_job_id,r.from_customer_id,r.from_name,r.from_lat,r.from_lng,r.departed_ts,r.to_stop_id,r.to_job_id,r.to_customer_id,r.to_name,r.to_lat,r.to_lng,r.arrived_ts,r.tat_mins,r.tat_basis,r.distance_km,r.target_mins,r.on_time,r.long_gap,r.archived_at,r.eta_mins,r.benchmark_mins,r.available_at,r.idle_mins,r.unscored,m0.driver_id as master_driver_id,m1.customer_id as master_from_id,m2.customer_id as master_to_id
from public.tat_legs r
left join public.master_drivers m0 on m0.driver_id=public.master_uuid_or_null(r.driver_id::text)
left join public.master_clients m1 on m1.customer_id=public.master_uuid_or_null(r.from_customer_id::text)
left join public.master_clients m2 on m2.customer_id=public.master_uuid_or_null(r.to_customer_id::text);
revoke all on public.tat_legs_linked from public,anon,authenticated;
grant select on public.tat_legs_linked to service_role;
drop trigger master_link_tat_legs on public.tat_legs;
alter table public.tat_legs drop column master_driver_id,drop column master_from_id,drop column master_to_id;
create or replace view public.pay_jobs_linked with(security_invoker=true) as
select r.id,r.trip_date,r.driver_id,r.driver_name,r.job_id,r.reference_number,r.pickup_customer_id,r.pickup_name,r.pickup_lat,r.pickup_lng,r.pickup_completed_ts,r.dropoff_customer_id,r.dropoff_name,r.dropoff_lat,r.dropoff_lng,r.dropoff_completed_ts,r.distance_km,r.archived_at,m0.driver_id as master_driver_id,m1.customer_id as master_pickup_id,m2.customer_id as master_dropoff_id
from public.pay_jobs r
left join public.master_drivers m0 on m0.driver_id=public.master_uuid_or_null(r.driver_id::text)
left join public.master_clients m1 on m1.customer_id=public.master_uuid_or_null(r.pickup_customer_id::text)
left join public.master_clients m2 on m2.customer_id=public.master_uuid_or_null(r.dropoff_customer_id::text);
revoke all on public.pay_jobs_linked from public,anon,authenticated;
grant select on public.pay_jobs_linked to service_role;
drop trigger master_link_pay_jobs on public.pay_jobs;
alter table public.pay_jobs drop column master_driver_id,drop column master_pickup_id,drop column master_dropoff_id;
create or replace view public.pay_punches_linked with(security_invoker=true) as
select r.id,r.trip_date,r.driver_id,r.driver_name,r.job_id,r.kind,r.customer_id,r.location_name,r.started_ts,r.arrived_ts,r.completed_ts,r.job_status_id,r.archived_at,m0.driver_id as master_driver_id,m1.customer_id as master_customer_id
from public.pay_punches r
left join public.master_drivers m0 on m0.driver_id=public.master_uuid_or_null(r.driver_id::text)
left join public.master_clients m1 on m1.customer_id=public.master_uuid_or_null(r.customer_id::text);
revoke all on public.pay_punches_linked from public,anon,authenticated;
grant select on public.pay_punches_linked to service_role;
drop trigger master_link_pay_punches on public.pay_punches;
alter table public.pay_punches drop column master_driver_id,drop column master_customer_id;
create or replace view public.pickup_eta_linked with(security_invoker=true) as
select r.job_id,r.trip_date,r.pickup_customer_id,r.pickup_name,r.scheduled_ts,r.arrived_ts,r.arrived_basis,r.has_window,r.archived_at,r.dropoff_date,r.pickup_completed_ts,r.is_eta_sample,m0.customer_id as master_pickup_id
from public.pickup_eta r
left join public.master_clients m0 on m0.customer_id=public.master_uuid_or_null(r.pickup_customer_id::text);
revoke all on public.pickup_eta_linked from public,anon,authenticated;
grant select on public.pickup_eta_linked to service_role;
drop trigger master_link_pickup_eta on public.pickup_eta;
alter table public.pickup_eta drop column master_pickup_id;
create or replace view public.pay_shifts_linked with(security_invoker=true) as
select r.id,r.trip_date,r.driver_id,r.staff_code,r.account_name,r.shift_start,r.shift_end,r.source,r.imported_at,m0.driver_id as master_driver_id
from public.pay_shifts r
left join public.master_drivers m0 on m0.driver_id=public.master_uuid_or_null(r.driver_id::text);
revoke all on public.pay_shifts_linked from public,anon,authenticated;
grant select on public.pay_shifts_linked to service_role;
drop trigger master_link_pay_shifts on public.pay_shifts;
alter table public.pay_shifts drop column master_driver_id;
drop function public.master_link_report();
do $$
declare snapshot jsonb; original jsonb; current_row public.master_leave_rows; key text; val text;
begin
 select source_snapshot into strict snapshot from public.master_import_runs where source_hash='schema-consolidation-20261004' order by committed_at desc limit 1;
 for original in select * from jsonb_array_elements(snapshot->'leave') loop
  select * into strict current_row from public.master_leave_rows where id=(original->>'id')::bigint;
  for key,val in select * from jsonb_each_text(public.master_leave_review_input(original||jsonb_build_object('substitutes',coalesce((select jsonb_agg(to_jsonb(s)-'leave_id') from public.master_leave_substitutes s where s.leave_id=current_row.id),'[]')))) loop
   if public.master_leave_source(current_row)->>key is distinct from val then raise exception 'Unresolved leave input lost: %, %',current_row.id,key; end if;
  end loop;
  if coalesce(current_row.note,'')<>coalesce(original->'row_data'->>'note','') or coalesce(current_row.leave_type,'')<>coalesce(original->'row_data'->>'Loại Nghỉ','') then raise exception 'Leave metadata changed'; end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(snapshot->'rules') x(item) join public.master_config_rules r on r.id=(x.item->>'id')::bigint where coalesce(r.bot_token,'')<>coalesce(x.item->'row_data'->>'bot_token','') or coalesce(r.chat_id,'')<>coalesce(x.item->'row_data'->>'chat_id','')) then raise exception 'Notification settings changed'; end if;
end $$;
notify pgrst,'reload schema';
-- Retire only the confirmed empty, unused shift table. Never discard newly arrived data.
do $$ begin if exists(select 1 from public.pay_shifts) then raise exception 'pay_shifts is no longer empty; review before retiring'; end if; end $$;
drop view public.pay_shifts_linked;
drop table public.pay_shifts;
drop function public.master_smart_driver_id(text,text);
