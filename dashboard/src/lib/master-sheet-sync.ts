import { parseLeaveCsv, PROXY_3PL_DRIVER_ID } from "./leave-config";
import { assertCsvResponse, assertHeaders, sheetCsvUrl, SHEET_CONTRACT, SHEET_GID } from "./sheets";
import { stableJson } from "./master-sync";
import { sbDelete, sbPatch, sbRpc, sbSelectAll, sbUpsert } from "./supabase-rest";

type SheetRow = { source_row: number; row_data: Record<string, string> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEAVE_HEADERS = [
  "Ngày Nộp Đơn", "driver_id", "driver", "Loại Nghỉ", "leave_from", "leave_to",
  "leave_from_hr", "leave_to_hr", "day", "sub1_name", "sub1_id", "sub1_from",
  "sub1_to", "note", "Vị trí",
] as const;

async function sheetRows(gid: string, label: string, required: readonly string[]): Promise<SheetRow[]> {
  const res = await fetch(`${sheetCsvUrl(gid)}&_cb=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  assertCsvResponse(label, res);
  const [header, ...cells] = parseLeaveCsv(await res.text());
  if (!header || cells.length < 100) throw new Error(`${label}: suspiciously short export`);
  assertHeaders(label, header, required);
  const names = header.map((name) => name.trim());
  return cells.map((values, index) => ({
    source_row: index + 2,
    row_data: Object.fromEntries(names.flatMap((name, i) => name ? [[name, (values[i] ?? "").trim()]] : [])),
  }));
}

const ids = (value: string) => value.split(",").map((id) => id.trim().toLowerCase()).filter((id) => UUID.test(id));

/** Explicit Sheet → Supabase review refresh. The assignment source does not change. */
export async function syncConfigSheet(dryRun = false) {
  const [weekday, sunday, roster] = await Promise.all([
    sheetRows(SHEET_GID.mapping, SHEET_CONTRACT.mapping.label, SHEET_CONTRACT.mapping.require),
    sheetRows(SHEET_GID.sunday, SHEET_CONTRACT.sunday.label, SHEET_CONTRACT.sunday.require),
    sheetRows(SHEET_GID.drivers, SHEET_CONTRACT.drivers.label, SHEET_CONTRACT.drivers.require),
  ]);
  const desired = ([...weekday.map((r) => ({ ...r, day_type: "weekday" })),
    ...sunday.map((r) => ({ ...r, day_type: "sunday" }))])
    .filter((r) => r.row_data.customer_id || r.row_data["Điểm Pick-up"]);
  const [stored, clients, drivers] = await Promise.all([
    sbSelectAll<{ id: number; day_type: string; source_row: number; row_data: Record<string, string> }>(
      "master_config_rules", "select=id,day_type,source_row,row_data", "id.asc"),
    sbSelectAll<{ customer_id: string }>("master_clients", "select=customer_id", "customer_id.asc"),
    sbSelectAll<{ driver_id: string; roster: Record<string, string> | null; roster_source_row: number | null }>(
      "master_drivers", "select=driver_id,roster,roster_source_row", "driver_id.asc"),
  ]);
  if (desired.length < 100 || (stored.length && desired.length < stored.length * 0.8)) {
    throw new Error("Config sheet unexpectedly short; refusing to remove mirrored rules");
  }
  const clientIds = new Set(clients.map((c) => c.customer_id));
  const driverIds = new Set(drivers.map((d) => d.driver_id));
  for (const { row_data: row } of desired) {
    for (const id of [row.customer_id, row.dropoff_id, row.alt_drop_off_id].flatMap((v) => ids(v ?? ""))) {
      if (!clientIds.has(id)) throw new Error(`Cartrack client ${id} must be refreshed before config sync`);
    }
    for (const id of [row.driver_id, row.smart_driver_id].flatMap((v) => ids(v ?? ""))) {
      if (!driverIds.has(id)) throw new Error(`Cartrack driver ${id} must be refreshed before config sync`);
    }
  }
  const rosterRows = roster.filter((r) => r.row_data.Driver && r.row_data.delivery_driver_id);
  if (rosterRows.length < 100) throw new Error("Driver sheet unexpectedly short");
  if (new Set(rosterRows.map((r) => r.row_data.delivery_driver_id.toLowerCase())).size !== rosterRows.length) {
    throw new Error("Driver sheet contains duplicate driver IDs");
  }
  const oldDrivers = new Map(drivers.map((d) => [d.driver_id, d]));
  const rosterChanged = rosterRows.filter((r) => {
    const id = r.row_data.delivery_driver_id.toLowerCase();
    if (!UUID.test(id) || !oldDrivers.has(id)) throw new Error(`Cartrack driver ${id} must be refreshed before roster sync`);
    const old = oldDrivers.get(id)!;
    return old.roster_source_row !== r.source_row || stableJson(old.roster) !== stableJson(r.row_data);
  });
  const key = (r: { day_type: string; source_row: number }) => `${r.day_type}:${r.source_row}`;
  const old = new Map(stored.map((r) => [key(r), r]));
  const wanted = new Set(desired.map(key));
  const changed = desired.filter((r) => stableJson(old.get(key(r))?.row_data) !== stableJson(r.row_data));
  const removed = stored.filter((r) => !wanted.has(key(r)));
  if (!dryRun) {
    const now = new Date().toISOString();
    for (let i = 0; i < rosterChanged.length; i += 4) {
      await Promise.all(rosterChanged.slice(i, i + 4).map((r) => sbPatch(
        "master_drivers", `driver_id=eq.${r.row_data.delivery_driver_id.toLowerCase()}`,
        { roster: r.row_data, roster_source_row: r.source_row },
      )));
    }
    await sbUpsert("master_config_rules", changed.map((r) => ({ ...r, updated_at: now })), "day_type,source_row", 100);
    for (let i = 0; i < removed.length; i += 100) {
      await sbDelete("master_config_rules", `id=in.(${removed.slice(i, i + 100).map((r) => r.id).join(",")})`);
    }
    if (rosterChanged.length) await sbRpc<number>("refresh_master_smart_driver_ids");
  }
  return { total: desired.length, changed: changed.length, removed: removed.length, rosterChanged: rosterChanged.length };
}

/** Mirrors all meaningful leave rows, including rows with broken driver lookups. */
export async function syncLeaveSheet(dryRun = false) {
  const rows = (await sheetRows(SHEET_GID.nghi_phep, SHEET_CONTRACT.nghi_phep.label, LEAVE_HEADERS))
    .filter((r) => Object.values(r.row_data).some(Boolean));
  const [stored, drivers] = await Promise.all([
    sbSelectAll<{ source_row: number; row_data: Record<string, string>; linked_driver_id: string | null; linked_sub1_driver_id: string | null }>(
      "master_leave_rows", "select=source_row,row_data,linked_driver_id,linked_sub1_driver_id", "source_row.asc"),
    sbSelectAll<{ driver_id: string }>("master_drivers", "select=driver_id", "driver_id.asc"),
  ]);
  if (rows.length < 100 || (stored.length && rows.length < stored.length * 0.8)) {
    throw new Error("Leave sheet unexpectedly short; refusing to remove mirrored rows");
  }
  const driverIds = new Set(drivers.map((d) => d.driver_id));
  const link = (value: string | undefined) => {
    const id = value?.toLowerCase();
    return id && UUID.test(id) && driverIds.has(id) ? id : null;
  };
  const desired = rows.map((r) => ({ ...r,
    linked_driver_id: link(r.row_data.driver_id),
    linked_sub1_driver_id: r.row_data.sub1_id === PROXY_3PL_DRIVER_ID ? null : link(r.row_data.sub1_id),
  }));
  const old = new Map(stored.map((r) => [r.source_row, r]));
  const wanted = new Set(desired.map((r) => r.source_row));
  const changed = desired.filter((r) => {
    const before = old.get(r.source_row);
    return stableJson(before?.row_data) !== stableJson(r.row_data) ||
      before?.linked_driver_id !== r.linked_driver_id || before?.linked_sub1_driver_id !== r.linked_sub1_driver_id;
  });
  const removed = stored.filter((r) => !wanted.has(r.source_row));
  if (!dryRun) {
    const now = new Date().toISOString();
    await sbUpsert("master_leave_rows", changed.map((r) => ({ ...r, synced_at: now })), "source_row", 100);
    for (let i = 0; i < removed.length; i += 100) {
      await sbDelete("master_leave_rows", `source_row=in.(${removed.slice(i, i + 100).map((r) => r.source_row).join(",")})`);
    }
  }
  return { total: desired.length, changed: changed.length, removed: removed.length,
    unlinkedDrivers: desired.filter((r) => r.row_data.driver_id && !r.linked_driver_id).length,
    blankDriverIds: desired.filter((r) => !r.row_data.driver_id).length };
}
