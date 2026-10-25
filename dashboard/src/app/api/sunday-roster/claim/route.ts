import { NextRequest, NextResponse, after } from "next/server";
import { verifySession, NV_COOKIE } from "@/lib/driver-session";
import { sbRpc, sbSelect } from "@/lib/supabase-rest";
import { assertMasterWritable } from "@/lib/master-store";
import { invalidateConfigCache } from "@/lib/config";
import { vnDate } from "@/lib/time";
import { loadSunday, loadSundayLines, sendDriverGroup } from "@/lib/sunday-roster-zalo";
import { claimText, hoursMeet, isOpen, isPublished } from "@/lib/sunday-roster-post";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

const fail = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** POST { id } — the signed-in driver takes an open Sunday line ("Nhận ca").
 *  The driver comes from the nv_session cookie only, never the body. First one
 *  in wins (master_claim_sunday_slot); an admin undoes it in Lịch Chủ nhật. */
export async function POST(req: NextRequest) {
  const session = verifySession(req.cookies.get(NV_COOKIE)?.value);
  if (!session) return fail("Đăng nhập ở Tab Nhận Việc trước khi nhận ca.", 401);
  try {
    assertMasterWritable();
    const id = Number((await req.json().catch(() => null))?.id);
    if (!Number.isSafeInteger(id)) return fail("Ca không hợp lệ");

    // Every roster save mints new ids, so a missing id means the roster moved under the page.
    const [row] = await sbSelect<{ work_date: string | null }>("master_sunday_roster", `select=work_date&id=eq.${id}`);
    if (!row?.work_date) return fail("Lịch vừa được cập nhật — tải lại trang rồi thử lại.", 409);
    const date = row.work_date;
    if (date < vnDate()) return fail("Ca này đã qua.");

    const { lines, awayOf } = await loadSunday(date);
    const target = lines.find((l) => l.id === id);
    if (!target || !isPublished(target.area) || !isOpen(target)) return fail("Ca này vừa có người nhận.", 409);
    if (target.driver_id === session.driver_id) return fail("Bạn đang có tên trong ca này.");
    const clash = lines.find((l) => l.driver_id === session.driver_id && !l.away && hoursMeet(l.shift || null, target.shift || null));
    if (clash) return fail(`Bạn đã có ca ${clash.area} ${clash.shift} trùng giờ.`);
    const away = awayOf(session.driver_id, target.shift);
    if (away) return fail(`Bạn đang có đơn nghỉ ngày này (${away}).`);

    const newId = await sbRpc<number>("master_claim_sunday_slot", {
      line_id: id, expected_driver: target.driver_id, claimer: session.driver_id,
    });
    // The roster decides who drives every Sunday rule on that area.
    await invalidateConfigCache();
    after(async () => {
      const now = await loadSundayLines(date);
      const mine = now.find((l) => l.id === newId);
      const ok = await sendDriverGroup(claimText(date, mine?.name || session.driver_name, target, now));
      if (!ok) console.warn("[sunday-roster] claim announcement not sent", newId);
    });
    return NextResponse.json({ ok: true, id: newId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("Slot already taken")) return fail("Ca này vừa có người nhận.", 409);
    if (msg.includes("violates foreign key")) return fail("Tài khoản của bạn chưa có trong danh sách tài xế — liên hệ Đội điều phối.");
    if (msg.includes("duplicate key")) return fail("Bạn đã có tên ở khu vực này ngày Chủ nhật đó.");
    console.error("[sunday-roster] claim failed:", msg);
    return fail("Không nhận được ca — thử lại sau.", 500);
  }
}
