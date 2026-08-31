import { Redis } from "@upstash/redis";
import type { Config, ConfigDriver, Mapping, UnfinishedConfigRow, CoverageGap } from "./types";
import { fetchSheetRows, isSheetShapeError, noteSheetLoad, noteSheetWarning, SHEET_CONTRACT, SHEET_GID } from "./sheets";
import {
  findDuplicateBranches, findShiftOverlaps, resolveGaps,
  duplicateBranchWarning, shiftOverlapWarning, unresolvedWarning,
  type LocationRow, type UnresolvedRows, type RuleRow,
} from "./config-audit";
import { vnDate, vnIsSunday, vnTimestamp } from "./time";
import { looksAutoCreated } from "./unmapped-row";

function getRedis(): Redis | null {
  const url   = process.env.KV_REST_API_URL   ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

// Shared invalidation stamp — what makes Refresh reach every instance instead of only the
// one that served it. In-memory caches are per-instance by nature, so the button could
// never clear the others; they kept their copy until they were recycled. Each load now
// compares a few bytes against the stamp its copy was built under and re-reads the sheet
// only when they differ. One tiny GET in place of a ~100 KB CSV download.
const GEN_KEY = "config:gen";
let cachedGen: string | null = null;

/** Current stamp, or null when Redis is unconfigured or unreachable. Null means "no reason
 *  to invalidate", deliberately: a Redis blip that made every instance re-download the
 *  sheet at the same moment is a worse failure than briefly missing a Refresh. */
async function readGen(): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    return (await redis.get<string>(GEN_KEY)) ?? null;
  } catch {
    return null;
  }
}

// L2 — the parsed mapping, shared by every instance and every deployment on this Redis.
// GEN_KEY stops an instance serving a STALE copy; it does nothing for a COLD one, which
// still re-downloads and re-parses ~100 KB of CSV before it can assign anything. Running
// the engine from two Vercel projects makes cold starts more frequent, so that download
// is the cost this closes. Mirrors the two-tier cache leave-config.ts already has.
//
// Keyed by gen AND date — both in the key, not compared after the read:
//   gen  — a Refresh moves every instance to a NEW key, so the old blob is orphaned
//          rather than overwritten. There is no window where the stamp reads "new" but
//          the payload is still the old one.
//   date — vnIsSunday() selects a different tab, so a Saturday blob served on Sunday
//          would assign every job from the wrong sheet, silently, all day.
//
// The TTL only reaps orphans (each Refresh strands the previous key). It is never the
// freshness mechanism — that is the gen stamp, deliberately, after a clock-based cache
// was measured at an 87% miss rate.
const L2_TTL_S = 48 * 60 * 60;
//   version — the `v7` below is NOT decoration. This blob is PARSED config, so a change to
//          how it is parsed (a renamed column, a new field) leaves every server reading a
//          blob built by the old code until someone presses Refresh. That is exactly how
//          the "Driver" column fix shipped and did nothing: correct code, stale parse.
//          Bump this whenever the parsing changes, and the deploy invalidates itself.
//          THE WARNING TEXT COUNTS AS PARSING. The audit's sentences are built from
//          this blob, and a warning is only republished when it CHANGES — so a
//          deploy that only rewords one leaves the OLD sentence on the dashboard
//          indefinitely, because the condition behind it never moved. That is
//          exactly what happened on 2026-08-31: two fixes to this wording shipped
//          and neither reached the screen. Hence the audit inputs now ride the blob
//          and the sentences are rebuilt on every load, cached or not.
const l2Key = (gen: string, date: string) => `config:v7:${gen}:${date}`;


let cachedConfig: Config | null = null;
// The VN date the cached config was built for. NOT a TTL — the cache is held until
// something invalidates it, because a clock-based one was near-useless here: 108 sheet
// downloads for 124 cron cycles over 12h, an 87% miss rate on a 5-minute TTL.
//
// Note WHY a 5-minute TTL missed against a 3-minute cron, since the arithmetic looks like
// it should have hit: the cache is per serverless INSTANCE. Requests spread across several
// instances, so any one instance sees the cron far less often than every 3 minutes and its
// timer has usually lapsed by the time it is called again. No TTL is short enough to fix
// that and long enough to be worth having — the problem was never the duration, it was
// that each instance was alone. GEN_KEY below is the actual fix. A sheet edit is applied
// by the dashboard's Refresh button (invalidateConfigCache), a deliberate act rather than
// something to poll for.
//
// The date is still checked because the mapping SOURCE changes with the day: vnIsSunday()
// picks a different tab, so an instance that cached Saturday's mapping and survived into
// Sunday would assign every job from the wrong sheet, silently and all day. Comparing a
// date string costs nothing and closes that.
//
// Cross-instance invalidation is handled by GEN_KEY above, not by a timer.
let cachedDay = "";

