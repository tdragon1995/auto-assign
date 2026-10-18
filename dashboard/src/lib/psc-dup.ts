import { searchActiveStops, UNCOLLECTED_STOP_STATUSES, type Env } from "./cartrack";
import { isBlockingPickupStop, isFarWindowPickup } from "./job-filters";
import { vnMinutesSinceMidnight } from "./time";
import { PSC_VIA_LABEL } from "./via-legs";
import type { PscDupHit } from "./smart-log-kv";
import type { Stop } from "./types";

/** "BRA - D006" → "D006": the short code a booking's reference starts with. */
export const shortCode = (name: string) => name.replace(/^BRA\s*-\s*/i, "");

/**
 * The trip already booked for this pair whose samples have not been collected, found by
 * a LIVE Cartrack search on the reference "D006→D001" — the same search box as
 * Cartrack's delivery table, asked for unfinished stops only.
 *
 * Replaced reading a pair index out of the shared day copy (2026-10-14): that index had
 * to be republished with the whole day every cycle, and the guard then needed a live
 * re-check before it could refuse anyone anyway. One search measured 1.6–1.9s and 6–55
 * KB, all on Cartrack's side; it runs while the driver lookups are already in flight.
 *
 * Only references in the app's own "<pickup>→<dropoff>_" form count. A trip made by
 * hand in Cartrack under another name is not seen — accepted when this was chosen.
 * Via-legs share the format and are excluded by label, as they always were.
 *
 * "unavailable" when Cartrack could not answer: an unanswered question, never a clear
 * route.
 */
export async function livePairDuplicate(
  pickupCode: string, dropoffCode: string, today: string, env: Env,
): Promise<PscDupHit | null | "unavailable"> {
  const prefix = `${pickupCode}→${dropoffCode}`;
  // Uncollected stops only (1, 2, 3): a picked-up trip can never block, so it is not fetched.
  const stops = await searchActiveStops(today, prefix, env, UNCOLLECTED_STOP_STATUSES).catch(() => null);
  if (!stops) return "unavailable";
  const nowMin = vnMinutesSinceMidnight();
  const hit = stops.find((s) =>
    s.stop_type_id === 1
    && String(s.reference_number ?? "").startsWith(`${prefix}_`)
    && s.job_status_id !== 3 && s.job_status_id !== 7
    && !labelNames(s.labels).includes(PSC_VIA_LABEL)
    // The search already asked for unfinished stops; re-test anyway so a status the
    // filter lets through can never refuse a branch whose samples are gone.
    && isBlockingPickupStop(s as Stop)
    && !isFarWindowPickup(s as Stop, nowMin));
  return hit ? { job_id: Number(hit.job_id), reference_number: (hit.reference_number as string) ?? null } : null;
}

/** RPC labels arrive as `{ label }` objects, REST ones as strings. */
function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels.map((l) => (typeof l === "string" ? l : l?.label)).filter((l): l is string => typeof l === "string");
}
