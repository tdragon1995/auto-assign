-- Safe database check: every mutation is rolled back.
begin;
do $$
declare r public.master_import_runs; payload jsonb; before_state jsonb; fresh_run uuid; rejected boolean;
begin
 select * into strict r from public.master_import_runs where committed_at is not null order by committed_at desc limit 1;
 if jsonb_typeof(r.source_snapshot->'rules')<>'object' then raise exception 'Use the captured first-import snapshot for this check'; end if;
 select jsonb_build_object(
 'rules',(select jsonb_agg(item order by key::int,ordinality) from jsonb_each(r.source_snapshot->'rules') c cross join lateral jsonb_array_elements(c.value) with ordinality v(item,ordinality)),
 'leave',(select jsonb_agg(item order by key::int,ordinality) from jsonb_each(r.source_snapshot->'leave') c cross join lateral jsonb_array_elements(c.value) with ordinality v(item,ordinality))) into payload;
 before_state:=public.master_review_state();
 perform public.master_commit_import(r.id,payload,r.source_hash);
 if public.master_review_state()<>before_state then raise exception 'Committed retry changed records'; end if;
 fresh_run:=public.master_begin_import(r.source_hash,'{}',before_state,'{"test":true}');
 rejected:=false;
 begin
  perform public.master_commit_import(fresh_run,jsonb_set(payload,'{rules}',payload->'rules'||jsonb_build_array(payload->'rules'->0)),r.source_hash);
 exception when others then if sqlerrm not like '%Duplicate source UID%' then raise; end if; rejected:=true; end;
 if not rejected then raise exception 'Duplicate source IDs accepted'; end if;
 payload:=jsonb_set(payload,'{rules,0,row_data,chat_id}','"changed"');
 payload:=jsonb_set(payload,array['rules',(jsonb_array_length(payload->'rules')-1)::text,'driver_ids'],jsonb_build_array(gen_random_uuid()));
 rejected:=false;
 begin perform public.master_commit_import(fresh_run,payload,r.source_hash);
 exception when foreign_key_violation then rejected:=true; end;
 if not rejected or public.master_review_state()<>before_state then raise exception 'Failed import changed the usable configuration'; end if;
end $$;
rollback;
select 'passed: idempotent retry, duplicate IDs rejected, interrupted import rolled back' as checks;
