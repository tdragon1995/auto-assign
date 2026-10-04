// Run: node --env-file=<production.env> --import tsx scripts/backfill-pickup-events.mts
// Reads existing Cartrack routes and upserts only retained pickup events.
import { getTimelineRoutes } from "../src/lib/cartrack";
import { archivePickupEvents } from "../src/lib/pickup-setup";
import { addDays, cartrackHistoryCutoff, vnDate } from "../src/lib/time";

const from = process.argv[2] ?? cartrackHistoryCutoff();
const to = process.argv[3] ?? addDays(vnDate(), -1);
const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && addDays(date, 0) === date;
if (!validDate(from) || !validDate(to) || from < cartrackHistoryCutoff() || from > to || to >= vnDate()) {
  throw new Error("Backfill must be within the retained period, through yesterday");
}
const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!url || new URL(url).hostname !== "odbmfkzkipklepmghjwj.supabase.co") {
  throw new Error("Expected the Diag Logistics production Supabase project");
}
for (let date = from; date <= to; date = addDays(date, 1)) {
  const routes = await getTimelineRoutes(date, "prod");
  if (!routes) throw new Error(`Cartrack fetch failed for ${date}; previous events preserved`);
  const count = await archivePickupEvents(routes, date);
  console.log(`${date}: ${count} completed pickups`);
}
