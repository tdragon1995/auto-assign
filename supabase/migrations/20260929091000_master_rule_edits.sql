create table public.master_record_changes (
  id bigint generated always as identity primary key,
  rule_id bigint references public.master_config_rules(id),
  leave_id bigint references public.master_leave_rows(id),
  changed_at timestamptz not null default now(),
  before_data jsonb, after_data jsonb
);
alter table public.master_record_changes enable row level security;
revoke all on public.master_record_changes from anon,authenticated;
create index master_record_changes_rule_idx on public.master_record_changes(rule_id);
create index master_record_changes_leave_idx on public.master_record_changes(leave_id);

create function public.master_write_rules(changes jsonb) returns jsonb
language plpgsql set search_path = '' as $$
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
        insert into public.master_config_rules(day_type,source_row,row_data,assignment_mode,pickup_customer_id,
          dropoff_customer_id,alternate_dropoff_customer_id,shift_start,shift_end)
        values('weekday',next_source,coalesce(item->'row_data','{}'),item->>'assignment_mode',(item->>'pickup_customer_id')::uuid,
          (item->>'dropoff_customer_id')::uuid,(item->>'alternate_dropoff_customer_id')::uuid,
          (item->>'shift_start')::time,(item->>'shift_end')::time) returning * into after_row;
      else
        update public.master_config_rules set
          row_data=before_row.row_data || coalesce(item->'row_data','{}'),assignment_mode=item->>'assignment_mode',
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
      -- Compatibility only, derived from explicit mode and selected UUID links.
      update public.master_config_rules set
        fixed_driver_id=case when assignment_mode='fixed' then (selected->>0)::uuid end,
        smart_driver_id=case when assignment_mode='smart' then (select string_agg(value,',' order by ordinality) from jsonb_array_elements_text(selected) with ordinality) end,
        smart_driver_id_manual=null where id=after_row.id returning * into after_row;
    end if;
    insert into public.master_record_changes(rule_id,before_data,after_data)
    values(after_row.id,
      case when before_row.id is not null then (to_jsonb(before_row)-'row_data') || jsonb_build_object('driver_ids',before_ids) end,
      (to_jsonb(after_row)-'row_data') || jsonb_build_object('driver_ids',selected));
    result:=result || jsonb_build_array(jsonb_build_object('id',after_row.id,'revision',after_row.revision,'source_row',after_row.source_row));
  end loop;
  return result;
end $$;
revoke all on function public.master_write_rules(jsonb) from public,anon,authenticated;
grant execute on function public.master_write_rules(jsonb) to service_role;
