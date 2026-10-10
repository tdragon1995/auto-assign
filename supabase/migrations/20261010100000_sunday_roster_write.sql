-- Save one Sunday's roster as a whole: the page edits a ~70-line week the way
-- the sheet did, so a save replaces the week rather than diffing lines.
--
-- expected_ids is the version check. A save deletes and re-inserts, so every
-- save mints new ids: if the ids on the table are not exactly the ones the
-- editor loaded, someone else saved in between and this refuses.
--
-- The replaced lines go to master_action_logs, so an unwanted save can be
-- undone by hand from the log.
create function public.master_write_sunday_roster(roster_date date, expected_ids bigint[], lines jsonb)
returns integer language plpgsql security invoker set search_path='' as $$
declare current_ids bigint[]; before jsonb; n integer;
begin
  perform pg_advisory_xact_lock(873652906);
  if roster_date is null or extract(isodow from roster_date) <> 7 then raise exception 'Roster date must be a Sunday'; end if;
  if jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines) > 200 then raise exception 'Invalid roster lines'; end if;
  select coalesce(array_agg(r.id order by r.id), '{}'),
         coalesce(jsonb_agg(to_jsonb(r) order by r.sort, r.id), '[]')
    into current_ids, before
    from public.master_sunday_roster r where r.work_date = roster_date;
  if current_ids is distinct from (select coalesce(array_agg(x order by x), '{}') from unnest(coalesce(expected_ids, '{}')) x) then
    raise exception 'Roster changed since it was loaded';
  end if;
  delete from public.master_sunday_roster r where r.work_date = roster_date;
  insert into public.master_sunday_roster(work_date, area, driver_id, raw_name, shift, note, sort)
  select roster_date, btrim(l->>'area'), nullif(l->>'driver_id', '')::uuid, nullif(btrim(l->>'raw_name'), ''),
         nullif(btrim(l->>'shift'), ''), nullif(btrim(l->>'note'), ''), t.ord
    from jsonb_array_elements(lines) with ordinality as t(l, ord);
  get diagnostics n = row_count;
  insert into public.master_action_logs(action, occurred_at, details)
  values ('Sunday roster save', now(), jsonb_build_object('work_date', roster_date, 'lines', n, 'before', before));
  return n;
end $$;
revoke all on function public.master_write_sunday_roster(date, bigint[], jsonb) from public, anon, authenticated;
grant execute on function public.master_write_sunday_roster(date, bigint[], jsonb) to service_role;
