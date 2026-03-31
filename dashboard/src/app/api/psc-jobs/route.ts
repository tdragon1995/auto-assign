import { NextRequest, NextResponse } from "next/server";
import { type Env } from "@/lib/cartrack";

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

const PAGE_SIZE = 1000;

// Fetches ALL today's jobs — cached 30s at the Next.js data layer.
// Uses a single request; only paginates on days with >1000 jobs.
// Clients filter by their own customer_id to avoid per-PSC API calls.
export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  const vnNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const today = vnNow.toISOString().split("T")[0];

  const allJobs: unknown[] = [];

  try {
    const headers = getHeaders(env);
    let offset = 0;

    while (true) {
      const params = new URLSearchParams({
        "filter[scheduled_delivery_ts_from]": `${today} 00:00:00`,
        "filter[scheduled_delivery_ts_to]": `${today} 23:59:59`,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });

      const res = await fetch(`${BASE_URL}/jobs?${params}`, {
        headers,
        next: { revalidate: 30 },
      });
      if (!res.ok) break;

      const data = await res.json();
      const page: unknown[] = data.data ?? [];
      allJobs.push(...page);

      if (page.length < PAGE_SIZE) break; // last page — stop
      offset += PAGE_SIZE;
    }

    return NextResponse.json({ jobs: allJobs });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
