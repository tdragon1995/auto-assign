import { NextRequest, NextResponse } from "next/server";
import { sbRpc, sbSelectAll } from "@/lib/supabase-rest";
import { assertMasterWritable, masterDriverNames } from "@/lib/master-store";
import { invalidateConfigCache } from "@/lib/config";
import { addDays, vnDate } from "@/lib/time";
import { loadLeaveEntries, leaveEntriesOnDate, type LeaveEntry } from "@/lib/leave-config";
import { areaKey, isSunday, parseRosterLines, rosterSunday, type RosterArea, type RosterLeave, type RosterWeek } from "@/lib/sunday-roster";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

type Row = { id: number; area: string; driver_id: string | null; raw_name: string | null; shift: string | null; note: string | null };

const dm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

/** Who will not drive on `date`, by driver id. A resignation counts from its
 *  first day off onward (the engine skips them forever); other leave only where
 *  it covers the day, with its hours and substitutes — the same coverage rules
 *  the leave panel and the engine use. */
function leaveOn(date: string, entries: LeaveEntry[]): Record<string, RosterLeave> {
  const out: Record<string, RosterLeave> = {};
  for (const e of entries) {
    if (e.loai_nghi === "Nghỉ việc" && e.leave_from <= date) out[e.driver_id] = { kind: "resigned", label: `Nghỉ việc từ ${dm(e.leave_from)}` };
  }
  for (const e of leaveEntriesOnDate(date, entries)) {
    if (out[e.driver_id] || e.loai_nghi === "Nghỉ việc") continue;
    const subs = e.subs.map((s) => s.name).filter(Boolean).join(", ");
    out[e.driver_id] = { kind: "leave", label: [e.loai_nghi || "Nghỉ", e.timeLabel, subs && `người thay: ${subs}`].filter(Boolean).join(" · ") };
  }
  return out;
}

/** One Sunday's roster, plus every area a line could be on: the ones Sunday
 *  rules name (spelled as the rules spell them) and the ones rostered lately. */
export async function GET(req: NextRequest) {
  try {
    const date = req.nextUrl.searchParams.get("date") || rosterSunday(vnDate());
    if (!isSunday(date)) throw new Error("Ngày phải là Chủ nhật");
    const [saved, rules, recent, dates, entries] = await Promise.all([
      sbSelectAll<Row>("master_sunday_roster", `select=id,area,driver_id,raw_name,shift,note&work_date=eq.${date}`, "sort.asc,id.asc"),
      sbSelectAll<{ id: number; areas: string[] | null }>("master_config_rules", "select=id,areas&day_type=eq.sunday&active=eq.true", "id.asc"),
      sbSelectAll<{ id: number; area: string }>("master_sunday_roster", `select=id,area&work_date=gte.${addDays(date, -56)}`, "id.asc"),
      // Dated lines only: a line with no date is never a Sunday to copy.
      sbSelectAll<{ work_date: string }>("master_sunday_roster", "select=work_date&work_date=not.is.null", "work_date.desc"),
      // Colours only: an unreadable leave list shows no leave rather than failing the page.
      loadLeaveEntries().catch(() => [] as LeaveEntry[]),
    ]);
    const areas = new Map<string, RosterArea>();
    for (const r of rules) for (const a of r.areas ?? []) {
      const k = areaKey(a);
      const hit = areas.get(k);
      if (hit) hit.rules++; else areas.set(k, { area: a.trim(), rules: 1 });
    }
    for (const r of [...saved, ...recent]) if (!areas.has(areaKey(r.area))) areas.set(areaKey(r.area), { area: r.area, rules: 0 });
    // A Sunday nobody has saved opens as a copy of the most recent saved Sunday
    // before it, unsaved — ops edit what differs and save.
    const copiedFrom = saved.length ? undefined : dates.map((d) => d.work_date).find((d) => d < date);
    const rows = copiedFrom
      ? await sbSelectAll<Row>("master_sunday_roster", `select=id,area,driver_id,raw_name,shift,note&work_date=eq.${copiedFrom}`, "sort.asc,id.asc")
      : saved;
    const names = await masterDriverNames(rows.flatMap((r) => (r.driver_id ? [r.driver_id] : [])));
    const body: RosterWeek = {
      date,
      leave: leaveOn(date, entries),
      // The version check is THIS Sunday's saved lines, never the copied ones.
      ids: saved.map((r) => r.id),
      copiedFrom,
      // Shown in the rules' spelling, so the area picker has one entry per area.
      lines: rows.map((r) => ({
        area: areas.get(areaKey(r.area))?.area ?? r.area, driver_id: r.driver_id, raw_name: r.raw_name,
        shift: r.shift ?? "", note: r.note ?? "",
      })),
      areas: [...areas.values()].sort((a, b) => a.area.localeCompare(b.area, "vi")),
      names: Object.fromEntries(names),
      weeks: [...new Set(dates.map((d) => d.work_date))],
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
    // A roster save changes who drives every Sunday rule on those areas.
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
