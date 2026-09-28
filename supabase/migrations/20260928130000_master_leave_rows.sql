-- Review mirror of the Leave Status sheet. Assignment continues to read Google Sheets.
-- Source row and raw values survive blank/broken lookup formulas.
create table public.master_leave_rows (
  source_row integer primary key check (source_row >= 2),
  row_data jsonb not null,
  submitted_at text generated always as (row_data->>'Ngày Nộp Đơn') stored,
  driver_id text generated always as (row_data->>'driver_id') stored,
  driver_name text generated always as (row_data->>'driver') stored,
  leave_type text generated always as (row_data->>'Loại Nghỉ') stored,
  leave_from text generated always as (row_data->>'leave_from') stored,
  leave_to text generated always as (row_data->>'leave_to') stored,
  leave_from_hr text generated always as (row_data->>'leave_from_hr') stored,
  leave_to_hr text generated always as (row_data->>'leave_to_hr') stored,
  day text generated always as (row_data->>'day') stored,
  sub1_name text generated always as (row_data->>'sub1_name') stored,
  sub1_id text generated always as (row_data->>'sub1_id') stored,
  sub1_from text generated always as (row_data->>'sub1_from') stored,
  sub1_to text generated always as (row_data->>'sub1_to') stored,
  note text generated always as (row_data->>'note') stored,
  position text generated always as (row_data->>'Vị trí') stored,
  linked_driver_id uuid references public.master_drivers (driver_id),
  linked_sub1_driver_id uuid references public.master_drivers (driver_id),
  synced_at timestamptz not null default now()
);
alter table public.master_leave_rows enable row level security;
