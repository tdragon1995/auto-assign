import { NextRequest, NextResponse } from "next/server";
import { getReceptionistToken } from "@/lib/labcenter";
import { vnDate } from "@/lib/time";

export const preferredRegion = "sin1";

/**
 * GET /api/psc-assign/batches?branch=D006
 *
 * Mã Batch suggestions for the /qr Grab dialog: this branch's LIS batches created today
 * that have not been handed over yet (not cancelled, no transfer or completion time),
 * newest first. One Labcenter call, made only when the dialog opens.
 *
 * Needs an LIS-capable login. Neither the receptionist nor the admin account has one
 * (both 403, checked 2026-10-19), so this rides LABCENTER_LOOKUP_TOKEN like the admin
 * batch lookup does — a pasted token that lasts 14 days. Any failure answers an empty
 * list with `access: false`: the dialog then just shows the typing box, as before.
 */
type LisBatch = {
  batch_code?: string; status?: string; total_sample?: number; created_at?: string;
  transferred_at?: string | null; completed_at?: string | null; cancelled_at?: string | null;
};

export async function GET(req: NextRequest) {
  const branch = /^D?(\d{3})$/.exec(req.nextUrl.searchParams.get("branch") ?? "")?.[1];
  if (!branch) return NextResponse.json({ batches: [], access: true });
  try {
    const token = process.env.LABCENTER_LOOKUP_TOKEN?.trim() || await getReceptionistToken();
    if (!token) return NextResponse.json({ batches: [], access: false });
    const today = vnDate();
    const params = new URLSearchParams({
      batch_code: "", status: "", per_page: "50", page: "1", order_direction: "desc",
      created_at_from: new Date(`${today}T00:00:00+07:00`).toISOString(),
      created_at_to: new Date(`${today}T23:59:59.999+07:00`).toISOString(),
    });
    params.append("source_location[]", branch);
    const res = await fetch(`https://api.labcenter.vn/spc-lis/api/v1/batch?${params}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", Origin: "https://labcenter.vn", Referer: "https://labcenter.vn/" },
      cache: "no-store",
    });
    if (!res.ok) {
      // 401 = the pasted token expired; 403 = an account without LIS access. Loud here,
      // silent on the phone.
      console.error(`[psc-assign/batches] LIS ${res.status} for D${branch}`);
      return NextResponse.json({ batches: [], access: false });
    }
    const rows: LisBatch[] = (await res.json())?.data ?? [];
    const batches = (Array.isArray(rows) ? rows : [])
      .filter((b) => /^B\d+$/.test(b.batch_code ?? "") && b.status !== "cancelled"
        && !b.cancelled_at && !b.transferred_at && !b.completed_at)
      .map((b) => ({ code: b.batch_code as string, samples: b.total_sample ?? null, created: b.created_at ?? null }));
    return NextResponse.json({ batches, access: true });
  } catch (e) {
    console.error("[psc-assign/batches]", e);
    return NextResponse.json({ batches: [], access: false });
  }
}
