-- =============================================================================
-- What the morning Labcenter check found, kept so the dashboard can show it.
--
-- The morning sync used to count its issues and throw the list away; only a
-- manual "Đồng Bộ Thông Tin → Labcenter" ever showed one. Each morning run
-- clears the previous run's rows when it starts and appends one batch at a time.
-- =============================================================================

create table if not exists public.master_sync_issues (
  id           bigserial primary key,
  run_id       bigint not null,
  client_code  text not null,
  customer_id  text not null,
  name         text not null,
  kind         text not null,
  detail       text not null,
  created_at   timestamptz not null default now()
);

-- Server-only (service role); no policies means no anon/authenticated access.
alter table public.master_sync_issues enable row level security;
