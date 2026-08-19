-- =============================================================================
-- Store Goong's own travel-time estimate beside the fixed target.
--
-- WHY BOTH. target_mins is a flat rule — whole kilometres × 4 — and is what a
-- driver is measured against precisely because they can reproduce it in their
-- head. But it knows nothing about the road: a 5 km run down a clear arterial and
-- 5 km through Quận 1 at 17:00 get the same number. Goong's duration does know,
-- so showing them side by side separates "this driver was slow" from "this route
-- is slow", which is the distinction any fair conversation about a late leg needs.
--
-- eta_mins does NOT grade anything. It is a reference shown next to the verdict,
-- not a second verdict — a routing estimate is a model too, and swapping one model
-- for another silently would just move the argument rather than settle it.
--
-- COSTS NOTHING EXTRA. Goong returns distance and duration in the same response,
-- and the distance cache has been storing both all along; the archive was simply
-- throwing the duration away. Even already-cached pairs yield it with no new call.
--
-- Nullable, and left null on every existing row: back-filling would mean claiming
-- an estimate for legs that were never measured against one. The next archive pass
-- fills it in.
-- =============================================================================

alter table public.tat_legs
  add column if not exists eta_mins integer;

comment on column public.tat_legs.eta_mins is
  'Goong travel-time estimate for this leg, in minutes. Reference only — never used to grade; on_time compares tat_mins against target_mins.';
