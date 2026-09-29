-- Present in 35 Cartrack driver records; expose it alongside the other profile fields.
alter table public.master_drivers
  add column last_online_ts text generated always as (cartrack ->> 'last_online_ts') stored;
