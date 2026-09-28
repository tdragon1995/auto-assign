-- Reproduce the config Sheet's SPLIT/Driver!A:B/TEXTJOIN calculation in Master.
-- A non-NULL manual value overrides the formula; an empty string forces no smart driver.
alter table public.master_drivers add column roster_source_row integer;
alter table public.master_config_rules add column smart_driver_id_manual text;
alter table public.master_config_rules alter column smart_driver_id drop expression;

create function public.master_smart_driver_id(driver_names text, manual_ids text default null)
returns text language plpgsql stable set search_path = '' as $$
declare
  result text;
  missing text;
  name_count integer;
begin
  if manual_ids is not null then
    select string_agg(d.driver_id::text, ',' order by p.ord),
           min(btrim(p.name)) filter (where d.driver_id is null)
      into result, missing
    from regexp_split_to_table(manual_ids, ',') with ordinality as p(name, ord)
    left join public.master_drivers d on d.driver_id = public.master_uuid_or_null(p.name)
    where btrim(p.name) <> '';
    if missing is not null then
      raise exception 'smart_driver_id_manual contains an unknown driver: %', missing;
    end if;
    return result;
  end if;

  select count(*) into name_count
  from regexp_split_to_table(coalesce(driver_names, ''), ',') as p(name)
  where btrim(p.name) <> '';
  if name_count <= 1 then return null; end if;

  select string_agg(d.driver_id::text, ',' order by p.ord) into result
  from regexp_split_to_table(driver_names, ',') with ordinality as p(name, ord)
  left join lateral (
    select md.driver_id from public.master_drivers md
    where lower(regexp_replace(btrim(md.roster->>'Driver'), '[[:space:]]+', ' ', 'g')) =
          lower(regexp_replace(btrim(p.name), '[[:space:]]+', ' ', 'g'))
    order by md.roster_source_row nulls last, md.driver_id
    limit 1
  ) d on true
  where btrim(p.name) <> '';
  return result;
end;
$$;
revoke all on function public.master_smart_driver_id(text, text) from public, anon, authenticated;
grant execute on function public.master_smart_driver_id(text, text) to service_role;

create function public.set_master_smart_driver_id()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.smart_driver_id := public.master_smart_driver_id(new.row_data->>'Driver', new.smart_driver_id_manual);
  return new;
end;
$$;
revoke all on function public.set_master_smart_driver_id() from public, anon, authenticated;
create trigger set_master_smart_driver_id
before insert or update on public.master_config_rules
for each row execute function public.set_master_smart_driver_id();

create or replace function public.sync_master_rule_smart_drivers()
returns trigger language plpgsql set search_path = '' as $$
begin
  delete from public.master_rule_smart_drivers where rule_id = new.id;
  insert into public.master_rule_smart_drivers (rule_id, driver_id)
  select distinct new.id, d.driver_id
  from regexp_split_to_table(coalesce(new.smart_driver_id, ''), ',') as ids(value)
  join public.master_drivers d on d.driver_id = public.master_uuid_or_null(ids.value);
  return new;
end;
$$;
drop trigger sync_master_rule_smart_drivers on public.master_config_rules;
create trigger sync_master_rule_smart_drivers
after insert or update of row_data, smart_driver_id_manual on public.master_config_rules
for each row execute function public.sync_master_rule_smart_drivers();

-- These 14 current weekday cells are literals, not Sheet formulas.
update public.master_config_rules
set smart_driver_id_manual = row_data->>'smart_driver_id'
where day_type = 'weekday' and source_row in
  (835, 836, 838, 1004, 1006, 1007, 1009, 1010, 1012, 1013, 1057, 1093, 1679, 1680);

-- Called only by the manual Sheet refresh after the Driver roster changes.
create function public.refresh_master_smart_driver_ids()
returns integer language plpgsql set search_path = '' as $$
declare changed integer;
begin
  update public.master_config_rules r set row_data = r.row_data
  where r.smart_driver_id is distinct from
    public.master_smart_driver_id(r.row_data->>'Driver', r.smart_driver_id_manual);
  get diagnostics changed = row_count;
  return changed;
end;
$$;
revoke all on function public.refresh_master_smart_driver_ids() from public, anon, authenticated;
grant execute on function public.refresh_master_smart_driver_ids() to service_role;
