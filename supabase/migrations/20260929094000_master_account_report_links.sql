-- Verified ownership is shared by account; locations remain separate.
create function public.master_sync_accounts(accounts jsonb) returns void
language plpgsql set search_path='' as $$
declare item jsonb; account_uuid uuid;
begin
  if jsonb_typeof(accounts) is distinct from 'array' then raise exception 'Invalid accounts'; end if;
  for item in select * from jsonb_array_elements(accounts) loop
    if not coalesce(item->>'client_code' ~ '^[0-9]+$',false) or item->>'verified_at' is null then raise exception 'Unverified account code'; end if;
    insert into public.master_accounts(client_code,sales_name,sales_email,supervisor_name,supervisor_email,verified_at)
    values(item->>'client_code',item->>'sales_name',item->>'sales_email',item->>'supervisor_name',item->>'supervisor_email',(item->>'verified_at')::timestamptz)
    on conflict(client_code) do update set sales_name=excluded.sales_name,sales_email=excluded.sales_email,
      supervisor_name=excluded.supervisor_name,supervisor_email=excluded.supervisor_email,verified_at=excluded.verified_at,updated_at=now()
    returning id into account_uuid;
    update public.master_clients set account_id=account_uuid where client_code=item->>'client_code' and account_id is distinct from account_uuid;
  end loop;
end $$;
revoke all on function public.master_sync_accounts(jsonb) from public,anon,authenticated;
grant execute on function public.master_sync_accounts(jsonb) to service_role;
-- Reuse only consistent, previously fetched Sapoche ownership, never name-derived codes alone.
select public.master_sync_accounts(coalesce(jsonb_agg(x),'[]')) from (
  select client_code,min(sales_name) sales_name,min(sales_email) sales_email,
    min(supervisor_name) supervisor_name,min(supervisor_email) supervisor_email,min(synced_at) verified_at
  from public.master_clients where client_code ~ '^[0-9]+$' and sales_email is not null
  group by client_code having count(distinct jsonb_build_array(sales_name,sales_email,supervisor_name,supervisor_email))=1
) x;

-- Historical raw IDs and names are unchanged; only verified UUID relationships are added.
create function public.master_link_report() returns trigger language plpgsql set search_path='' as $$
declare value uuid; linked uuid; i integer; data jsonb:=to_jsonb(new);
begin
  for i in 0..tg_nargs/3-1 loop
    value:=public.master_uuid_or_null(data->>tg_argv[i*3]);
    if tg_argv[i*3+2]='driver' then
      select driver_id into linked from public.master_drivers where driver_id=value;
    else
      select customer_id into linked from public.master_clients where customer_id=value;
    end if;
    data:=data||jsonb_build_object(tg_argv[i*3+1],linked);
  end loop;
  new:=jsonb_populate_record(new,data);
  return new;
end $$;
revoke all on function public.master_link_report() from public,anon,authenticated;
alter table public.pay_jobs add column master_driver_id uuid references public.master_drivers(driver_id);
create index pay_jobs_master_driver_id_idx on public.pay_jobs(master_driver_id);
update public.pay_jobs t set master_driver_id=r.driver_id from public.master_drivers r where public.master_uuid_or_null(t.driver_id::text)=r.driver_id;
alter table public.pay_jobs add column master_pickup_id uuid references public.master_clients(customer_id);
create index pay_jobs_master_pickup_id_idx on public.pay_jobs(master_pickup_id);
update public.pay_jobs t set master_pickup_id=r.customer_id from public.master_clients r where public.master_uuid_or_null(t.pickup_customer_id::text)=r.customer_id;
alter table public.pay_jobs add column master_dropoff_id uuid references public.master_clients(customer_id);
create index pay_jobs_master_dropoff_id_idx on public.pay_jobs(master_dropoff_id);
update public.pay_jobs t set master_dropoff_id=r.customer_id from public.master_clients r where public.master_uuid_or_null(t.dropoff_customer_id::text)=r.customer_id;
create trigger master_link_pay_jobs before insert or update of driver_id,pickup_customer_id,dropoff_customer_id on public.pay_jobs for each row execute function public.master_link_report('driver_id','master_driver_id','driver','pickup_customer_id','master_pickup_id','client','dropoff_customer_id','master_dropoff_id','client');
alter table public.pay_punches add column master_driver_id uuid references public.master_drivers(driver_id);
create index pay_punches_master_driver_id_idx on public.pay_punches(master_driver_id);
update public.pay_punches t set master_driver_id=r.driver_id from public.master_drivers r where public.master_uuid_or_null(t.driver_id::text)=r.driver_id;
alter table public.pay_punches add column master_customer_id uuid references public.master_clients(customer_id);
create index pay_punches_master_customer_id_idx on public.pay_punches(master_customer_id);
update public.pay_punches t set master_customer_id=r.customer_id from public.master_clients r where public.master_uuid_or_null(t.customer_id::text)=r.customer_id;
create trigger master_link_pay_punches before insert or update of driver_id,customer_id on public.pay_punches for each row execute function public.master_link_report('driver_id','master_driver_id','driver','customer_id','master_customer_id','client');
alter table public.pay_shifts add column master_driver_id uuid references public.master_drivers(driver_id);
create index pay_shifts_master_driver_id_idx on public.pay_shifts(master_driver_id);
update public.pay_shifts t set master_driver_id=r.driver_id from public.master_drivers r where public.master_uuid_or_null(t.driver_id::text)=r.driver_id;
create trigger master_link_pay_shifts before insert or update of driver_id on public.pay_shifts for each row execute function public.master_link_report('driver_id','master_driver_id','driver');
alter table public.pickup_eta add column master_pickup_id uuid references public.master_clients(customer_id);
create index pickup_eta_master_pickup_id_idx on public.pickup_eta(master_pickup_id);
update public.pickup_eta t set master_pickup_id=r.customer_id from public.master_clients r where public.master_uuid_or_null(t.pickup_customer_id::text)=r.customer_id;
create trigger master_link_pickup_eta before insert or update of pickup_customer_id on public.pickup_eta for each row execute function public.master_link_report('pickup_customer_id','master_pickup_id','client');
alter table public.tat_legs add column master_driver_id uuid references public.master_drivers(driver_id);
create index tat_legs_master_driver_id_idx on public.tat_legs(master_driver_id);
update public.tat_legs t set master_driver_id=r.driver_id from public.master_drivers r where public.master_uuid_or_null(t.driver_id::text)=r.driver_id;
alter table public.tat_legs add column master_from_id uuid references public.master_clients(customer_id);
create index tat_legs_master_from_id_idx on public.tat_legs(master_from_id);
update public.tat_legs t set master_from_id=r.customer_id from public.master_clients r where public.master_uuid_or_null(t.from_customer_id::text)=r.customer_id;
alter table public.tat_legs add column master_to_id uuid references public.master_clients(customer_id);
create index tat_legs_master_to_id_idx on public.tat_legs(master_to_id);
update public.tat_legs t set master_to_id=r.customer_id from public.master_clients r where public.master_uuid_or_null(t.to_customer_id::text)=r.customer_id;
create trigger master_link_tat_legs before insert or update of driver_id,from_customer_id,to_customer_id on public.tat_legs for each row execute function public.master_link_report('driver_id','master_driver_id','driver','from_customer_id','master_from_id','client','to_customer_id','master_to_id','client');
