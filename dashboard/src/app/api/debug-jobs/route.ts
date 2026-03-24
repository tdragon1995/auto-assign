import { NextRequest, NextResponse } from "next/server";
import { getActiveJobs, type Env } from "@/lib/cartrack";

export const runtime = "edge";
export const preferredRegion = "sin1";

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const { data: jobs } = await getActiveJobs(env);
  return NextResponse.json({ count: jobs.length, jobs });
}