let cachedDrivers: ConfigDriver[] | null = null;
let cachedDriversAt = 0;
const DRIVERS_TTL_MS = 5 * 60 * 1000;

/** Clears this instance AND bumps the shared stamp, so every other warm instance drops its
 *  copy on its next load. Best-effort on the Redis write: a failure degrades to the old
 *  behaviour (this instance only), never to an error. */
export async function invalidateConfigCache(): Promise<void> {
  cachedConfig = null;
  cachedDay = "";
  cachedGen = null;
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(GEN_KEY, String(Date.now()));
  } catch { /* best-effort */ }
}

export function invalidateDriversCache(): void {
  cachedDrivers = null;
  cachedDriversAt = 0;
}

export function parseTime(
  str: string | undefined
): { hours: number; minutes: number } | null {
  if (!str) return null;
  const trimmed = str.trim();
  if (!trimmed) return null;

  // Match HH:MM or HH:MM:SS
  const match = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;

  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

  return { hours, minutes };
}

const DRIVER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Driver IDs from the sheet are usable only if they're real UUIDs. Broken
 *  spreadsheet references (#REF!, #N/A, …), blanks, or other junk would build a
 *  malformed assign URL (e.g. PUT /jobs/assign/#REF → Cartrack HTML 404), so we
 *  drop them at load time. */
export function isValidDriverId(id: string): boolean {
  return DRIVER_ID_RE.test(id.trim());
}

/** The Driver tab keeps every driver Cartrack returns, active or not, with the
 *  account flag in `is_active`. A blank (or missing column) counts as active —
 *  the flag is written by the Apps Script fetcher, so if that ever stops running
 *  we want a full picker, not an empty one. Only an explicit false excludes. */
function isDeactivatedRow(row: Record<string, string>): boolean {
  const v = (row["is_active"] ?? "").trim().toLowerCase();
  return v === "false" || v === "0" || v === "no";
}

export async function loadDriversFromSheet(): Promise<ConfigDriver[]> {
  if (cachedDrivers && Date.now() - cachedDriversAt < DRIVERS_TTL_MS) return cachedDrivers;
  try {
    const rows = await fetchSheetRows(SHEET_GID.drivers, SHEET_CONTRACT.drivers);
    const drivers: ConfigDriver[] = [];
    let skipped = 0;
    for (const row of rows) {
      const driver_id = (row["delivery_driver_id"] ?? "").trim();
      const name = (row["Driver"] ?? "").trim();
      if (!driver_id) continue;
      // A deactivated account can never take a job — Cartrack 422s the assign
      // ("Driver is deactivated…"). Leaving them in the picker only offers a
      // guaranteed failure, so they're dropped at load time.
      if (isDeactivatedRow(row)) {
        skipped++;
        continue;
      }
      drivers.push({ driver_id, name: name || driver_id });
    }
    // An empty roster is never real — there are always hundreds. Caching one
    // used to hold for the full 5 minutes and made the substitute picker reject
    // every name typed into it, because the only list it validates against was
    // briefly blank. Same discipline the mapping load has had all along.
    if (drivers.length === 0) {
      console.error("Driver roster load returned 0 rows — not caching");
      return cachedDrivers || [];
    }
    console.log(`Loaded ${drivers.length} active drivers from sheet (${skipped} deactivated skipped)`);
    noteSheetLoad(SHEET_CONTRACT.drivers.label, null);
    cachedDrivers = drivers.sort((a, b) => a.name.localeCompare(b.name));
    cachedDriversAt = Date.now();
    return cachedDrivers;
  } catch (e) {
    if (isSheetShapeError(e)) noteSheetLoad(e.sheetLabel, e);
    console.error("Error loading drivers from sheet:", e);
    return cachedDrivers || [];
  }
}

// Distinct alarm labels, one per fault. They share the banner with a refused tab
// but must never overwrite each other — a tab can be perfectly readable and still
// be carrying rows the engine cannot use.
const A_UNRESOLVED = "config — tên không ra mã";
const A_OVERLAP    = "config — trùng giờ";
const A_DUPE_LOC   = "Location Table — tên trùng";

/** The VN date the Location Table was last checked on this instance. That tab is
 *  ~700 KB and duplicates appear when someone creates a customer, not minute to
 *  minute — so it is read once a day per instance rather than on every parse. */
let locationsAuditedOn = "";

/**
 * Everything decidable from the sheet alone, reported the moment it is parsed.
 *
 * Never throws: an audit that broke the config load would be far worse than the
 * faults it looks for. The Location Table read is the only part that can fail,
 * and it is allowed to fail quietly and be retried tomorrow.
 */
/** The sentences, from data alone. Separate so the cached path can rebuild them
 *  without re-reading the sheet — see the version note on the L2 key. */
function emitConfigWarnings(
  tabLabel: string,
  mappings: Mapping[],
  unresolved: UnresolvedRows,
  nameByCustomer: ReadonlyMap<string, string>,
): void {
  const dropped = unresolvedWarning(unresolved);
  noteSheetWarning(A_UNRESOLVED, dropped && `${tabLabel}: ${dropped}`);
  noteSheetWarning(A_OVERLAP, shiftOverlapWarning(findShiftOverlaps(mappings, nameByCustomer)));
}

async function auditParsedConfig(
  tabLabel: string,
  mappings: Mapping[],
  unresolved: UnresolvedRows,
  pickupNames: Set<string>,
  nameByCustomer: Map<string, string>,
  today: string,
): Promise<void> {
  emitConfigWarnings(tabLabel, mappings, unresolved, nameByCustomer);

  if (locationsAuditedOn === today) return;
  try {
    const locRows = await fetchSheetRows(SHEET_GID.locations, SHEET_CONTRACT.locations);
    // Stamped only on success, so a failed read is retried on the next parse
    // rather than skipped for the rest of the day.
    locationsAuditedOn = today;
    noteSheetLoad(SHEET_CONTRACT.locations.label, null);
    const locations = locRows.map((r): LocationRow => ({
      customer_name: r["customer_name"] ?? "",
      customer_id: r["customer_id"] ?? "",
    }));
    noteSheetWarning(A_DUPE_LOC, duplicateBranchWarning(findDuplicateBranches(locations, pickupNames)));
  } catch (e) {
    // The engine does not read this tab, so a broken one costs only the check —
    // worth saying, never worth failing the config load for.
    if (isSheetShapeError(e)) noteSheetLoad(e.sheetLabel, e);
    console.error("Location Table audit skipped:", e);
  }
}

export async function loadConfigFromSheets(): Promise<Config | null> {
  const today = vnDate(new Date());
  // Read once and reuse for the write below, so a hit costs exactly one Redis GET.
  const gen = await readGen();
  if (cachedConfig && cachedDay === today && (gen === null || gen === cachedGen)) {
    return cachedConfig;
  }

  // L2 before the sheet: a cold instance pays one small Redis GET instead of the CSV
  // download plus parse. Skipped when gen is null (Redis absent, or a blip) — with no
  // stamp there is no safe key to read under, so fall through to the sheet.
  if (gen !== null) {
    const redis = getRedis();
    if (redis) {
      try {
        const hit = await redis.get<{ mappings: Mapping[]; unfinished?: UnfinishedConfigRow[]; gaps?: CoverageGap[]; parsedAt?: string; unresolved?: UnresolvedRows; names?: [string, string][] }>(l2Key(gen, today));
        // Same zero-length suspicion as the sheet path below: never adopt an empty
        // mapping, whatever it came from.
        if (hit && Array.isArray(hit.mappings) && hit.mappings.length > 0) {
          cachedConfig = { mappings: hit.mappings, unfinished: hit.unfinished ?? [], gaps: hit.gaps ?? [], parsedAt: hit.parsedAt ?? "" };
          cachedDay = today;
          cachedGen = gen;
          // Rebuild the sentences from the cached inputs. Pure string work, and
          // noteSheetWarning only marks a change when the text actually differs,
          // so a warm instance writes nothing — but a freshly deployed one now
          // says what the CURRENT code says instead of leaving an old sentence
          // standing until the underlying condition happens to move.
          emitConfigWarnings(
            SHEET_CONTRACT[vnIsSunday() ? "sunday" : "mapping"].label,
            hit.mappings,
            hit.unresolved ?? { pickups: [], drivers: [], dropoffs: [], invalidDriverIds: [] },
            new Map(hit.names ?? []),
          );
          return cachedConfig;
        }
      } catch { /* fall through to the sheet fetch */ }
    }
  }

  const tab = vnIsSunday() ? "sunday" : "mapping";
  try {
    const rows = await fetchSheetRows(SHEET_GID[tab], SHEET_CONTRACT[tab]);

    const mappings: Mapping[] = [];
    // Rows the parser is about to throw away, and the pickup names it saw. Both
    // are collected HERE because this is the only place that still knows what a
    // dropped row said — afterwards there is nothing left to report.
    const unresolved: UnresolvedRows = { pickups: [], drivers: [], dropoffs: [], invalidDriverIds: [] };
    // Branches with a line but nobody on it — the to-do list, read back out of
    // the sheet rather than kept anywhere else. See UnfinishedConfigRow.
    const unfinished: UnfinishedConfigRow[] = [];
    const pickupNames = new Set<string>();
    // customer id → branch name, so a warning can say the place rather than the id.
    const nameByCustomer = new Map<string, string>();
    // Rules per branch, carrying the sheet row so a boundary can later be moved.
    const rulesByCustomer = new Map<string, RuleRow[]>();
    for (const [idx, row] of rows.entries()) {
      const customer_id = row["customer_id"] ?? "";
      const driver_id = (row["driver_id"] ?? "").trim();
      // Drop junk smart-driver entries (e.g. a broken #REF sheet ref) so they
      // can never build a malformed assign URL. An invalid fixed driver_id is
      // left in place and reported at assign time (assign.ts), where it shows
      // in the Activity Log.
      const smart_driver_id = (row["smart_driver_id"] ?? "")
        .split(",").map((s) => s.trim()).filter(isValidDriverId);

      const pickupName = (row["Điểm Pick-up"] ?? "").trim();
      const driverName = (row["Driver"] ?? "").trim();
      const dropoffName = (row["Điểm Drop-off"] ?? "").trim();
      if (pickupName) pickupNames.add(pickupName);
      if (customer_id && pickupName && !nameByCustomer.has(customer_id)) nameByCustomer.set(customer_id, pickupName);
      // Checked BEFORE the drop test, and on rows that survive it: unlike the
      // other two this row is not thrown away, it just loses its destination
      // scope and starts taking jobs meant for someone else.
      // Present but not an id — a failed lookup spelled out in the cell. It slips
      // past a blank test, so it has to be named on its own.
      //
      // Only when there is no smart fallback: on a smart row the fixed-driver
      // lookup is EXPECTED to fail, because the name cell holds several drivers
      // and resolves to none. 218 rows look like that today and every one of
      // them works. Reporting those would bury the handful that cannot assign.
      if (driver_id && !isValidDriverId(driver_id) && smart_driver_id.length === 0) {
        unresolved.invalidDriverIds.push(`${pickupName || customer_id}: ${driver_id}`);
      }
      if (dropoffName && !(row["dropoff_id"] ?? "").trim()) {
        unresolved.dropoffs.push(`${pickupName || customer_id}: ${dropoffName}`);
      }

      if (!customer_id || (!driver_id && smart_driver_id.length === 0)) {
        // A row is dropped either because it is empty residue — most of this tab
        // is — or because a lookup stopped resolving. Only the second is worth
        // saying, and a typed NAME with no id beside it is what tells them apart.
        if (!customer_id && pickupName) unresolved.pickups.push(pickupName);
        else if (customer_id && driverName && !driver_id && smart_driver_id.length === 0) {
          unresolved.drivers.push(`${pickupName || customer_id}: ${driverName}`);
        } else if (customer_id && pickupName && !driverName) {
          // A branch that resolved, with the driver cell left empty. Nothing is
          // wrong with it — it is simply unfinished, and it is what the "Cần xử
          // lý" tab now offers to complete.
          //
          // +2 maps the parsed index to the sheet row: one for the header, one
          // for 1-based counting. Only a HINT — a save re-reads the row and
          // checks it still holds this branch before writing anything.
          const ws = (row["shift_start"] ?? "").trim(), we = (row["shift_end"] ?? "").trim();
          const window = ws && we ? `${ws}–${we}` : null;
          // Only lines this system created. The sheet also carries rows that have
          // simply never had a driver — a years-old test row, something abandoned
          // half-finished — and those are not work waiting on anyone. Listing
          // them buries the ones that are.
          if (looksAutoCreated(window)) {
            unfinished.push({ row: idx + 2, pickup_name: pickupName, dropoff_name: dropoffName, window });
          }
        }
        continue;
      }

      const rules = rulesByCustomer.get(customer_id);
      const thisRule: RuleRow = {
        row: idx + 2, driver: driverName,
        start: parseTime(row["shift_start"]), end: parseTime(row["shift_end"]),
      };
      if (rules) rules.push(thisRule); else rulesByCustomer.set(customer_id, [thisRule]);

      mappings.push({
        customer_id,
        driver_id,
        smart_driver_id,
        // Optional. Absent column ⇒ blank on every row ⇒ identical behaviour to
        // before it existed, which is what lets the code ship before the column
        // is added to the sheet. Deliberately NOT in SHEET_CONTRACT for the same
        // reason (footgun 3: requiring a column that isn't there refuses the tab
        // on every load and the engine then runs on a stale copy indefinitely).
        dropoff_id: (row["dropoff_id"] ?? "").trim(),
        // The sheet's name column is headed "Driver" — the same header the Driver tab
        // uses. Reading "first_name_last_name" found nothing on all 1390 rows, which is
        // why anything printing this name fell back to a raw UUID (the instant-assign
        // log line, the held-job preview). Old key kept as a fallback so a renamed
        // column degrades instead of blanking.
        first_name_last_name: row["Driver"] ?? row["first_name_last_name"] ?? "",
        shift_start: parseTime(row["shift_start"]),
        shift_end: parseTime(row["shift_end"]),
        bot_token: row["bot_token"] ?? "",
        chat_id: row["chat_id"] ?? "",
        alt_drop_off_id: row["alt_drop_off_id"] ?? "",
      });
    }

    if (mappings.length === 0) {
      // Zero mappings is almost certainly a bad/empty fetch (there are always
      // hundreds). Don't cache it — keep any prior good cache, else return null so
      // the next cycle retries instead of locking in an empty mapping.
      console.error("Config load returned 0 mappings — not caching");
      return cachedConfig;
    }

    noteSheetLoad(SHEET_CONTRACT[tab].label, null);
    // Which recorded gaps are still open, and which the config now covers. The
    // CLOSING is decided here, from the data, rather than by whoever recorded
    // it — an alarm only its author can retract outlives its author.
    let gaps: CoverageGap[] = [];
    try {
      const kv = await import("./smart-log-kv");
      const recorded = await kv.readCoverageGaps();
      if (recorded.length) {
        const { open, closed } = resolveGaps(recorded, rulesByCustomer);
        gaps = open;
        if (closed.length) await kv.clearCoverageGaps(closed);
      }
    } catch (e) {
      console.error("Coverage-gap resolve skipped:", e);
    }
    await auditParsedConfig(SHEET_CONTRACT[tab].label, mappings, unresolved, pickupNames, nameByCustomer, today);
    const parsedAt = vnTimestamp();
    cachedConfig = { mappings, unfinished, gaps, parsedAt };
    cachedDay = today;
    cachedGen = gen;

    // Write-behind, strictly AFTER the zero-mappings guard above. That ordering is the
    // whole safety story: a bad or partial parse cached here would poison every instance
    // on both deployments, where today it only poisons the one that fetched it.
    if (gen !== null) {
      const redis = getRedis();
      if (redis) {
        try {
          await redis.set(l2Key(gen, today), { mappings, unfinished, gaps, parsedAt, unresolved, names: [...nameByCustomer] }, { ex: L2_TTL_S });
        } catch { /* best-effort; the sheet is always the fallback */ }
      }
    }
    return cachedConfig;
  } catch (e) {
    // A SHAPE failure is a person to tell, not a request to retry: someone has
    // edited the tab into a state this parser cannot read. The stale copy still
    // serves, so the engine keeps running — which is exactly why it has to be
    // said out loud somewhere.
    if (isSheetShapeError(e)) noteSheetLoad(e.sheetLabel, e);
    console.error("Error loading config from sheets:", e);
    // Prefer stale cache over nothing on a transient fetch failure.
    return cachedConfig;
  }
}
