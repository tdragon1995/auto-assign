-- AO "Lịch sử in": every hard-copy handover sheet printed, kept 60 days so a
-- VID can be traced back to the sheet it went out on. Moved off Redis, where the
-- page had to download every print in full just to list them.
-- Nothing deletes a print except the 60-day expiry inside ao_save_print.
create table if not exists public.ao_prints (
  id uuid primary key,
  printed_at timestamptz not null default now(),
  title text not null check (title in ('D001', 'Ngoài D001')),
  row_count int not null
);
create index if not exists ao_prints_printed_at on public.ao_prints (printed_at desc);
alter table public.ao_prints enable row level security;

create table if not exists public.ao_print_rows (
  print_id uuid not null references public.ao_prints(id) on delete cascade,
  idx int not null,
  dest text not null,
  client text not null,
  vid text not null,
  patient text not null,
  billing text not null,
  note text not null,
  primary key (print_id, idx)
);
create index if not exists ao_print_rows_vid on public.ao_print_rows (vid);
alter table public.ao_print_rows enable row level security;

-- One call = one print, atomically. The browser picks the id, so a retried save
-- (reply lost) lands once; an existing print is returned as is, never overwritten.
create or replace function public.ao_save_print(print_id uuid, print_title text, print_rows jsonb, printed timestamptz default now())
returns public.ao_prints
language plpgsql
set search_path to ''
as $$
declare p public.ao_prints;
begin
  delete from public.ao_prints where printed_at < now() - interval '60 days';
  insert into public.ao_prints(id, printed_at, title, row_count)
  values (print_id, printed, print_title, jsonb_array_length(print_rows))
  on conflict (id) do nothing
  returning * into p;
  if p.id is null then
    select * into p from public.ao_prints where id = print_id;
    return p;
  end if;
  insert into public.ao_print_rows(print_id, idx, dest, client, vid, patient, billing, note)
  select print_id, (r.ord - 1)::int, r.v->>'dest', r.v->>'client', r.v->>'vid', r.v->>'patient', r.v->>'billing', r.v->>'note'
  from jsonb_array_elements(print_rows) with ordinality as r(v, ord);
  return p;
end $$;
revoke all on function public.ao_save_print(uuid, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.ao_save_print(uuid, text, jsonb, timestamptz) to service_role;
