import { resolveConfigDay } from "@/lib/config-day";
import { NextRequest, NextResponse } from "next/server";
import { bulkMasterConfig, weekdayOnly } from "@/lib/master-config-actions";
import { invalidateConfigCache } from "@/lib/config";
import { parseConfigTargets } from "@/lib/config-targets";

/**
 * The Config tab's bulk "Xoá": every ticked rule switched off in one write, each
 * re-checked by rule id + revision (bulkMasterConfig).
 */
export async function POST(req: NextRequest) {
  const bad = (msg: string, code = 400) => NextResponse.json({ ok: false, error: msg }, { status: code });
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return bad("Body không hợp lệ");
    const configDay = resolveConfigDay(body.config_day);
    const parsed = parseConfigTargets((body as { rows?: unknown }).rows);
    if ("error" in parsed) return bad(parsed.error);

    weekdayOnly(configDay);
    const result = await bulkMasterConfig(parsed.targets, { delete: true });
    if (result.done.length > 0) await invalidateConfigCache();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e), 409);
  }
}
