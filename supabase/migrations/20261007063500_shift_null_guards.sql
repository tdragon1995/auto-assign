-- Reject NULL payloads before replacing existing rows.
-- Keep revisions across source refreshes, so an open editor cannot overwrite a newer import.
create or replace function public.replace_driver_shifts(p_from date,p_to date,rows jsonb) returns integer
language plpgsql security invoker set search_path='' as $$
declare written integer;
begin
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>400 or jsonb_typeof(rows) is distinct from 'array' or jsonb_array_length(rows)=0 then raise exception 'Invalid or empty shift replacement'; end if;
 if exists(select 1 from jsonb_to_recordset(rows) as r(shift_date date) where shift_date is null or shift_date<p_from or shift_date>p_to) then raise exception 'Shift date outside sync range'; end if;
 lock table public.driver_shifts in share row exclusive mode;
 delete from public.driver_shifts s where shift_date between greatest(p_from,public.cartrack_history_cutoff()) and p_to and source<>'manual' and not exists(select 1 from jsonb_to_recordset(rows) as r(employee_code text,shift_date date,slot smallint) where r.employee_code=s.employee_code and r.shift_date=s.shift_date and coalesce(r.slot,1)=s.slot);
 insert into public.driver_shifts(employee_code,full_name,shift_date,slot,day_type,start_time,end_time,holiday_name,leave_start,leave_end,leave_gap,driver_id,source,raw_source)
 select r.employee_code,r.full_name,r.shift_date,coalesce(r.slot,1),r.day_type,r.start_time,r.end_time,r.holiday_name,r.leave_start,r.leave_end,coalesce(r.leave_gap,false),
 coalesce(r.driver_id,(select case when count(*)=1 then (array_agg(d.driver_id))[1] end from public.master_drivers d where d.roster->>'employee_code'=r.employee_code)),coalesce(r.source,'MISA'),r.raw_source
 from jsonb_to_recordset(rows) as r(employee_code text,full_name text,shift_date date,slot smallint,day_type text,start_time text,end_time text,holiday_name text,leave_start text,leave_end text,leave_gap boolean,driver_id uuid,source text,raw_source jsonb)
 where r.shift_date>=public.cartrack_history_cutoff()
 on conflict(employee_code,shift_date,slot) do update set
 full_name=excluded.full_name,day_type=excluded.day_type,start_time=excluded.start_time,end_time=excluded.end_time,
 holiday_name=excluded.holiday_name,leave_start=excluded.leave_start,leave_end=excluded.leave_end,leave_gap=excluded.leave_gap,
 driver_id=excluded.driver_id,source=excluded.source,raw_source=excluded.raw_source,synced_at=now(),revision=public.driver_shifts.revision+1
 where public.driver_shifts.source<>'manual';
 get diagnostics written=row_count;
 return written;
end $$;


create or replace function public.master_write_shift_pattern(data jsonb) returns public.driver_shift_patterns
language plpgsql security invoker set search_path='' as $$
declare old public.driver_shift_patterns; saved public.driver_shift_patterns; win jsonb;
begin
 if jsonb_typeof(data->'days') is distinct from 'array' or jsonb_array_length(data->'days')<>7 then raise exception 'Expected seven weekdays'; end if;
 for win in select value from jsonb_array_elements(data->'days') loop
  if win<>'null'::jsonb and (coalesce(win->>'start','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(win->>'end','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or win->>'start'=win->>'end') then raise exception 'Invalid pattern shift'; end if;
 end loop;
 if data->>'id' is not null then
  select * into old from public.driver_shift_patterns where id=(data->>'id')::bigint for update;
  if old.id is null or old.revision is distinct from (data->>'revision')::bigint then raise exception 'Dòng đã thay đổi — tải lại trước khi lưu'; end if;
  if old.driver_id is distinct from (data->>'driver_id')::uuid and not exists(select 1 from public.master_drivers where driver_id=(data->>'driver_id')::uuid and is_active) then raise exception 'Chọn tài xế đang hoạt động'; end if;
  update public.driver_shift_patterns set driver_id=(data->>'driver_id')::uuid,employee_code=data->>'employee_code',label=data->>'label',review_issues=case when data->>'driver_id' is null then review_issues else '[]'::jsonb end,days=data->'days',active_from=(data->>'active_from')::date,active_to=(data->>'active_to')::date,active=(data->>'active')::boolean,note=data->>'note',revision=revision+1,updated_at=now() where id=old.id returning * into saved;
 else
  if not exists(select 1 from public.master_drivers where driver_id=(data->>'driver_id')::uuid and is_active) then raise exception 'Chọn tài xế đang hoạt động'; end if;
  insert into public.driver_shift_patterns(driver_id,employee_code,label,days,active_from,active_to,active,note)
  values((data->>'driver_id')::uuid,data->>'employee_code',data->>'label',data->'days',(data->>'active_from')::date,(data->>'active_to')::date,(data->>'active')::boolean,data->>'note') returning * into saved;
 end if;
 return saved;
end $$;
