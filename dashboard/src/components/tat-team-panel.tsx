"use client";

/**
 * Driver TAT for a whole month, every driver — the supervisor side of the report
 * drivers see in /cham-cong.
 *
 * Defaults to LAST month, not this one. Payroll runs on the 25th and evaluates the
 * month before, so the current month is a half-finished number nobody is paid
 * against; opening on it would invite comparing eighteen days of one driver with
 * thirty-one of another.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, AlertCircle, Download, ChevronLeft, ChevronRight } from "lucide-react";
import { driverDisplayName, staffCode } from "@/lib/display-names";

interface DriverRow {
  driver_id: string;
  driver_name: string;
  days_worked: number;
  trips_total: number;
  trips_measured: number;
  trips_graded: number;
  trips_on_time: number;
  long_gaps: number;
  on_time_pct: number | null;
  avg_tat_mins: number | null;
  total_tat_mins: number;
  total_km: number;
}

interface TeamReport {
  ok: boolean;
  month: string;
  from: string;
  to: string;
  mins_per_km: number;
  driver_count: number;
  totals: Omit<DriverRow, "driver_id" | "driver_name" | "days_worked">;
  drivers: DriverRow[];
  error?: string;
}

/** "2026-07" → "Tháng 7/2026" */
const monthLabel = (m: string) => `Tháng ${Number(m.slice(5, 7))}/${m.slice(0, 4)}`;

