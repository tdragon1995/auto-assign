-- Review release: no source switch, no scheduled work. Snapshots remain server-only.
create table public.master_import_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  source_hash text not null,
  source_snapshot jsonb not null,
  database_snapshot jsonb not null,
  report jsonb not null default '{}'::jsonb
);
alter table public.master_import_runs enable row level security;
revoke all on public.master_import_runs from anon, authenticated;

-- Capture the original records, including credentials, before structural changes.
insert into public.master_import_runs(source_hash,source_snapshot,database_snapshot,report)
values ('before-id-migration','{}',jsonb_build_object(
  'rules',(select jsonb_agg(to_jsonb(r)) from public.master_config_rules r),
  'leave',(select jsonb_agg(to_jsonb(l)) from public.master_leave_rows l),
  'drivers',(select jsonb_agg(to_jsonb(d)) from public.master_drivers d)),
  '{"stage":"before_schema"}');

alter table public.master_config_rules
  add column source_uid uuid not null default gen_random_uuid() unique,
  add column assignment_mode text not null default 'fixed' check (assignment_mode in ('fixed','smart')),
  add column active boolean not null default true,
  add column revision bigint not null default 1,
  add column review_issues jsonb not null default '[]';
alter table public.master_config_rules drop constraint master_config_rules_day_type_source_row_key;
alter table public.master_config_rules alter column pickup_customer_id drop expression;
alter table public.master_config_rules alter column dropoff_customer_id drop expression;
alter table public.master_config_rules alter column alternate_dropoff_customer_id drop expression;
alter table public.master_config_rules alter column fixed_driver_id drop expression;
alter table public.master_config_rules alter column shift_start drop expression;
alter table public.master_config_rules alter column shift_end drop expression;

create function public.master_local_time(value text) returns time
language plpgsql immutable set search_path = '' as $$
begin
  if btrim(value) ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' then return btrim(value)::time; end if;
  return null;
end $$;
alter table public.master_config_rules alter column shift_start type time using public.master_local_time(shift_start);
alter table public.master_config_rules alter column shift_end type time using public.master_local_time(shift_end);

drop trigger set_master_smart_driver_id on public.master_config_rules;
drop trigger sync_master_rule_smart_drivers on public.master_config_rules;
alter table public.master_rule_smart_drivers rename to master_rule_drivers;
alter table public.master_rule_drivers add column selection_order integer;
update public.master_config_rules set assignment_mode='smart' where nullif(smart_driver_id,'') is not null;
update public.master_rule_drivers d set selection_order = coalesce(
  array_position(string_to_array(r.smart_driver_id,','),d.driver_id::text),1)
from public.master_config_rules r where r.id=d.rule_id;
insert into public.master_rule_drivers(rule_id,driver_id,selection_order)
select id,fixed_driver_id,1 from public.master_config_rules
where assignment_mode='fixed' and fixed_driver_id is not null;
alter table public.master_rule_drivers alter column selection_order set not null;
alter table public.master_rule_drivers add constraint master_rule_driver_order unique(rule_id,selection_order);
alter table public.master_rule_drivers add constraint master_rule_driver_order_positive check(selection_order>0);
-- Legacy columns are read-only compatibility values until the review is finished.
-- Their original values, including all 14 single-driver Smart overrides, are archived above.
create view public.master_rule_smart_drivers with (security_invoker=true) as
select d.rule_id,d.driver_id from public.master_rule_drivers d
join public.master_config_rules r on r.id=d.rule_id where r.assignment_mode='smart';
revoke all on public.master_rule_smart_drivers from anon,authenticated;

alter table public.master_leave_rows drop constraint master_leave_rows_pkey;
alter table public.master_leave_rows
  add column id bigint generated always as identity primary key,
  add column source_uid uuid not null default gen_random_uuid() unique,
  add column active boolean not null default true,
  add column revision bigint not null default 1,
  add column starts_on date,
  add column ends_on date,
  add column starts_at time,
  add column ends_at time,
  add column review_issues jsonb not null default '[]';
alter table public.master_leave_rows alter column source_row drop not null;
create table public.master_leave_substitutes (
  leave_id bigint not null references public.master_leave_rows(id),
  selection_order integer not null check(selection_order between 1 and 4),
  coverage_kind text not null check(coverage_kind in ('driver','3pl')),
  driver_id uuid references public.master_drivers(driver_id),
  starts_at time,
  ends_at time,
  primary key(leave_id,selection_order),
  check((coverage_kind='driver' and driver_id is not null and driver_id <> '6437bace-6578-11f1-9378-fa163ee8d8ac') or
        (coverage_kind='3pl' and driver_id is null))
);
alter table public.master_leave_substitutes enable row level security;
create index master_leave_substitutes_driver_idx on public.master_leave_substitutes(driver_id);
create index master_leave_driver_dates_idx on public.master_leave_rows(linked_driver_id,starts_on,ends_on) where active;
create index master_rules_pickup_idx on public.master_config_rules(pickup_customer_id) where active;
create index master_rules_dropoff_idx on public.master_config_rules(dropoff_customer_id);
create index master_rules_alt_dropoff_idx on public.master_config_rules(alternate_dropoff_customer_id);
create index master_rules_fixed_driver_idx on public.master_config_rules(fixed_driver_id);

create table public.master_accounts (
  id uuid primary key default gen_random_uuid(),
  client_code text not null unique check(client_code ~ '^[0-9]+$'),
  sales_name text, sales_email text, supervisor_name text, supervisor_email text,
  verified_at timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.master_accounts enable row level security;
alter table public.master_clients
  add column account_id uuid references public.master_accounts(id),
  add column geo_calculated_at timestamptz,
  add column geo_dataset_version text;
create index master_clients_account_idx on public.master_clients(account_id);

create function public.master_review_state() returns jsonb
language sql stable set search_path = '' as $$
select jsonb_build_object(
  'rules',coalesce((select jsonb_agg(to_jsonb(r) order by id) from public.master_config_rules r),'[]'),
  'leave',coalesce((select jsonb_agg(to_jsonb(l) order by id) from public.master_leave_rows l),'[]'))
$$;
revoke all on function public.master_review_state() from public,anon,authenticated;
grant execute on function public.master_review_state() to service_role;

create function public.master_begin_import(source_hash text, source_snapshot jsonb, expected_state jsonb, report jsonb)
returns uuid language plpgsql set search_path = '' as $$
declare run_id uuid;
begin
  if public.master_review_state() <> expected_state then raise exception 'Master changed; repeat reconciliation'; end if;
  insert into public.master_import_runs(source_hash,source_snapshot,database_snapshot,report)
  values(source_hash,source_snapshot,expected_state,report) returning id into run_id;
  return run_id;
end $$;
revoke all on function public.master_begin_import(text,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.master_begin_import(text,jsonb,jsonb,jsonb) to service_role;

create function public.master_commit_import(run_id uuid, payload jsonb, verified_source_hash text)
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
