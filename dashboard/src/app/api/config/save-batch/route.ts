import { NextRequest, NextResponse } from "next/server";
import { saveMasterConfigBatch } from "@/lib/master-config-actions";
import { masterEnabled } from "@/lib/master-store";
import { invalidateConfigCache } from "@/lib/config";
import { vnIsSunday } from "@/lib/time";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

export async function POST(req: NextRequest) {
  const start = performance.now();
  try {
    if (!masterEnabled() || vnIsSunday()) throw new Error("Lưu nhiều dòng chỉ áp dụng cho config Supabase ngày thường");
    const body = await req.json();
    const saved = await saveMasterConfigBatch(body?.branches);
    const writeMs = Math.round(performance.now() - start);
    await invalidateConfigCache();
    return NextResponse.json({ok:true,saved,write_ms:writeMs}, {headers:{"Server-Timing":`write;dur=${writeMs}, total;dur=${Math.round(performance.now()-start)}`}});
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const code = /Dòng đã thay đổi|revision|stale/i.test(error) ? "CONFIG_ROW_CHANGED" : /abort|fetch|timeout|timed out|signal|HTTP 5\d\d/i.test(error) ? "CONFIG_SAVE_UNCERTAIN" : undefined;
    return NextResponse.json({ok:false,error,code},{status:409});
  }
}
