import { NextRequest, NextResponse } from "next/server";
import { fetchSheetRows, SHEET_CONTRACT, SHEET_GID } from "@/lib/sheets";
import { readConfigGen } from "@/lib/config-gen";
import { dailyDriverShifts } from "@/lib/driver-shifts";
import { vnDate, vnTimestamp } from "@/lib/time";
import { masterClients, masterDrivers, masterEnabled, masterRuleRows } from "@/lib/master-store";
import { publicClient, publicDriver } from "@/lib/master-public";
import { loadPickupVolumes } from "@/lib/pickup-setup";

import { resolveConfigDay, type ConfigDay } from "@/lib/config-day";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

/**
 * The config table itself, for reading and searching on the dashboard.
 *
 * DELIBERATELY NOT part of the 90-second status poll. This is ~1,700 rows; the
 * poll ships a few log lines. It is fetched when someone opens the config tab
 * and at most once every few minutes after that, because the alternative —
 * carrying the table in the snapshot every cycle — would put a few hundred KB
 * through Redis and the browser on a loop to answer a question nobody is asking
 * most of the time.
 *
 * It also does NOT go through loadConfigFromSheets. That returns the parsed
 * Mapping, which by design carries no sheet row and no branch NAME — a row
 * number on all 1,700 would grow the cached blob to label a handful. Browsing
 * needs exactly those two things, so this reads the tab on its own and keeps a
 * slim copy.
 *
 * Defaults to today; an explicit day browses the other roster without changing
 * the operational engine.
 */

export interface ConfigRowView {
  rule_id?: number;
  revision?: number;
  assignment_mode?: "fixed" | "smart";
  /** 1-based sheet row, so an edit elsewhere can address it. */
  row: number;
  customer_id: string;
  pickup: string;
  /** The Driver cell verbatim — one name, or several for a smart row. */
  driver: string;
  driver_ids?: string[];
  start: string;
  end: string;
  /** Destination this rule is scoped to; blank means every destination. */
  dropoff: string;
  /** Client metadata joined in the browser; undefined until the profile is loaded. */
  default_dropoff?: string;
  alt_drop_off_id?: string;
  /** True when the cell names several drivers: the engine ranks them by
   *  distance rather than treating them as competing rules. */
  smart: boolean;
  /** Display-only Cartrack client without a weekday Google Sheet mapping. */
  unmapped?: boolean;
}

/**
 * `gen` is the shared config stamp this copy was built under.
 *
 * The TTL alone made both of the Config tab's freshness bugs. Every writer here
 * calls `invalidateConfigCache`, which clears the ENGINE's cache and moves the
 * stamp — but nothing touched this one, so a rule edited from "Cần xử lý" kept
 * reading the pre-edit row for up to five minutes, and "Tải lại" spent the whole
 * of that window re-fetching a route that answered from memory. The button
 * looked broken because from the outside it was: it did exactly nothing.
 *
 * The stamp is the right signal rather than a local invalidator because this
 * cache is per serverless INSTANCE. A write and the GET after it need not land
 * on the same instance, so clearing the one that served the write would leave
 * every other warm instance still serving the old table. Comparing a few bytes
 * closes that for every instance at once, and every existing writer already
 * bumps it — none of them need to know this reader exists.
 */
