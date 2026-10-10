import { NextRequest, NextResponse } from "next/server";
import { sbRpc, sbSelectAll } from "@/lib/supabase-rest";
import { assertMasterWritable, masterDriverNames } from "@/lib/master-store";
import { invalidateConfigCache } from "@/lib/config";
import { addDays, vnDate } from "@/lib/time";
import { areaKey, isSunday, parseRosterLines, rosterSunday, type RosterArea, type RosterWeek } from "@/lib/sunday-roster";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

type Row = { id: number; area: string; driver_id: string | null; raw_name: string | null; shift: string | null; note: string | null };

/** One Sunday's roster, plus every area a line could be on: the ones Sunday
 *  rules name (spelled as the rules spell them) and the ones rostered lately. */
export async function GET(req: NextRequest) {
  try {
    const date = req.nextUrl.searchParams.get("date") || rosterSunday(vnDate());
    if (!isSunday(date)) throw new Error("Ngày phải là Chủ nhật");
    const [rows, rules, recent] = await Promise.all([
      sbSelectAll<Row>("master_sunday_roster", `select=id,area,driver_id,raw_name,shift,note&work_date=eq.${date}`, "sort.asc,id.asc"),
      sbSelectAll<{ id: number; areas: string[] | null }>("master_config_rules", "select=id,areas&day_type=eq.sunday&active=eq.true", "id.asc"),
      sbSelectAll<{ id: number; area: string }>("master_sunday_roster", `select=id,area&work_date=gte.${addDays(date, -56)}`, "id.asc"),
    ]);
    const areas = new Map<string, RosterArea>();
    for (const r of rules) for (const a of r.areas ?? []) {
      const k = areaKey(a);
      const hit = areas.get(k);
      if (hit) hit.rules++; else areas.set(k, { area: a.trim(), rules: 1 });
    }
    for (const r of [...rows, ...recent]) if (!areas.has(areaKey(r.area))) areas.set(areaKey(r.area), { area: r.area, rules: 0 });
    const names = await masterDriverNames(rows.flatMap((r) => (r.driver_id ? [r.driver_id] : [])));
    const body: RosterWeek = {
      date,
      ids: rows.map((r) => r.id),
      // Shown in the rules' spelling, so the area picker has one entry per area.
      lines: rows.map((r) => ({
        area: areas.get(areaKey(r.area))?.area ?? r.area, driver_id: r.driver_id, raw_name: r.raw_name,
        shift: r.shift ?? "", note: r.note ?? "",
      })),
      areas: [...areas.values()].sort((a, b) => a.area.localeCompare(b.area, "vi")),
      names: Object.fromEntries(names),
    };
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

/** Replace one Sunday's roster. `ids` is the version the editor loaded. */
export async function POST(req: NextRequest) {
  try {
    assertMasterWritable();
    const body = await req.json();
    if (!isSunday(body?.date)) throw new Error("Ngày phải là Chủ nhật");
    if (!Array.isArray(body.ids) || body.ids.some((id: unknown) => !Number.isSafeInteger(id))) throw new Error("Phiên bản lịch không hợp lệ");
    const lines = parseRosterLines(body.lines);
    const saved = await sbRpc<number>("master_write_sunday_roster", { roster_date: body.date, expected_ids: body.ids, lines });
    // Nothing assigns from the roster yet; this keeps the cut-over from
    // forgetting that a roster save changes who drives a Sunday rule.
    await invalidateConfigCache();
    return NextResponse.json({ ok: true, saved });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("Roster changed since it was loaded")) {
      return NextResponse.json({ error: "Lịch Chủ nhật này vừa được người khác lưu — tải lại trước khi lưu." }, { status: 409 });
    }
    if (msg.includes("violates foreign key")) return NextResponse.json({ error: "Có tài xế không còn trong danh sách tài xế." }, { status: 400 });
    if (msg.includes("duplicate key")) return NextResponse.json({ error: "Một tài xế bị nhập hai lần cho cùng khu vực." }, { status: 400 });
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
