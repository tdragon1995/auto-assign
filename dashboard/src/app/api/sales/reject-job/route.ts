import { NextRequest, NextResponse } from "next/server";
import { getFleetwebCookie, BASE_URL, JSONRPC_URL, getHeaders, type Env } from "@/lib/cartrack";
import { isStopStarted } from "@/lib/job-filters";
import { pushRunLog } from "@/lib/smart-log-kv";
import { vnTimestamp } from "@/lib/time";

export const runtime = "edge";
export const preferredRegion = "sin1";

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  try {
    const { reference_number, reject_reason } = await req.json();
    if (!reference_number || !reject_reason) {
      return NextResponse.json({ error: "Missing reference_number or reject_reason" }, { status: 400 });
    }

    const headers = getHeaders(env);

    // Lookup job by reference_number (no date filter)
    const qs = new URLSearchParams();
    qs.set("filter[reference_number]", reference_number);

    const findRes = await fetch(`${BASE_URL}/jobs?${qs.toString()}`, {
      headers,
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

    // Only allow reject if no stop has progressed beyond status 1 (Chờ lấy)
    const fullRes = await fetch(`${BASE_URL}/jobs/${job.job_id}`, {
      headers,
      cache: "no-store",
    });
    if (!fullRes.ok) {
      return NextResponse.json({ error: "Không lấy được chi tiết job" }, { status: 500 });
    }
    const fullData = await fullRes.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stops: any[] = fullData.data?.stops ?? [];
    const pickup = stops.find((s: any) => s.stop_type_id === 1);
    const pickupCustomerName = pickup?.customer_name ?? null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const started = stops.some((s: any) => isStopStarted(s));
    if (started) {
      return NextResponse.json({ error: "Không thể huỷ: tài xế đã bắt đầu công việc." }, { status: 409 });
    }

    // Always assign to proxy driver first, then reject via JSON-RPC
    const proxyDriverId = process.env.CARTRACK_REJECT_PROXY_DRIVER_ID ?? "";
    if (!proxyDriverId) {
      return NextResponse.json({ error: "CARTRACK_REJECT_PROXY_DRIVER_ID not configured" }, { status: 500 });
    }
    const assignRes = await fetch(`${BASE_URL}/jobs/${job.job_id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ delivery_driver_id: proxyDriverId }),
      cache: "no-store",
    });
    if (!assignRes.ok) {
      return NextResponse.json({ error: "Không thể giao job cho proxy driver trước khi huỷ" }, { status: 500 });
    }

    const cookie = await getFleetwebCookie();
    if (!cookie) {
      return NextResponse.json({ error: "Không thể đăng nhập Cartrack fleetweb" }, { status: 500 });
    }

    const rpcRes = await fetch(JSONRPC_URL, {
      method: "POST",
      headers: { ...headers, Cookie: cookie },
      body: JSON.stringify({
        version: "2.0",
        method: "delivery_reject_job",
        id: 10,
        params: { data: { jobIds: [job.job_id], rejectReason: reject_reason } },
      }),
    });
    const rpcData = await rpcRes.json().catch(() => ({}));
    if (!rpcRes.ok || rpcData.error) {
      const errorMsg = rpcData.error?.message ?? rpcData.error ?? "Cartrack API error";
      return NextResponse.json({
        error: `Từ chối thất bại: ${errorMsg}`,
        details: rpcData
      }, { status: 500 });
    }

    void pushRunLog([{
      ts: vnTimestamp(),
      level: "OK",
      msg: `[Sales] Huỷ job: Job ${job.job_id} | Ref: ${job.reference_number} | KH: ${pickupCustomerName ?? "—"} | Lý do: ${reject_reason}`,
    }]);
    return NextResponse.json({
      success: true,
      job_id: job.job_id,
      reference_number: job.reference_number,
      pickup_customer_name: pickupCustomerName,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
