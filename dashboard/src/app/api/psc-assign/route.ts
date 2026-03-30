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

  const headers: Record<string, string> = {
    Authorization: auth,
    "Content-Type": "application/json",
  };
  if (cookie) headers["Cookie"] = cookie;
  return headers;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchJobsToday(status: number | null, from: string, to: string, env: Env): Promise<any[]> {
  const params = new URLSearchParams({
    "filter[scheduled_delivery_ts_from]": from,
    "filter[scheduled_delivery_ts_to]": to,
    limit: "1000",
  });
  if (status !== null) params.set("filter[job_status_id]", String(status));

  const res = await fetch(`${BASE_URL}/jobs?${params}`, {
    headers: getHeaders(env),
    cache: "no-store",
  });

  if (!res.ok) return [];
  const data = await res.json();
  return data.data ?? [];
}

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  try {
    const body = await req.json();
    const { psc_pickup, dropoff_location, pickup, dropoff, ref_number } = body;

    if (!pickup || !dropoff || !psc_pickup) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // --- Duplicate check ---
    // Use Vietnam time (UTC+7) to define "today"
    const vnNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const today = vnNow.toISOString().split("T")[0]; // YYYY-MM-DD
    const todayStart = `${today} 00:00:00`;
    const todayEnd = `${today} 23:59:59`;

    const [assignLaterJobs, assignedJobs, allTodayJobs] = await Promise.all([
      fetchJobsToday(2, todayStart, todayEnd, env), // status 2 = Assign Later
      fetchJobsToday(4, todayStart, todayEnd, env), // status 4 = Assigned
      fetchJobsToday(null, todayStart, todayEnd, env), // all statuses for running number
    ]);

    const allJobs = [...assignLaterJobs, ...assignedJobs];

    // Block only if the pickup stop is still active (Created=1, Started=2, Arrived=3)
    // Allow if stop is Completed=4 or Rejected=5
    const ACTIVE_STOP_STATUSES = new Set([1, 2, 3]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const duplicate = allJobs.find((job: any) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      job.stops?.some((stop: any) =>
        stop.stop_type_id === 1 &&
        stop.customer_id === pickup &&
        ACTIVE_STOP_STATUSES.has(stop.stop_status_id)
      )
    );

    if (duplicate) {
      return NextResponse.json(
        {
          error: "duplicate",
          message: `A job for this pickup already exists today (Job #${duplicate.job_id})`,
          job_id: duplicate.job_id,
        },
        { status: 409 }
      );
    }

    // --- Create the job ---
    const refBase = ref_number || `${psc_pickup}▶️${dropoff_location}`;
    const existingCount = allTodayJobs.filter((job: any) => {
      const r: string = job.reference_number ?? "";
      return r === refBase || r.startsWith(`${refBase}_`);
    }).length;
    const refLabel = `${refBase}_${existingCount + 1}`;

    const jobPayload = {
      job_type_id: 1,
      schedule_type_id: 1,
      reference_number: refLabel,
      labels: ["🛵 Vận chuyển mẫu PSC"],
      stops: [
        {
          stop_type_id: 1,
          customer_id: pickup,
          customer_name: psc_pickup,
          duration: 5,
          todos: [
            { todo_type_id: 2, description: "📦 Chụp thấy rõ mẫu đã đóng gói trong hộp" },
            { todo_type_id: 2, description: "✍️ Chụp batchsheet đã ký" },
          ],
        },
        {
          stop_type_id: 2,
          customer_id: dropoff,
          customer_name: dropoff_location,
          duration: 10,
          todos: [
            { todo_type_id: 2, description: "📋 Chụp các hộp thấy rõ batchsheet" },
            { todo_type_id: 2, description: "🤝 Chụp phiếu bàn giao & hàng mang về" },
          ],
        },
      ],
      items: [
        {
          description: "🧪 Mẫu",
          weight: 0,
          item_type_id: 1,
          quantity: 1,
          tracking_number: "",
          todos: [
            { todo_type_id: 3, stop_type_id: 1, is_required: true, description: "🔍 Quét mọi batchsheet" },
            { todo_type_id: 5, stop_type_id: 2, is_required: true, description: "👤 Người nhận" },
          ],
        },
      ],
    };

    const createRes = await fetch(`${BASE_URL}/jobs`, {
      method: "POST",
      headers: getHeaders(env),
      body: JSON.stringify(jobPayload),
    });

    if (!createRes.ok) {
      const errBody = await createRes.json().catch(() => ({}));
      return NextResponse.json({ error: "Failed to create job", details: errBody }, { status: createRes.status });
    }

    const created = await createRes.json();

    return NextResponse.json({
      success: true,
      reference: refLabel,
      job_id: created.data?.job_id,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
