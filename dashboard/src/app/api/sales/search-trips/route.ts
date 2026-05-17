import { NextRequest, NextResponse } from "next/server";
import { BASE_URL, getHeaders, type Env } from "@/lib/cartrack";
import { vnDate } from "@/lib/time";

export const runtime = "edge";
export const preferredRegion = "sin1";

const B2B_LABEL = "🛵 Vận chuyển mẫu B2B";

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const maKh = req.nextUrl.searchParams.get("ma_kh")?.trim();

  if (!maKh || maKh.length < 2) {
    return NextResponse.json({ jobs: [] });
  }

  const headers = getHeaders(env);
  const today = vnDate();
  const from = `${today} 00:00:00`;
  const to = `${today} 23:59:59`;

  const [res2, res4] = await Promise.all([
    fetch(`${BASE_URL}/jobs?filter[create_ts_from]=${from}&filter[create_ts_to]=${to}&filter[job_status_id]=2&limit=200`, { headers, cache: "no-store" }),
    fetch(`${BASE_URL}/jobs?filter[create_ts_from]=${from}&filter[create_ts_to]=${to}&filter[job_status_id]=4&limit=200`, { headers, cache: "no-store" }),
  ]);

  const [data2, data4] = await Promise.all([
    res2.ok ? res2.json() : { data: [] },
    res4.ok ? res4.json() : { data: [] },
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allJobs: any[] = [...(data2.data ?? []), ...(data4.data ?? [])];

  const matched = allJobs.filter(
    (j) =>
      (j.reference_number ?? "").includes(`-${maKh}`) &&
      (j.labels ?? []).includes(B2B_LABEL)
  );

  return NextResponse.json({ jobs: matched });
}
