import { NextRequest, NextResponse } from "next/server";
import { getJobsByStatusAndDate, type Env } from "@/lib/cartrack";
import type { Job, Stop } from "@/lib/types";

// Node runtime + a generous duration: a wide date range fetches day-by-day
// sequentially, and each day can itself paginate several Cartrack calls.
export const runtime = "nodejs";
export const maxDuration = 60;
export const preferredRegion = "sin1";

// job_status_id 5 = Hoàn thành (Completed). Fixed by spec.
const COMPLETED_STATUS = 5;

// Cap the range so one request can't fan out into hundreds of Cartrack calls.
const MAX_DAYS = 62;

// One exported row per completed job. Field names stay faithful to Cartrack.
// distance_km / duration_mins are filled later by the client "Mileage
// calculation" step (Goong); lat/lon are carried for that lookup, not exported.
export interface CompletedRow {
  ft_pt: string;                       // FT/PT — driver first name starts F→FT, P→PT
  driver_name: string;                 // driver.first_name + " " + driver.last_name
  device_description: string;          // driver.device_description
  reference_number: string;            // Order # = job.reference_number
  pickup_customer_name: string;        // stop[0].customer_name (blank if single-stop)
  pickup_activity_completed_ts: string;
  pickup_activity_arrived_ts: string;
  pickup_coords: string;               // "lat,long"
  dropoff_customer_name: string;       // last stop's customer_name
  dropoff_activity_completed_ts: string;
  dropoff_activity_arrived_ts: string;
  dropoff_coords: string;
  distance_km: number | "";            // Goong road distance, pickup→dropoff
  duration_mins: number | "";          // Goong travel-time estimate
  // Raw coordinates for the mileage lookup (not emitted to CSV).
  lat1: number | null;
  lon1: number | null;
  lat2: number | null;
  lon2: number | null;
}

// Inclusive list of "YYYY-MM-DD" days. Built at UTC midnight and stepped by whole
// days so there's no DST drift — the strings only feed Cartrack's date filters.
function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) return days;
  for (let t = start; t <= end; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

function coordsStr(stop: Stop | undefined): string {
  if (!stop || stop.latitude == null || stop.longitude == null) return "";
  return `${stop.latitude},${stop.longitude}`;
}

function mapJob(job: Job): CompletedRow {
  const dr = job.driver;
  const driverName = `${dr?.first_name ?? ""} ${dr?.last_name ?? ""}`.trim();
  const fn = (dr?.first_name ?? "").trim().toUpperCase();
  const ftPt = fn.startsWith("F") ? "FT" : fn.startsWith("P") ? "PT" : "";

  // Transport jobs carry [pickup(type 1), dropoff(type 2)]. A job_type_id 3
  // (delivery) job has a SINGLE stop — by rule that stop is the dropoff, so the
  // pickup columns stay blank.
  const stops = job.stops ?? [];
  const pickup = stops.length >= 2 ? stops[0] : undefined;
  const dropoff = stops.length >= 2 ? stops[1] : stops[0];

  return {
    ft_pt: ftPt,
    driver_name: driverName,
    device_description: dr?.device_description ?? "",
    reference_number: job.reference_number ?? "",
    pickup_customer_name: pickup?.customer_name ?? "",
    pickup_activity_completed_ts: pickup?.activity_completed_ts ?? "",
    pickup_activity_arrived_ts: pickup?.activity_arrived_ts ?? "",
    pickup_coords: coordsStr(pickup),
    dropoff_customer_name: dropoff?.customer_name ?? "",
    dropoff_activity_completed_ts: dropoff?.activity_completed_ts ?? "",
    dropoff_activity_arrived_ts: dropoff?.activity_arrived_ts ?? "",
    dropoff_coords: coordsStr(dropoff),
    distance_km: "",
    duration_mins: "",
    lat1: pickup?.latitude ?? null,
    lon1: pickup?.longitude ?? null,
    lat2: dropoff?.latitude ?? null,
    lon2: dropoff?.longitude ?? null,
  };
}

// GET /api/export-completed?from=2026-06-01&to=2026-06-21&env=prod
// Returns every job_status_id=5 job scheduled within [from, to], one row each.
export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const from = req.nextUrl.searchParams.get("from");
  const to = req.nextUrl.searchParams.get("to");

  if (!from || !to) {
    return NextResponse.json({ error: "Missing from or to (YYYY-MM-DD)" }, { status: 400 });
  }

  const days = eachDay(from, to);
  if (days.length === 0) {
    return NextResponse.json({ error: "Invalid range: from must be ≤ to" }, { status: 400 });
  }
  if (days.length > MAX_DAYS) {
    return NextResponse.json(
      { error: `Range too wide: ${days.length} days (max ${MAX_DAYS})` },
      { status: 400 }
    );
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const rows: CompletedRow[] = [];
  const errors: string[] = [];

  for (let i = 0; i < days.length; i++) {
    const date = days[i];
    // A short gap between days keeps the call rate gentle on Cartrack. The
    // per-day pagination inside getJobsByStatusAndDate is already sequential.
    if (i > 0) await sleep(250);
    try {
      const jobs = await getJobsByStatusAndDate(COMPLETED_STATUS, date, env);
      for (const job of jobs) rows.push(mapJob(job));
    } catch (e) {
      // One bad day shouldn't sink the whole export — record it and carry on.
      errors.push(`${date}: ${String(e)}`);
    }
  }

  // Stable order: by dropoff arrival (blanks last), then reference number.
  rows.sort(
    (a, b) =>
      (a.dropoff_activity_arrived_ts || "~").localeCompare(b.dropoff_activity_arrived_ts || "~") ||
      a.reference_number.localeCompare(b.reference_number)
  );

  return NextResponse.json({ count: rows.length, days: days.length, rows, errors });
}
