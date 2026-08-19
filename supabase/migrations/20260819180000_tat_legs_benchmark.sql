-- =============================================================================
-- Grade against whichever is HIGHER: the flat per-km rule, or Goong's estimate.
--
-- WHY. The flat rule (whole km × 4) is reproducible in a driver's head, which is
-- why it is the thing they are measured against — but it knows nothing about the
-- road. Measured over 3,956 real legs, on-time ran 55% for legs under 1 km against
-- 84% for legs over 12 km: the same fixed overhead every trip carries (out of the
-- parking area, first lights, finding the gate) eats an entire short leg's
-- allowance and rounds to nothing on a long one. Short-haul drivers were being
-- marked late for the shape of the formula, not for how they rode.
--
-- Taking the higher of the two fixes that without inventing a constant. Where the
-- road really is slow — dense inner-city, a 1.8 km crawl that Goong itself says
-- takes 14 minutes — the estimate lifts the bar to something achievable. Where
-- Goong is optimistic (open road, light traffic), the flat rule holds the floor,
-- so the benchmark can never drop BELOW what drivers are used to. Nobody's target
-- gets tighter than it is today; only the unfairly tight ones loosen.
--
-- STORED, NOT COMPUTED ON READ. Same rule as target_mins and distance_km: a driver
-- was measured against a specific number on a specific day, and recomputing it
-- later from a changed formula — or from a Goong estimate that has since shifted —
-- would silently rewrite whether they met it.
--
-- target_mins and eta_mins both stay, unchanged, so any verdict can be taken apart
-- into the two numbers that produced it.
--
-- Nullable, and null on existing rows: back-filling would assert a benchmark for
-- legs never judged against one. The next archive pass fills it in.
-- =============================================================================

alter table public.tat_legs
  add column if not exists benchmark_mins integer;

comment on column public.tat_legs.benchmark_mins is
  'The number this leg was actually graded against: max(target_mins, eta_mins), falling back to target_mins when Goong returned no estimate. on_time = tat_mins <= benchmark_mins.';
