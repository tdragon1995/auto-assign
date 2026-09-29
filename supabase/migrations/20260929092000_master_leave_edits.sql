create function public.master_write_leave(changes jsonb) returns jsonb
language plpgsql set search_path = '' as $$
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
        insert into public.master_leave_rows(source_row,row_data,linked_driver_id,starts_on,ends_on,starts_at,ends_at)
        values(next_source,item->'row_data',(item->>'linked_driver_id')::uuid,(item->>'starts_on')::date,
          (item->>'ends_on')::date,(item->>'starts_at')::time,(item->>'ends_at')::time) returning * into after_row;
      else
        update public.master_leave_rows set row_data=item->'row_data',linked_driver_id=(item->>'linked_driver_id')::uuid,
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
      update public.master_leave_rows set linked_sub1_driver_id=(item->'substitutes'->0->>'driver_id')::uuid
        where id=after_row.id returning * into after_row;
    end if;
    select coalesce(jsonb_agg(to_jsonb(s)-'leave_id' order by selection_order),'[]') into after_subs
      from public.master_leave_substitutes s where leave_id=after_row.id;
    insert into public.master_record_changes(leave_id,before_data,after_data)
    values(after_row.id,(to_jsonb(before_row)-'row_data')||jsonb_build_object('substitutes',before_subs),(to_jsonb(after_row)-'row_data')||jsonb_build_object('substitutes',after_subs));
    result:=result||jsonb_build_array(jsonb_build_object('id',after_row.id,'revision',after_row.revision));
  end loop;
  return result;
end $$;
revoke all on function public.master_write_leave(jsonb) from public,anon,authenticated;
grant execute on function public.master_write_leave(jsonb) to service_role;
