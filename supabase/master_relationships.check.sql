-- Run after the migration or any config import. Raises if the smart-driver
-- bridge differs from the valid IDs in the original Sheet-shaped rows.
do $$
begin
  if exists (
    with expected as (
      select distinct r.id rule_id, d.driver_id
      from public.master_config_rules r
      cross join lateral regexp_split_to_table(coalesce(r.row_data->>'smart_driver_id', ''), ',') as ids(value)
      join public.master_drivers d on d.driver_id = public.master_uuid_or_null(ids.value)
    ), difference as (
      (select rule_id, driver_id from expected except select rule_id, driver_id from public.master_rule_smart_drivers)
      union all
      (select rule_id, driver_id from public.master_rule_smart_drivers except select rule_id, driver_id from expected)
    )
    select 1 from difference
  ) then
    raise exception 'master_rule_smart_drivers is out of sync';
  end if;
end;
$$;

do $$
begin
  if not exists (select 1 from public.master_leave_rows) then
    raise exception 'master_leave_rows has not been imported';
  end if;
  if exists (
    select 1 from public.master_leave_rows
    where (linked_driver_id is not null and linked_driver_id::text <> lower(btrim(driver_id)))
       or (linked_sub1_driver_id is not null and linked_sub1_driver_id::text <> lower(btrim(sub1_id)))
  ) then
    raise exception 'a leave row links to the wrong driver';
  end if;
end;
$$;
