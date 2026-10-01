-- Status follows the Cartrack marker, including existing {inactive} prefixes.
alter table public.master_clients add column if not exists is_active boolean
  generated always as (coalesce((cartrack->>'customer_name') !~* '\{(inactive|inacttiv)\}',true)) stored;
create index if not exists master_clients_inactive_idx on public.master_clients(customer_id) where is_active=false;
