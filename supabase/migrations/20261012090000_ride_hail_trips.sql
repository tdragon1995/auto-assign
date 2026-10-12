-- =============================================================================
-- Trips sent by Grab / Be / Xanh SM instead of a Diag driver.
--
-- One row per Cartrack job, written from "Điều chỉnh job" when an admin sends the
-- trip by a ride-hail app. The amount is what the company paid and is editable
-- afterwards (the app's final fare often differs from the quote). completed_at is
-- set only once Cartrack accepted the completion, so a row without it is a send
-- whose completion failed and was not retried.
-- =============================================================================

create table if not exists public.ride_hail_trips (
  job_id        bigint primary key,
  provider      text not null check (provider in ('Grab','Be','Xanh SM','Ahamove','Khác')),
  amount_vnd    integer not null check (amount_vnd > 0),
  waybill       text not null check (length(trim(waybill)) > 0),
  admin_name    text not null,
  pickup_name   text,
  dropoff_name  text,
  trip_date     date not null default (now() at time zone 'Asia/Ho_Chi_Minh')::date,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists ride_hail_trips_trip_date on public.ride_hail_trips (trip_date);

-- Server-only (service role); no policies means no anon/authenticated access.
alter table public.ride_hail_trips enable row level security;
