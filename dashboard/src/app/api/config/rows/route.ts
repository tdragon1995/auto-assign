import { NextResponse } from "next/server";
import { fetchSheetRows, SHEET_CONTRACT, SHEET_GID } from "@/lib/sheets";
import { vnIsSunday, vnTimestamp } from "@/lib/time";

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
 * Whichever tab the engine is reading TODAY, so what is shown is what is in
 * force — the Sunday tab is a different roster, and showing the weekday one on a
 * Sunday would be showing rules that are not running.
 */

export interface ConfigRowView {
  /** 1-based sheet row, so an edit elsewhere can address it. */
  row: number;
  customer_id: string;
  pickup: string;
  /** The Driver cell verbatim — one name, or several for a smart row. */
  driver: string;
  start: string;
  end: string;
  /** Destination this rule is scoped to; blank means every destination. */
  dropoff: string;
  /** True when the cell names several drivers: the engine ranks them by
   *  distance rather than treating them as competing rules. */
  smart: boolean;
}

let cache: { rows: ConfigRowView[]; tab: string; at: number; fetchedAt: string } | null = null;
const TTL_MS = 5 * 60 * 1000;

export async function GET() {
  const sunday = vnIsSunday();
  const contract = sunday ? SHEET_CONTRACT.sunday : SHEET_CONTRACT.mapping;
  const gid = sunday ? SHEET_GID.sunday : SHEET_GID.mapping;

  try {
    if (cache && cache.tab === contract.label && Date.now() - cache.at < TTL_MS) {
      return NextResponse.json({ rows: cache.rows, tab: cache.tab, fetchedAt: cache.fetchedAt, cached: true });
    }

    const raw = await fetchSheetRows(gid, { label: contract.label, require: contract.require });
    const rows: ConfigRowView[] = [];
    raw.forEach((r, idx) => {
      const pickup = (r["Điểm Pick-up"] ?? "").trim();
      const customer_id = (r["customer_id"] ?? "").trim();
      // A row with neither is an empty line inside the table — the space new
      // rules are written into. Nothing to show and nothing to search for.
      if (!pickup && !customer_id) return;
      const driver = (r["Driver"] ?? "").trim();
      rows.push({
        row: idx + 2,
        customer_id,
        pickup,
        driver,
        start: (r["shift_start"] ?? "").trim(),
        end: (r["shift_end"] ?? "").trim(),
        dropoff: (r["Điểm Drop-off"] ?? "").trim(),
        smart: driver.includes(","),
      });
    });

    // An empty read is never real — this table has well over a thousand rows —
    // so it is not cached, the same discipline every other reader here follows.
    if (rows.length === 0) {
      return NextResponse.json(
        { rows: cache?.rows ?? [], tab: contract.label, fetchedAt: cache?.fetchedAt ?? "", error: "Đọc được 0 dòng" },
        { status: 502 },
      );
    }

    cache = { rows, tab: contract.label, at: Date.now(), fetchedAt: vnTimestamp() };
    return NextResponse.json({ rows, tab: cache.tab, fetchedAt: cache.fetchedAt, cached: false });
  } catch (e) {
    // Serve the stale copy rather than an empty table: a browser showing last
    // hour's config is useful, a browser showing nothing looks like the config
    // is gone.
    if (cache) {
      return NextResponse.json({ rows: cache.rows, tab: cache.tab, fetchedAt: cache.fetchedAt, cached: true, stale: true });
    }
    return NextResponse.json({ rows: [], tab: contract.label, error: String(e) }, { status: 500 });
  }
}
