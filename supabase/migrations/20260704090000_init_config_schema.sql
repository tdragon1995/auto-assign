-- =============================================================================
-- Fleet Auto-Assign: Google Sheet -> Supabase migration (phase 1: mirror + compare)
--
-- Design notes
--  * Every table keeps `sheet_row` (original 1-based row number) so lookup
--    semantics can mirror the sheet: VLOOKUP/XLOOKUP take the FIRST match in
--    sheet order, and several lookup keys are NOT unique in the sheet
--    (15 duplicated locations.customer_name, 8 duplicated drivers.code_name).
--  * Columns that were per-row VLOOKUP formulas in the sheet are stored
--    MATERIALIZED here (imported as the formula's current output) so the data
--    can be compared 1:1 against the sheet. The v_* views recompute them
--    relationally; a mismatch between stored and recomputed = stale formula or
--    duplicate-key ambiguity in the sheet.
--  * No hard FKs in phase 1 — the sheet contains dangling references and the
--    goal is a faithful import. FKs are added in phase 2 after validation.
--  * RLS is enabled with no policies: only the service-role key (used by the
--    Next.js server) can read/write. Add policies before exposing to clients.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- locations  <- tab "Location Table" (gid 232994825)
-- The master lookup table behind almost every VLOOKUP in the sheet.
-- ---------------------------------------------------------------------------
create table public.locations (
  customer_id     text primary key,          -- Cartrack customer id
  customer_name   text not null,             -- VLOOKUP key (NOT unique: 15 dupes)
  address_line_1  text,
  new_ward        text,
  dropoff_name    text,                      -- raw "dropoff" column (a location name)
  dropoff_id      text,                      -- was: VLOOKUP(dropoff_name -> customer_id) (self-join)
  eta             text,
  export_status   text,
  nearest_dropoff text,
  lat             double precision,
  lng             double precision,
  sheet_row       integer not null
);
create index locations_customer_name_idx on public.locations (customer_name);

-- ---------------------------------------------------------------------------
-- drivers  <- tab "Driver" (gid 467715355). No formulas in the sheet tab.
-- ---------------------------------------------------------------------------
create table public.drivers (
  driver_id            uuid primary key,     -- delivery_driver_id
  driver_name          text not null,        -- "Driver" col: xlookup key of config/leave tabs
  zalo_chat_id         text,                 -- driver_zalo_id
  bot_token            text,
  employee_code        text,
  employee_full_name   text,
  email                text,
  phone_code           text,
  phone_number         text,
  phone_number_update  text,                 -- used by the sunday-schedule phone formula
  shift_time_start     time,
  shift_time_end       time,
  start_location_customer_id text,
  end_location_customer_id   text,
  code_name            text,                 -- sunday-schedule name key (NOT unique: 8 dupes)
  is_active            boolean,
  sheet_row            integer not null
);
create index drivers_driver_name_idx on public.drivers (driver_name);
create index drivers_code_name_idx   on public.drivers (code_name);

-- ---------------------------------------------------------------------------
-- mappings  <- tabs "config" (gid 0, day_type='weekday')
--              and "(NO edit) CONFIG SUNDAY" (gid 1277313355, day_type='sunday')
-- One row = one (pickup customer, driver, shift window) assignment rule.
-- The same customer may appear on several rows with different shift windows.
-- customer_id / driver_id / alt_drop_off_id were VLOOKUP formulas -> materialized.
-- bot_token / chat_id are NOT stored: they were VLOOKUPs into Driver and are
-- recomputed by v_config via join (single source of truth).
-- ---------------------------------------------------------------------------
create table public.mappings (
  id                bigint generated always as identity primary key,
  day_type          text not null check (day_type in ('weekday','sunday')),
  pickup_name       text,                    -- "Điểm Pick-up" (ops entry key)
  customer_id       text,                    -- was: VLOOKUP(pickup_name -> locations)
  driver_name       text,                    -- "Driver" (ops entry key)
  driver_id         uuid,                    -- was: VLOOKUP/XLOOKUP(driver_name -> drivers)
  alt_drop_off_name text,                    -- "Điểm Drop-off thay thế"
  alt_drop_off_id   text,                    -- was: VLOOKUP(alt name -> locations)
  shift_start       time,
  shift_end         time,
  smart_driver_ids  uuid[] not null default '{}',
  -- sunday-only columns:
  area_public_on_schedule text,              -- was: giant nested IF (see docs/supabase-migration.md)
  driver_is_manual_override boolean,         -- sunday "f=fx"=FALSE -> driver typed by hand
  sheet_row         integer not null
);
create index mappings_customer_idx on public.mappings (day_type, customer_id);
create index mappings_driver_idx   on public.mappings (driver_id);

-- ---------------------------------------------------------------------------
-- leave_status + leave_subs  <- tab "Leave Status" (gid 158238549)
-- driver_id / subN_id were xlookup(name -> Driver) formulas -> materialized,
-- and recomputable via v_leave_status.
-- "day" was =IF(WEEKDAY(E,2)=7,8,WEEKDAY(E,2)+1)  -> generated column
--   (Mon=2 .. Sat=7, Sun=8 — the sheet's Vietnamese thứ convention).
-- ---------------------------------------------------------------------------
create table public.leave_status (
  id            bigint generated always as identity primary key,
  submitted_at  text,                        -- "Ngày Nộp Đơn" kept raw (mixed formats)
  driver_name   text,                        -- "driver" (entry key)
  driver_id     uuid,                        -- was: xlookup(driver_name -> drivers)
  loai_nghi     text,                        -- '', 'Nghỉ nguyên buổi', 'Nghỉ nửa buổi', 'Nghỉ việc'
  leave_from    date,
  leave_to      date,
  leave_from_hr time,
  leave_to_hr   time,
  day           integer generated always as (
                  case when leave_from is null then null
                       when extract(isodow from leave_from) = 7 then 8
                       else extract(isodow from leave_from)::integer + 1 end
                ) stored,
  note          text,
  vi_tri        text,                        -- "Vị trí"
  sheet_row     integer not null
);
create index leave_status_driver_idx on public.leave_status (driver_id, leave_from);

create table public.leave_subs (
  leave_id   bigint not null references public.leave_status (id) on delete cascade,
  slot       integer not null check (slot between 1 and 4),
  sub_name   text,
  sub_id     uuid,                           -- was: xlookup(sub_name -> drivers)
  cover_from time,
  cover_to   time,
  primary key (leave_id, slot)
);

-- ---------------------------------------------------------------------------
-- scheduled_trips_by_driver  <- tab "scheduled_trips" (gid 1684649126)
-- Display helper: which fixed trips a driver runs, split weekday vs weekend.
-- ---------------------------------------------------------------------------
create table public.scheduled_trips_by_driver (
  full_name     text primary key,
  weekday_trips text,                        -- sheet col "2,3,4,5,6"
  weekend_trips text,                        -- sheet col "7,8"
  sheet_row     integer not null
);

-- ---------------------------------------------------------------------------
-- schedule_jobs  <- tab "Scheduled Setup" (gid 834076876)
-- pickup_id / dropoff_id / driver_id were VLOOKUP formulas -> materialized.
-- ---------------------------------------------------------------------------
create table public.schedule_jobs (
  id                    bigint generated always as identity primary key,
  pickup_name           text,
  pickup_id             text,
  dropoff_name          text,
  dropoff_id            text,
  delivery_window       text,                -- "HH:MM" (app validates format)
  sent_to_driver_before integer,
  reference             text,
  monday    boolean not null default false,
  tuesday   boolean not null default false,
  wednesday boolean not null default false,
  thursday  boolean not null default false,
  friday    boolean not null default false,
  saturday  boolean not null default false,
  sunday    boolean not null default false,
  driver_name           text,
  driver_id             uuid,
  sheet_row             integer not null
);

-- ---------------------------------------------------------------------------
-- tpl_entries  <- tab "3PL" (gid 934328932)
-- tpl_uuid / address were VLOOKUPs into Location Table -> materialized,
-- recomputable via v_tpl_entries.
-- ---------------------------------------------------------------------------
create table public.tpl_entries (
  id        bigint generated always as identity primary key,
  psc_tinh  text not null,
  tpl_name  text,
  tpl_uuid  text,
  address   text,
  sheet_row integer not null
);

-- ---------------------------------------------------------------------------
-- sunday_schedule  <- tab "(Edit weekly) PUBLIC SUNDAY SCHEDULE" (gid 566382846)
-- full_name matches drivers.code_name. Phone + "Xin nghỉ" were formulas ->
-- recomputed in v_sunday_schedule (not stored).
-- ---------------------------------------------------------------------------
create table public.sunday_schedule (
  id        bigint generated always as identity primary key,
  work_date date,
  stt       text,
  full_name text,
  area      text,                            -- "Địa điểm"
  ca        text,                            -- shift label, e.g. "5:00 - 15:00"
  note      text,
  sheet_row integer not null
);
create index sunday_schedule_date_idx on public.sunday_schedule (work_date);

-- =============================================================================
-- Views: recompute what the sheet computed with formulas.
-- first_match() mirrors VLOOKUP/XLOOKUP first-match-in-sheet-order semantics.
-- =============================================================================

-- App-shaped config feed (replaces CSV of gid 0 / gid 1277313355).
-- bot_token & chat_id come from the drivers join — the sheet duplicated them
-- per row with VLOOKUPs; here they live only on drivers.
create view public.v_config as
select
  m.day_type,
  m.customer_id,
  m.driver_id,
  m.alt_drop_off_id,
  m.pickup_name,
  m.driver_name       as first_name_last_name,
  d.bot_token,
  d.zalo_chat_id      as chat_id,
  m.shift_start,
  m.shift_end,
  m.smart_driver_ids,
  m.area_public_on_schedule,
  m.sheet_row
from public.mappings m
left join public.drivers d on d.driver_id = m.driver_id;

-- Recompute the mapping VLOOKUPs from names, first-match-in-sheet-order.
-- Compare against the stored (imported) values to find stale formulas/dupes:
--   select * from v_mappings_recomputed where customer_id_recomputed
--     is distinct from customer_id;
create view public.v_mappings_recomputed as
select
  m.id, m.day_type, m.sheet_row, m.pickup_name, m.driver_name,
  m.customer_id, lp.customer_id  as customer_id_recomputed,
  m.driver_id,   ld.driver_id    as driver_id_recomputed,
  m.alt_drop_off_id, la.customer_id as alt_drop_off_id_recomputed
from public.mappings m
left join lateral (select l.customer_id from public.locations l
                   where l.customer_name = m.pickup_name
                   order by l.sheet_row limit 1) lp on true
left join lateral (select d.driver_id from public.drivers d
                   where d.driver_name = m.driver_name
                   order by d.sheet_row limit 1) ld on true
left join lateral (select l.customer_id from public.locations l
                   where l.customer_name = m.alt_drop_off_name
                   order by l.sheet_row limit 1) la on true;

-- Leave feed with sub slots re-attached (shape of loadLeaveEntries).
create view public.v_leave_status as
select
  l.*,
  coalesce(
    (select jsonb_agg(jsonb_build_object(
              'slot', s.slot, 'id', s.sub_id, 'name', s.sub_name,
              'from', to_char(s.cover_from, 'HH24:MI'),
              'to',   to_char(s.cover_to,   'HH24:MI'))
            order by s.slot)
     from public.leave_subs s where s.leave_id = l.id),
    '[]'::jsonb) as subs,
  -- was: =IFS(day in 2..6 -> weekday_trips; day in 7..8 -> weekend_trips)
  case when l.day between 2 and 6 then st.weekday_trips
       when l.day in (7, 8)       then st.weekend_trips
       else null end as scheduled_trips
from public.leave_status l
left join public.scheduled_trips_by_driver st on st.full_name = l.driver_name;

-- 3PL entries with address recomputed from locations (was 2 VLOOKUPs).
create view public.v_tpl_entries as
select
  t.id, t.psc_tinh, t.tpl_name, t.sheet_row,
  t.tpl_uuid, loc.customer_id   as tpl_uuid_recomputed,
  t.address,  loc.address_line_1 as address_recomputed
from public.tpl_entries t
left join lateral (select l.customer_id, l.address_line_1 from public.locations l
                   where l.customer_name = t.tpl_name
                   order by l.sheet_row limit 1) loc on true;

-- Public sunday schedule with phone + leave flag recomputed.
-- Phone was: ="+84"&XLOOKUP(name, Driver!code_name, Driver!phone_number_update)
-- "Xin nghỉ" was: COUNTIFS(leave_from = work_date) + COUNTIFS(leave_to = work_date) > 0
--   (sheet checks the two ENDPOINTS only, not the whole range — kept faithful here;
--    see docs/supabase-migration.md for the range-based improvement).
create view public.v_sunday_schedule as
select
  s.id, s.work_date, s.stt, s.full_name, s.area, s.ca, s.note, s.sheet_row,
  case when d.phone_number_update is not null and d.phone_number_update <> ''
       then '+84' || d.phone_number_update
       else 'Liên hệ Đội điều phối' end as phone,
  case
    when exists (select 1 from public.leave_status l
                 where l.driver_name = d.driver_name
                   and (l.leave_from = s.work_date or l.leave_to = s.work_date))
      then 'Nghỉ'
    when exists (select 1 from public.leave_status l
                 where l.driver_name = d.driver_name
                   and l.loai_nghi = 'Nghỉ việc' and l.leave_from < s.work_date)
      then 'Nghỉ việc'
    else '' end as xin_nghi
from public.sunday_schedule s
left join lateral (select d.driver_id, d.driver_name, d.phone_number_update
                   from public.drivers d where d.code_name = s.full_name
                   order by d.sheet_row limit 1) d on true;

-- Who covers each Sunday-config area on a given Sunday.
-- Replaces the CONFIG SUNDAY col-F mega-formula:
--   xlookup(INDEX/MATCH(schedule row where area matches and date = this week's
--   Sunday), Driver_2[code_name], Driver_2[Driver])
create view public.v_sunday_driver_by_area as
select
  m.id as mapping_id, m.customer_id, m.area_public_on_schedule,
  sched.work_date, sched.full_name as scheduled_code_name,
  d.driver_id, d.driver_name
from public.mappings m
left join lateral (
  select s.work_date, s.full_name
  from public.sunday_schedule s
  where btrim(s.area) = btrim(m.area_public_on_schedule)
    -- TODAY() - WEEKDAY(TODAY(),2) + 7 = the Sunday of the current Mon–Sun week
    and s.work_date = (now() at time zone 'Asia/Ho_Chi_Minh')::date
                      - extract(isodow from (now() at time zone 'Asia/Ho_Chi_Minh')::date)::integer + 7
  order by s.sheet_row limit 1
) sched on true
left join lateral (select d.driver_id, d.driver_name from public.drivers d
                   where d.code_name = sched.full_name
                   order by d.sheet_row limit 1) d on true
where m.day_type = 'sunday';

-- =============================================================================
-- RLS: deny-all by default; the Next.js server uses the service-role key.
-- =============================================================================
alter table public.locations                 enable row level security;
alter table public.drivers                   enable row level security;
alter table public.mappings                  enable row level security;
alter table public.leave_status              enable row level security;
alter table public.leave_subs                enable row level security;
alter table public.scheduled_trips_by_driver enable row level security;
alter table public.schedule_jobs             enable row level security;
alter table public.tpl_entries               enable row level security;
alter table public.sunday_schedule           enable row level security;
