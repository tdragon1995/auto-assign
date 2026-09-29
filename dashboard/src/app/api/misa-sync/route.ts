import { NextRequest } from "next/server";
import { dispatchMisaSync, getMisaSyncStatus } from "@/lib/misa-sync";

export async function GET() {
  return getMisaSyncStatus();
}

export async function POST(req: NextRequest) {
  return dispatchMisaSync(req.nextUrl.searchParams.get("month"));
}
