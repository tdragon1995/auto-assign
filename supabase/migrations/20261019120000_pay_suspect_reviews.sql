-- Lương PT "Nghi vấn": the supervisor's ruling on each listed day (2026-10-19).
--  * ok  — checked, paid as the rule computed.
--  * cut — paid in_time–out_time instead; written with a supervisor correction in
--          pay_day_corrections carrying the same decided_at, which is what pays it.
-- A ruled day leaves the open count; deleting the row (and withdrawing that
-- correction) puts it back.
create table if not exists public.pay_suspect_reviews (
  driver_id  uuid        not null,
  trip_date  date        not null,
  verdict    text        not null check (verdict in ('ok','cut')),
  in_time    time,
  out_time   time,
  note       text        not null default '',
  decided_at timestamptz not null default now(),
  primary key (driver_id, trip_date),
  check (verdict = 'ok' or (in_time is not null and out_time is not null and out_time > in_time))
);
alter table public.pay_suspect_reviews enable row level security;
