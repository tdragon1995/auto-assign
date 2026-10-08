-- =============================================================================
-- Part-time hours: payroll's shifts live in Lịch ca, and a day can be corrected.
--
-- 1. SHIFTS. Pay reads its shift from driver_shifts (Lịch ca tài xế) — one shift
--    source for dispatch and pay. Lịch ca matched payroll's own shifts on only half
--    the days of 1–14/09 (2026-10-08), so payroll's monthly records file is written
--    INTO it for the days payroll paid, as source 'payroll'. Those rows survive the
--    MISA refresh exactly as 'manual' rows do; nothing else about the refresh changes.
--
-- 2. CORRECTIONS ("Cập nhật công"). A driver asks, a supervisor approves; or a
--    supervisor corrects directly. An APPROVED correction is the day's worked window
--    and replaces the computed one. Nothing derived is stored — the hours are still
--    computed on read (pay.ts/workedMinutes).
-- =============================================================================

-- The temporary pay-only shift table from 2026-09-22 never held a row.
drop table if exists public.pay_shifts;

-- v_pay_daily: first pickup / last dropoff of the day (same VN date only — a job
-- finished the next morning must not stretch this day's shift overnight). Appended
-- last: create or replace view may only add columns at the end.
create or replace view public.v_pay_daily
with (security_invoker = on) as
select
  driver_id,
  trip_date,
  max(driver_name)                                       as driver_name,
  count(*)                                               as jobs_total,
  count(*) filter (where distance_km is not null)        as jobs_priced,
  round(coalesce(sum(distance_km), 0)::numeric, 2)       as total_km,
  min(pickup_completed_ts) filter (where (pickup_completed_ts at time zone 'Asia/Ho_Chi_Minh')::date = trip_date)   as first_pickup_ts,
  max(dropoff_completed_ts) filter (where (dropoff_completed_ts at time zone 'Asia/Ho_Chi_Minh')::date = trip_date) as last_dropoff_ts
from public.pay_jobs
group by driver_id, trip_date;

-- ── 1. The MISA refresh leaves 'payroll' rows alone, as it does 'manual' ones ──
-- Identical to 20261007063500 except the two source tests.
create or replace function public.replace_driver_shifts(p_from date,p_to date,rows jsonb) returns integer
language plpgsql security invoker set search_path='' as $$
declare written integer;
begin
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>400 or jsonb_typeof(rows) is distinct from 'array' or jsonb_array_length(rows)=0 then raise exception 'Invalid or empty shift replacement'; end if;
 if exists(select 1 from jsonb_to_recordset(rows) as r(shift_date date) where shift_date is null or shift_date<p_from or shift_date>p_to) then raise exception 'Shift date outside sync range'; end if;
 lock table public.driver_shifts in share row exclusive mode;
 delete from public.driver_shifts s where shift_date between greatest(p_from,public.cartrack_history_cutoff()) and p_to and source not in ('manual','payroll') and not exists(select 1 from jsonb_to_recordset(rows) as r(employee_code text,shift_date date,slot smallint) where r.employee_code=s.employee_code and r.shift_date=s.shift_date and coalesce(r.slot,1)=s.slot);
 insert into public.driver_shifts(employee_code,full_name,shift_date,slot,day_type,start_time,end_time,holiday_name,leave_start,leave_end,leave_gap,driver_id,source,raw_source)
 select r.employee_code,r.full_name,r.shift_date,coalesce(r.slot,1),r.day_type,r.start_time,r.end_time,r.holiday_name,r.leave_start,r.leave_end,coalesce(r.leave_gap,false),
 coalesce(r.driver_id,(select case when count(*)=1 then (array_agg(d.driver_id))[1] end from public.master_drivers d where d.roster->>'employee_code'=r.employee_code)),coalesce(r.source,'MISA'),r.raw_source
 from jsonb_to_recordset(rows) as r(employee_code text,full_name text,shift_date date,slot smallint,day_type text,start_time text,end_time text,holiday_name text,leave_start text,leave_end text,leave_gap boolean,driver_id uuid,source text,raw_source jsonb)
 where r.shift_date>=public.cartrack_history_cutoff()
 on conflict(employee_code,shift_date,slot) do update set
 full_name=excluded.full_name,day_type=excluded.day_type,start_time=excluded.start_time,end_time=excluded.end_time,
 holiday_name=excluded.holiday_name,leave_start=excluded.leave_start,leave_end=excluded.leave_end,leave_gap=excluded.leave_gap,
 driver_id=excluded.driver_id,source=excluded.source,raw_source=excluded.raw_source,synced_at=now(),revision=public.driver_shifts.revision+1
 where public.driver_shifts.source not in ('manual','payroll');
 get diagnostics written=row_count;
 return written;
end $$;

-- ── Payroll's file → Lịch ca ──────────────────────────────────────────────────
-- For every driver-DAY in the file, that day's shifts become exactly payroll's
-- windows (all codes for that driver that day are cleared first, so a MISA row under
-- the same person can never sit beside it as a second shift). Days payroll did not
-- pay are left as they are. Rows come in as {driver_id, shift_date, start_time,
-- end_time}; the slot is the window's order within the day. One transaction.
create or replace function public.import_payroll_shifts(p_from date,p_to date,rows jsonb) returns integer
language plpgsql security invoker set search_path='' as $$
declare written integer;
begin
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>40 or jsonb_typeof(rows) is distinct from 'array' or jsonb_array_length(rows)=0 then raise exception 'Invalid or empty payroll shift import'; end if;
 if exists(select 1 from jsonb_to_recordset(rows) as r(driver_id uuid,shift_date date,start_time text,end_time text)
   where r.driver_id is null or r.shift_date is null or r.shift_date<p_from or r.shift_date>p_to
      or r.start_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or r.end_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or r.start_time>=r.end_time)
 then raise exception 'Payroll shift row invalid or outside the period'; end if;
 lock table public.driver_shifts in share row exclusive mode;
 delete from public.driver_shifts s using (select distinct driver_id, shift_date from jsonb_to_recordset(rows) as r(driver_id uuid,shift_date date)) d
  where s.driver_id=d.driver_id and s.shift_date=d.shift_date;
 insert into public.driver_shifts(employee_code,full_name,shift_date,slot,day_type,start_time,end_time,driver_id,source)
 select coalesce(nullif(m.roster->>'employee_code',''),'driver:'||r.driver_id::text),
        trim(coalesce(m.first_name,'')||' '||coalesce(m.last_name,'')),
        r.shift_date,
        row_number() over (partition by r.driver_id,r.shift_date order by r.start_time),
        'working', r.start_time, r.end_time, r.driver_id, 'payroll'
 from jsonb_to_recordset(rows) as r(driver_id uuid,shift_date date,start_time text,end_time text)
 left join public.master_drivers m on m.driver_id=r.driver_id
 where r.shift_date>=public.cartrack_history_cutoff();
 get diagnostics written=row_count;
 return written;
end $$;
revoke all on function public.import_payroll_shifts(date,date,jsonb) from public,anon,authenticated;
grant execute on function public.import_payroll_shifts(date,date,jsonb) to service_role;

-- ── 2. Corrections ─────────────────────────────────────────────────────────────
create table if not exists public.pay_day_corrections (
  id            bigint generated always as identity primary key,
  driver_id     uuid        not null,
  driver_name   text,
  trip_date     date        not null,
  in_time       time        not null,
  out_time      time        not null check (out_time > in_time),
  -- forgot_tap = "Quên / chưa biết chấm công"; system_error = "Lỗi hệ thống";
  -- supervisor = entered directly by a supervisor.
  reason        text        not null check (reason in ('forgot_tap','system_error','supervisor')),
  note          text        not null default '',
  -- Public links to the proof files (see lib/cartrack-files.ts).
  proof_urls    text[]      not null default '{}',
  source        text        not null check (source in ('driver','supervisor')),
  status        text        not null default 'pending' check (status in ('pending','approved','rejected','withdrawn')),
  decision_note text        not null default '',
  created_at    timestamptz not null default now(),
  decided_at    timestamptz
);
-- One open request per driver-day: a new submission replaces the old one.
create unique index if not exists pay_day_corrections_one_pending
  on public.pay_day_corrections (driver_id, trip_date) where status = 'pending';
create index if not exists pay_day_corrections_date_idx on public.pay_day_corrections (trip_date, status);
create index if not exists pay_day_corrections_driver_idx on public.pay_day_corrections (driver_id, trip_date);
alter table public.pay_day_corrections enable row level security;
