/**
 * Read-only probe: run every real reader against the LIVE workbook with the
 * contracts on, and confirm none of them refuses it. A contract requiring a
 * column the sheet does not have would refuse that tab on EVERY load, leaving the
 * engine on a stale copy indefinitely — so this is the check that matters before
 * pushing. No Redis configured, so the caches degrade and every call really does
 * hit the sheet.
 *
 * Run it whenever SHEET_CONTRACT changes, and whenever someone reports having
 * reorganised a tab:
 *
 *   npx tsx scripts/sheet-contract-live.mts
 */
const { loadConfigFromSheets, loadDriversFromSheet } = await import("../src/lib/config");
const { loadTplEntries } = await import("../src/lib/psc-config");
const { loadScheduleJobRows } = await import("../src/lib/schedule-job");
const { loadLeaveEntries } = await import("../src/lib/leave-config");
const { drainSheetAlarms, fetchSheetRowsByName, SHEET_CONTRACT } = await import("../src/lib/sheets");

let bad = 0;
async function probe(name: string, fn: () => Promise<number>) {
  try {
    const n = await fn();
    if (n > 0) console.log(`  ok   ${name}: ${n} rows`);
    else { bad++; console.error(`  FAIL ${name}: 0 rows`); }
  } catch (e) {
    bad++;
    console.error(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

await probe("mapping/sunday (today's tab)", async () => (await loadConfigFromSheets())?.mappings.length ?? 0);
await probe("Driver roster", async () => (await loadDriversFromSheet()).length);
await probe("Leave Status", async () => (await loadLeaveEntries()).length);
await probe("3PL", async () => (await loadTplEntries()).length);
await probe("Scheduled Setup", async () => (await loadScheduleJobRows()).length);
await probe("PUBLIC SUNDAY SCHEDULE", async () =>
  (await fetchSheetRowsByName("(Edit weekly) PUBLIC SUNDAY SCHEDULE", SHEET_CONTRACT.public_sunday)).length);

const raised = (drainSheetAlarms() ?? []).filter((a) => a.reason);
if (raised.length) { bad++; console.error(`\n  FAIL live sheet raised alarms: ${JSON.stringify(raised)}`); }
else console.log("\n  ok   no tab was refused");

console.log(bad === 0 ? "\nLive sheet passes every contract." : `\n${bad} problem(s).`);
process.exit(bad === 0 ? 0 : 1);
