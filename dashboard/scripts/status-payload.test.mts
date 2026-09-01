/**
 * Pins that the dashboard receives EVERY field the status bundle computes.
 *
 * This has gone wrong three times, always the same way: a field is added to the
 * bundle, fetched correctly, typed correctly — and then not named again in the
 * reply, so it silently never leaves the server. It cost the refused-tab banner
 * (sheetAlarms, never once displayed), and then the config editor, which opened
 * with none of the branch's existing shifts because branchRules never arrived —
 * making it look as though a shift could only be replaced, never extended.
 *
 * Nothing in a code review catches it: the call site looks complete either way.
 * So the shape is asserted here instead.
 *
 *   npx tsx scripts/status-payload.test.mts
 */
import type { StatusBundle } from "../src/lib/smart-log-kv";
const { statusPayload } = await import("../src/lib/smart-log-kv");

let failed = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) return console.log(`  ok   ${label}`);
  failed++;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
}

// Every field the bundle can carry, each with a value that is easy to spot.
const bundle: StatusBundle = {
  state: { armedUntil: Date.now() + 60_000 } as StatusBundle["state"],
  lastChecked: "2026-09-01 07:03:12",
  deployments: [],
  logs: [
    { ts: "2026-09-01 07:00:00", level: "OK", msg: "older" },
    { ts: "2026-09-01 07:05:00", level: "OK", msg: "newer" },
  ],
  held: [],
  warnings: [],
  failed: [],
  sheetAlarms: [],
  unfinished: [],
  gaps: [{ customer_id: "C1", pickup_name: "BRA - D015", at: "05:32", also: [], before: null, after: null }],
  parsedAt: "2026-09-01 05:30:00",
  branchRules: { C1: [{ row: 900, driver: "An", start: "05:45", end: "07:30" }] },
};

const out = statusPayload(bundle, null) as Record<string, unknown>;

// The point of the test. Not "the fields I remembered" — every key the bundle has.
for (const key of Object.keys(bundle)) {
  ok(`${key} reaches the dashboard`, key in out);
}

ok("the editor gets the branch's existing shifts",
   JSON.stringify(out.branchRules) === JSON.stringify(bundle.branchRules),
   `got ${JSON.stringify(out.branchRules)}`);
ok("...and the time the sheet was read", out.parsedAt === bundle.parsedAt);
ok("armed is derived, not carried", out.armed === true);

{
  // The one field that is deliberately NOT passed through unchanged.
  const since = statusPayload(bundle, "2026-09-01 07:05:00") as Record<string, unknown>;
  ok("?since trims the log", (since.logs as unknown[]).length === 1);
  ok("...inclusively, so a same-second entry is not lost",
     (since.logs as { msg: string }[])[0].msg === "newer");
  ok("...and trims nothing else", (since.gaps as unknown[]).length === 1);
}

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
