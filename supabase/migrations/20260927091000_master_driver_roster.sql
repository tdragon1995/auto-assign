alter table public.master_drivers add column if not exists roster jsonb not null default '{}'::jsonb;
