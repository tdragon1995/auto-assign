-- Expose the IDs already stored in Sheet-shaped JSON as real Supabase relations.
-- Malformed legacy values remain in row_data and appear as NULL in these columns.
create or replace function public.master_uuid_or_null(value text)
returns uuid language sql immutable strict parallel safe
set search_path = ''
as $$
  select case when btrim(value) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then btrim(value)::uuid else null end
$$;

alter table public.master_clients
  add constraint master_clients_default_dropoff_fkey foreign key (default_dropoff_id) references public.master_clients (customer_id),
  add constraint master_clients_nearest_psc_fkey foreign key (nearest_psc_id) references public.master_clients (customer_id);

alter table public.master_config_rules
  add column pickup_customer_id uuid generated always as (public.master_uuid_or_null(row_data->>'customer_id')) stored,
  add column dropoff_customer_id uuid generated always as (public.master_uuid_or_null(row_data->>'dropoff_id')) stored,
  add column alternate_dropoff_customer_id uuid generated always as (public.master_uuid_or_null(row_data->>'alt_drop_off_id')) stored,
  add column fixed_driver_id uuid generated always as (public.master_uuid_or_null(row_data->>'driver_id')) stored,
  add constraint master_rules_pickup_fkey foreign key (pickup_customer_id) references public.master_clients (customer_id),
  add constraint master_rules_dropoff_fkey foreign key (dropoff_customer_id) references public.master_clients (customer_id),
  add constraint master_rules_alt_dropoff_fkey foreign key (alternate_dropoff_customer_id) references public.master_clients (customer_id),
  add constraint master_rules_fixed_driver_fkey foreign key (fixed_driver_id) references public.master_drivers (driver_id);

alter table public.master_drivers
  add column start_customer_id uuid generated always as (public.master_uuid_or_null(cartrack->>'start_location_customer_id')) stored,
  add column end_customer_id uuid generated always as (public.master_uuid_or_null(cartrack->>'end_location_customer_id')) stored,
  add constraint master_drivers_start_fkey foreign key (start_customer_id) references public.master_clients (customer_id),
  add constraint master_drivers_end_fkey foreign key (end_customer_id) references public.master_clients (customer_id);

-- Smart assignment can list several drivers, so those IDs need a bridge table.
create table public.master_rule_smart_drivers (
  rule_id bigint not null references public.master_config_rules (id) on delete cascade,
  driver_id uuid not null references public.master_drivers (driver_id),
  primary key (rule_id, driver_id)
);
create index master_rule_smart_drivers_driver_idx on public.master_rule_smart_drivers (driver_id);
alter table public.master_rule_smart_drivers enable row level security;

create function public.sync_master_rule_smart_drivers()
returns trigger language plpgsql set search_path = ''
as $$
begin
  delete from public.master_rule_smart_drivers where rule_id = new.id;
  insert into public.master_rule_smart_drivers (rule_id, driver_id)
  select distinct new.id, d.driver_id
  from regexp_split_to_table(coalesce(new.row_data->>'smart_driver_id', ''), ',') as ids(value)
  join public.master_drivers d on d.driver_id = public.master_uuid_or_null(ids.value);
  return new;
end;
$$;

create trigger sync_master_rule_smart_drivers
after insert or update of row_data on public.master_config_rules
for each row execute function public.sync_master_rule_smart_drivers();

insert into public.master_rule_smart_drivers (rule_id, driver_id)
select distinct r.id, d.driver_id
from public.master_config_rules r
cross join lateral regexp_split_to_table(coalesce(r.row_data->>'smart_driver_id', ''), ',') as ids(value)
join public.master_drivers d on d.driver_id = public.master_uuid_or_null(ids.value);
