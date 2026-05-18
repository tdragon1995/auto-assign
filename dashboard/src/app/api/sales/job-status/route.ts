import { NextRequest, NextResponse } from "next/server";
import { BASE_URL, getHeaders, type Env } from "@/lib/cartrack";

export const runtime = "edge";
export const preferredRegion = "sin1";

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const ref = req.nextUrl.searchParams.get("ref")?.trim();

  if (!ref) return NextResponse.json({ error: "Missing ref" }, { status: 400 });

  const headers = getHeaders(env);
  const res = await fetch(
    `${BASE_URL}/jobs?filter[reference_number]=${encodeURIComponent(ref)}&limit=5`,
    { headers, cache: "no-store" }
  );
  if (!res.ok) return NextResponse.json({ error: "Lookup failed" }, { status: 502 });

  const data = await res.json();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jobs: any[] = data.data ?? [];
  const job = jobs.find((j) => (j.reference_number ?? "").trim() === ref);
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ job_status_id: job.job_status_id });
}
