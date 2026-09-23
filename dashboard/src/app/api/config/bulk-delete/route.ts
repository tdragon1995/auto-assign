import { NextRequest, NextResponse } from "next/server";
import { bulkDeleteConfigRows } from "@/lib/sheets-writer";
import { invalidateConfigCache } from "@/lib/config";
import { parseConfigTargets } from "@/lib/config-targets";

/**
 * The Config tab's bulk "Xoá": every ticked row removed in one Sheets batch.
 *
 * It replaces a loop of delete-row calls, which spent three reads a row and ran
 * out of Google's per-minute read quota after ~15 rows. Same guards as the
 * single delete — branch re-checked per row, row 2 refused, id column read back
 * — done once for the whole set. See bulkDeleteConfigRows.
 */
export async function POST(req: NextRequest) {
  const bad = (msg: string, code = 400) => NextResponse.json({ ok: false, error: msg }, { status: code });
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return bad("Body không hợp lệ");
    const parsed = parseConfigTargets((body as { rows?: unknown }).rows);
    if ("error" in parsed) return bad(parsed.error);

    const result = await bulkDeleteConfigRows({ targets: parsed.targets });
    if (result.done.length > 0) await invalidateConfigCache();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e), 409);
  }
}
