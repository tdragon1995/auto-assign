-- Canonical selections are ordered child rows; no stored legacy driver strings.
do $$
begin
 if exists(select 1 from public.master_config_rules r join public.master_rule_drivers d on d.rule_id=r.id
   where r.assignment_mode='fixed' group by r.id having count(*)>1) then raise exception 'Fixed rule has multiple drivers'; end if;
 if exists(select 1 from public.master_rules_read r where coalesce(r.row_data->>'smart_driver_id','') is distinct from
   case when r.assignment_mode='smart' then coalesce((select string_agg(driver_id::text,',' order by selection_order) from public.master_rule_drivers where rule_id=r.id),'') else '' end)
   then raise exception 'Rule adapter differs from canonical selections'; end if;
 if not exists(select 1 from public.master_leave_rows) then raise exception 'Leave has not been imported'; end if;
 if exists(select 1 from public.master_leave_substitutes s where s.coverage_kind='driver' and s.driver_id is null)
   then raise exception 'Driver coverage has no linked driver'; end if;
end $$;
