"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Loader2, ArrowRight } from "lucide-react";
import { NDTP_DROPOFFS } from "@/lib/ndtp";
import { foldName } from "@/lib/driver-cell";
import { placeLabel } from "@/lib/place-label";
import { TripSteps, TRIP_STATE_STYLE, tripStateText, tripStateFromStops } from "@/components/trip-steps";
import type { NdtpTrip } from "@/app/api/ndtp/route";

const shortName = (name: string) => name.replace(/^NDTP - /, "");
// A scheduled run with no set time reads midnight, which is not when anyone asked.
const hm = (ts?: string | null) => (ts && !ts.endsWith("00:00:00") ? ts.slice(11, 16) : null);

function TripCard({ trip }: { trip: NdtpTrip }) {
  const state = tripStateFromStops(trip.pickup_status_id, trip.dropoff_status_id, !!trip.driver_name, trip.job_status_id, trip.parked);
  const dest = placeLabel(trip.dropoff_name);
  return (
    <div className="rounded-2xl bg-white shadow-sm border border-gray-200 p-4">
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0">
          <p className="text-sm font-bold text-gray-800">
            <ArrowRight aria-hidden className="inline w-4 h-4 text-gray-500 mr-1" />{dest}
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

export default function NdtpPage() {
  const [dropoffId, setDropoffId] = useState("");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  const [trips, setTrips] = useState<NdtpTrip[]>([]);
  // The published day runs a few minutes behind, so a trip sent from this screen is
  // shown from the POST response until the list catches up. Lost on reload — by then
  // the day usually has it.
  const [sent, setSent] = useState<NdtpTrip[]>([]);
  const [tripsLoading, setTripsLoading] = useState(false);
  const [tripsError, setTripsError] = useState("");

  const loadTrips = useCallback(async () => {
    setTripsLoading(true);
    try {
      const res = await fetch("/api/ndtp");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error);
      setTrips(data.trips ?? []);
      setTripsError("");
    } catch (e) {
      setTripsError(e instanceof Error && e.message ? e.message : "Chưa tải được danh sách chuyến");
    } finally {
      setTripsLoading(false);
    }
  }, []);

  useEffect(() => { loadTrips(); }, [loadTrips]);

  const shown = useMemo(() => {
    const known = new Set(trips.map((t) => t.job_id));
    return [...sent.filter((t) => !known.has(t.job_id)), ...trips];
  }, [trips, sent]);

  const matches = useMemo(() => {
    const q = foldName(search.trim());
    return q ? NDTP_DROPOFFS.filter((d) => foldName(d.name).includes(q)) : NDTP_DROPOFFS;
  }, [search]);

  async function submit() {
    if (!dropoffId) {
      setStatus("error");
      setMessage("Vui lòng chọn nơi giao");
      return;
    }
    setStatus("loading");
    setMessage("");
    try {
      const res = await fetch("/api/ndtp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dropoff_id: dropoffId, note }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus("error");
        setMessage(data.error ?? "Có lỗi xảy ra. Vui lòng thử lại.");
        return;
      }
      setStatus("success");
      setMessage(`Đã gửi yêu cầu (Job #${data.job_id ?? "?"}).`);
      const dropoff = NDTP_DROPOFFS.find((d) => d.customer_id === dropoffId);
      if (data.job_id && dropoff) {
        const now = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" });
        setSent((prev) => [{
          job_id: data.job_id, dropoff_name: dropoff.name, job_status_id: 2, pickup_status_id: 1,
          dropoff_status_id: 1, driver_name: null, parked: false, requested_ts: now,
          pickup_completed_ts: null, dropoff_started_ts: null, dropoff_completed_ts: null,
        }, ...prev]);
      }
      setDropoffId("");
      setSearch("");
      setNote("");
    } catch {
      setStatus("error");
      setMessage("Không thể kết nối. Vui lòng thử lại.");
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center gap-5 p-4 pb-12">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 w-full max-w-md p-6 space-y-5">
        <header className="border-b-4 border-[#1f5fc4] pb-3">
          <p className="text-sm font-bold text-[#1f4fa8] leading-tight">BỆNH VIỆN</p>
          <p className="text-xl font-extrabold text-[#1f4fa8] leading-tight">NHI ĐỒNG THÀNH PHỐ</p>
        </header>

        <h1 className="text-xl font-bold text-gray-900">Gửi mẫu</h1>

        <div className="space-y-1 relative">
          <label htmlFor="dropoff" className="text-sm font-medium text-gray-700">Nơi giao</label>
          <div className="relative">
            <input
              id="dropoff"
              type="text"
              role="combobox"
              aria-expanded={open && !dropoffId}
              aria-controls="dropoff-list"
              autoComplete="off"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Tìm nơi giao..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setDropoffId(""); setOpen(true); }}
              onFocus={() => setOpen(true)}
              onBlur={() => setTimeout(() => setOpen(false), 150)}
            />
            {search && (
              <button
                aria-label="Xoá nơi giao"
                className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-gray-400 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                onMouseDown={(e) => { e.preventDefault(); setSearch(""); setDropoffId(""); }}
              >
                ×
              </button>
            )}
          </div>
          {open && !dropoffId && (
            <ul id="dropoff-list" role="listbox" className="absolute z-10 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-y-auto mt-1">
              {matches.length === 0 && <li className="px-3 py-2 text-sm text-gray-400">Không tìm thấy</li>}
              {matches.map((d) => (
                <li
                  key={d.customer_id}
                  role="option"
                  aria-selected={false}
                  className="px-3 py-2 text-sm hover:bg-blue-50 cursor-pointer"
                  onMouseDown={() => { setDropoffId(d.customer_id); setSearch(shortName(d.name)); setOpen(false); }}
                >
                  {shortName(d.name)}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-1">
          <label htmlFor="note" className="text-sm font-medium text-gray-700">Ghi chú (không bắt buộc)</label>
          <textarea
            id="note"
            rows={2}
            maxLength={500}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Người yêu cầu, số lượng mẫu..."
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        <button
          disabled={status === "loading"}
          onClick={submit}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold rounded-xl py-3 text-sm transition-colors"
        >
          {status === "loading" ? "Đang gửi..." : "Gửi yêu cầu"}
        </button>

        {message && (
          <div
            role="status"
            className={`rounded-lg px-4 py-3 text-sm font-medium border ${
              status === "success" ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-700 border-red-200"
            }`}
          >
            {message}
          </div>
        )}
      </div>

      <section className="w-full max-w-md space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-gray-900">Chuyến hôm nay ({shown.length})</h2>
          <button
            onClick={loadTrips}
            disabled={tripsLoading}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold text-blue-700 bg-white border border-gray-200 active:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw aria-hidden className={`w-4 h-4 ${tripsLoading ? "animate-spin" : ""}`} />
            Làm mới
          </button>
        </div>
        {tripsError && <p role="alert" className="text-sm text-red-600">{tripsError}</p>}
        {tripsLoading && !shown.length && (
          <p className="flex items-center justify-center gap-2 text-sm text-gray-500 py-6">
            <Loader2 aria-hidden className="w-4 h-4 animate-spin" />Đang tải…
          </p>
        )}
        {!tripsLoading && !tripsError && !shown.length && (
          <p className="text-center text-sm text-gray-500 py-6">Chưa có chuyến nào hôm nay.</p>
        )}
        {shown.map((t) => <TripCard key={t.job_id} trip={t} />)}
      </section>
    </div>
  );
}
