import { NextRequest, NextResponse } from "next/server";
import { getReceptionistToken } from "@/lib/labcenter";
import { vnDate } from "@/lib/time";

export const preferredRegion = "sin1";

/**
 * GET /api/psc-assign/batches?branch=D006
 *
 * Mã Batch suggestions for the /qr Grab dialog: today's batches of this branch (D006 →
 * B006…) and of HBC (B199…), newest first, each with who created it so staff pick the
 * right ones. Only cancelled batches are left out. One Labcenter call, made only when
 * the dialog opens.
 *
 * The same call Labcenter's own Batch Management page makes (checked 2026-10-19), and it
 * needs a login with the "receptionist-nurse-phlebotomist" role — the receptionist account
 * (LABCENTER_RECEPTIONIST_*), tried FIRST. LABCENTER_LOOKUP_TOKEN, a pasted token that
 * lasts 14 days, is only the fallback: tried first, an expired one failed every request
 * before the working login was ever asked. Any failure answers an empty list with
 * `access: false`: the dialog then just shows the typing box, as before.
 */
/** HBC's batches are B199… — offered to every branch alongside its own. */
const HBC = "199";

type LisBatch = {
  batch_code?: string; status?: string; total_sample?: number; created_at?: string; created_by?: string;
  transferred_at?: string | null; completed_at?: string | null; cancelled_at?: string | null;
};

export async function GET(req: NextRequest) {
  const branch = /^D?(\d{3})$/.exec(req.nextUrl.searchParams.get("branch") ?? "")?.[1];
  if (!branch) return NextResponse.json({ batches: [], access: true });
  try {
    const today = vnDate();
    const params = new URLSearchParams({
      batch_code: "", status: "", per_page: "100", page: "1", order_direction: "desc",
      created_at_from: new Date(`${today}T00:00:00+07:00`).toISOString(),
      created_at_to: new Date(`${today}T23:59:59.999+07:00`).toISOString(),
    });
    params.append("source_location[]", branch);
    params.append("source_location[]", HBC);
    const ask = (token: string) => fetch(`https://api.labcenter.vn/spc-lis/api/v1/batch?${params}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", Origin: "https://labcenter.vn", Referer: "https://labcenter.vn/" },
      cache: "no-store",
    });
    const receptionist = await getReceptionistToken().catch(() => null);
    let res = receptionist ? await ask(receptionist) : null;
    const lookup = process.env.LABCENTER_LOOKUP_TOKEN?.trim();
    if ((!res || res.status === 401 || res.status === 403) && lookup) res = await ask(lookup);
    if (!res) return NextResponse.json({ batches: [], access: false });
    if (!res.ok) {
      // 401 = the pasted token expired; 403 = an account without LIS access. Loud here,
      // silent on the phone.
      console.error(`[psc-assign/batches] LIS ${res.status} for D${branch}`);
      return NextResponse.json({ batches: [], access: false });
    }
    const rows: LisBatch[] = (await res.json())?.data ?? [];
    // The code says whose batch it is (B006… is D006's), so that is the filter.
    const batches = (Array.isArray(rows) ? rows : [])
      .filter((b) => (b.batch_code?.startsWith(`B${branch}`) || b.batch_code?.startsWith(`B${HBC}`))
        && b.status !== "cancelled" && !b.cancelled_at)
      .map((b) => ({
        code: b.batch_code as string, samples: b.total_sample ?? null, created: b.created_at ?? null,
        by: b.created_by ?? null, hbc: (b.batch_code as string).startsWith(`B${HBC}`),
      }));
    return NextResponse.json({ batches, access: true });
  } catch (e) {
    console.error("[psc-assign/batches]", e);
    return NextResponse.json({ batches: [], access: false });
  }
}
