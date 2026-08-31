/**
 * Pins the map link on a "Cần xử lý" row.
 *
 * The link is built from COORDINATES, never names: the branch names in that list
 * are internal codes ("BRA - D001", "3PL - TLT") that no map could place. The
 * thing that can break is parsing the compact "lat,lng;lat,lng" the cycle
 * publishes — a half-parsed pair would open a map of nowhere, which is worse
 * than the Cartrack link it replaced.
 *
 *   npx tsx scripts/gmaps-route.test.mts
 */
const { gmapsRoute } = await import("../src/components/failed-jobs-panel");

let failed = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) return console.log(`  ok   ${label}`);
  failed++;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
}

const url = gmapsRoute("11.0641,106.6672;10.7738,106.6640");
ok("a well-formed pair produces a link", !!url);
ok("...to Google's documented directions endpoint", !!url?.startsWith("https://www.google.com/maps/dir/?api=1"));
ok("...starting at the pickup", !!url?.includes("origin=11.0641%2C106.6672"));
ok("...ending at the destination", !!url?.includes("destination=10.7738%2C106.6640"));
ok("...by road", !!url?.includes("travelmode=driving"));
ok("the comma is escaped, so the coordinate survives the query string",
   !!url && !/origin=[^&]*,/.test(url));

// Every way the field can arrive unusable. Each must fall back, not half-build.
for (const [label, v] of [
  ["absent", undefined],
  ["empty", ""],
  ["only one end", "11.0641,106.6672"],
  ["trailing separator, no second end", "11.0641,106.6672;"],
  ["leading separator, no first end", ";10.7738,106.6640"],
  ["separator only", ";"],
] as const) {
  ok(`${label} → no link, so the row keeps its Cartrack fallback`, gmapsRoute(v as string | undefined) === null);
}

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