const caches: Partial<Record<ConfigDay, { rows: ConfigRowView[]; tab: string; at: number; fetchedAt: string; gen: string | null }>> = {};
const TTL_MS = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.has("metadata")) {
    try {
      const shiftDate=vnDate();
      const [clients, drivers, volumes, shifts] = await Promise.all([
        masterClients(), masterDrivers(),
        loadPickupVolumes().catch(e => { console.error("[config] pickup volumes:", e); return null; }),
        dailyDriverShifts(shiftDate).catch(e=>{console.error("[config] driver shifts:",e);return null;}),
      ]);
      const byClient = new Map(volumes?.map(v => [v.pickup_customer_id, v]));
      const codeCounts=new Map<string,number>();
      for(const d of drivers){const code=d.roster.employee_code?.trim();if(code)codeCounts.set(code,(codeCounts.get(code)??0)+1);}
      // ponytail: bounded one-day roster scan; index by driver ID if fleet size grows.
      const publicDrivers=drivers.map(d=>{
        const code=d.roster.employee_code?.trim();
        return {...publicDriver(d),shift_date:shiftDate,work_shifts:shifts?.filter(s=>s.driver_id===d.driver_id || (!s.driver_id && !!code && codeCounts.get(code)===1 && s.employee_code===code))??null};
      });
      return NextResponse.json({ clients: clients.map(c => ({ ...publicClient(c), pickup_volume: byClient.get(c.customer_id) ?? null })), drivers: publicDrivers },
        { headers: { "Cache-Control": "private, no-store" } });
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 502 });
    }
  }
  let day: ConfigDay;
  try { day = resolveConfigDay(req.nextUrl.searchParams.get("day")); }
  catch (e) { return NextResponse.json({error:String(e)}, {status:400}); }
  const sunday = day === "sunday";
  let cache = caches[day];
  const contract = sunday ? SHEET_CONTRACT.sunday : SHEET_CONTRACT.mapping;
  const gid = sunday ? SHEET_GID.sunday : SHEET_GID.mapping;
  const tab = masterEnabled() && !sunday ? "Supabase" : contract.label;
  if (cache?.tab !== tab) cache = undefined;
  // The explicit reload. Belt and braces beside the stamp: it also covers the
  // case where Redis is unconfigured or unreachable, where `readConfigGen`
  // deliberately reports "no reason to invalidate" and the stamp can never move.
  // A button that says Tải lại has to re-read the sheet every time it is pressed.
  const fresh = !!new URL(req.url).searchParams.get("fresh");

  try {
    const gen = await readConfigGen();
    if (!fresh && cache && cache.tab === tab && cache.gen === gen
        && Date.now() - cache.at < TTL_MS) {
      return NextResponse.json({ day, rows: cache.rows, tab: cache.tab, fetchedAt: cache.fetchedAt, cached: true });
    }

    const raw = masterEnabled() && !sunday
      ? await masterRuleRows("weekday")
      : await fetchSheetRows(gid, { label: contract.label, require: contract.require });
    const rows: ConfigRowView[] = [];
    raw.forEach((r, idx) => {
      const pickup = (r["Điểm Pick-up"] ?? "").trim();
      const customer_id = (r["customer_id"] ?? "").trim();
      // A row with neither is an empty line inside the table — the space new
      // rules are written into. Nothing to show and nothing to search for.
      if (!pickup && !customer_id) return;
      const driver = (r["Driver"] ?? "").trim();
      rows.push({
        ...(r._rule_id ? {rule_id:Number(r._rule_id),revision:Number(r._revision),assignment_mode:r.assignment_mode as "fixed"|"smart"} : {}),
        row: idx + 2,
        customer_id,
        pickup,
        driver,
        driver_ids: (r["smart_driver_id"]?.trim() || r["driver_id"]?.trim() || "")
          .split(",").map((id) => id.trim()).filter(Boolean),
        start: (r["shift_start"] ?? "").trim(),
        end: (r["shift_end"] ?? "").trim(),
        dropoff: (r["Điểm Drop-off"] ?? "").trim(),
        alt_drop_off_id: (r["alt_drop_off_id"] ?? "").trim(),
        smart: r.assignment_mode === "smart" || !!r.smart_driver_id?.trim(),
      });
    });

    // An empty read is never real — this table has well over a thousand rows —
    // so it is not cached, the same discipline every other reader here follows.
    if (rows.length === 0) {
      return NextResponse.json(
        { day, rows: cache?.rows ?? [], tab, fetchedAt: cache?.fetchedAt ?? "", error: "Đọc được 0 dòng" },
        { status: 502 },
      );
    }

    cache = caches[day] = { rows, tab, at: Date.now(), fetchedAt: vnTimestamp(), gen };
    return NextResponse.json({ day, rows, tab: cache.tab, fetchedAt: cache.fetchedAt, cached: false });
  } catch (e) {
    // Serve the stale copy rather than an empty table: a browser showing last
    // hour's config is useful, a browser showing nothing looks like the config
    // is gone.
    if (cache) {
      return NextResponse.json({ day, rows: cache.rows, tab: cache.tab, fetchedAt: cache.fetchedAt, cached: true, stale: true });
    }
    return NextResponse.json({ day, rows: [], tab, error: String(e) }, { status: 500 });
  }
}
