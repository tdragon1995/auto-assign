begin;
do $$
declare r public.driver_shifts; result public.driver_shifts; data jsonb; day date:=current_date+90; n integer;
begin
 select * into r from public.driver_shifts s where driver_id is not null and exists(select 1 from public.master_drivers d where d.driver_id=s.driver_id and d.is_active) order by shift_date desc limit 1;
 if r.driver_id is null then raise exception 'Test requires one active imported driver'; end if;
 data:=jsonb_build_object('employee_code',r.employee_code,'full_name',r.full_name,'driver_id',r.driver_id,'shift_date',day,'slot',20,'revision',0,'day_type','working','start_time','08:00','end_time','20:00');
 result:=public.master_write_shift(data);
 if result.source<>'manual' or result.shift_date<>day then raise exception 'Future manual write failed'; end if;
 begin perform public.master_write_shift(data);raise exception 'Stale edit accepted';exception when others then if sqlerrm='Stale edit accepted' then raise;end if;end;
 n:=public.replace_driver_shifts(day,day,jsonb_build_array(data||jsonb_build_object('source','MISA','end_time','21:00')));
 if n<>0 or (select end_time from public.driver_shifts where employee_code=r.employee_code and shift_date=day and slot=20)<>'20:00' then raise exception 'MISA overwrote manual edit';end if;
 -- A bad replacement must roll its delete back as well as its insert.
 update public.driver_shifts set source='MISA' where employee_code=r.employee_code and shift_date=day and slot=20;
 begin perform public.replace_driver_shifts(day,day,jsonb_build_array(data||jsonb_build_object('end_time',null)));raise exception 'Partial shift accepted';exception when others then if sqlerrm='Partial shift accepted' then raise;end if;end;
 if not exists(select 1 from public.driver_shifts where employee_code=r.employee_code and shift_date=day and slot=20 and end_time='20:00') then raise exception 'Failed replacement lost prior data';end if;
 n:=public.replace_driver_shifts(day,day,jsonb_build_array(data||jsonb_build_object('source','MISA','end_time','21:00')));
 if n<>1 then raise exception 'Source refresh did not replace its row';end if;
 begin perform public.master_write_shift(data||jsonb_build_object('revision',result.revision));raise exception 'Pre-refresh revision accepted';exception when others then if sqlerrm='Pre-refresh revision accepted' then raise;end if;end;
 begin perform public.replace_driver_shifts(day,day,null);raise exception 'NULL replacement accepted';exception when others then if sqlerrm='NULL replacement accepted' then raise;end if;end;
 begin perform public.master_write_shift_pattern('{}'::jsonb);raise exception 'Missing pattern days accepted';exception when others then if sqlerrm='Missing pattern days accepted' then raise;end if;end;
 begin perform public.replace_driver_shifts(day,day,'[]'::jsonb);raise exception 'Empty replacement accepted';exception when others then if sqlerrm='Empty replacement accepted' then raise;end if;end;
 begin perform public.master_write_shift(data||jsonb_build_object('shift_date',public.cartrack_history_cutoff()-1));raise exception 'Pre-cutoff date accepted';exception when others then if sqlerrm='Pre-cutoff date accepted' then raise;end if;end;
 raise notice 'PASS: future writes, stale edits, manual preservation, atomic failures and payroll cutoff';
end $$;
rollback;
