import { NextRequest, NextResponse } from "next/server";
import { sbRpc } from "@/lib/supabase-rest";
import { assertMasterWritable, inactiveMasterClientIds } from "@/lib/master-store";
import { invalidateConfigCache } from "@/lib/config";
import { timeToMins } from "@/lib/time";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Replace one clinic's Sunday rules (Config tab, Chủ nhật). A Sunday rule is
 * clinic + hours + area(s); who drives an area is Lịch Chủ nhật, never this.
 * `expected` is [[rule_id, revision], ...] as the editor loaded them — the
 * database refuses if anyone saved this clinic's Sunday in between.
 */
export async function POST(req: NextRequest) {
  const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });
  try {
    assertMasterWritable();
    const body = await req.json().catch(() => null);
    const pickup = body?.customer_id;
    if (typeof pickup !== "string" || !UUID.test(pickup)) return bad("Điểm lấy mẫu không hợp lệ");
    const expected = body.expected;
    if (!Array.isArray(expected) || expected.some((e: unknown) => !Array.isArray(e) || e.length !== 2 || !e.every(Number.isSafeInteger))) return bad("Phiên bản không hợp lệ — tải lại");
    if (!Array.isArray(body.rules) || body.rules.length > 50) return bad("Danh sách ca không hợp lệ");
    const rules = body.rules.map((raw: unknown, i: number) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const n = i + 1;
      const start = String(r.start ?? "").trim(), end = String(r.end ?? "").trim();
      if (!HHMM.test(start) || !HHMM.test(end)) throw new Error(`Ca ${n}: giờ phải có dạng 06:00`);
      if (timeToMins(start) === timeToMins(end)) throw new Error(`Ca ${n}: giờ bắt đầu và kết thúc trùng nhau`);
      const areas = Array.isArray(r.areas) ? [...new Set(r.areas.map((a) => String(a ?? "").trim().replace(/\s+/g, " ")).filter(Boolean))] : [];
      if (areas.length === 0) throw new Error(`Ca ${n}: chọn khu vực`);
      if (areas.length > 10 || areas.some((a) => a.length > 200)) throw new Error(`Ca ${n}: khu vực không hợp lệ`);
      const alt = String(r.alt_drop_off_id ?? "").trim();
      if (alt && !UUID.test(alt)) throw new Error(`Ca ${n}: điểm giao thay thế không hợp lệ`);
      return { shift_start: start, shift_end: end, areas, alt_drop_off_id: alt };
    });
    const inactive = new Set(await inactiveMasterClientIds());
    if (rules.length && inactive.has(pickup)) return bad("Điểm lấy mẫu đã ngừng hoạt động");
    if (rules.some((r: { alt_drop_off_id: string }) => inactive.has(r.alt_drop_off_id))) return bad("Điểm giao thay thế đã ngừng hoạt động");
    const saved = await sbRpc<number>("master_write_sunday_rules", { pickup, expected, rules });
    await invalidateConfigCache();
    return NextResponse.json({ ok: true, saved });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("changed since they were loaded")) return bad("Lịch Chủ nhật của điểm này vừa được người khác lưu — tải lại trước khi lưu.", 409);
    return bad(msg);
  }
}
