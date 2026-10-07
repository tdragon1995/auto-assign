-- Non-Sunday operational sources. Service-role APIs own all writes.
create table if not exists public.driver_shifts (
 employee_code text not null, full_name text not null, shift_date date not null,
 slot smallint not null default 1 check(slot between 1 and 20),
 day_type text not null check(day_type in ('working','off','holiday')),
 start_time text, end_time text, holiday_name text, leave_start text, leave_end text,
 leave_gap boolean not null default false, synced_at timestamptz not null default now(),
 driver_id uuid references public.master_drivers(driver_id), source text not null default 'MISA',
 revision bigint not null default 1, raw_source jsonb,
 primary key(employee_code,shift_date,slot),
 check(length(trim(employee_code))>0),
 check(start_time is null or start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 check(end_time is null or end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 check(leave_start is null or leave_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 check(leave_end is null or leave_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 check((day_type='working' and start_time is not null and end_time is not null and start_time<>end_time) or (day_type<>'working' and start_time is null and end_time is null))
);
-- Also supports installations that applied the earlier dormant driver_shifts migration.
alter table public.driver_shifts add column if not exists driver_id uuid references public.master_drivers(driver_id),
 add column if not exists source text not null default 'MISA',
 add column if not exists revision bigint not null default 1,
 add column if not exists raw_source jsonb;
create index if not exists driver_shifts_date_idx on public.driver_shifts(shift_date);
create index driver_shifts_driver_idx on public.driver_shifts(driver_id,shift_date);
create table public.driver_shift_patterns (
 id bigint generated always as identity primary key, source_key text unique,
 driver_id uuid references public.master_drivers(driver_id), employee_code text not null,
 label text not null, days jsonb not null check(jsonb_typeof(days)='array' and jsonb_array_length(days)=7),
 active_from date, active_to date, active boolean not null default true,
 note text not null default '', review_issues jsonb not null default '[]', raw_source jsonb,
 revision bigint not null default 1, updated_at timestamptz not null default now(),
 check(active_to is null or active_from is null or active_to>=active_from)
);
create index driver_shift_patterns_driver_idx on public.driver_shift_patterns(driver_id,active_from);
create table public.master_tpl_entries (
 id bigint generated always as identity primary key, source_key text unique,
 psc_tinh text not null, tpl_name text not null, tpl_uuid uuid not null references public.master_clients(customer_id),
 address text not null default '', raw_source jsonb, active boolean not null default true
);
create table public.master_leave_suppressions (
 id bigint generated always as identity primary key, source_key text unique,
 driver_id uuid not null references public.master_drivers(driver_id), driver_name text not null,
 loai_nghi text not null, leave_from date not null, leave_to date,
 gio_bat_dau text, gio_ket_thuc text, deleted_at timestamptz not null default now(),
 note text not null default '', raw_source jsonb,
 check(leave_to is null or leave_to>=leave_from)
);
create index master_leave_suppressions_driver_idx on public.master_leave_suppressions(driver_id,leave_from);
create table public.master_action_logs (
 id bigint generated always as identity primary key, source_key text unique,
 action text not null, occurred_at timestamptz not null, driver_id uuid references public.master_drivers(driver_id),
 job_id bigint, details jsonb not null
);
create index master_action_logs_date_idx on public.master_action_logs(occurred_at);
alter table public.driver_shifts enable row level security;
drop policy if exists driver_shifts_read on public.driver_shifts;
alter table public.driver_shift_patterns enable row level security;
alter table public.master_tpl_entries enable row level security;
alter table public.master_leave_suppressions enable row level security;
alter table public.master_action_logs enable row level security;
revoke all on public.driver_shifts,public.driver_shift_patterns,public.master_tpl_entries,public.master_leave_suppressions,public.master_action_logs from anon,authenticated;
grant all on public.driver_shifts,public.driver_shift_patterns,public.master_tpl_entries,public.master_leave_suppressions,public.master_action_logs to service_role;
grant usage,select on sequence public.driver_shift_patterns_id_seq,public.master_tpl_entries_id_seq,public.master_leave_suppressions_id_seq,public.master_action_logs_id_seq to service_role;

create function public.replace_driver_shifts(p_from date,p_to date,rows jsonb) returns integer
language plpgsql security invoker set search_path='' as $$
declare written integer;
begin
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>400 or jsonb_typeof(rows)<>'array' or jsonb_array_length(rows)=0 then raise exception 'Invalid or empty shift replacement'; end if;
 if exists(select 1 from jsonb_to_recordset(rows) as r(shift_date date) where shift_date is null or shift_date<p_from or shift_date>p_to) then raise exception 'Shift date outside sync range'; end if;
 lock table public.driver_shifts in share row exclusive mode;
 delete from public.driver_shifts where shift_date between greatest(p_from,public.cartrack_history_cutoff()) and p_to and source<>'manual';
 insert into public.driver_shifts(employee_code,full_name,shift_date,slot,day_type,start_time,end_time,holiday_name,leave_start,leave_end,leave_gap,driver_id,source,raw_source)
 select r.employee_code,r.full_name,r.shift_date,coalesce(r.slot,1),r.day_type,r.start_time,r.end_time,r.holiday_name,r.leave_start,r.leave_end,coalesce(r.leave_gap,false),
 coalesce(r.driver_id,(select case when count(*)=1 then (array_agg(d.driver_id))[1] end from public.master_drivers d where d.roster->>'employee_code'=r.employee_code)),coalesce(r.source,'MISA'),r.raw_source
 from jsonb_to_recordset(rows) as r(employee_code text,full_name text,shift_date date,slot smallint,day_type text,start_time text,end_time text,holiday_name text,leave_start text,leave_end text,leave_gap boolean,driver_id uuid,source text,raw_source jsonb)
 where r.shift_date>=public.cartrack_history_cutoff()
 on conflict(employee_code,shift_date,slot) do nothing;
 get diagnostics written=row_count;
 return written;
end $$;

create function public.master_import_remaining(data jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare shifts integer;
begin
 shifts:=public.replace_driver_shifts((data->>'from')::date,(data->>'to')::date,data->'shifts');
 insert into public.driver_shift_patterns(source_key,driver_id,employee_code,label,days,active_from,active_to,active,note,review_issues,raw_source)
 select source_key,driver_id,employee_code,label,days,active_from,active_to,active,note,review_issues,raw_source
 from jsonb_to_recordset(data->'patterns') as r(source_key text,driver_id uuid,employee_code text,label text,days jsonb,active_from date,active_to date,active boolean,note text,review_issues jsonb,raw_source jsonb) on conflict(source_key) do nothing;
 insert into public.master_tpl_entries(source_key,psc_tinh,tpl_name,tpl_uuid,address,raw_source)
 select source_key,psc_tinh,tpl_name,tpl_uuid,address,raw_source from jsonb_to_recordset(data->'tpl') as r(source_key text,psc_tinh text,tpl_name text,tpl_uuid uuid,address text,raw_source jsonb) on conflict(source_key) do nothing;
 insert into public.master_leave_suppressions(source_key,driver_id,driver_name,loai_nghi,leave_from,leave_to,gio_bat_dau,gio_ket_thuc,deleted_at,note,raw_source)
 select source_key,driver_id,driver_name,loai_nghi,leave_from,leave_to,gio_bat_dau,gio_ket_thuc,deleted_at,note,raw_source from jsonb_to_recordset(data->'suppressions') as r(source_key text,driver_id uuid,driver_name text,loai_nghi text,leave_from date,leave_to date,gio_bat_dau text,gio_ket_thuc text,deleted_at timestamptz,note text,raw_source jsonb) on conflict(source_key) do nothing;
 insert into public.master_action_logs(source_key,action,occurred_at,driver_id,job_id,details)
 select source_key,action,occurred_at,driver_id,job_id,details from jsonb_to_recordset(data->'logs') as r(source_key text,action text,occurred_at timestamptz,driver_id uuid,job_id bigint,details jsonb) on conflict(source_key) do nothing;
 return jsonb_build_object('shifts',shifts,'patterns',(select count(*) from public.driver_shift_patterns),'tpl',(select count(*) from public.master_tpl_entries),'suppressions',(select count(*) from public.master_leave_suppressions),'logs',(select count(*) from public.master_action_logs));
end $$;

create function public.master_write_shift(data jsonb) returns public.driver_shifts
language plpgsql security invoker set search_path='' as $$
declare old public.driver_shifts; saved public.driver_shifts; code text:=data->>'employee_code'; day date:=(data->>'shift_date')::date; n smallint:=coalesce((data->>'slot')::smallint,1);
begin
 if day<public.cartrack_history_cutoff() then raise exception 'Date before payroll cutoff'; end if;
 perform pg_advisory_xact_lock(hashtextextended(code||day::text||n::text,0));
 select * into old from public.driver_shifts where employee_code=code and shift_date=day and slot=n for update;
 if coalesce(old.revision,0)<>coalesce((data->>'revision')::bigint,0) then raise exception 'Dòng đã thay đổi — tải lại trước khi lưu'; end if;
 if old.employee_code is null and not exists(select 1 from public.master_drivers where driver_id=(data->>'driver_id')::uuid and is_active) then raise exception 'Chọn tài xế đang hoạt động'; end if;
 insert into public.driver_shifts(employee_code,full_name,shift_date,slot,day_type,start_time,end_time,holiday_name,driver_id,source)
 values(code,data->>'full_name',day,n,data->>'day_type',nullif(data->>'start_time',''),nullif(data->>'end_time',''),nullif(data->>'holiday_name',''),(data->>'driver_id')::uuid,'manual')
 on conflict(employee_code,shift_date,slot) do update set day_type=excluded.day_type,start_time=excluded.start_time,end_time=excluded.end_time,holiday_name=excluded.holiday_name,source='manual',synced_at=now(),revision=public.driver_shifts.revision+1
 returning * into saved;
 return saved;
end $$;

create function public.master_write_shift_pattern(data jsonb) returns public.driver_shift_patterns
language plpgsql security invoker set search_path='' as $$
declare old public.driver_shift_patterns; saved public.driver_shift_patterns; win jsonb;
begin
 if jsonb_typeof(data->'days')<>'array' or jsonb_array_length(data->'days')<>7 then raise exception 'Expected seven weekdays'; end if;
 for win in select value from jsonb_array_elements(data->'days') loop
  if win<>'null'::jsonb and (coalesce(win->>'start','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(win->>'end','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or win->>'start'=win->>'end') then raise exception 'Invalid pattern shift'; end if;
 end loop;
 if data->>'id' is not null then
  select * into old from public.driver_shift_patterns where id=(data->>'id')::bigint for update;
  if old.id is null or old.revision<>(data->>'revision')::bigint then raise exception 'Dòng đã thay đổi — tải lại trước khi lưu'; end if;
  update public.driver_shift_patterns set days=data->'days',active_from=(data->>'active_from')::date,active_to=(data->>'active_to')::date,active=(data->>'active')::boolean,note=data->>'note',revision=revision+1,updated_at=now() where id=old.id returning * into saved;
 else
  if not exists(select 1 from public.master_drivers where driver_id=(data->>'driver_id')::uuid and is_active) then raise exception 'Chọn tài xế đang hoạt động'; end if;
  insert into public.driver_shift_patterns(driver_id,employee_code,label,days,active_from,active_to,active,note)
  values((data->>'driver_id')::uuid,data->>'employee_code',data->>'label',data->'days',(data->>'active_from')::date,(data->>'active_to')::date,(data->>'active')::boolean,data->>'note') returning * into saved;
 end if;
 return saved;
end $$;

create function public.retain_driver_shift() returns trigger language plpgsql security invoker set search_path='' as $$
begin if new.shift_date<public.cartrack_history_cutoff() then raise exception 'Date before payroll cutoff'; end if;return new;end $$;
create trigger driver_shift_retention before insert or update on public.driver_shifts for each row execute function public.retain_driver_shift();
-- Extend the existing midnight retention run; no new polling or cron job.
select cron.alter_job(jobid,command := 'select public.purge_cartrack_history(); delete from public.driver_shifts where shift_date < public.cartrack_history_cutoff(); delete from public.master_action_logs where occurred_at < (public.cartrack_history_cutoff()::timestamp at time zone ''Asia/Ho_Chi_Minh'');') from cron.job where jobname='cartrack-history-retention';
revoke all on function public.replace_driver_shifts(date,date,jsonb),public.master_import_remaining(jsonb),public.master_write_shift(jsonb),public.master_write_shift_pattern(jsonb),public.retain_driver_shift() from public,anon,authenticated;
grant execute on function public.replace_driver_shifts(date,date,jsonb),public.master_import_remaining(jsonb),public.master_write_shift(jsonb),public.master_write_shift_pattern(jsonb),public.retain_driver_shift() to service_role;
