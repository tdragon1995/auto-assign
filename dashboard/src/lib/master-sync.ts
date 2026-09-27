import { BASE_URL, getHeaders } from "./cartrack";
import { fetchSheetRows, SHEET_CONTRACT, SHEET_GID } from "./sheets";
import { getAdminToken, getReceptionistToken, listLocationsByClientCode, getCartrackCustomerId, listPickDropLocations } from "./labcenter";
import { sbSelectAll, sbUpsert } from "./supabase-rest";
import { nearestPsc, newWard } from "./master-geo";
import type { MasterClient } from "./master-store";

type CartrackRow = Record<string, unknown>;
type MasterDriver = { driver_id: string; cartrack: CartrackRow };

async function cartrackList(kind: "customers" | "drivers"): Promise<CartrackRow[]> {
  const all: CartrackRow[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(`${BASE_URL}/${kind}?page=${page}&limit=1000`, {
      headers: getHeaders(), cache: "no-store",
    });
    if (!res.ok) throw new Error(`Cartrack ${kind} page ${page}: HTTP ${res.status}`);
    const rows = (await res.json()).data;
    if (!Array.isArray(rows)) throw new Error(`Cartrack ${kind} page ${page}: invalid response`);
    all.push(...rows);
    if (rows.length < 1000) break;
    if (page === 20) throw new Error(`Cartrack ${kind} exceeded 20 pages`);
  }
  return all;
}

function coordinate(value: unknown): number | null {
  const n = Number(value);
  return value === null || value === "" || !Number.isFinite(n) || n === 0 ? null : n;
}

// Import is one-time. Once cut over, Supabase rows are the editable master and
// the daily Cartrack sync never overwrites them with the old workbook.
export async function importCurrentConfig(): Promise<{ weekday: number; sunday: number; driverSettings: number }> {
  const [weekday, sunday, driverSheet] = await Promise.all([
    fetchSheetRows(SHEET_GID.mapping, SHEET_CONTRACT.mapping),
    fetchSheetRows(SHEET_GID.sunday, SHEET_CONTRACT.sunday),
    fetchSheetRows(SHEET_GID.drivers, SHEET_CONTRACT.drivers),
  ]);
  if (weekday.length < 100 || sunday.length === 0 || driverSheet.length < 100) {
    throw new Error("Refusing to import suspiciously short Sheet data");
  }
  const existing = await sbSelectAll<{ day_type: string; source_row: number; row_data: Record<string, string> }>(
    "master_config_rules", "select=day_type,source_row,row_data", "id.asc",
  );
  const used = (rows: Record<string, string>[], day_type: "weekday" | "sunday") => rows.flatMap((r, i) =>
    r.customer_id?.trim() || r["Điểm Pick-up"]?.trim() ? [{ day_type, source_row: i + 2, row_data: r }] : []);
  const desired = [...used(weekday, "weekday"), ...used(sunday, "sunday")];
  const imported = new Map(existing.map((r) => [`${r.day_type}:${r.source_row}`, r.row_data]));
  const desiredByRow = new Map(desired.map((r) => [`${r.day_type}:${r.source_row}`, r.row_data]));
  if (existing.some((r) => {
    const expected = desiredByRow.get(`${r.day_type}:${r.source_row}`);
    return !expected || Object.keys(expected).length !== Object.keys(r.row_data).length ||
      Object.entries(expected).some(([key, value]) => r.row_data[key] !== value);
  })) {
    throw new Error("Master config has changed since import; refusing to overwrite edits");
  }
  if (existing.length === desired.length) throw new Error("Master config already imported");
  const missing = desired.filter((r) => !imported.has(`${r.day_type}:${r.source_row}`));
  const profiles = await sbSelectAll<MasterDriver>("master_drivers", "select=driver_id,cartrack", "driver_id.asc");
  const byId = new Map(profiles.map((p) => [p.driver_id, p.cartrack]));
  const settings = driverSheet.filter((r) => r.delivery_driver_id && byId.has(r.delivery_driver_id)).map((r) => ({
    driver_id: r.delivery_driver_id,
    cartrack: byId.get(r.delivery_driver_id),
    roster: r,
    driver_zalo_id: r.driver_zalo_id || null,
    bot_token: r.bot_token || null,
    phone_number_update: r.phone_number_update || null,
  }));
  await sbUpsert("master_config_rules", missing, "day_type,source_row");
  await sbUpsert("master_drivers", settings, "driver_id");
  return { weekday: weekday.length, sunday: sunday.length, driverSettings: settings.length };
}

