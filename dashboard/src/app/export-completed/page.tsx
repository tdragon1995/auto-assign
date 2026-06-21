"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";

// Mirrors CompletedRow in /api/export-completed/route.ts.
interface CompletedRow {
  ft_pt: string;
  courier: string;
  pickup_from: string;
  customer: string;
  order_no: number | "";
  pickup_departure: string;
  dropoff_arrival: string;
  started_time: string;
  travel_time: number | "";
  target: number | "";
  distance_target: number | "";
  pass_fail: string;
  device_description: string;
  pickup_coords: string;
  dropoff_coords: string;
  lat1: number | null;
  lon1: number | null;
  lat2: number | null;
  lon2: number | null;
}

// Shape returned per row by POST /api/distance-checking.
interface ApiDistance {
  distance_km: number | null;
  duration_mins: number | null;
}

// CSV header ↔ row key, in order. The first 12 are the exact headers the
// downstream Power Query "Export" sheet binds to; the rest are extras the query
// ignores. The raw lat/lon fields are intentionally NOT exported.
const COLUMNS: { key: keyof CompletedRow; label: string }[] = [
  { key: "ft_pt", label: "FT/ PT" },
  { key: "courier", label: "Courier" },
  { key: "pickup_from", label: "Pickup From" },
  { key: "customer", label: "Customer" },
  { key: "order_no", label: "Order #" },
  { key: "pickup_departure", label: "Pickup Departure" },
  { key: "dropoff_arrival", label: "Dropoff Arrival" },
  { key: "started_time", label: "Started Time" },
  { key: "travel_time", label: "# Travel Time" },
  { key: "target", label: "# Target" },
  { key: "distance_target", label: "# Distance Target" },
  { key: "pass_fail", label: "Pass/ Fail" },
  { key: "device_description", label: "device_description" },
  { key: "pickup_coords", label: "Pickup Coords" },
  { key: "dropoff_coords", label: "Dropoff Coords" },
];

// Quote a CSV cell if it contains a comma, quote, or newline (RFC 4180). The
// coordinate cells are "lat,long" so they MUST be quoted to stay in one column.
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function toCSV(rows: CompletedRow[]): string {
  const header = COLUMNS.map((c) => c.label).join(",");
  const lines = rows.map((r) =>
    COLUMNS.map((c) => csvCell(String(r[c.key] ?? ""))).join(",")
  );
  // Leading BOM so Excel reads UTF-8 (Vietnamese names) correctly.
  return "﻿" + [header, ...lines].join("\n");
}

function today(): string {
  // VN date (UTC+7) as YYYY-MM-DD.
  return new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
}

// True when the row is a real pickup→dropoff trip (both ends have coordinates).
function hasTrip(r: CompletedRow): boolean {
  return r.lat1 != null && r.lon1 != null && r.lat2 != null && r.lon2 != null;
}

