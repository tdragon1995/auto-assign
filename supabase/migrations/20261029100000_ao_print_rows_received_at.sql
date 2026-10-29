-- The PSC ticks a hard-copy result off on its /qr page when the paper arrives. A mark on
-- the printed row, never a delete: print history is never deleted (user rule, 2026-10-27).
alter table public.ao_print_rows add column if not exists received_at timestamptz;
