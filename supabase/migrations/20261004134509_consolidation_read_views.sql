create or replace view public.master_rules_read with(security_invoker=true) as
select r.id,r.day_type,r.source_row,r.updated_at,r.pickup_customer_id,r.dropoff_customer_id,r.alternate_dropoff_customer_id,r.shift_start,r.shift_end,r.source_uid,r.assignment_mode,r.active,r.revision,r.review_issues, r.row_data as row_data,
coalesce((select jsonb_agg(jsonb_build_object('driver_id',d.driver_id,'selection_order',d.selection_order) order by d.selection_order) from public.master_rule_drivers d where d.rule_id=r.id),'[]'::jsonb) as master_rule_drivers
from public.master_config_rules r;
revoke all on public.master_rules_read from public,anon,authenticated;
grant select on public.master_rules_read to service_role;
create or replace view public.master_leave_read with(security_invoker=true) as
select l.source_row,l.linked_driver_id,l.synced_at,l.id,l.source_uid,l.active,l.revision,l.starts_on,l.ends_on,l.starts_at,l.ends_at,l.review_issues, l.row_data as row_data,
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
alter table public.pickup_setup_changes drop constraint pickup_setup_changes_kind_check;
alter table public.pickup_setup_changes add constraint pickup_setup_changes_kind_check check(kind in ('approve_eta','repush','accept_lc','client_edit','reconcile_lc'));
create or replace function public.commit_pickup_setup(item jsonb, expected jsonb)
returns void language plpgsql set search_path='' as $$
declare previous public.pickup_setup; location_id integer:=(item->>'lc_location_id')::integer;
begin
 perform pg_advisory_xact_lock(873652902,location_id);
 select * into previous from public.pickup_setup where lc_location_id=location_id for update;
 if (case when previous.lc_location_id is null then null else jsonb_build_object('drop_location_id',previous.drop_location_id,'eta_mins',previous.eta_mins,'drop_id',previous.drop_id,'pick_id',previous.pick_id) end) is distinct from expected then
   raise exception 'Pickup setup changed; refresh before approving';
 end if;
 if location_id is null or item->>'drop_location_id' is null or item->>'eta_mins' is null or location_id<=0 or (item->>'drop_location_id')::integer<=0 or (item->>'eta_mins')::integer not between 0 and 1440 or item->>'kind' not in ('accept_lc','approve_eta','repush','client_edit','reconcile_lc') or item->>'kind' is null then raise exception 'Invalid pickup setup'; end if;
 if item->>'pick_id' is not null and not exists(select 1 from public.master_clients where customer_id=(item->>'pick_id')::uuid) then raise exception 'Unknown pickup'; end if;
 if item->>'drop_id' is not null and not exists(select 1 from public.master_clients where customer_id=(item->>'drop_id')::uuid) then raise exception 'Unknown dropoff'; end if;
 insert into public.pickup_setup(lc_location_id,pick_id,pick_name,drop_location_id,drop_id,drop_name,eta_mins,updated_at,updated_reason)
 values(location_id,item->>'pick_id',item->>'pick_name',(item->>'drop_location_id')::integer,item->>'drop_id',item->>'drop_name',(item->>'eta_mins')::integer,now(),item->>'kind')
 on conflict(lc_location_id) do update set pick_id=excluded.pick_id,pick_name=excluded.pick_name,drop_location_id=excluded.drop_location_id,
 drop_id=excluded.drop_id,drop_name=excluded.drop_name,eta_mins=excluded.eta_mins,updated_at=excluded.updated_at,updated_reason=excluded.updated_reason;
 update public.master_clients set default_dropoff_id=null,eta_minutes=null where labcenter_location_id=location_id;
 insert into public.pickup_setup_changes(lc_location_id,kind,old_drop_location_id,new_drop_location_id,old_eta,new_eta,basis_mins,n)
 values(location_id,item->>'kind',previous.drop_location_id,(item->>'drop_location_id')::integer,previous.eta_mins,(item->>'eta_mins')::integer,(item->>'basis_mins')::numeric,(item->>'n')::integer);
end $$;
revoke all on function public.commit_pickup_setup(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.commit_pickup_setup(jsonb,jsonb) to service_role;
notify pgrst,'reload schema';
