-- Keep the Sheet-shaped row_data as the source while making shifts visible
-- and automatically current in the Supabase table editor.
alter table public.master_config_rules
  add column if not exists shift_start text generated always as (nullif(row_data->>'shift_start', '')) stored,
  add column if not exists shift_end text generated always as (nullif(row_data->>'shift_end', '')) stored;
