import { BASE_URL, getHeaders } from "./cartrack";
import { fetchSheetRows, SHEET_CONTRACT, SHEET_GID } from "./sheets";
import { getAdminToken, getReceptionistToken, listLocationsByClientCode, getCartrackCustomerId, listPickDropLocations } from "./labcenter";
import { sbSelect, sbSelectAll, sbUpsert } from "./supabase-rest";
import { nearestPsc, newWard } from "./master-geo";
import type { MasterClient } from "./master-store";

type CartrackRow = Record<string, unknown>;
type MasterDriver = { driver_id: string; cartrack: CartrackRow };

async function cartrackDetail(kind: "customers" | "drivers", id: string): Promise<CartrackRow> {
  const res = await fetch(`${BASE_URL}/${kind}/${id}`, { headers: getHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Cartrack ${kind}/${id}: HTTP ${res.status}`);
  const data = (await res.json()).data;
  const idKey = kind === "customers" ? "customer_id" : "delivery_driver_id";
  if (!data || typeof data !== "object" || String(data[idKey]) !== id) throw new Error(`Cartrack ${kind}/${id}: invalid detail`);
  return data;
}

// The list omits detail-only keys. Compare only keys supplied by the list and
// merge them into the last full record, or every refresh would erase details.
export function listedChanged(stored: CartrackRow | undefined, listed: CartrackRow): boolean {
  return !stored || Object.entries(listed).some(([key, value]) => stableJson(stored[key]) !== stableJson(value));
}
export const mergeCartrack = (stored: CartrackRow | undefined, listed: CartrackRow, detail?: CartrackRow | null) =>
  ({ ...stored, ...listed, ...detail });

/** A new Cartrack customer costs one detail read, not a full address-book scan. */
export async function syncCartrackClient(id: string): Promise<string | null> {
  const cartrack = await cartrackDetail("customers", id);
  const lat = coordinate(cartrack.latitude), lon = coordinate(cartrack.longitude);
  const psc = lat !== null && lon !== null ? await nearestPsc(lat, lon) : null;
  const code = String(cartrack.customer_name ?? "").split(/\s*-\s*/, 1)[0].trim();
  const clientCode = /^\d+$/.test(code) ? code : null;
  await sbUpsert("master_clients", [{
    customer_id: id, cartrack, client_code: clientCode,
    new_ward: lat !== null && lon !== null ? newWard(lat, lon) : null,
    nearest_psc_id: psc?.id ?? null, nearest_psc_name: psc?.name ?? null,
    nearest_psc_km: psc?.km ?? null, detail_synced_at: new Date().toISOString(),
  }], "customer_id");
  return clientCode;
}

export async function cartrackList(kind: "customers" | "drivers"): Promise<CartrackRow[]> {
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

// Postgres jsonb sorts object keys; Cartrack does not. Compare normalized JSON
// so a daily read does not rewrite every profile and burn Supabase egress.
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    : item);
}

// Import is one-time. The Google Sheet remains the assignment source until
// the migration is reviewed; a manual Cartrack refresh never overwrites it.
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
    return listedChanged(oldClients.get(id)?.cartrack, c);
  });
  const changedDrivers = drivers.filter((d) => listedChanged(oldDrivers.get(String(d.delivery_driver_id ?? ""))?.cartrack, d));
  const clientRows = await Promise.all(changedClients.map(async (c) => {
    const id = String(c.customer_id ?? "");
    const previous = oldClients.get(id);
    const detail = !previous && oldClients.size > 100 ? await cartrackDetail("customers", id).catch((e) => { console.error(e); return null; }) : null;
    const latitude = coordinate(c.latitude), longitude = coordinate(c.longitude);
    const psc = latitude !== null && longitude !== null ? await nearestPsc(latitude, longitude) : null;
    const name = String(c.customer_name ?? "");
    const candidate = name.split(/\s*-\s*/, 1)[0].trim();
    return {
      customer_id: c.customer_id,
      cartrack: mergeCartrack(previous?.cartrack, c, detail),
      ...(detail ? { detail_synced_at: now } : {}),
      client_code: /^\d+$/.test(candidate) ? candidate : null,
      new_ward: latitude !== null && longitude !== null ? newWard(latitude, longitude) : null,
      nearest_psc_id: psc?.id ?? null,
      nearest_psc_name: psc?.name ?? null,
      nearest_psc_km: psc?.km ?? null,
      synced_at: now,
    };
  }));
  await sbUpsert("master_clients", clientRows, "customer_id", 200);
  const driverRows = await Promise.all(changedDrivers.map(async (d) => {
    const id = String(d.delivery_driver_id ?? "");
    const previous = oldDrivers.get(id);
    const detail = !previous && oldDrivers.size > 100 ? await cartrackDetail("drivers", id).catch((e) => { console.error(e); return null; }) : null;
    return { driver_id: id, cartrack: mergeCartrack(previous?.cartrack, d, detail),
      ...(detail ? { detail_synced_at: now } : {}), synced_at: now };
  }));
  await sbUpsert("master_drivers", driverRows, "driver_id", 200);
  return { clients: clients.length, drivers: drivers.length, changedClients: changedClients.length, changedDrivers: changedDrivers.length, newClientCodes: [...newClientCodes] };
}

/** Explicit one-time/detail refresh, capped to avoid a Cartrack or Vercel spike. */
export async function syncCartrackDetailPage(kind: "customers" | "drivers", offset: number, limit: number) {
  const isClient = kind === "customers";
  const table = isClient ? "master_clients" : "master_drivers";
  const idKey = isClient ? "customer_id" : "driver_id";
  const rows = await sbSelect<Record<string, unknown>>(
    table, `select=${idKey},cartrack&order=${idKey}.asc&limit=${limit}&offset=${offset}`,
  );
  const updates: Record<string, unknown>[] = [];
  const failed: string[] = [];
  for (let i = 0; i < rows.length; i += 4) {
    await Promise.all(rows.slice(i, i + 4).map(async (row) => {
      const id = String(row[idKey]);
      try {
        const cartrack = mergeCartrack(row.cartrack as CartrackRow, await cartrackDetail(kind, id));
        const update: Record<string, unknown> = { [idKey]: id, cartrack, detail_synced_at: new Date().toISOString() };
        if (isClient) {
          const lat = coordinate(cartrack.latitude), lon = coordinate(cartrack.longitude);
          const psc = lat !== null && lon !== null ? await nearestPsc(lat, lon) : null;
          update.new_ward = lat !== null && lon !== null ? newWard(lat, lon) : null;
          update.nearest_psc_id = psc?.id ?? null;
          update.nearest_psc_name = psc?.name ?? null;
          update.nearest_psc_km = psc?.km ?? null;
        }
        updates.push(update);
      } catch (e) { failed.push(id); console.error(`Cartrack detail ${kind}/${id}:`, e); }
    }));
  }
  await sbUpsert(table, updates, idKey, 100);
  return { kind, offset, attempted: rows.length, updated: updates.length, failed };
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
  for (let i = 0; i < codes.length; i += 4) {
    await Promise.all(codes.slice(i, i + 4).map(async (code) => {
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
