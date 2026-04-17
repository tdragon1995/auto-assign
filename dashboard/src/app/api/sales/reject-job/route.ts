import { NextRequest, NextResponse } from "next/server";
import { getFleetwebCookie, type Env } from "@/lib/cartrack";

export const runtime = "edge";
export const preferredRegion = "sin1";

const BASE_URL = "https://fleetapi-vn.cartrack.com/rest/delivery";
const JSONRPC_URL = "https://fleetweb-vn.cartrack.com/jsonrpc/index.php";

function getAuth(env: Env = "prod"): string {
  const suffix = env === "uat" ? "_UAT" : "";
  const auth = process.env[`CARTRACK_AUTH${suffix}`] ?? "";
  if (!auth) throw new Error(`CARTRACK_AUTH${suffix} not set`);
  return auth;
}

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  try {
    const { reference_number, reject_reason } = await req.json();
    if (!reference_number || !reject_reason) {
      return NextResponse.json({ error: "Missing reference_number or reject_reason" }, { status: 400 });
    }

    const auth = getAuth(env);

    // Lookup job by reference_number (no date filter)
    const qs = new URLSearchParams();
    qs.set("filter[reference_number]", reference_number);

    const findRes = await fetch(`${BASE_URL}/jobs?${qs.toString()}`, {
      headers: { Authorization: auth, Accept: "application/json" },
      cache: "no-store",
    });
    if (!findRes.ok) {
      return NextResponse.json({ error: "Không tìm được job" }, { status: 404 });
    }
    const findData = await findRes.json();
    const jobs: { job_id: number; reference_number: string; job_status_id: number }[] = findData.data ?? [];
    const job = jobs.find((j) => (j.reference_number ?? "").trim() === reference_number.trim());
    if (!job) {
      return NextResponse.json({ error: "Không tìm thấy reference_number" }, { status: 404 });
    }
    if (job.job_status_id === 3 || job.job_status_id === 7) {
      return NextResponse.json({ error: "Job đã bị huỷ/từ chối trước đó" }, { status: 409 });
    }

    const cookie = await getFleetwebCookie();
    if (!cookie) {
      return NextResponse.json({ error: "Không thể đăng nhập Cartrack fleetweb" }, { status: 500 });
    }

    const rpcRes = await fetch(JSONRPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth, Cookie: cookie },
      body: JSON.stringify({
        version: "2.0",
        method: "delivery_reject_job",
        id: 10,
        params: { data: { jobIds: [job.job_id], rejectReason: reject_reason } },
      }),
    });
    const rpcData = await rpcRes.json().catch(() => ({}));
    if (!rpcRes.ok || rpcData.error) {
      return NextResponse.json({ error: "Từ chối thất bại", details: rpcData }, { status: 500 });
    }

    return NextResponse.json({ success: true, job_id: job.job_id });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
