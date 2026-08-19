/**
 * Can we tell "idle because there was no work" from "idle with work waiting"?
 *
 * A leg is timed from the driver COMPLETING the previous stop to ARRIVING at the
 * next. If the next job did not exist yet, that clock counts an hour the driver
 * could not possibly have used — and since waits are now graded, it counts against
 * them. The fair start is the later of: when they left the last stop, and when the
 * next job actually became available to them.
 *
 * This probe answers whether Cartrack gives us that second timestamp, and how many
 * of today's flagged waits would change verdict if we used it.
 *
 *   npx tsx scripts/tat-idle-probe.mts [days]
 */
import fs from "node:fs";
import path from "node:path";
for (const line of fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const { getTimelineRoutes } = await import("../src/lib/cartrack");
const { legsForRoute, LONG_GAP_OVER_TARGET_MINS, MINS_PER_KM } = await import("../src/lib/tat");
const { haversineKm } = await import("../src/lib/distance");
const { vnDate, addDays } = await import("../src/lib/time");

const DAYS = Math.max(1, Math.min(Number(process.argv[2] ?? 3), 14));
const DETOUR = 1.35;

const t19 = (s: unknown) => (typeof s === "string" && s.length >= 19 ? `${s.slice(0, 10)}T${s.slice(11, 19)}+07:00` : null);

let stops = 0;
const present = { sendToDriverAt: 0, allowedToStartAt: 0, scheduledDeliveryTs: 0, deliveryWindow: 0 };
let gaps = 0, gapsExplainedByAvailability = 0, gapsStillGaps = 0, noSignal = 0;
let gapsWithWindow = 0, clearedByWindowAlone = 0;
const savedMins: number[] = [];

for (let back = 1; back <= DAYS; back++) {
  const date = addDays(vnDate(), -back);
  const routes = await getTimelineRoutes(date);
  if (!routes) { console.error(`  ${date}: unavailable`); continue; }

  // Index every stop's availability stamps by stopId so a leg can look up its own
  // destination without re-deriving the route.
  // Delivery windows arrive TIME-ONLY ("14:00:00+07"), so they need the trip date
  // bolted on before they mean anything as an instant.
  const windowStart = (w: { timeFrom?: string | null }[] | undefined): string | null => {
    const raw = w?.[0]?.timeFrom;
    const m = typeof raw === "string" ? /^(\d{2}):(\d{2})/.exec(raw) : null;
    return m ? `${date}T${m[1]}:${m[2]}:00+07:00` : null;
  };

  const byStop = new Map<number, { send: string | null; allowed: string | null; sched: string | null; win: string | null }>();
  for (const r of routes) {
    for (const s of (r.orderedStops ?? [])) {
      stops++;
      if (s.sendToDriverAt) present.sendToDriverAt++;
      if (s.allowedToStartAt) present.allowedToStartAt++;
      if (s.scheduledDeliveryTs) present.scheduledDeliveryTs++;
      const win = windowStart(s.deliveryWindows as { timeFrom?: string | null }[] | undefined);
      if (win) present.deliveryWindow++;
      if (s.stopId != null) byStop.set(s.stopId, {
        send: t19(s.sendToDriverAt), allowed: t19(s.allowedToStartAt), sched: t19(s.scheduledDeliveryTs), win,
      });
    }
  }

  for (const r of routes) {
    for (const leg of legsForRoute(r, date)) {
      if (leg.tat_mins == null || leg.from_lat == null || leg.to_lat == null) continue;
      const km = haversineKm(leg.from_lat, leg.from_lng!, leg.to_lat, leg.to_lng!) * DETOUR;
      const bench = Math.max(1, Math.ceil(km)) * MINS_PER_KM;
      if (leg.tat_mins - bench <= LONG_GAP_OVER_TARGET_MINS) continue;
      gaps++;

      const avail = leg.to_stop_id != null ? byStop.get(leg.to_stop_id) : undefined;
      // Earliest moment the driver could have set off toward this stop.
      if (avail?.win) gapsWithWindow++;
      const cand = [avail?.send, avail?.allowed, avail?.sched, avail?.win].filter(Boolean) as string[];
      if (cand.length === 0) { noSignal++; continue; }
      const availableAt = Math.max(...cand.map((c) => Date.parse(c)));
      const departed = Date.parse(leg.departed_ts!);
      const arrived = Date.parse(leg.arrived_ts!);

      // If the job only became available AFTER the driver already got there, they
      // did not wait for it — they arrived ahead of it. Availability then says
      // nothing about this leg, and using it would produce a negative duration.
      const effective = availableAt < arrived ? availableAt : departed;
      const fairStart = Math.max(departed, effective);
      const fairMins = Math.round((arrived - fairStart) / 60000);

      if (fairMins - bench <= LONG_GAP_OVER_TARGET_MINS) {
        gapsExplainedByAvailability++;
        savedMins.push(leg.tat_mins - fairMins);
        // Would the window ALONE have cleared it? Tells us whether windows carry
        // signal the other stamps miss.
        if (avail?.win) {
          const wOnly = Math.round((arrived - Math.max(departed, Date.parse(avail.win))) / 60000);
          if (wOnly >= 0 && wOnly - bench <= LONG_GAP_OVER_TARGET_MINS) clearedByWindowAlone++;
        }
      } else gapsStillGaps++;
    }
  }
  console.error(`  ${date}: done`);
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
console.log(`\nStops examined: ${stops}`);
console.log("Availability stamps present:");
for (const [k, v] of Object.entries(present)) console.log(`  ${k.padEnd(22)} ${pct(v, stops)}%  (${v})`);

console.log(`\nFlagged waits: ${gaps}`);
console.log(`  would clear once "job did not exist yet" is honoured: ${gapsExplainedByAvailability} (${pct(gapsExplainedByAvailability, gaps)}%)`);
console.log(`  genuinely idle with work already available:           ${gapsStillGaps} (${pct(gapsStillGaps, gaps)}%)`);
console.log(`  of the flagged waits, ${gapsWithWindow} had a delivery window (${pct(gapsWithWindow, gaps)}%)`);
console.log(`  cleared by the WINDOW alone:                          ${clearedByWindowAlone}`);
console.log(`  no availability stamp to judge by:                    ${noSignal} (${pct(noSignal, gaps)}%)`);
if (savedMins.length) {
  const sorted = [...savedMins].sort((a, b) => a - b);
  console.log(`  median minutes wrongly charged per cleared leg:      ${sorted[Math.floor(sorted.length / 2)]}`);
}
