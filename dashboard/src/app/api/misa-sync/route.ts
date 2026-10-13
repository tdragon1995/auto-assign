import { NextRequest } from "next/server";
import { dispatchMisaSync, getMisaSyncStatus, morningIssues } from "@/lib/misa-sync";

export const runtime="nodejs";
export const preferredRegion="sin1";
export const maxDuration=300;

export async function GET(req: NextRequest) {
  return req.nextUrl.searchParams.get("issues") === "1" ? morningIssues() : getMisaSyncStatus();
}

export async function POST(req: NextRequest) {
  return dispatchMisaSync(req.nextUrl.searchParams.get("month"));
}
