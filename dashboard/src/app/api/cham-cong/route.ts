import { NextRequest, NextResponse } from "next/server";
import { loadPscRoutes } from "@/lib/psc-config";
import { assignJob, type Env } from "@/lib/cartrack";

const BASE_URL = "https://fleetapi-vn.cartrack.com/rest/delivery";
const CACHE_TTL_MS = 5 * 60 * 1000;

function getHeaders(env: Env = "prod"): Record<string, string> {
  const suffix = env === "uat" ? "_UAT" : "";
  const auth = process.env[`CARTRACK_AUTH${suffix}`] ?? "";
  const cookie = process.env[`CARTRACK_COOKIE${suffix}`] ?? "";
  if (!auth) throw new Error(`CARTRACK_AUTH${suffix} not set`);
  const headers: Record<string, string> = { Authorization: auth, "Content-Type": "application/json" };
  if (cookie) headers["Cookie"] = cookie;
  return headers;
}

// ── Location cache (customer_id → address) ─────────────────────────────────

interface LocationEntry {
  customer_id: string;
  name: string;
  address: string;
}

let locationsCache: { data: LocationEntry[]; ts: number } | null = null;

async function fetchLocations(env: Env): Promise<LocationEntry[]> {
  if (locationsCache && Date.now() - locationsCache.ts < CACHE_TTL_MS) {
    return locationsCache.data;
  }

  const routes = await loadPscRoutes();

  // Deduplicate pickup customer_ids
  const seen = new Set<string>();
  const pickups: { customer_id: string; name: string }[] = [];
  for (const r of routes) {
    if (r.pickup && r.psc_pickup && !seen.has(r.pickup)) {
      seen.add(r.pickup);
      pickups.push({ customer_id: r.pickup, name: r.psc_pickup });
    }
  }

  // Fetch address for each location in parallel
  const headers = getHeaders(env);
  const enriched = await Promise.all(
    pickups.map(async (p) => {
      try {
        const res = await fetch(`${BASE_URL}/customers/${p.customer_id}`, { headers });
        if (!res.ok) return { ...p, address: "" };
        const data = await res.json();
        const c = data.data ?? data;
        const address = [c.address_line_1, c.address_line_2]
          .filter(Boolean)
          .join(", ");
        return { customer_id: p.customer_id, name: p.name, address };
      } catch {
        return { ...p, address: "" };
      }
    })
  );

  enriched.sort((a, b) => a.name.localeCompare(b.name, "vi"));
  locationsCache = { data: enriched, ts: Date.now() };
  return enriched;
}

// ── GET /api/cham-cong — location list with addresses ─────────────────────

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  try {
    const pscs = await fetchLocations(env);
    return NextResponse.json({ pscs });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ── POST /api/cham-cong — create check-in or check-out job ────────────────

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  try {
    const { driver_id, driver_name, psc_customer_id, psc_name, type } = await req.json();

    if (!driver_id || !psc_customer_id || (type !== "check-in" && type !== "check-out")) {
      return NextResponse.json({ error: "Missing or invalid fields" }, { status: 400 });
    }

    // ── Validation: fetch today's cham-cong jobs for this driver ─────────
    const headers = getHeaders(env);
    const vnNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const today = vnNow.toISOString().split("T")[0];

    const checkRes = await fetch(
      `${BASE_URL}/jobs?filter[driver_id]=${driver_id}&filter[create_ts_from]=${today} 00:00:00&filter[create_ts_to]=${today} 23:59:59&limit=100`,
      { headers, cache: "no-store" }
    );

    if (checkRes.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const checkData = await checkRes.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const todayJobs: any[] = checkData.data ?? [];

      const chamCongJobs = todayJobs.filter(
        (j) =>
          (j.reference_number ?? "").startsWith("Chấm Công -") &&
          j.job_status_id !== 7 &&
          j.job_status_id !== 3
      );

      const checkInCount        = chamCongJobs.filter((j) => (j.labels ?? []).includes("check_in")).length;
      const completedCheckOuts  = chamCongJobs.filter((j) => (j.labels ?? []).includes("check_out") && j.job_status_id === 5).length;
      const activeCheckOuts     = chamCongJobs.filter((j) => (j.labels ?? []).includes("check_out") && j.job_status_id !== 5).length;

      // Shift is open if more check-ins than *completed* check-outs
      const hasOpenShift = checkInCount > completedCheckOuts;

      if (type === "check-in" && hasOpenShift) {
        return NextResponse.json(
          { error: "Tài xế đang trong ca làm việc. Vui lòng chấm công ra trước." },
          { status: 409 }
        );
      }
      // Block check-out if a pending check-out already exists, or shift is fully closed
      const alreadyCheckedOut =
        activeCheckOuts > 0 ||
        (completedCheckOuts > 0 && completedCheckOuts >= checkInCount);
      if (type === "check-out" && alreadyCheckedOut) {
        return NextResponse.json(
          { error: activeCheckOuts > 0
              ? "Đã có yêu cầu chấm công ra đang chờ xử lý."
              : "Tài xế đã chấm công ra rồi. Vui lòng chấm công vào trước." },
          { status: 409 }
        );
      }
    }

    const isCheckin = type === "check-in";
    const jobPayload = {
      job_type_id: 3,
      schedule_type_id: 1,
      reference_number: `Chấm Công - ${psc_name} - ${isCheckin ? "Vào" : "Ra"}`,
      labels: [isCheckin ? "check_in" : "check_out"],
      stops: [
        {
          stop_type_id: 3,
          customer_id: psc_customer_id,
          customer_name: psc_name,
          duration: 5,
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
    const jobId: number | undefined = created.data?.job_id;
    if (!jobId) return NextResponse.json({ error: "No job_id returned from Cartrack" }, { status: 500 });

    const assignResult = await assignJob(driver_id, jobId, driver_name, env);
    if (assignResult.status !== 200) {
      return NextResponse.json(
        { warning: "Job created but driver assignment failed", job_id: jobId, assign_status: assignResult.status },
        { status: 207 }
      );
    }

    return NextResponse.json({ success: true, job_id: jobId });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
