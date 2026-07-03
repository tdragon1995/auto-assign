import { NextRequest, NextResponse } from "next/server";
import { BASE_URL, getHeaders, getTimelineJobs, getJobDetails, type Env } from "@/lib/cartrack";
import type { Job, Stop } from "@/lib/types";

export const runtime = "edge";
export const preferredRegion = "sin1";

// GET /api/location-jobs?date=2026-04-11&status=4&code=<customer_uuid>
//   Location-scoped list for the /qr page: only jobs touching `code`, slimmed to
//   the fields the list renders. The old whole-day dump was ~220 KB per tap and
//   the phone discarded 99% of it (all locations, todos, POD images).
// GET /api/location-jobs?job_id=123
//   Full detail for one job (address, todos, POD image URLs) — fetched only when
//   staff open the job sheet.
// Without `code`, returns the legacy whole-day dump so cached bundles keep working.

// REST embeds the human name in driver.last_name (first_name is an internal code);
// timeline-derived jobs carry the route's driverFullname in first_name, prefixed
// with that internal code ("F - C - DC100320 Lý Chánh Hùng"). Take whichever is
// populated and strip the code prefix so the page can keep reading driver.last_name.
function displayName(driver: Job["driver"]): string | null {
  const raw = driver?.last_name?.trim() || driver?.first_name?.trim() || null;
  return raw ? raw.replace(/^(?:[A-Z]{1,2}\s*-\s*){0,2}DC\w+\s+/, "") : null;
}

function slimStop(s: Stop) {
  return {
    stop_id: s.stop_id,
    stop_type_id: s.stop_type_id,
    stop_status_id: s.stop_status_id,
    customer_id: s.customer_id,
    customer_name: s.customer_name ?? s.name ?? "",
    activity_started_ts: s.activity_started_ts ?? null,
    activity_arrived_ts: s.activity_arrived_ts ?? null,
    activity_completed_ts: s.activity_completed_ts ?? null,
  };
}

function slimJob(j: Job) {
  return {
    job_id: j.job_id,
    reference_number: j.reference_number,
    job_status_id: j.job_status_id,
    scheduled_delivery_ts: j.scheduled_delivery_ts ?? null,
    driver: { last_name: displayName(j.driver) },
    stops: (j.stops ?? []).map(slimStop),
  };
}

// Job-sheet detail: slim fields plus address, todos and POD image URLs. The
// images stay links (Cartrack serves them publicly) — nothing binary passes
// through this function.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function detailJob(j: any) {
  return {
    job_id: j.job_id,
    reference_number: j.reference_number,
    job_status_id: j.job_status_id,
    scheduled_delivery_ts: j.scheduled_delivery_ts ?? null,
    driver: { last_name: displayName(j.driver) },
    // Batch IDs (Mã Batch) attached by the via-3PL flow or scanned by the driver.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    item_tracking_numbers: (j.items ?? []).map((it: any) => it.tracking_number).filter(Boolean),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stops: (j.stops ?? []).map((s: any) => ({
      ...slimStop(s),
      address_line_1: s.address_line_1 ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      todos: (s.todos ?? []).map((t: any) => ({
        todo_type_id: t.todo_type_id,
        description: t.description ?? null,
        note: t.note ?? null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        images: (t.images ?? []).map((img: any) => ({
          image_id: img.image_id,
          image_url: img.image_url,
          is_deleted: img.is_deleted,
        })),
      })),
    })),
  };
}

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  // ── ?job_id=123: full detail for the job sheet ─────────────────────────────
  const jobIdParam = req.nextUrl.searchParams.get("job_id");
  if (jobIdParam) {
    try {
      const { data } = await getJobDetails(Number(jobIdParam), env);
      if (!data?.job_id) return NextResponse.json({ error: "Job not found" }, { status: 404 });
      return NextResponse.json({ job: detailJob(data) });
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 });
    }
  }

  const date = req.nextUrl.searchParams.get("date");
  const status = req.nextUrl.searchParams.get("status");
  const code = req.nextUrl.searchParams.get("code");

  if (!date || !status) {
    return NextResponse.json({ error: "Missing date or status" }, { status: 400 });
  }

  try {
    // Fast path (prod, code-scoped): one timeline JSON-RPC call covers assigned +
    // completed jobs; filter to this location and slim before responding. Any
    // failure (including a throw) falls back to REST rather than 500ing.
    if (code) {
      let timeline: Job[] | null = null;
      try {
        timeline = await getTimelineJobs(date, env);
      } catch {
        timeline = null;
      }
      if (timeline) {
        const statusId = Number(status);
        const jobs = timeline
          .filter((j) => j.job_status_id === statusId && (j.stops ?? []).some((s) => s.customer_id === code))
          .map(slimJob);
        return NextResponse.json({ jobs });
      }
    }

    const headers = getHeaders(env);
    const res = await fetch(
      `${BASE_URL}/jobs?filter[scheduled_delivery_ts_from]=${date} 00:00:00&filter[scheduled_delivery_ts_to]=${date} 23:59:59&filter[job_status_id]=${status}&limit=1000`,
      { headers, cache: "no-store" }
    );
    if (!res.ok) return NextResponse.json({ jobs: [] });
    const data = await res.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allJobs: any[] = data.data ?? [];

    // Code-scoped REST fallback: same filter + slim as the fast path.
    if (code) {
      const jobs = allJobs
        .filter((j) => (j.stops ?? []).some((s: Stop) => s.customer_id === code))
        .map(slimJob);
      return NextResponse.json({ jobs });
    }

    return NextResponse.json({ jobs: allJobs });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
