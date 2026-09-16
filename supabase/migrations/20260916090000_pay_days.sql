-- One row per day whose payroll records were written successfully.
--
-- pay_jobs / pay_punches alone cannot tell "a day with nothing to pay" from "a
-- day that was never archived" — both are zero rows. The pay archive shipped on
-- 2026-08-30 and nothing backfilled the days before it, so the September period
-- (15/08–14/09) read as complete while two thirds of it was simply absent. This
-- row is written only AFTER a day's rows land, and Tính lương counts a period day
-- without one as missing coverage.
create table if not exists public.pay_days (
  trip_date    date        primary key,
  jobs         integer     not null,
  punches      integer     not null,
  unpriced     integer     not null,
  source       text        not null,           -- 'archive' | 'reconcile'
  archived_at  timestamptz not null default now()
);

alter table public.pay_days enable row level security;
