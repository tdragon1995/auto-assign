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

const PAGE_SIZE = 500;

// Fetches ALL today's jobs via pagination — cached 30s at the Next.js data layer.
// Clients filter by their own customer_id to avoid per-PSC API calls.
export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  const vnNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const today = vnNow.toISOString().split("T")[0];

  try {
    const headers = getHeaders(env);

    const makeUrl = (offset: number) => {
      const params = new URLSearchParams({
        "filter[scheduled_delivery_ts_from]": `${today} 00:00:00`,
        "filter[scheduled_delivery_ts_to]": `${today} 23:59:59`,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      return `${BASE_URL}/jobs?${params}`;
    };

    const fetchPage = (offset: number) =>
      fetch(makeUrl(offset), { headers, next: { revalidate: 30 } })
        .then((r) => (r.ok ? r.json() : { data: [] }))
        .then((d) => (d.data ?? []) as unknown[]);

    // Fetch first two pages in parallel — covers up to 1000 jobs in one round-trip
    const [page0, page1] = await Promise.all([fetchPage(0), fetchPage(PAGE_SIZE)]);
    const allJobs: unknown[] = [...page0, ...page1];

    // If page1 was full there may be more — fetch remaining pages sequentially
    if (page1.length === PAGE_SIZE) {
      let offset = PAGE_SIZE * 2;
      while (true) {
        const page = await fetchPage(offset);
        allJobs.push(...page);
        if (page.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }
    }

    return NextResponse.json({ jobs: allJobs });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