function shiftMonth(m: string, delta: number): string {
  const d = new Date(`${m}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.toISOString().slice(0, 7);
}

function defaultMonth(): string {
  const vnNow = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" })
    .format(new Date()).slice(0, 7);
  return shiftMonth(vnNow, -1);
}

const pctTone = (p: number | null) =>
  p == null ? "text-slate-400" : p >= 80 ? "text-green-600" : p >= 60 ? "text-amber-600" : "text-red-600";

export function TatTeamPanel() {
  const [month, setMonth] = useState<string>(defaultMonth);
  const [data, setData] = useState<TeamReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (m: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/tat/team?month=${m}`);
      const j = await res.json();
      if (!res.ok || !j.ok) { setError(j.error ?? "Không tải được báo cáo."); setData(null); return; }
      setData(j as TeamReport);
    } catch {
      setError("Không kết nối được máy chủ.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(month); }, [month, load]);

  /** CSV for the payroll conversation — the numbers usually have to leave this
   *  screen and land in a spreadsheet beside attendance and leave. */
  function exportCsv() {
    if (!data) return;
    const head = ["Tài xế", "Số ngày", "Số chặng", "Đúng giờ", "Được chấm", "Tỉ lệ đúng giờ (%)",
                  "TB mỗi chặng (phút)", "Tổng thời gian chạy (phút)", "Tổng km", "Chờ/nghỉ"];
    const rows = data.drivers.map((d) => [
      // FULL name here, staff code and all, unlike the table on screen. This file
      // gets matched against attendance and leave in a spreadsheet, and the code
      // is what those are keyed on — two drivers share a display name today.
      d.driver_name, d.days_worked, d.trips_total, d.trips_on_time, d.trips_graded,
      d.on_time_pct ?? "", d.avg_tat_mins ?? "", d.total_tat_mins, d.total_km, d.long_gaps,
    ]);
    const csv = [head, ...rows]
      .map((r) => r.map((c) => (typeof c === "string" && /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","))
      .join("\n");
    // BOM so Excel opens Vietnamese diacritics correctly instead of mojibake.
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tat-${data.month}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="h-full flex flex-col rounded-xl border border-slate-200 bg-white overflow-hidden">
      {/* Month navigator */}
      <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-slate-200 shrink-0">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setMonth(shiftMonth(month, -1))}
            className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100"
            title="Tháng trước"
          >
            <ChevronLeft className="size-4" />
          </button>
          <span className="text-sm font-semibold text-slate-800 min-w-[120px] text-center">
            {monthLabel(month)}
          </span>
          <button
            onClick={() => setMonth(shiftMonth(month, 1))}
            disabled={month >= defaultMonth() && month >= shiftMonth(defaultMonth(), 1)}
            className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-40"
            title="Tháng sau"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
        <button
          onClick={exportCsv}
          disabled={!data || data.drivers.length === 0}
          className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 border border-slate-300 rounded-lg px-2.5 py-1.5 hover:bg-slate-50 disabled:opacity-40"
        >
          <Download className="size-3.5" />
          CSV
        </button>
      </div>

      {/* Fleet totals */}
      {data && data.drivers.length > 0 && (
        <div className="grid grid-cols-4 gap-px bg-slate-200 border-b border-slate-200 shrink-0">
          {[
            ["Tài xế", String(data.driver_count)],
            ["Chặng", data.totals.trips_total.toLocaleString("vi-VN")],
            ["Đúng giờ", data.totals.on_time_pct == null ? "—" : `${data.totals.on_time_pct}%`],
            ["Tổng km", Math.round(data.totals.total_km).toLocaleString("vi-VN")],
          ].map(([label, value]) => (
            <div key={label} className="bg-white px-2 py-2 text-center">
              <p className="text-base font-bold text-slate-800 leading-tight">{value}</p>
              <p className="text-[11px] text-slate-500">{label}</p>
            </div>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-slate-400">
            <Loader2 className="size-6 animate-spin" />
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 m-3 rounded-lg px-4 py-3">
            <AlertCircle className="size-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : !data || data.drivers.length === 0 ? (
          <p className="text-center text-sm text-slate-400 py-16">
            Chưa có dữ liệu cho {monthLabel(month)}.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-slate-600 text-[11px] uppercase tracking-wide">
              <tr>
                <th className="text-left font-semibold px-3 py-2">Tài xế</th>
                <th className="text-right font-semibold px-2 py-2">Ngày</th>
                <th className="text-right font-semibold px-2 py-2">Chặng</th>
                <th className="text-right font-semibold px-2 py-2">Đúng giờ</th>
                <th className="text-right font-semibold px-2 py-2">TB</th>
                <th className="text-right font-semibold px-3 py-2">Km</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.drivers.map((d, i) => (
                <tr key={d.driver_id} className="hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <span className="text-slate-400 text-xs mr-1.5">{i + 1}</span>
                    <span className="font-medium text-slate-800">{driverDisplayName(d.driver_name)}</span>
                    {/* The staff code stays: about a dozen drivers hold both a
                        part-time and a full-time account under one personal name,
                        and without it those are two identical rows. */}
                    {staffCode(d.driver_name) && (
                      <span className="text-slate-400 text-[10px] ml-1.5">{staffCode(d.driver_name)}</span>
                    )}
                  </td>
                  <td className="text-right px-2 py-2 text-slate-600">{d.days_worked}</td>
                  <td className="text-right px-2 py-2 text-slate-700 font-medium">{d.trips_total}</td>
                  <td className={`text-right px-2 py-2 font-semibold ${pctTone(d.on_time_pct)}`}>
                    {d.on_time_pct == null ? "—" : `${d.on_time_pct}%`}
                    <span className="block text-[10px] font-normal text-slate-400">
                      {d.trips_on_time}/{d.trips_graded}
                    </span>
                  </td>
                  <td className="text-right px-2 py-2 text-slate-600">{d.avg_tat_mins ?? "—"}</td>
                  <td className="text-right px-3 py-2 text-slate-600">{Math.round(d.total_km)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data && (
        <p className="text-[11px] text-slate-400 px-3 py-2 border-t border-slate-200 shrink-0">
          Mục tiêu mỗi chặng = số km làm tròn lên × {data.mins_per_km} phút. Chặng chờ/nghỉ dài
          không tính vào tỉ lệ đúng giờ. Xếp hạng theo tỉ lệ đúng giờ, rồi theo số chặng.
        </p>
      )}
    </div>
  );
}
