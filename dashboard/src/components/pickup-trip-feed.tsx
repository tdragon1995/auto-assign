"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Loader2, ArrowRight } from "lucide-react";
import { placeLabel } from "@/lib/place-label";
import { TripSteps, TRIP_STATE_STYLE, tripStateText, tripStateFromStops } from "@/components/trip-steps";
import type { PickupTrip } from "@/lib/pickup-trips";

// A scheduled run with no set time reads midnight, which is not when anyone asked.
const hm = (ts?: string | null) => (ts && !ts.endsWith("00:00:00") ? ts.slice(11, 16) : null);

/** A trip just created from a request page, shown until the published day lists it. */
export function justSentTrip(jobId: number, pickupName: string, dropoffName: string): PickupTrip {
  return {
    job_id: jobId, pickup_name: pickupName, dropoff_name: dropoffName, job_status_id: 2,
    pickup_status_id: 1, dropoff_status_id: 1, driver_name: null, parked: false,
    requested_ts: new Date().toLocaleString("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }),
    pickup_completed_ts: null, dropoff_started_ts: null, dropoff_completed_ts: null,
  };
}

function TripCard({ trip, showPickup }: { trip: PickupTrip; showPickup: boolean }) {
  const state = tripStateFromStops(trip.pickup_status_id, trip.dropoff_status_id, !!trip.driver_name, trip.job_status_id, trip.parked);
  const dest = placeLabel(trip.dropoff_name);
  return (
    <div className="rounded-2xl bg-white shadow-sm border border-gray-200 p-4">
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0">
          <p className="text-sm font-bold text-gray-800">
            {showPickup && placeLabel(trip.pickup_name)}
            <ArrowRight aria-hidden className="inline w-4 h-4 text-gray-500 mx-1" />{dest}
          </p>
          <p className="text-[11px] font-semibold text-gray-500 mt-0.5">
            {hm(trip.requested_ts) ?? "—"} · #{trip.job_id}{trip.driver_name ? ` · ${trip.driver_name}` : ""}
          </p>
        </div>
        <span className={`flex-none text-[11px] font-bold px-2.5 py-1 rounded-full whitespace-nowrap ${TRIP_STATE_STYLE[state]}`}>
          {tripStateText(state, dest)}
        </span>
      </div>
      <TripSteps
        times={[hm(trip.requested_ts), hm(trip.pickup_completed_ts), hm(trip.dropoff_started_ts), hm(trip.dropoff_completed_ts)]}
        state={state}
      />
    </div>
  );
}

/**
 * "Chuyến hôm nay" for a client request page. Loads once and on "Làm mới" — no polling,
 * which is what keeps it nearly free. `sent` is the page's own just-created trips, shown
 * until the published day (a few minutes behind) lists them; lost on reload, by which
 * time the day usually has them.
 */
export function PickupTripFeed({ url, sent, showPickup = false }: { url: string; sent: PickupTrip[]; showPickup?: boolean }) {
  const [trips, setTrips] = useState<PickupTrip[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error);
      setTrips(data.trips ?? []);
      setError("");
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Chưa tải được danh sách chuyến");
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => {
    const known = new Set(trips.map((t) => t.job_id));
    return [...sent.filter((t) => !known.has(t.job_id)), ...trips];
  }, [trips, sent]);

  return (
    <section className="w-full max-w-md space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold text-gray-900">Chuyến hôm nay ({shown.length})</h2>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold text-blue-700 bg-white border border-gray-200 active:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw aria-hidden className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Làm mới
        </button>
      </div>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {loading && !shown.length && (
        <p className="flex items-center justify-center gap-2 text-sm text-gray-500 py-6">
          <Loader2 aria-hidden className="w-4 h-4 animate-spin" />Đang tải…
        </p>
      )}
      {!loading && !error && !shown.length && (
        <p className="text-center text-sm text-gray-500 py-6">Chưa có chuyến nào hôm nay.</p>
      )}
      {shown.map((t) => <TripCard key={t.job_id} trip={t} showPickup={showPickup} />)}
    </section>
  );
}
