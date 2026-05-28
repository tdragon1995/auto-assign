import { NextResponse } from "next/server";
import { getLastRun } from "@/lib/schedule-job-kv";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

export async function GET() {
  const record = await getLastRun();
  if (!record) {
    return NextResponse.json({ record: null });
  }
  const counts = {
    ok: record.results.filter((r) => r.status === "OK").length,
    skipped: record.results.filter((r) => r.status === "SKIPPED").length,
    error: record.results.filter((r) => r.status === "ERROR").length,
  };
  return NextResponse.json({ record, counts });
}
