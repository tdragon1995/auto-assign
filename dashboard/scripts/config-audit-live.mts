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
const unresolved: UnresolvedRows = { pickups: [], drivers: [], dropoffs: [], invalidDriverIds: [] };
const pickupNames = new Set<string>();

for (const row of rows) {
  const customer_id = row["customer_id"] ?? "";
  const driver_id = (row["driver_id"] ?? "").trim();
  const smart = (row["smart_driver_id"] ?? "").split(",").map((s) => s.trim()).filter(isValidDriverId);
  const pickupName = (row["Điểm Pick-up"] ?? "").trim();
  const driverName = (row["Driver"] ?? "").trim();
  const dropoffName = (row["Điểm Drop-off"] ?? "").trim();
  if (pickupName) pickupNames.add(pickupName);
  // Present but not an id — a failed lookup spelled out in the cell. It slips
  // past a blank test, so it has to be named on its own.
  //
  // Only when there is no smart fallback: on a smart row the fixed-driver
  // lookup is EXPECTED to fail, because the name cell holds several drivers
  // and resolves to none. 218 rows look like that today and every one of
  // them works. Reporting those would bury the handful that cannot assign.
  if (driver_id && !isValidDriverId(driver_id) && smart.length === 0) {
    unresolved.invalidDriverIds.push(`${pickupName || customer_id}: ${driver_id}`);
  }
  if (dropoffName && !(row["dropoff_id"] ?? "").trim()) {
    unresolved.dropoffs.push(`${pickupName || customer_id}: ${dropoffName}`);
  }

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

// Every column the contract names, and how much of it is actually there. This is
// the promotion evidence: an `expect` column present on every routing tab and
// carrying data is ready to become `require`; one still at 0 is not, and a
// `require` column at 0 is a column that passes its check while saying nothing.
const declared = [
  ...SHEET_CONTRACT[tab].require.map((c) => [c, "require"] as const),
  ...((SHEET_CONTRACT[tab] as { expect?: readonly string[] }).expect ?? []).map((c) => [c, "expect"] as const),
];
const header = rows.length ? Object.keys(rows[0]) : [];
console.log("Columns the contract names:");
for (const [col, tier] of declared) {
  const there = header.includes(col);
  const filled = there ? rows.filter((r) => (r[col] ?? "").trim()).length : 0;
  const note = !there ? (tier === "require" ? "MISSING — tab would be refused" : "missing — warning only")
    : filled === 0 ? "present, empty on every row"
    : `present, ${filled}/${rows.length}`;
  console.log(`  ${tier.padEnd(8)} ${col.padEnd(18)} ${note}`);
}
console.log();

console.log(`  mapping rows read     ${rows.length}`);
console.log(`  usable rules          ${mappings.length}`);
console.log(`  locations read        ${locations.length}`);
console.log(`  distinct pickups      ${pickupNames.size}\n`);

// Which columns the auto-written config row can fill, on BOTH tabs. The Sunday
// tab has no destination column yet, so a row written there covers every
// destination — correct and safe, but worth being able to see rather than
// remember. The writer looks these up by name, so a column appearing or moving
// is picked up with no code change.
{
  const { CONFIG_TABS, WRITE_COLS } = await import("../src/lib/sheets-writer");
  const letter = (i: number) => { let s = "", n = i; do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0); return s; };
  console.log("Columns the auto-written row fills:");
  for (const t of [CONFIG_TABS.weekday, CONFIG_TABS.sunday]) {
    const hdr = await fetchSheetRows(t.gid);
    const names = hdr.length ? Object.keys(hdr[0]) : [];
    const shown = Object.values(WRITE_COLS).map((c) => {
      const i = names.indexOf(c as string);
      return `${c}=${i < 0 ? "—" : letter(i)}`;
    });
    console.log(`  ${t.title.padEnd(26)} ${shown.join("  ")}`);
  }
  console.log();
}

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