export default function ExportCompletedPage() {
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [rows, setRows] = useState<CompletedRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [runError, setRunError] = useState("");

  // Distance phase (Goong) state.
  const [distStatus, setDistStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [distProgress, setDistProgress] = useState(0);
  const [distError, setDistError] = useState("");
  const [quotaReached, setQuotaReached] = useState(false);

  const tripCount = useMemo(() => rows.filter(hasTrip).length, [rows]);
  const filledCount = useMemo(
    () => rows.filter((r) => hasTrip(r) && r.distance_target !== "").length,
    [rows]
  );
  const pendingCount = tripCount - filledCount;

  const load = async () => {
    setStatus("loading");
    setRows([]);
    setErrors([]);
    setRunError("");
    setDistStatus("idle");
    setQuotaReached(false);
    try {
      const res = await fetch(`/api/export-completed?from=${from}&to=${to}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Lỗi tải dữ liệu");
      setRows(data.rows ?? []);
      setErrors(data.errors ?? []);
      setStatus("done");
    } catch (e) {
      setRunError(String(e));
      setStatus("error");
    }
  };

  // Fill # Distance Target (Goong km), # Target (Goong mins) and Pass/ Fail for
  // every trip that doesn't have them yet, reusing the distance-checking endpoint
  // (self/cache pairs are free; only fresh pairs spend Goong quota). Stops the
  // moment Goong reports its daily limit — already-computed pairs are cached, so
  // re-running tomorrow fills exactly the gaps.
  const computeDistances = async () => {
    setDistStatus("loading");
    setDistProgress(0);
    setDistError("");
    setQuotaReached(false);

    // Only rows that are trips AND still missing a distance.
    const targets = rows
      .map((r, i) => ({ i, r }))
      .filter(({ r }) => hasTrip(r) && r.distance_target === "");
    if (targets.length === 0) {
      setDistStatus("done");
      return;
    }

    const next = [...rows];
    const CHUNK = 50;
    let done = 0;
    let hitQuota = false;
    try {
      for (let off = 0; off < targets.length; off += CHUNK) {
        const slice = targets.slice(off, off + CHUNK);
        const payload = slice.map(({ r }) => ({
          pickup: String(r.order_no),
          dropoff: "",
          lat1: r.lat1 as number,
          lon1: r.lon1 as number,
          lat2: r.lat2 as number,
          lon2: r.lon2 as number,
        }));
        const res = await fetch("/api/distance-checking", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows: payload }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Lỗi tính khoảng cách");
        (data.results as ApiDistance[]).forEach((d, j) => {
          const idx = slice[j].i;
          const km = d.distance_km;
          const mins = d.duration_mins;
          const travel = next[idx].travel_time;
          next[idx] = {
            ...next[idx],
            distance_target: km ?? "",
            target: mins ?? "",
            pass_fail:
              typeof mins === "number" && typeof travel === "number"
                ? travel <= mins
                  ? "Pass"
                  : "Fail"
                : "",
          };
        });
        done += slice.length;
        setDistProgress(done);
        setRows([...next]);
        // Goong daily cap hit — stop now, leave the rest blank for tomorrow.
        if (data.quotaReached) {
          hitQuota = true;
          break;
        }
      }
      setQuotaReached(hitQuota);
      setDistStatus("done");
    } catch (e) {
      setDistError(String(e));
      setDistStatus("error");
    }
  };

  const download = () => {
    const blob = new Blob([toCSV(rows)], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Export_${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Xuất chuyến đã hoàn thành</h1>
          <p className="text-sm text-slate-500 mt-1">
            Lọc theo{" "}
            <code className="bg-slate-100 px-1 rounded text-xs">scheduled_delivery_ts</code> và{" "}
            <code className="bg-slate-100 px-1 rounded text-xs">job_status_id = 5</code> (Hoàn thành).
            Cột khớp với sheet <code className="bg-slate-100 px-1 rounded text-xs">Export</code> của Power Query.
          </p>
        </div>

        {/* Date range + load */}
        <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-white p-4">
          <label className="flex flex-col gap-1 text-xs text-slate-500">
            Từ ngày
            <input
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-500">
            Đến ngày
            <input
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </label>
          <Button onClick={load} disabled={status === "loading"} className="h-10">
            {status === "loading" ? "Đang tải…" : "🔍 Tải dữ liệu"}
          </Button>
          {rows.length > 0 && tripCount > 0 && (
            <Button
              variant="outline"
              onClick={computeDistances}
              disabled={distStatus === "loading" || pendingCount === 0}
              className="h-10"
              title="Bổ sung khoảng cách + thời gian dự kiến (Goong). Tự dừng khi hết hạn mức ngày."
            >
              {distStatus === "loading"
                ? `Đang tính… ${distProgress}/${tripCount}`
                : pendingCount === 0
                ? "✓ Đã có khoảng cách"
                : `📏 Tính khoảng cách + thời gian (${pendingCount})`}
            </Button>
          )}
          {rows.length > 0 && (
            <Button variant="outline" onClick={download} className="h-10">
              ⬇ Tải CSV ({rows.length})
            </Button>
          )}
        </div>

        {status === "error" && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{runError}</div>
        )}
        {distError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{distError}</div>
        )}

        {/* Goong quota notice */}
        {quotaReached && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            ⚠ Đã chạm hạn mức Goong hôm nay. Còn <strong>{pendingCount}</strong> chuyến chưa có khoảng cách —
            các chuyến đã tính đã được lưu cache, chạy lại vào ngày mai để tính tiếp phần còn lại.
          </div>
        )}

        {/* Per-day fetch errors (partial export still usable) */}
        {errors.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1">
            <p className="text-xs font-medium text-amber-800">
              {errors.length} ngày lỗi (dữ liệu các ngày khác vẫn đầy đủ):
            </p>
            {errors.map((e, i) => (
              <p key={i} className="text-xs text-amber-800">{e}</p>
            ))}
          </div>
        )}

        {status === "done" && rows.length === 0 && errors.length === 0 && (
          <p className="text-sm text-slate-500">Không có chuyến hoàn thành nào trong khoảng ngày này.</p>
        )}

        {/* Results table */}
        {rows.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-slate-500">
              {rows.length} chuyến · {tripCount} có toạ độ · {filledCount} đã có khoảng cách — hiển thị tối đa 200 dòng đầu.
            </p>
            <div className="rounded-lg border bg-white overflow-x-auto">
              <table className="w-full text-xs min-w-[1400px]">
                <thead className="bg-slate-50 border-b text-slate-500 uppercase tracking-wide">
                  <tr>
                    {COLUMNS.map((c) => (
                      <th key={c.key} className="px-3 py-2 text-left whitespace-nowrap">{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.slice(0, 200).map((r, i) => (
                    <tr key={`${r.order_no}-${i}`} className={r.pass_fail === "Fail" ? "bg-red-50/40" : "hover:bg-slate-50/60"}>
                      {COLUMNS.map((c) => (
                        <td key={c.key} className="px-3 py-2 whitespace-nowrap text-slate-600">
                          {String(r[c.key] ?? "")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
