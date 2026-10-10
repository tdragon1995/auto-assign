-- Sunday config without the formulas.
--
-- A Sunday rule was never really "pickup -> driver": the sheet's Driver column was
-- derived from the weekly public roster by AREA, and the area itself came from one
-- ~60-clause formula. So a Sunday rule is pickup + hours + area(s), and who drives
-- it is whoever the roster puts on that area for that Sunday.
--
-- areas: Sunday rules only (null on weekday). Empty array = no area, i.e. a rule
-- nobody can be assigned to — reported, never guessed.
alter table public.master_config_rules add column areas text[];

-- One line per person per area per Sunday. driver_id is null for an unfilled slot;
-- raw_name keeps a typed name that did not resolve, so an import never drops a line
-- silently.
create table public.master_sunday_roster (
  id bigint generated always as identity primary key,
  work_date date not null check (extract(isodow from work_date) = 7),
  area text not null check (btrim(area) <> ''),
  driver_id uuid references public.master_drivers(driver_id),
  raw_name text,
  shift text,
  note text,
  sort integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (work_date, area, driver_id)
);
create index master_sunday_roster_date on public.master_sunday_roster(work_date);
alter table public.master_sunday_roster enable row level security;
