import { NextRequest, NextResponse } from "next/server";
import { type Env } from "@/lib/cartrack";

export const runtime = "edge";
export const preferredRegion = "sin1";

const BASE_URL = "https://fleetapi-vn.cartrack.com/rest/delivery";

function getHeaders(env: Env = "prod"): Record<string, string> {
  const suffix = env === "uat" ? "_UAT" : "";
  const auth = process.env[`CARTRACK_AUTH${suffix}`] ?? "";
  const cookie = process.env[`CARTRACK_COOKIE${suffix}`] ?? "";
  if (!auth) throw new Error(`CARTRACK_AUTH${suffix} not set`);
  const headers: Record<string, string> = { Authorization: auth, "Content-Type": "application/json" };
  if (cookie) headers["Cookie"] = cookie;
  return headers;
}

// GET /api/location-jobs?date=2026-04-11&status=4
// Fetches all jobs for a given date + job_status_id, paginating until exhausted
export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const date = req.nextUrl.searchParams.get("date");
  const status = req.nextUrl.searchParams.get("status");

  if (!date || !status) {
    return NextResponse.json({ error: "Missing date or status" }, { status: 400 });
  }

  try {
    const headers = getHeaders(env);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allJobs: any[] = [];
    let page = 1;
    const limit = 100;

    while (true) {
      const res = await fetch(
        `${BASE_URL}/jobs?filter[scheduled_delivery_ts_from]=${date} 00:00:00&filter[scheduled_delivery_ts_to]=${date} 23:59:59&filter[job_status_id]=${status}&page=${page}&limit=${limit}`,
        { headers, cache: "no-store" }
      );
      if (!res.ok) break;
      const data = await res.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const jobs: any[] = data.data ?? [];
      allJobs.push(...jobs);
      if (jobs.length < limit) break;
      page++;
    }

    return NextResponse.json({ jobs: allJobs });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
