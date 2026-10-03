alter table public.master_schedule_jobs add constraint master_schedule_days_shape
check (cardinality(days)=7 and array_lower(days,1)=1);
