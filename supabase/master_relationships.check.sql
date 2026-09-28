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
