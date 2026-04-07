const SHEET_ID = "1Bqsm5atLYUQ4gMsL7zHrbrS6YUu7pEDa-Iy_j_wpCss";
const PSC_SHEET_GID = "281585585";
const MAPPING_SHEET_GID = "0";
const TPL_SHEET_GID = "934328932";

const PSC_SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${PSC_SHEET_GID}`;
const MAPPING_SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${MAPPING_SHEET_GID}`;
const TPL_SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${TPL_SHEET_GID}`;

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface PscRoute {
  psc_pickup: string;
  dropoff_location: string;
  pickup: string;
  dropoff: string;
  ref_number: string;
}

export interface TplEntry {
  psc_tinh: string;
  tpl_name: string;
  tpl_uuid: string;
  address: string;
}

export interface DriverMapping {
  customer_id: string;
  driver_id: string;
  driver_name: string;
  shift_start: string;
  shift_end: string;
}

// ── In-memory cache ──────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  ts: number;
}

let routesCache: CacheEntry<PscRoute[]> | null = null;
let mappingsCache: CacheEntry<DriverMapping[]> | null = null;
// Pre-built lookup: customer_id → DriverMapping
let mappingsIndex: Map<string, DriverMapping> | null = null;

function isFresh<T>(entry: CacheEntry<T> | null): entry is CacheEntry<T> {
  return entry !== null && Date.now() - entry.ts < CACHE_TTL_MS;
}

/** Called by dashboard Refresh button to bust the cache */
export function invalidatePscCache() {
  routesCache = null;
  mappingsCache = null;
  mappingsIndex = null;
}

export async function loadTplEntries(): Promise<TplEntry[]> {
  const res = await fetch(TPL_SHEET_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const text = await res.text();
  const rows = parseCSV(text);

  return rows
    .filter((r) => r["psc-tinh"] && r["3pl_uuid"])
    .map((r) => ({
      psc_tinh: r["psc-tinh"] ?? "",
      tpl_name: r["3pl"] ?? "",
      tpl_uuid: r["3pl_uuid"] ?? "",
      address: r["address"] ?? "",
    }));
}

// ── CSV parsing ──────────────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

function parseCSV(text: string): Record<string, string>[] {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim());
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]).map((h) => h.trim());
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = (values[idx] ?? "").trim();
    });
    rows.push(row);
  }
  return rows;
}

// ── Public API ───────────────────────────────────────────────────

export async function loadPscRoutes(): Promise<PscRoute[]> {
  if (isFresh(routesCache)) return routesCache.data;

  const res = await fetch(PSC_SHEET_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const text = await res.text();
  const rows = parseCSV(text);

  const data = rows
    .filter((r) => r["psc_pickup"] && r["pickup"])
    .map((r) => ({
      psc_pickup: r["psc_pickup"] ?? "",
      dropoff_location: r["dropoff_location"] ?? "",
      pickup: r["pickup"] ?? "",
      dropoff: r["dropoff"] ?? "",
      ref_number: r["ref_number"] ?? "",
    }));

  routesCache = { data, ts: Date.now() };
  return data;
}

export async function loadDriverMappings(): Promise<DriverMapping[]> {
  if (isFresh(mappingsCache)) return mappingsCache.data;

  const res = await fetch(MAPPING_SHEET_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const text = await res.text();
  const rows = parseCSV(text);

  const data: DriverMapping[] = [];
  const index = new Map<string, DriverMapping>();

  for (const row of rows) {
    const customer_id = row["customer_id"] ?? "";
    const driver_id = row["driver_id"] ?? "";
    if (!customer_id || !driver_id) continue;

    const m: DriverMapping = {
      customer_id,
      driver_id,
      driver_name: row["Driver"] ?? row["first_name_last_name"] ?? "",
      shift_start: row["shift_start"] ?? "",
      shift_end: row["shift_end"] ?? "",
    };
    data.push(m);
    index.set(customer_id, m);
  }

  mappingsCache = { data, ts: Date.now() };
  mappingsIndex = index;
  return data;
}

/** O(1) lookup: PSC.pickup → config.customer_id → driver */
export function findDriverForPickup(
  _mappings: DriverMapping[],
  pickupCustomerId: string
): DriverMapping | null {
  return mappingsIndex?.get(pickupCustomerId) ?? null;
}
