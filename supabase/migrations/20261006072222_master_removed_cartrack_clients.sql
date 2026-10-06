alter table public.master_clients add column cartrack_missing_at timestamptz;
create index master_clients_cartrack_missing_idx on public.master_clients(customer_id) where cartrack_missing_at is not null;

-- A complete source refresh flags omissions for review; it never deletes profiles.
create function public.master_mark_cartrack_missing(seen_ids uuid[]) returns void
language plpgsql security invoker set search_path='' as $$
begin
  if cardinality(seen_ids)<100 or array_position(seen_ids,null) is not null then raise exception 'Incomplete Cartrack list'; end if;
  update public.master_clients set cartrack_missing_at=now() where not(customer_id=any(seen_ids)) and cartrack_missing_at is null;
  update public.master_clients set cartrack_missing_at=null where customer_id=any(seen_ids) and cartrack_missing_at is not null;
end $$;

-- Check UUID foreign keys AND retained raw IDs in reports, setup and backups.
create function public.master_client_references(p_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare col record; n bigint; refs jsonb:='{}';
begin
  for col in select table_name,column_name,data_type from information_schema.columns c
    where c.table_schema='public' and c.column_name in ('customer_id','pickup_customer_id','dropoff_customer_id','alternate_dropoff_customer_id','default_dropoff_id','nearest_psc_id','start_customer_id','end_customer_id','start_location_customer_id','end_location_customer_id','pickup_id','dropoff_id','from_customer_id','to_customer_id','pick_id','drop_id')
      and not(c.table_name='master_clients' and c.column_name='customer_id')
      and exists(select 1 from information_schema.tables t where t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE')
  loop
    execute format('select count(*) from public.%I where %I=$1::%s',col.table_name,col.column_name,case when col.data_type='uuid' then 'uuid' else 'text' end) into n using p_id::text;
    if n>0 then refs:=refs||jsonb_build_object(col.table_name,coalesce((refs->>col.table_name)::bigint,0)+n); end if;
  end loop;
  select count(*) into n from public.master_record_changes where strpos(before_data::text,p_id::text)>0 or strpos(after_data::text,p_id::text)>0;
  if n>0 then refs:=refs||jsonb_build_object('master_record_changes',n); end if;
  return refs;
end $$;

create function public.master_drop_removed_client(p_id uuid,expected_missing_at timestamptz) returns void
language plpgsql security invoker set search_path='' as $$
declare tbl record; actual timestamptz; refs jsonb;
begin
  -- Serialize against source reappearance and reference creation before checking.
  for tbl in select distinct c.table_name from information_schema.columns c
    where c.table_schema='public' and c.column_name in ('customer_id','pickup_customer_id','dropoff_customer_id','alternate_dropoff_customer_id','default_dropoff_id','nearest_psc_id','start_customer_id','end_customer_id','start_location_customer_id','end_location_customer_id','pickup_id','dropoff_id','from_customer_id','to_customer_id','pick_id','drop_id','before_data','after_data')
      and exists(select 1 from information_schema.tables t where t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE') order by c.table_name
  loop execute format('lock table public.%I in share mode',tbl.table_name); end loop;
  select cartrack_missing_at into actual from public.master_clients where customer_id=p_id for update;
  if actual is null or actual is distinct from expected_missing_at then raise exception 'Danh sách đã thay đổi; tải lại trước khi xoá'; end if;
  refs:=public.master_client_references(p_id);
  if refs<>'{}'::jsonb then raise exception 'Không thể xoá: còn tham chiếu %',refs; end if;
  delete from public.master_clients where customer_id=p_id;
end $$;
revoke all on function public.master_mark_cartrack_missing(uuid[]),public.master_client_references(uuid),public.master_drop_removed_client(uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.master_mark_cartrack_missing(uuid[]),public.master_client_references(uuid),public.master_drop_removed_client(uuid,timestamptz) to service_role;
