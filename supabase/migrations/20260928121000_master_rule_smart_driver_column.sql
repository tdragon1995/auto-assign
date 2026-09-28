-- Keep the original comma-separated value visible beside the linked drivers.
alter table public.master_config_rules
  add column if not exists smart_driver_id text generated always as (nullif(row_data->>'smart_driver_id', '')) stored;
