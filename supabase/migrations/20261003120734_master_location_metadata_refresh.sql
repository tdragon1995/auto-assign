-- Patch only Labcenter-owned columns; never INSERT incomplete Cartrack profiles.
create function public.master_refresh_metadata(updates jsonb, accounts jsonb default '[]') returns void
language plpgsql security invoker set search_path='' as $$
begin
  if jsonb_typeof(updates) is distinct from 'array' or jsonb_array_length(updates)>5000 then raise exception 'Invalid metadata updates'; end if;
  if exists (
    select 1 from jsonb_array_elements(updates) u
    cross join lateral jsonb_object_keys(u) k
    where k not in ('customer_id','labcenter_location_id','default_dropoff_id','default_dropoff_name','eta_minutes','sales_name','sales_email','supervisor_name','supervisor_email')
  ) then raise exception 'Unexpected metadata field'; end if;
  if exists (select 1 from jsonb_array_elements(updates) u group by u->>'customer_id' having count(*)>1)
    then raise exception 'Duplicate metadata identity'; end if;
  if exists (
    select 1 from jsonb_array_elements(updates) u
    left join public.master_clients c on c.customer_id=(u->>'customer_id')::uuid
    where c.customer_id is null
  ) then raise exception 'Unknown metadata identity'; end if;
  perform public.master_sync_accounts(accounts);
  update public.master_clients c set
    labcenter_location_id=case when u.item ? 'labcenter_location_id' then (u.item->>'labcenter_location_id')::integer else c.labcenter_location_id end,
    default_dropoff_id=case when u.item ? 'default_dropoff_id' then (u.item->>'default_dropoff_id')::uuid else c.default_dropoff_id end,
    default_dropoff_name=case when u.item ? 'default_dropoff_name' then u.item->>'default_dropoff_name' else c.default_dropoff_name end,
    eta_minutes=case when u.item ? 'eta_minutes' then (u.item->>'eta_minutes')::integer else c.eta_minutes end,
    sales_name=case when u.item ? 'sales_name' then u.item->>'sales_name' else c.sales_name end,
    sales_email=case when u.item ? 'sales_email' then u.item->>'sales_email' else c.sales_email end,
    supervisor_name=case when u.item ? 'supervisor_name' then u.item->>'supervisor_name' else c.supervisor_name end,
    supervisor_email=case when u.item ? 'supervisor_email' then u.item->>'supervisor_email' else c.supervisor_email end
  from jsonb_array_elements(updates) u(item)
  where c.customer_id=(u.item->>'customer_id')::uuid;
end $$;
revoke all on function public.master_refresh_metadata(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.master_refresh_metadata(jsonb,jsonb) to service_role;