export async function syncCartrackProfiles(): Promise<{ clients: number; drivers: number; changedClients: number; changedDrivers: number; newClientCodes: string[] }> {
  const [clients, drivers] = await Promise.all([cartrackList("customers"), cartrackList("drivers")]);
  if (clients.length < 100 || drivers.length < 100) throw new Error("Refusing to replace profiles with an incomplete Cartrack response");
  const [storedClients, storedDrivers] = await Promise.all([
    sbSelectAll<MasterClient>("master_clients", "select=customer_id,cartrack,client_code", "customer_id.asc"),
    sbSelectAll<MasterDriver>("master_drivers", "select=driver_id,cartrack", "driver_id.asc"),
  ]);
  const oldClients = new Map(storedClients.map((c) => [c.customer_id, c]));
  const oldDrivers = new Map(storedDrivers.map((d) => [d.driver_id, d]));
  const now = new Date().toISOString();
  const newClientCodes = new Set<string>();
  const changedClients = clients.filter((c) => {
    const id = String(c.customer_id ?? "");
    const code = String(c.customer_name ?? "").split(/\s*-\s*/, 1)[0].trim();
    if (/^\d+$/.test(code) && oldClients.get(id)?.client_code !== code) newClientCodes.add(code);
    return JSON.stringify(oldClients.get(id)?.cartrack) !== JSON.stringify(c);
  });
  const changedDrivers = drivers.filter((d) => JSON.stringify(oldDrivers.get(String(d.delivery_driver_id ?? ""))?.cartrack) !== JSON.stringify(d));
  const clientRows = await Promise.all(changedClients.map(async (c) => {
    const latitude = coordinate(c.latitude), longitude = coordinate(c.longitude);
    const psc = latitude !== null && longitude !== null ? await nearestPsc(latitude, longitude) : null;
    const name = String(c.customer_name ?? "");
    const candidate = name.split(/\s*-\s*/, 1)[0].trim();
    return {
      customer_id: c.customer_id,
      cartrack: c,
      client_code: /^\d+$/.test(candidate) ? candidate : null,
      new_ward: latitude !== null && longitude !== null ? newWard(latitude, longitude) : null,
      nearest_psc_id: psc?.id ?? null,
      nearest_psc_name: psc?.name ?? null,
      nearest_psc_km: psc?.km ?? null,
      synced_at: now,
    };
  }));
  await sbUpsert("master_clients", clientRows, "customer_id", 200);
  await sbUpsert("master_drivers", changedDrivers.map((d) => ({
    driver_id: d.delivery_driver_id, cartrack: d, synced_at: now,
  })), "driver_id", 200);
  return { clients: clients.length, drivers: drivers.length, changedClients: changedClients.length, changedDrivers: changedDrivers.length, newClientCodes: [...newClientCodes] };
}

export async function syncLabcenterMetadata(offset = 0, limit = 200, onlyCodes?: string[]): Promise<{ matched: number; owners: number; errors: number; totalCodes: number }> {
  const [admin, receptionist] = await Promise.all([getAdminToken(), getReceptionistToken()]);
  if (!admin || !receptionist) throw new Error("Labcenter credentials unavailable");
  const [clients, pickDrops] = await Promise.all([
    sbSelectAll<MasterClient>("master_clients", "select=*&client_code=not.is.null", "customer_id.asc"),
    listPickDropLocations(admin),
  ]);
  if (pickDrops.length < 1000) throw new Error("Refusing incomplete Labcenter pick-drop list");
  const byPick = new Map(pickDrops.map((r) => [r.lc_location_id, r]));
  const changed = new Map<string, MasterClient>();
  const byCode = new Map<string, MasterClient[]>();
  for (const c of clients) {
    const code = c.client_code ?? "";
    if (!/^\d+$/.test(code)) continue;
    byCode.set(code, [...(byCode.get(code) ?? []), c]);
  }
  let matched = 0, owners = 0, errors = 0;
  const codes = onlyCodes ? [...new Set(onlyCodes)].filter((c) => byCode.has(c)) : [...byCode.keys()].sort().slice(offset, offset + limit);
  for (let i = 0; i < codes.length; i += 12) {
    await Promise.all(codes.slice(i, i + 12).map(async (code) => {
      try {
      const locations = await listLocationsByClientCode(code, admin);
      const clientIds = new Set(byCode.get(code)!.map((c) => c.customer_id));
      for (const loc of locations) {
        const known = byCode.get(code)!.find((c) => c.labcenter_location_id === loc.id);
        const cartrackId = known?.customer_id ?? await getCartrackCustomerId(loc.id, admin);
        if (!cartrackId || !clientIds.has(cartrackId)) continue;
        const setup = byPick.get(loc.id);
        const client = byCode.get(code)!.find((c) => c.customer_id === cartrackId)!;
        const dropoffId = setup ? await getCartrackCustomerId(setup.drop_location_id, admin) : null;
        Object.assign(client, {
          labcenter_location_id: loc.id, default_dropoff_id: dropoffId,
          default_dropoff_name: setup?.drop_name ?? null, eta_minutes: setup?.eta_mins ?? null,
        });
        changed.set(cartrackId, client);
        matched++;
      }
      const res = await fetch(`https://api.labcenter.vn/spc-pos/api/client?q=${encodeURIComponent(code)}`, {
        headers: { Authorization: `Bearer ${receptionist}` }, cache: "no-store",
      });
      if (!res.ok) return;
      const rows = (await res.json().catch(() => ({})))?.data;
      const owner = Array.isArray(rows) ? rows.find((r) => String(r.code) === code) : null;
      if (!owner) return;
      for (const c of byCode.get(code)!) {
        Object.assign(c, {
          sales_name: owner.owner_name ?? null, sales_email: owner.owner ?? null,
          supervisor_name: owner.supervisor ?? null, supervisor_email: owner.supervisor_email ?? null,
        });
        changed.set(c.customer_id, c);
      }
      owners += byCode.get(code)!.length;
      } catch (e) {
        errors++;
        console.error(`Master metadata ${code}:`, e);
      }
    }));
  }
  if (changed.size) await sbUpsert("master_clients", [...changed.values()], "customer_id", 200);
  return { matched, owners, errors, totalCodes: byCode.size };
}
