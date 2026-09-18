"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Loader2, ArrowRight, Clock } from "lucide-react";
import { placeLabel } from "@/lib/place-label";
import { TRIP_STATE_STYLE, tripStateText, tripStateFromStops, isTripWaiting, type TripState } from "@/components/trip-steps";
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

const STEPS = ["Lấy mẫu", "Đã giao"] as const;

function initial(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1][0].toUpperCase() : "?";
}

/** The /qr two-step bar: collected, handed over; the current step pulses. */
function Stepper({ trip, state }: { trip: PickupTrip; state: TripState }) {
  const times = [hm(trip.pickup_completed_ts), hm(trip.dropoff_completed_ts)];
  const doneUpto = state === 3 ? 1 : state === 2 ? 0 : -1;
  const nowIdx = state === 3 ? -1 : state === 2 ? 1 : 0;
  return (
    <div className="flex items-start mt-2 mb-1">
      {STEPS.map((label, i) => {
        const done = i <= doneUpto;
        const current = i === nowIdx;
        return (
          <div key={label} className="flex-1 flex flex-col items-center relative">
            {i > 0 && (
              <span aria-hidden className={`absolute top-[5px] -left-1/2 w-full h-[3px] ${done || current ? "bg-green-600" : "bg-slate-200"}`} />
            )}
            <span
              aria-hidden
              className={`relative z-10 w-3.5 h-3.5 rounded-full border-[3px] ${
                done ? "bg-green-600 border-green-600" : current ? "bg-white border-blue-600 animate-pulse" : "bg-slate-200 border-slate-200"
              }`}
            />
            <span className={`mt-1.5 text-[10px] font-semibold leading-tight text-center ${done ? "text-green-700" : current ? "text-blue-700" : "text-slate-500"}`}>
              {label}
            </span>
            {times[i] && <span className="text-[10px] font-bold tabular-nums text-slate-500">{times[i]}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** Same status display as a /qr trip card; "Huỷ chuyến" is its only action. */
function TripCard({ trip, showPickup, url, onCancelled }: { trip: PickupTrip; showPickup: boolean; url: string; onCancelled: (jobId: number) => void }) {
  const state = tripStateFromStops(trip.pickup_status_id, trip.dropoff_status_id, !!trip.driver_name, trip.job_status_id, trip.parked);
  return (
    <div className="rounded-2xl bg-white shadow-sm border border-slate-100 p-4">
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0">
          <p className="text-base font-extrabold tracking-tight text-slate-800">
            {showPickup && placeLabel(trip.pickup_name)}
            <ArrowRight aria-hidden className="inline w-4 h-4 text-slate-500 mx-0.5 shrink-0" /> {placeLabel(trip.dropoff_name)}
          </p>
          <p className="text-[11px] font-semibold text-slate-500 mt-1">
            Yêu cầu lúc {hm(trip.requested_ts) ?? "—"} · #{trip.job_id}
          </p>
        </div>
        <span className={`flex-none text-[11px] font-bold px-2.5 py-1 rounded-full whitespace-nowrap ${TRIP_STATE_STYLE[state]}`}>
          {tripStateText(state)}
        </span>
      </div>

      {state !== 4 && <Stepper trip={trip} state={state} />}

      {isTripWaiting(state) ? (
        <div className="flex items-center gap-2 mt-3 pt-3 border-t border-slate-100 text-[13px] font-semibold text-amber-700">
          <Clock aria-hidden className="w-4 h-4 shrink-0" />
          {state === 5 ? "Đã đặt lịch, chờ tới giờ hẹn lấy mẫu" : "Đang chờ điều phối Giao Nhận Mẫu"}
        </div>
      ) : state !== 4 && trip.driver_name && (
        <div className="flex items-center gap-2.5 mt-3 pt-3 border-t border-slate-100">
          <span aria-hidden className="w-8 h-8 flex-none rounded-full bg-blue-100 text-blue-700 font-extrabold text-xs flex items-center justify-center">
            {initial(trip.driver_name)}
          </span>
          <span className="flex-1 min-w-0 text-sm font-bold text-slate-800 break-words">{trip.driver_name}</span>
        </div>
      )}

      {canCancel(trip) && <CancelTripButton url={url} jobId={trip.job_id} onCancelled={onCancelled} />}
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
  // Cancelled here: the published day can still list them for a few minutes.
  const [cancelled, setCancelled] = useState<Set<number>>(() => new Set());

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
    return [...sent.filter((t) => !known.has(t.job_id)), ...trips].filter((t) => !cancelled.has(t.job_id));
  }, [trips, sent, cancelled]);

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
      {shown.map((t) => (
        <TripCard key={t.job_id} trip={t} showPickup={showPickup} url={url}
          onCancelled={(id) => setCancelled((prev) => new Set(prev).add(id))} />
      ))}
    </section>
  );
}

/** Offered only while the pickup is untouched and the trip is still open; the server
 *  re-checks both live before deleting anything. */
export function canCancel(t: { pickup_status_id: number | null; pickup_completed_ts: string | null; job_status_id: number | null }): boolean {
  return t.pickup_status_id === 1 && !t.pickup_completed_ts && (t.job_status_id === 2 || t.job_status_id === 4);
}

/** "Huỷ chuyến" with a confirm step. `url` is the page's API (DELETE ?job_id=). */
export function CancelTripButton({ url, jobId, onCancelled }: { url: string; jobId: number; onCancelled: (jobId: number) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function cancel() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${url}?job_id=${jobId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Huỷ thất bại");
      onCancelled(jobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không thể kết nối. Vui lòng thử lại.");
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        className="w-full mt-3 py-2.5 rounded-xl text-xs font-bold text-red-600 border border-red-200 active:bg-red-50"
      >
        Huỷ chuyến
      </button>
    );
  }
  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs font-semibold text-slate-700">Huỷ chuyến #{jobId}? Hành động này không thể hoàn tác.</p>
      {error && <p role="alert" className="text-xs font-medium text-red-600">{error}</p>}
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => { setConfirming(false); setError(""); }}
          disabled={busy}
          className="py-2.5 rounded-xl text-xs font-semibold border border-slate-200 text-slate-600 disabled:opacity-40"
        >
          Quay lại
        </button>
        <button onClick={cancel} disabled={busy} className="py-2.5 rounded-xl text-xs font-bold bg-red-600 text-white disabled:opacity-40">
          {busy ? "Đang huỷ…" : "Xác nhận huỷ"}
        </button>
      </div>
    </div>
  );
}
