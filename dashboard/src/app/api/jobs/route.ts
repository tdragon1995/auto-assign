import { NextRequest, NextResponse } from "next/server";
import { getUnassignedJobs, type Env } from "@/lib/cartrack";

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  try {
    const data = await getUnassignedJobs(1, 50, env);
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { data: [], error: String(e) },
      { status: 500 }
    );
  }
}
