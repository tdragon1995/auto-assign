import { NextRequest, NextResponse } from "next/server";
import { clearCoverageGaps } from "@/lib/smart-log-kv";
import { invalidateConfigCache } from "@/lib/config";

/**
 * Drop a recorded coverage gap from the to-do list.
 *
 * The list is EVIDENCE, not config: each row is a minute some job actually
 * wanted and no rule covered. Everything else in this panel is closed by
 * editing the sheet, and a gap normally closes the same way — the parse notices
 * the branch now covers that minute and retracts the record itself. This is the
 * other case: a record that is stale rather than wrong to begin with, and which
 * no sheet edit will ever answer. Nothing else could remove one, so a row like
 * that sat in the list for good.
 *
 * IT IS A "not now", NOT A DECISION. No config changes here — the only thing
 * deleted is the observation. If the hole is real, the next job that falls into
 * it records it again and the row comes back, which is the property that makes
 * a single click safe: being wrong costs a day, not a silence.
 *
 * The whole collapsed group goes, not just the headline minute. One hole
 * gathers a fresh minute every day it swallows a job — 18:07 today, 18:11
 * tomorrow — shown as one row with the rest in `also`. Clearing only the one
 * named would leave the row standing under the next minute along, which reads
 * as the button having done nothing.
 */
export async function POST(req: NextRequest) {
  const bad = (msg: string, code = 400) => NextResponse.json({ ok: false, error: msg }, { status: code });
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return bad("Body không hợp lệ");
    const { customer_id, at, also } = body as { customer_id?: string; at?: string; also?: unknown };

    const cid = (customer_id ?? "").trim();
    const head = (at ?? "").trim();
    if (!cid) return bad("Thiếu mã điểm");
    if (!head) return bad("Thiếu giờ");

    const times = [head, ...(Array.isArray(also) ? also : [])]
      .map((t) => String(t ?? "").trim())
      .filter((t) => /^\d{1,2}:\d{2}$/.test(t));

    await clearCoverageGaps(times.map((t) => ({ customer_id: cid, at: t })));
    // The panel reads gaps off the parsed config, which caches them. Without
    // this the row survives until the next parse — up to a day.
    await invalidateConfigCache();

    return NextResponse.json({ ok: true, removed: times.length });
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e), 500);
  }
}
