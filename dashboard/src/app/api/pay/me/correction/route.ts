/**
 * A driver asks to correct a day's công — Thu Nhập's "Cập nhật công" form.
 *
 * Driver id from the signed nv_session cookie ONLY, as /api/pay/me does; PT
 * accounts only. The request waits for a supervisor (Lương PT → Cập nhật công);
 * nothing a driver sends changes pay until it is approved.
 *
 * A new request for a day REPLACES the driver's open one for that day (the old one
 * becomes 'withdrawn'), so a typo is fixed by sending again.
 *
 * Proof files are uploaded to Cartrack server-side (lib/cartrack-files.ts) and
 * only their links are stored.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifySession, NV_COOKIE } from "@/lib/driver-session";
import { sbInsert, sbPatch, supabaseConfigured } from "@/lib/supabase-rest";
import { employmentOf } from "@/lib/driver-label";
import { checkTimes, checkProof, type CorrectionInput } from "@/lib/pay-corrections";
import { uploadToCartrack, proofUploadConfigured, type UploadFile } from "@/lib/cartrack-files";
import { vnDate } from "@/lib/time";

export const runtime = "nodejs";
export const maxDuration = 60;
export const preferredRegion = "sin1";

export async function POST(req: NextRequest) {
  const session = verifySession(req.cookies.get(NV_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ ok: false, expired: true, error: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại." }, { status: 401 });
  }
  if (employmentOf(session.driver_name) !== "part-time") {
    return NextResponse.json({ ok: false, error: "Chỉ áp dụng cho tài khoản bán thời gian (PT)." }, { status: 403 });
  }
  if (!supabaseConfigured()) {
    return NextResponse.json({ ok: false, error: "Hệ thống lưu trữ chưa được cấu hình." }, { status: 503 });
  }

  const body = await req.json().catch(() => null) as (Partial<CorrectionInput> & { reason?: unknown; files?: unknown }) | null;
  if (!body) return NextResponse.json({ ok: false, error: "Yêu cầu không hợp lệ." }, { status: 400 });
  const bad = checkTimes(body, vnDate()) ?? checkProof(body.reason, body.files);
  if (bad) return NextResponse.json({ ok: false, error: bad }, { status: 400 });

  const files = (Array.isArray(body.files) ? body.files : []) as UploadFile[];
  if (files.length > 0 && !proofUploadConfigured()) {
    return NextResponse.json({ ok: false, error: "Chưa nhận được ảnh lúc này — báo điều phối." }, { status: 503 });
  }

  try {
    const proof_urls = await uploadToCartrack(files);
    const date = body.date!;
    // Replace this driver's open request for the day, if any.
    await sbPatch("pay_day_corrections", `driver_id=eq.${session.driver_id}&trip_date=eq.${date}&status=eq.pending`, { status: "withdrawn" });
    await sbInsert("pay_day_corrections", [{
      driver_id: session.driver_id,
      driver_name: session.driver_name,
      trip_date: date,
      in_time: body.in_time,
      out_time: body.out_time,
      reason: body.reason,
      note: body.note ?? "",
      proof_urls,
      source: "driver",
      status: "pending",
    }]);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[pay/me/correction] error:", msg);
    return NextResponse.json({ ok: false, error: "Không gửi được yêu cầu. Thử lại sau." }, { status: 502 });
  }
}
