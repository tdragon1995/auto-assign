-- Driver shift schedule + approved/pending leave, synced from MISA AMIS by the
-- misa-fetcher CI job (see misa-fetcher/ and .github/workflows/misa-shifts.yml).
-- The job replaces the current month wholesale on each run (delete + insert),
-- mirroring the "Driver Shift" Google Sheet tab.

create table if not exists public.driver_shifts (
  employee_code text        not null,
  full_name     text        not null,
  shift_date    date        not null,
  slot          smallint    not null default 1,  -- shift index within the day (multi-shift days)
  day_type      text        not null check (day_type in ('working', 'off', 'holiday')),
  start_time    text,                            -- "HH:MM" when working, else null
  end_time      text,
  holiday_name  text,                            -- e.g. "Nghỉ lễ" when day_type = 'holiday'
  leave_start   text,                            -- "HH:MM" leave window from MISA attendance
  leave_end     text,
  -- true when the person is inside an approved leave span on a day their roster
  -- says they work, but MISA deducted nothing (its company calendar called the
  -- day non-working). Without this they read as available. See findLeaveGaps.
  leave_gap     boolean     not null default false,
  synced_at     timestamptz not null default now(),
  primary key (employee_code, shift_date, slot)
);

create index if not exists driver_shifts_date_idx on public.driver_shifts (shift_date);

alter table public.driver_shifts enable row level security;

-- Reads are open (same visibility as the existing Google Sheet); writes only
-- via the service role, which bypasses RLS.
create policy "driver_shifts_read" on public.driver_shifts
  for select using (true);
