-- Apply to the TAT/payroll project (odbmfkzkipklepmghjwj), not the legacy config project.
create table if not exists public.master_clients (
  customer_id uuid primary key,
  cartrack jsonb not null,
  client_code text,
  new_ward text,
  nearest_psc_id uuid,
  nearest_psc_name text,
  nearest_psc_km double precision,
  labcenter_location_id bigint,
  default_dropoff_id uuid,
  default_dropoff_name text,
  eta_minutes integer,
  sales_name text,
  sales_email text,
  supervisor_name text,
  supervisor_email text,
  synced_at timestamptz not null default now()
);
create index if not exists master_clients_code_idx on public.master_clients (client_code);

create table if not exists public.master_drivers (
  driver_id uuid primary key,
  cartrack jsonb not null,
  driver_zalo_id text,
  bot_token text,
  phone_number_update text,
  synced_at timestamptz not null default now()
);

-- A stable surrogate key lets rules be edited without a Google Sheet row number.
create table if not exists public.master_config_rules (
  id bigint generated always as identity primary key,
  day_type text not null check (day_type in ('weekday', 'sunday')),
  source_row integer,
  row_data jsonb not null,
  updated_at timestamptz not null default now(),
  unique (day_type, source_row)
);
create index if not exists master_config_rules_day_idx on public.master_config_rules (day_type, id);

alter table public.master_clients enable row level security;
alter table public.master_drivers enable row level security;
alter table public.master_config_rules enable row level security;
