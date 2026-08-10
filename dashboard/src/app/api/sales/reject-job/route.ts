import { NextRequest, NextResponse } from "next/server";
import { BASE_URL, jsonRpc, getHeaders, assignJob, type Env } from "@/lib/cartrack";
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
    // The list response already carries the full `stops` array (verified on prod:
    // stop_status_id, activity_*_ts and customer_name are all present). A second
    // GET /jobs/{id} for the detail costs ~4.5s of Cartrack latency and returns
    // nothing new — and this route's whole budget is the edge runtime's 25s.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jobs: any[] = findData.data ?? [];
    const job = jobs.find((j) => (j.reference_number ?? "").trim() === reference_number.trim());
    if (!job) {
      return NextResponse.json({ error: "Không tìm thấy reference_number" }, { status: 404 });
    }
    if (job.job_status_id === 3 || job.job_status_id === 7) {
      return NextResponse.json({ error: "Job đã bị huỷ/từ chối trước đó" }, { status: 409 });
    }

    // Only allow reject if no stop has progressed beyond status 1 (Chờ lấy)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stops: any[] = job.stops ?? [];
    const pickup = stops.find((s: any) => s.stop_type_id === 1);
    const pickupCustomerName = pickup?.customer_name ?? null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dropoffCustomerName = stops.find((s: any) => s.stop_type_id === 2)?.customer_name ?? "—";
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
    // assignJob, not a hand-rolled REST PUT: it tries the fleetweb RPC first
    // (~2.0s vs ~7.3s REST, measured 2026-07-18) and falls back to REST on its own.
    // isProxyDriver() exempts the reject proxy from the driver-state gate, so the
    // RPC path costs no extra drivers fetch. This is the same call the duplicate
    // rejection in assign.ts already makes.
    const { status: assignStatus } = await assignJob(proxyDriverId, job.job_id, env);
    if (assignStatus !== 200) {
      return NextResponse.json({ error: "Không thể giao job cho proxy driver trước khi huỷ" }, { status: 500 });
    }

    const out = await jsonRpc(
      "delivery_reject_job",
      { data: { jobIds: [job.job_id], rejectReason: reject_reason } },
      { env, id: 10 }
    );
    if (!out.ok) {
      return NextResponse.json({ error: `Từ chối thất bại: ${out.error}` }, { status: 500 });
    }

    // AWAITED, not fired and forgotten: on the edge runtime an unawaited promise
    // dies with the invocation, so a cancel that lands right at the timeout gets
    // rejected on Cartrack with no trace in the run log — exactly what happened to
    // job 34411772 on 2026-08-10.
    await pushRunLog([{
      ts: vnTimestamp(),
      level: "OK",
      msg: `[Sales] Huỷ job: Job ${job.job_id}, Ref: ${job.reference_number}, Lý do: ${reject_reason} | ${pickupCustomerName ?? "—"} → ${dropoffCustomerName}`,
    }]).catch(() => {});
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
