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

// Fetches ALL today's jobs once — cached 30s at the Next.js data layer.
// Clients filter by their own customer_id to avoid per-PSC API calls.
export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  const vnNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const today = vnNow.toISOString().split("T")[0];

  const params = new URLSearchParams({
    "filter[scheduled_delivery_ts_from]": `${today} 00:00:00`,
    "filter[scheduled_delivery_ts_to]": `${today} 23:59:59`,
    limit: "1000",
  });

  try {
    const res = await fetch(`${BASE_URL}/jobs?${params}`, {
      headers: getHeaders(env),
      next: { revalidate: 30 }, // shared cache across all PSC refreshes
    });
    if (!res.ok) return NextResponse.json({ jobs: [] });

    const data = await res.json();
    return NextResponse.json({ jobs: data.data ?? [] });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
