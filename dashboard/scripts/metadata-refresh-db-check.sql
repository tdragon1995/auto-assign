-- Run against the Master database; every change rolls back.
begin;
set local role service_role;
do $$
declare client_id uuid; original jsonb;
begin
  select customer_id,to_jsonb(c) into client_id,original from public.master_clients c order by customer_id limit 1;
  perform public.master_refresh_metadata(jsonb_build_array(jsonb_build_object('customer_id',client_id,'eta_minutes',42)));
  assert (select eta_minutes=42 from public.master_clients where customer_id=client_id);
  assert (select (to_jsonb(c)-'eta_minutes')=(original-'eta_minutes') from public.master_clients c where customer_id=client_id), 'Other profile fields changed';
  begin
    perform public.master_refresh_metadata('[{"customer_id":"00000000-0000-4000-8000-000000000000","eta_minutes":10}]');
    raise exception 'Unknown UUID was accepted';
  exception when others then
    if sqlerrm not like '%Unknown metadata identity%' then raise; end if;
  end;
  begin
    perform public.master_refresh_metadata(jsonb_build_array(jsonb_build_object('customer_id',client_id,'cartrack','{}'::jsonb)));
    raise exception 'Unexpected field was accepted';
  exception when others then
    if sqlerrm not like '%Unexpected metadata field%' then raise; end if;
  end;
  begin
    perform public.master_refresh_metadata(jsonb_build_array(jsonb_build_object('customer_id',client_id),jsonb_build_object('customer_id',client_id)));
    raise exception 'Duplicate UUID was accepted';
  exception when others then
    if sqlerrm not like '%Duplicate metadata identity%' then raise; end if;
  end;
end $$;
rollback;
