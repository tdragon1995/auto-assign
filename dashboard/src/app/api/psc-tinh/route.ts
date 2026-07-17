import { NextRequest, NextResponse } from "next/server";
import { loadTplEntries, PSC_TINH_LABEL } from "@/lib/psc-config";
import { BASE_URL, getHeaders, getStopsByLabels, createJob, type Env } from "@/lib/cartrack";
import { vnDate, vnTimestamp } from "@/lib/time";
import { STOP_STATUS, JOB_STATUS } from "@/lib/job-filters";
import { pushRunLog } from "@/lib/smart-log-kv";

export const runtime = "edge";
export const preferredRegion = "sin1";

const D001_UUID = "3927b076-3af9-11ed-b939-506b8dbc8dfb";

/** Group flat delivery_get_stops_list stops by job_id, keep only this PSC's jobs
 *  (reference prefix) that aren't failed/cancelled, and map to the orders view shape.
 *  Address comes straight off the stop (address_line_1) — no TPL uuid→address lookup. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildOrdersFromStops(stops: any[], prefix: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byJob = new Map<number, any[]>();
  for (const s of stops) {
    const arr = byJob.get(s.job_id);
    if (arr) arr.push(s);
    else byJob.set(s.job_id, [s]);
  }

  return [...byJob.values()]
    .map((js) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pickup  = js.find((s: any) => s.stop_type_id === 1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dropoff = js.find((s: any) => s.stop_type_id === 2);
      const ref = pickup?.reference_number ?? dropoff?.reference_number ?? "";
      const jobStatusId = pickup?.job_status_id ?? dropoff?.job_status_id;
      return { pickup, dropoff, ref, jobStatusId };
    })
    .filter((o) => o.ref.startsWith(prefix) && o.jobStatusId !== 3 && o.jobStatusId !== 7)
    .sort((a, b) => a.ref.localeCompare(b.ref, "vi", { numeric: true }))
    .map(({ pickup, dropoff, ref, jobStatusId }) => ({
      job_id:    pickup?.job_id ?? dropoff?.job_id,
      reference: ref,
      job_status: JOB_STATUS[jobStatusId] ?? "Không rõ",
      pickup_name:      pickup?.customer_name ?? null,
      pickup_address:   pickup?.address_line_1 ?? null,
      pickup_stop_id:   (pickup?.stop_id ?? null) as number | null,
      pickup_status_id: (pickup?.stop_status_id ?? null) as number | null,
      dropoff_status_id: dropoff?.stop_status_id ?? null,
      dropoff_status:    STOP_STATUS[dropoff?.stop_status_id]?.label ?? "—",
      dropoff_color:     STOP_STATUS[dropoff?.stop_status_id]?.color ?? "slate",
      dropoff_update_ts: (
        dropoff?.activity_completed_ts ??
        dropoff?.activity_arrived_ts ??
        dropoff?.activity_started_ts ??
        null
      )?.slice(0, 19) ?? null,
      eta: pickup?.delivery_windows?.[0]?.time_from?.slice(0, 5) ?? null,
      driver_name: pickup?.driver_name ?? dropoff?.driver_name ?? null,
    }));
}

// ── GET /api/psc-tinh?psc=D021 — 3PL options ─────────────────────────────────
// GET /api/psc-tinh?psc=D021&mode=orders — today's orders for this PSC

export async function GET(req: NextRequest) {
  const psc  = req.nextUrl.searchParams.get("psc")?.trim().toUpperCase();
  const mode = req.nextUrl.searchParams.get("mode");
  const env  = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  if (!psc) return NextResponse.json({ error: "Missing psc param" }, { status: 400 });

  // ── mode=orders: fetch today's jobs for this PSC ──────────────────────────
  if (mode === "orders") {
    const today = vnDate();
    const prefix = `BRA - ${psc} - Mẫu`;

    // Fast path (prod): one label-filtered JSON-RPC call returns only PSC-tỉnh stops
    // with every field this view needs (address, driver, ETA, status), instead of
    // pulling the whole day's jobs over REST and filtering client-side. A throw
    // (e.g. malformed CARTRACK_AUTH inside getFleetwebCookie) degrades to the REST
    // fallback like any other fast-path failure instead of 500ing the view.
    let labelStops: Awaited<ReturnType<typeof getStopsByLabels>> = null;
    try {
      labelStops = await getStopsByLabels(today, [PSC_TINH_LABEL], env);
    } catch {
      labelStops = null;
    }
    if (labelStops) {
      return NextResponse.json({ orders: buildOrdersFromStops(labelStops, prefix) });
    }

    // Fallback (UAT / JSON-RPC unavailable): REST — fetch the day's jobs, filter by prefix.
    try {
      const headers = getHeaders(env);

      const [jobsRes, tplEntries] = await Promise.all([
        fetch(
          `${BASE_URL}/jobs?filter[scheduled_delivery_ts_from]=${today} 00:00:00&filter[scheduled_delivery_ts_to]=${today} 23:59:59&limit=1000`,
          { headers, cache: "no-store" }
        ),
        loadTplEntries(),
      ]);
      if (!jobsRes.ok) return NextResponse.json({ orders: [] });

      const tplByUuid = new Map(tplEntries.map((e) => [e.tpl_uuid, e.address]));
      const data = await jobsRes.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const jobs: any[] = data.data ?? [];

      const orders = jobs
        .filter((j) => (j.reference_number ?? "").startsWith(prefix) && j.job_status_id !== 3 && j.job_status_id !== 7)
        .sort((a, b) => (a.reference_number ?? "").localeCompare(b.reference_number ?? "", "vi", { numeric: true }))
        .map((j) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const stops: any[] = j.stops ?? [];
          const pickup  = stops.find((s: any) => s.stop_type_id === 1);
          const dropoff = stops.find((s: any) => s.stop_type_id === 2);
          return {
            job_id:    j.job_id,
            reference: j.reference_number,
            job_status: JOB_STATUS[j.job_status_id] ?? "Không rõ",
            pickup_name:      pickup?.customer_name ?? null,
            pickup_address:   tplByUuid.get(pickup?.customer_id) ?? null,
            pickup_stop_id:   (pickup?.stop_id ?? null) as number | null,
            pickup_status_id: (pickup?.stop_status_id ?? null) as number | null,
            dropoff_status_id: dropoff?.stop_status_id ?? null,
            dropoff_status:    STOP_STATUS[dropoff?.stop_status_id]?.label ?? "—",
            dropoff_color:     STOP_STATUS[dropoff?.stop_status_id]?.color ?? "slate",
            dropoff_update_ts: (
              dropoff?.activity_completed_ts ??
              dropoff?.activity_arrived_ts ??
              dropoff?.activity_started_ts ??
              null
            ),
            eta: pickup?.delivery_windows?.[0]?.time_from?.slice(0, 5) ?? null,
          };
        });

      return NextResponse.json({ orders });
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 });
    }
  }

  // ── default: 3PL options ──────────────────────────────────────────────────
  try {
    const entries = await loadTplEntries();
    const options = entries
      .filter((e) => e.psc_tinh.toUpperCase().includes(psc))
      .map((e) => ({
        tpl_uuid: e.tpl_uuid,
        tpl_name: e.tpl_name,
        address: e.address,
      }));

    return NextResponse.json({ options });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ── POST /api/psc-tinh ───────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  try {
    const { psc_code, tpl_uuid, eta, note } = await req.json();

    if (!psc_code || !tpl_uuid || !eta) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const headers = getHeaders(env);

    // Count today's non-cancelled jobs from this PSC for reference_number.
    const today = vnDate();
    const prefix = `BRA - ${psc_code} - Mẫu`;

    // Fast path (prod): count the exact rows the orders view shows — reusing
    // buildOrdersFromStops keeps the reference counter and the visible order list
    // in lockstep, so a job the view renders is never skipped by the numbering.
    // A throw degrades to the REST fallback below.
    let count: number | null = null;
    try {
      const labelStops = await getStopsByLabels(today, [PSC_TINH_LABEL], env);
      if (labelStops) count = buildOrdersFromStops(labelStops, prefix).length;
    } catch {
      count = null;
    }

    // Fallback (UAT / JSON-RPC unavailable): REST — fetch the day's jobs and count.
    if (count === null) {
      const countRes = await fetch(
        `${BASE_URL}/jobs?filter[scheduled_delivery_ts_from]=${today} 00:00:00&filter[scheduled_delivery_ts_to]=${today} 23:59:59&limit=1000`,
        { headers, cache: "no-store" }
      );

      count = 0;
      if (countRes.ok) {
        const countData = await countRes.json();
        const jobs: { reference_number?: string; job_status_id?: number }[] = countData.data ?? [];
        count = jobs.filter(
          (j) => j.job_status_id !== 7 && j.job_status_id !== 3 && (j.reference_number ?? "").startsWith(prefix)
        ).length;
      }
    }

    const refNumber = `${prefix} ${count + 1}`;

    // Build ETA window: time_from = eta, time_to = eta + 30 min
    const [etaH, etaM] = eta.split(":").map(Number);
    const toMins = etaH * 60 + etaM + 30;
    const toH = String(Math.floor(toMins / 60) % 24).padStart(2, "0");
    const toMin = String(toMins % 60).padStart(2, "0");
    const etaFrom = `${eta}:00+07:00`;
    const etaTo = `${toH}:${toMin}:00+07:00`;

    const jobPayload = {
      job_type_id: 1,
      schedule_type_id: 1,
      reference_number: refNumber,
      labels: [PSC_TINH_LABEL],
      stops: [
        {
          stop_type_id: 1,
          customer_id: tpl_uuid,
          duration: 5,
          note: note || null,
          delivery_windows: [{ time_from: etaFrom, time_to: etaTo }],
          todos: [
            { todo_type_id: 2, description: "" },
            { todo_type_id: 5, description: "" },
          ],
        },
        {
          stop_type_id: 2,
          customer_id: D001_UUID,
          duration: 10,
          todos: [
            { todo_type_id: 2, description: "" },
            { todo_type_id: 5, description: "" },
          ],
        },
      ],
    };

    const createRes = await createJob(jobPayload, env);

    if (!createRes.ok) {
      return NextResponse.json({ error: "Failed to create job", details: createRes.body }, { status: createRes.status });
    }

    const created = createRes.body;
    const jobId = created.data?.job_id;
    void pushRunLog([{
      ts: vnTimestamp(),
      level: "OK",
      msg: `[PSC-tỉnh] Tạo chuyến: Job ${jobId}, ETA ${eta}, Ref: ${refNumber} | ${psc_code}`,
    }]);
    return NextResponse.json({
      success: true,
      reference: refNumber,
      job_id: jobId,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ── DELETE /api/psc-tinh?job_id=123 — cancel job (only if not started) ───────

export async function DELETE(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const jobId = req.nextUrl.searchParams.get("job_id");

  if (!jobId) return NextResponse.json({ error: "Missing job_id" }, { status: 400 });

  try {
    const headers = getHeaders(env);

    const jobRes = await fetch(`${BASE_URL}/jobs/${jobId}`, { headers, cache: "no-store" });
    if (!jobRes.ok) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    const jobData = await jobRes.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stops: any[] = jobData.data?.stops ?? [];
    const pickup = stops.find((s) => s.stop_type_id === 1);
    if (pickup && pickup.stop_status_id !== 1) {
      return NextResponse.json({ error: "Không thể huỷ: tài xế đã bắt đầu công việc." }, { status: 409 });
    }

    const res = await fetch(`${BASE_URL}/jobs/${jobId}?force=true`, { method: "DELETE", headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return NextResponse.json({ error: "Failed to cancel job", details: err }, { status: res.status });
    }
    void pushRunLog([{
      ts: vnTimestamp(),
      level: "OK",
      msg: `[PSC-tỉnh] Huỷ job: Job ${jobId}`,
    }]);
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

