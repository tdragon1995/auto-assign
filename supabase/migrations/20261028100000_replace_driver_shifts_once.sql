-- replace_driver_shifts timed out (8s PostgREST statement_timeout) on the 28/10
-- morning sync, so no MISA shifts or leave were written.
--
-- The delete's NOT EXISTS read the rows jsonb through jsonb_to_recordset once
-- PER EXISTING ROW: ~11,600 rows in the range x ~11,600 incoming = ~135M
-- element parses, which no longer finished inside a minute. Each statement now
-- parses the payload once into a MATERIALIZED CTE, so the delete is a hash
-- anti join (88 ms on the live table). The insert's per-row master_drivers scan
-- for a missing driver_id is grouped once the same way. Behaviour is unchanged.
create or replace function public.replace_driver_shifts(p_from date, p_to date, rows jsonb)
returns integer
language plpgsql
set search_path to ''
as $function$
declare written integer;
begin
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>400 or jsonb_typeof(rows) is distinct from 'array' or jsonb_array_length(rows)=0 then raise exception 'Invalid or empty shift replacement'; end if;
 if exists(select 1 from jsonb_to_recordset(rows) as r(shift_date date) where shift_date is null or shift_date<p_from or shift_date>p_to) then raise exception 'Shift date outside sync range'; end if;
 lock table public.driver_shifts in share row exclusive mode;

 with incoming as materialized (
   select r.employee_code, r.shift_date, coalesce(r.slot,1) as slot
   from jsonb_to_recordset(rows) as r(employee_code text,shift_date date,slot smallint))
 delete from public.driver_shifts s
 where shift_date between greatest(p_from,public.cartrack_history_cutoff()) and p_to
   and source not in ('manual','payroll')
   and not exists(select 1 from incoming i where i.employee_code=s.employee_code and i.shift_date=s.shift_date and i.slot=s.slot);

 with codes as materialized (
   select d.roster->>'employee_code' as code, case when count(*)=1 then (array_agg(d.driver_id))[1] end as driver_id
   from public.master_drivers d where d.roster->>'employee_code' is not null group by 1)
 insert into public.driver_shifts(employee_code,full_name,shift_date,slot,day_type,start_time,end_time,holiday_name,leave_start,leave_end,leave_gap,driver_id,source,raw_source)
 select r.employee_code,r.full_name,r.shift_date,coalesce(r.slot,1),r.day_type,r.start_time,r.end_time,r.holiday_name,r.leave_start,r.leave_end,coalesce(r.leave_gap,false),
   coalesce(r.driver_id,c.driver_id),coalesce(r.source,'MISA'),r.raw_source
 from jsonb_to_recordset(rows) as r(employee_code text,full_name text,shift_date date,slot smallint,day_type text,start_time text,end_time text,holiday_name text,leave_start text,leave_end text,leave_gap boolean,driver_id uuid,source text,raw_source jsonb)
 left join codes c on c.code=r.employee_code
 where r.shift_date>=public.cartrack_history_cutoff()
 on conflict(employee_code,shift_date,slot) do update set
   full_name=excluded.full_name,day_type=excluded.day_type,start_time=excluded.start_time,end_time=excluded.end_time,
   holiday_name=excluded.holiday_name,leave_start=excluded.leave_start,leave_end=excluded.leave_end,leave_gap=excluded.leave_gap,
   driver_id=excluded.driver_id,source=excluded.source,raw_source=excluded.raw_source,synced_at=now(),revision=public.driver_shifts.revision+1
 where public.driver_shifts.source not in ('manual','payroll');
 get diagnostics written=row_count;
 return written;
end $function$;
