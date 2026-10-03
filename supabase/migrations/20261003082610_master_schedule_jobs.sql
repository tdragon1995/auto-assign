create table public.master_schedule_jobs (
  id bigint generated always as identity primary key,
  source_uid uuid not null unique default gen_random_uuid(),
  source_row integer not null,
  source_data jsonb not null default '{}',
  pickup_id uuid not null references public.master_clients(customer_id),
  dropoff_id uuid not null references public.master_clients(customer_id),
  driver_id uuid references public.master_drivers(driver_id),
  delivery_window time not null check (delivery_window < time '24:00'),
  sent_to_driver_before integer not null default 60 check (sent_to_driver_before between 0 and 720),
  reference text not null check (btrim(reference) <> ''),
  days boolean[] not null check (array_ndims(days)=1 and array_length(days,1)=7 and array_position(days,null) is null),
  active boolean not null default true,
  revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  check (pickup_id <> dropoff_id)
);
create unique index master_schedule_reference_idx on public.master_schedule_jobs(reference) where active;
create index master_schedule_pickup_idx on public.master_schedule_jobs(pickup_id);
create index master_schedule_dropoff_idx on public.master_schedule_jobs(dropoff_id);
create index master_schedule_driver_idx on public.master_schedule_jobs(driver_id);
alter table public.master_schedule_jobs enable row level security;
revoke all on public.master_schedule_jobs from anon,authenticated;
grant all on public.master_schedule_jobs to service_role;
grant usage,select on sequence public.master_schedule_jobs_id_seq to service_role;

create function public.master_schedule_revision() returns trigger
language plpgsql set search_path='' as $$
begin
  new.revision:=old.revision+1; new.updated_at:=now(); return new;
end $$;
create trigger master_schedule_revision before update on public.master_schedule_jobs
for each row execute function public.master_schedule_revision();
revoke all on function public.master_schedule_revision() from public,anon,authenticated;

create function public.master_write_schedule(item jsonb) returns jsonb
language plpgsql set search_path='' as $$
declare before_row public.master_schedule_jobs; after_row public.master_schedule_jobs; next_row integer;
begin
  -- ponytail: one lock for manual schedule edits; use per-row locks if write throughput grows.
  perform pg_advisory_xact_lock(873652905);
  if item->>'id' is not null then
    select * into strict before_row from public.master_schedule_jobs where id=(item->>'id')::bigint for update;
    if not before_row.active or (item->>'revision')::bigint is distinct from before_row.revision then
      raise exception 'Lịch đã thay đổi — tải lại trước khi lưu';
    end if;
  end if;
  if item->>'active'='false' then
    if before_row.id is null then raise exception 'Thiếu ID lịch'; end if;
    update public.master_schedule_jobs set active=false where id=before_row.id returning * into after_row;
  else
    if not exists(select 1 from public.master_clients where customer_id=(item->>'pickup_id')::uuid and is_active)
       or not exists(select 1 from public.master_clients where customer_id=(item->>'dropoff_id')::uuid and is_active) then
      raise exception 'Địa điểm không tồn tại hoặc đã ngừng hoạt động';
    end if;
    if nullif(item->>'driver_id','') is not null and not exists(select 1 from public.master_drivers
       where driver_id=(item->>'driver_id')::uuid and is_active is distinct from false) then
      raise exception 'Tài xế không tồn tại hoặc đã ngưng hoạt động';
    end if;
    if before_row.id is null then
      select coalesce(max(source_row),1)+1 into next_row from public.master_schedule_jobs;
      insert into public.master_schedule_jobs(source_row,pickup_id,dropoff_id,driver_id,delivery_window,sent_to_driver_before,reference,days)
      values(next_row,(item->>'pickup_id')::uuid,(item->>'dropoff_id')::uuid,nullif(item->>'driver_id','')::uuid,
        (item->>'delivery_window')::time,(item->>'sent_to_driver_before')::integer,btrim(item->>'reference'),
        array(select value::boolean from jsonb_array_elements_text(item->'days'))) returning * into after_row;
    else
      update public.master_schedule_jobs set pickup_id=(item->>'pickup_id')::uuid,dropoff_id=(item->>'dropoff_id')::uuid,
        driver_id=nullif(item->>'driver_id','')::uuid,delivery_window=(item->>'delivery_window')::time,
        sent_to_driver_before=(item->>'sent_to_driver_before')::integer,reference=btrim(item->>'reference'),
        days=array(select value::boolean from jsonb_array_elements_text(item->'days'))
      where id=before_row.id returning * into after_row;
    end if;
  end if;
  return jsonb_build_object('id',after_row.id,'revision',after_row.revision,'row',after_row.source_row);
end $$;
revoke all on function public.master_write_schedule(jsonb) from public,anon,authenticated;
grant execute on function public.master_write_schedule(jsonb) to service_role;
