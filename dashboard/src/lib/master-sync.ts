import { BASE_URL, getHeaders } from "./cartrack";
import { getAdminToken, getReceptionistToken, listLocationsByClientCode, getCartrackCustomerId, listPickDropLocations } from "./labcenter";
import { sbSelect, sbSelectAll, sbUpsert, sbRpc } from "./supabase-rest";
import { nearestPsc, newWard, GEO_DATASET_VERSION } from "./master-geo";
import type { MasterClient } from "./master-store";
import { UUID, type SourceRow } from "./master-reconcile";

type CartrackRow = Record<string, unknown>;
type MasterDriver = { driver_id: string; cartrack: CartrackRow; detail_synced_at?: string | null };

/** Fetch only unknown UUIDs referenced by this import; never scan all profiles here. */
export async function syncMissingProfiles(rows:SourceRow[], clients:Set<string>, drivers:Set<string>) {
  const wantedClients=new Set<string>(),wantedDrivers=new Set<string>();
  for(const {row_data:r} of rows) {
    for(const field of ["customer_id","dropoff_id","alt_drop_off_id"]) if(UUID.test(r[field]??"") && !clients.has(r[field])) wantedClients.add(r[field]);
    for(const field of ["driver_id","smart_driver_id","sub1_id","sub2_id","sub3_id","sub4_id"]) for(const id of (r[field]??"").split(",").map(s=>s.trim()))
      if(UUID.test(id) && !drivers.has(id)) wantedDrivers.add(id);
  }
  if(wantedClients.size+wantedDrivers.size>200) throw new Error("More than 200 unknown profiles; refresh profiles before importing");
  for(const id of wantedClients) {await syncCartrackClient(id);clients.add(id);}
  for(const id of wantedDrivers) {
    const cartrack=await cartrackDetail("drivers",id);
    for(const key of ["start_location_customer_id","end_location_customer_id"]) {
      const location=String(cartrack[key]??"");
      if(UUID.test(location) && !clients.has(location)) {await syncCartrackClient(location);clients.add(location);}
    }
    await sbUpsert("master_drivers",[{driver_id:id,cartrack,detail_synced_at:new Date().toISOString()}],"driver_id");
    drivers.add(id);
  }
}

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
    nearest_psc_km: psc?.km ?? null, geo_calculated_at: new Date().toISOString(), geo_dataset_version: GEO_DATASET_VERSION, detail_synced_at: new Date().toISOString(),
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

export async function syncCartrackProfiles(): Promise<{ clients: number; drivers: number; changedClients: number; changedDrivers: number; newClientCodes: string[] }> {
  const [clients, drivers] = await Promise.all([cartrackList("customers"), cartrackList("drivers")]);
  if (clients.length < 100 || drivers.length < 100) throw new Error("Refusing to replace profiles with an incomplete Cartrack response");
  const [storedClients, storedDrivers] = await Promise.all([
    sbSelectAll<MasterClient>("master_clients", "select=customer_id,cartrack,client_code", "customer_id.asc"),
    sbSelectAll<MasterDriver>("master_drivers", "select=driver_id,cartrack,detail_synced_at", "driver_id.asc"),
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
  const changedDrivers = drivers.filter((d) => {
    const previous = oldDrivers.get(String(d.delivery_driver_id ?? ""));
    return !previous?.detail_synced_at || listedChanged(previous.cartrack, d);
  });
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
      ...(previous?.client_code !== (/^\d+$/.test(candidate) ? candidate : null) ? {account_id:null} : {}),
      cartrack: mergeCartrack(previous?.cartrack, c, detail),
      ...(detail ? { detail_synced_at: now } : {}),
      client_code: /^\d+$/.test(candidate) ? candidate : null,
      new_ward: latitude !== null && longitude !== null ? newWard(latitude, longitude) : null,
      nearest_psc_id: psc?.id ?? null,
      nearest_psc_name: psc?.name ?? null,
      nearest_psc_km: psc?.km ?? null, geo_calculated_at: new Date().toISOString(), geo_dataset_version: GEO_DATASET_VERSION,
      synced_at: now,
    };
  }));
  await sbUpsert("master_clients", clientRows, "customer_id", 200);
  const driverRows = await Promise.all(changedDrivers.map(async (d) => {
    const id = String(d.delivery_driver_id ?? "");
    const previous = oldDrivers.get(id);
    const detail = !previous?.detail_synced_at && oldDrivers.size > 100 ? await cartrackDetail("drivers", id).catch((e) => { console.error(e); return null; }) : null;
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
  const changed = new Map<string, Record<string,unknown>>();
  const accounts:Record<string,unknown>[]=[];
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
        const dropoffId = setup ? await getCartrackCustomerId(setup.drop_location_id, admin) : null;
        changed.set(cartrackId, {...changed.get(cartrackId), customer_id:cartrackId,
          labcenter_location_id: loc.id, default_dropoff_id: dropoffId,
          default_dropoff_name: setup?.drop_name ?? null, eta_minutes: setup?.eta_mins ?? null,
        });
        matched++;
      }
      const res = await fetch(`https://api.labcenter.vn/spc-pos/api/client?q=${encodeURIComponent(code)}`, {
        headers: { Authorization: `Bearer ${receptionist}` }, cache: "no-store",
      });
      if (!res.ok) return;
      const rows = (await res.json().catch(() => ({})))?.data;
      const owner = Array.isArray(rows) ? rows.find((r) => String(r.code) === code) : null;
      if (!owner) return;
      accounts.push({client_code:code,verified_at:new Date().toISOString(),
        sales_name:owner.owner_name??null,sales_email:owner.owner??null,supervisor_name:owner.supervisor??null,supervisor_email:owner.supervisor_email??null});
      for (const c of byCode.get(code)!) {
        changed.set(c.customer_id, {...changed.get(c.customer_id), customer_id:c.customer_id,
          sales_name: owner.owner_name ?? null, sales_email: owner.owner ?? null,
          supervisor_name: owner.supervisor ?? null, supervisor_email: owner.supervisor_email ?? null,
        });
      }
      owners += byCode.get(code)!.length;
      } catch (e) {
        errors++;
        console.error(`Master metadata ${code}:`, e);
      }
    }));
  }
  if(accounts.length) await sbRpc("master_sync_accounts",{accounts});
  if (changed.size) await sbUpsert("master_clients", [...changed.values()], "customer_id", 200);
  return { matched, owners, errors, totalCodes: byCode.size };
}
