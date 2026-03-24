import { NextRequest, NextResponse } from "next/server";
import { getActiveJobs, type Env } from "@/lib/cartrack";

export const runtime = "edge";
export const preferredRegion = "sin1";

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const pickup = req.nextUrl.searchParams.get("pickup") ?? "";
  const dropoff = req.nextUrl.searchParams.get("dropoff") ?? "";

  if (!pickup || !dropoff) {
    return NextResponse.json({ error: "Missing pickup or dropoff" }, { status: 400 });
  }

  try {
    const { data: jobs } = await getActiveJobs(env);

    // Return full debug snapshot so the client can log everything
    const debug = jobs.map((job) => ({
      job_id: job.job_id,
      reference_number: job.reference_number,
      job_status_id: job.job_status_id,
      stops: job.stops.map((s) => ({
        stop_type_id: s.stop_type_id,
        stop_status_id: s.stop_status_id,
        customer_id: s.customer_id,
        customer_name: s.customer_name,
      })),
    }));

    for (const job of jobs) {
      const pickupStop = job.stops.find(
        (s) => s.stop_type_id === 1 && s.customer_id === pickup
      );
      const dropoffStop = job.stops.find((s) => s.customer_id === dropoff);

      if (pickupStop && dropoffStop) {
        const status = pickupStop.stop_status_id ?? 0;
        if (status === 1 || status === 2) {
          return NextResponse.json({
            blocked: true,
            reference: job.reference_number ?? String(job.job_id),
            stop_status_id: status,
            total_jobs: jobs.length,
            debug,
          });
        }
      }
    }

    return NextResponse.json({ blocked: false, total_jobs: jobs.length, debug });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
