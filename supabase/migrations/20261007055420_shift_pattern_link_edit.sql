create or replace function public.master_write_shift_pattern(data jsonb) returns public.driver_shift_patterns
language plpgsql security invoker set search_path='' as $$
declare old public.driver_shift_patterns; saved public.driver_shift_patterns; win jsonb;
begin
 if jsonb_typeof(data->'days')<>'array' or jsonb_array_length(data->'days')<>7 then raise exception 'Expected seven weekdays'; end if;
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

create or replace function public.master_write_shift(data jsonb) returns public.driver_shifts
language plpgsql security invoker set search_path='' as $$
declare old public.driver_shifts; saved public.driver_shifts; code text:=data->>'employee_code'; day date:=(data->>'shift_date')::date; n smallint:=coalesce((data->>'slot')::smallint,1);
begin
 if day<public.cartrack_history_cutoff() then raise exception 'Date before payroll cutoff'; end if;
 perform pg_advisory_xact_lock(hashtextextended(code||day::text||n::text,0));
 select * into old from public.driver_shifts where employee_code=code and shift_date=day and slot=n for update;
 if coalesce(old.revision,0)<>coalesce((data->>'revision')::bigint,0) then raise exception 'Dòng đã thay đổi — tải lại trước khi lưu'; end if;
 if old.driver_id is not null and old.driver_id is distinct from (data->>'driver_id')::uuid then raise exception 'Tài xế của ca đã thay đổi'; end if;
 if (old.employee_code is null or old.driver_id is distinct from (data->>'driver_id')::uuid) and not exists(select 1 from public.master_drivers where driver_id=(data->>'driver_id')::uuid and is_active) then raise exception 'Chọn tài xế đang hoạt động'; end if;
 insert into public.driver_shifts(employee_code,full_name,shift_date,slot,day_type,start_time,end_time,holiday_name,driver_id,source)
 values(code,data->>'full_name',day,n,data->>'day_type',nullif(data->>'start_time',''),nullif(data->>'end_time',''),nullif(data->>'holiday_name',''),(data->>'driver_id')::uuid,'manual')
 on conflict(employee_code,shift_date,slot) do update set driver_id=excluded.driver_id,full_name=excluded.full_name,day_type=excluded.day_type,start_time=excluded.start_time,end_time=excluded.end_time,holiday_name=excluded.holiday_name,source='manual',synced_at=now(),revision=public.driver_shifts.revision+1
 returning * into saved;
 return saved;
end $$;
