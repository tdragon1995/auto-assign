-- Weekly PT shifts: the latest save wins from its own date on (see the function).
-- Also retires the versions already shadowed this way, so the readers (MISA sync,
-- apply-pt, Bảng ca) agree with what was last saved.
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
  -- A new weekly shift from F replaces every older version starting on or after F
  -- (an undated one replaces them all): the LATEST SAVE wins from its date on.
  -- Without this, re-saving "from 14/09" lost to an older version from 21/09,
  -- because the reader picks the latest START date (PT101147, 27/09).
  if saved.active then
   update public.driver_shift_patterns set active=false,revision=revision+1,updated_at=now(),
     note=trim(both ' ' from coalesce(note,'')||' Thay bằng #'||saved.id)
   where driver_id=saved.driver_id and id<>saved.id and active
     and (saved.active_from is null or (active_from is not null and active_from>=saved.active_from));
  end if;
 end if;
 return saved;
end $$;

update public.driver_shift_patterns o set active=false,revision=o.revision+1,updated_at=now(),
  note=trim(both ' ' from coalesce(o.note,'')||' Thay bằng bản lưu sau')
where o.active and o.driver_id is not null and exists (
  select 1 from public.driver_shift_patterns n where n.driver_id=o.driver_id and n.active and n.id>o.id
    and (n.active_from is null or (o.active_from is not null and o.active_from>=n.active_from)));
