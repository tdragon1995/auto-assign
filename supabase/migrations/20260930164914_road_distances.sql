-- Durable copy of dist:v1:* values; retain the existing key and full precision.
create table public.road_distances (
  key text primary key check (key like 'dist:v1:%'),
  value jsonb not null check (
    jsonb_typeof(value) = 'object'
    and value ?& array['distance_km', 'eta_mins', 'from', 'to']
    and jsonb_typeof(value->'distance_km') = 'number'
    and jsonb_typeof(value->'eta_mins') = 'number'
    and jsonb_typeof(value->'from') = 'object'
    and jsonb_typeof(value->'to') = 'object'
  ),
  created_at timestamptz not null default now()
);
alter table public.road_distances enable row level security;
revoke all on public.road_distances from public, anon, authenticated;
grant select, insert, update on public.road_distances to service_role;
