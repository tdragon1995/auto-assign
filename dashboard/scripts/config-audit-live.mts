/**
 * Runs the config audit against the LIVE workbook and prints exactly what the
 * dashboard banner would say right now.
 *
 * Read-only: it touches Google, never Cartrack, never the engine, never Redis —
 * so it is safe to run at any hour and costs nothing but two CSV downloads.
 *
 * Use it after editing the sheet, and before deciding whether a warning that has
 * appeared is worth chasing today.
 *
 *   npx tsx scripts/config-audit-live.mts
 */

import type { AuditableRow, LocationRow, UnresolvedRows } from "../src/lib/config-audit";
const { fetchSheetRows, SHEET_CONTRACT, SHEET_GID } = await import("../src/lib/sheets");
const { parseTime, isValidDriverId } = await import("../src/lib/config");
const {
  findDuplicateBranches, findShiftOverlaps,
  duplicateBranchWarning, shiftOverlapWarning, unresolvedWarning,
} = await import("../src/lib/config-audit");

const isSunday = new Date(
  new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }),
).getDay() === 0;
const tab = isSunday ? "sunday" : "mapping";

console.log(`Reading "${SHEET_CONTRACT[tab].label}" and "${SHEET_CONTRACT.locations.label}"…\n`);

const rows = await fetchSheetRows(SHEET_GID[tab], SHEET_CONTRACT[tab]);

const mappings: AuditableRow[] = [];
const unresolved: UnresolvedRows = { pickups: [], drivers: [] };
const pickupNames = new Set<string>();

for (const row of rows) {
  const customer_id = row["customer_id"] ?? "";
  const driver_id = (row["driver_id"] ?? "").trim();
  const smart = (row["smart_driver_id"] ?? "").split(",").map((s) => s.trim()).filter(isValidDriverId);
  const pickupName = (row["Điểm Pick-up"] ?? "").trim();
  const driverName = (row["Driver"] ?? "").trim();
  if (pickupName) pickupNames.add(pickupName);

  if (!customer_id || (!driver_id && smart.length === 0)) {
    if (!customer_id && pickupName) unresolved.pickups.push(pickupName);
    else if (customer_id && driverName && !driver_id && smart.length === 0) {
      unresolved.drivers.push(`${pickupName || customer_id}: ${driverName}`);
    }
    continue;
  }
  mappings.push({
    customer_id, driver_id,
    first_name_last_name: driverName,
    shift_start: parseTime(row["shift_start"]),
    shift_end: parseTime(row["shift_end"]),
    // Blank on every row today; read anyway so this stays honest once the
    // per-destination column lands.
    dropoff_id: (row["dropoff_id"] ?? "").trim(),
  });
}

const locRows = await fetchSheetRows(SHEET_GID.locations, SHEET_CONTRACT.locations);
const locations = locRows.map((r): LocationRow => ({
  customer_name: r["customer_name"] ?? "",
  customer_id: r["customer_id"] ?? "",
}));

const dupes = findDuplicateBranches(locations, pickupNames);
const overlaps = findShiftOverlaps(mappings);

console.log(`  mapping rows read     ${rows.length}`);
console.log(`  usable rules          ${mappings.length}`);
console.log(`  locations read        ${locations.length}`);
console.log(`  distinct pickups      ${pickupNames.size}\n`);

const banners = [
  ["tên không ra mã", unresolvedWarning(unresolved)],
  ["trùng giờ", shiftOverlapWarning(overlaps)],
  ["tên trùng", duplicateBranchWarning(dupes)],
] as const;

let any = false;
for (const [label, msg] of banners) {
  if (!msg) { console.log(`  ok    ${label}: nothing to report`); continue; }
  any = true;
  console.log(`\n  WARN  ${label}\n        ${msg}\n`);
}

if (overlaps.length) {
  console.log("\nEvery overlapping pair:");
  for (const o of overlaps) console.log(`   ${o.customer_id}  ${o.drivers[0]}  /  ${o.drivers[1]}  ${o.window}`);
}
if (dupes.length) {
  console.log("\nEvery duplicated branch name:");
  for (const d of dupes) console.log(`   ${d.usedAsPickup ? "USED" : "    "}  ${d.name}  ->  ${d.ids.join(" , ")}`);
}

console.log(any ? "\nThe dashboard would show the warnings above." : "\nConfig is clean — no banner.");
