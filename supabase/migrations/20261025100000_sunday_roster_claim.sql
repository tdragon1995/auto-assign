-- A driver taking an open Sunday line from the Lịch CN tab ("Nhận ca").
-- First one in wins: the line must still hold the driver the claimer saw
-- (null for an empty line, the absent driver for a line opened by leave).
-- The line is re-inserted rather than updated so its id CHANGES: an admin
-- editor holding the roster from before the claim is then refused on save
-- (master_write_sunday_roster's id check) instead of silently erasing it.
create or replace function public.master_claim_sunday_slot(line_id bigint, expected_driver uuid, claimer uuid)
returns bigint
language plpgsql
set search_path to ''
as $$
declare r public.master_sunday_roster; new_id bigint;
begin
  perform pg_advisory_xact_lock(873652906);
  select * into r from public.master_sunday_roster where id = line_id;
  if not found or r.driver_id is distinct from expected_driver or (expected_driver is null and r.raw_name is not null) then
    raise exception 'Slot already taken';
  end if;
  delete from public.master_sunday_roster where id = line_id;
  insert into public.master_sunday_roster(work_date, area, driver_id, raw_name, shift, note, sort)
  values (r.work_date, r.area, claimer, null, r.shift, r.note, r.sort)
  returning id into new_id;
  insert into public.master_action_logs(action, occurred_at, driver_id, details)
  values ('Sunday roster claim', now(), claimer, jsonb_build_object('work_date', r.work_date, 'line_id', new_id, 'before', to_jsonb(r)));
  return new_id;
end $$;
revoke all on function public.master_claim_sunday_slot(bigint, uuid, uuid) from public, anon, authenticated;
grant execute on function public.master_claim_sunday_slot(bigint, uuid, uuid) to service_role;
