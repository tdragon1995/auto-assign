-- Save one clinic's Sunday rules as a whole: pickup + hours + area(s), never a
-- driver (who drives an area is the weekly roster, master_sunday_roster).
--
-- The editor shows a clinic's whole Sunday, so a save replaces it: the old
-- rules are switched off (kept, with their history) and the new ones inserted.
-- expected is the version check, [[id, revision], ...] as loaded; if the
-- clinic's active Sunday rules are not exactly those, someone else saved in
-- between and this refuses.
--
-- Every rule must name an area: a Sunday rule with no area is the old sheet's
-- #N/A row, which assigned nobody and said nothing.
create function public.master_write_sunday_rules(pickup uuid, expected jsonb, rules jsonb)
returns integer language plpgsql security invoker set search_path='' as $$
declare cur jsonb; item jsonb; old_row public.master_config_rules; new_row public.master_config_rules;
  next_source integer; n integer := 0;
begin
  -- The same lock as master_write_rules: both hand out source_row numbers.
  perform pg_advisory_xact_lock(873652901);
  if pickup is null then raise exception 'Pickup ID required'; end if;
  if jsonb_typeof(rules) is distinct from 'array' or jsonb_array_length(rules) > 50 then raise exception 'Invalid Sunday rules'; end if;
  if jsonb_typeof(expected) is distinct from 'array' then raise exception 'Invalid version'; end if;
  select coalesce(jsonb_agg(jsonb_build_array(r.id, r.revision) order by r.id), '[]') into cur
    from public.master_config_rules r where r.day_type = 'sunday' and r.active and r.pickup_customer_id = pickup;
  if cur is distinct from (select coalesce(jsonb_agg(jsonb_build_array((e->>0)::bigint, (e->>1)::bigint) order by (e->>0)::bigint), '[]')
                             from jsonb_array_elements(expected) e) then
    raise exception 'Sunday rules changed since they were loaded';
  end if;
  for old_row in select * from public.master_config_rules r where r.day_type = 'sunday' and r.active and r.pickup_customer_id = pickup loop
    update public.master_config_rules set active = false, revision = revision + 1, updated_at = now()
      where id = old_row.id returning * into new_row;
    insert into public.master_record_changes(rule_id, before_data, after_data) values (old_row.id, to_jsonb(old_row), to_jsonb(new_row));
  end loop;
  select coalesce(max(source_row), 1) into next_source from public.master_config_rules where day_type = 'sunday';
  for item in select * from jsonb_array_elements(rules) loop
    if (item->>'shift_start') is null or (item->>'shift_end') is null or (item->>'shift_start')::time = (item->>'shift_end')::time then
      raise exception 'Invalid shift';
    end if;
    if jsonb_typeof(item->'areas') is distinct from 'array' or jsonb_array_length(item->'areas') = 0 or jsonb_array_length(item->'areas') > 10
       or exists (select 1 from jsonb_array_elements_text(item->'areas') a where btrim(a) = '') then
      raise exception 'Sunday rule needs an area';
    end if;
    next_source := next_source + 1;
    insert into public.master_config_rules(day_type, source_row, assignment_mode, pickup_customer_id, alternate_dropoff_customer_id, shift_start, shift_end, areas)
    values ('sunday', next_source, 'fixed', pickup, nullif(item->>'alt_drop_off_id', '')::uuid,
            (item->>'shift_start')::time, (item->>'shift_end')::time,
            array(select btrim(a) from jsonb_array_elements_text(item->'areas') a))
    returning * into new_row;
    insert into public.master_record_changes(rule_id, before_data, after_data) values (new_row.id, null, to_jsonb(new_row));
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.master_write_sunday_rules(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.master_write_sunday_rules(uuid, jsonb, jsonb) to service_role;
