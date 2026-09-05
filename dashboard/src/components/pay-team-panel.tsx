"use client";

/**
 * Part-time pay for a whole month, every PT driver — the supervisor side of the
 * Thu Nhập tab drivers see in /cham-cong, and the sibling of TatTeamPanel.
 *
 * Defaults to LAST month, not this one, for the same reason the TAT monitor does:
 * payroll runs on the 25th and pays the month before, so the current month is a
 * half-finished number nobody is paid against.
 *
 * Sorted by what is OWED, largest first — this is a payables list, so the biggest
 * number is the one worth checking before it is paid, not the best performer.
 *
 * The one column that is a TASK rather than a report is "⚠": days where a driver
 * checked in and never checked out. Those hours pay nothing, and the fix has to
 * happen before the 25th, so the column stays visible even at zero rather than
 * appearing only when something is wrong.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, AlertCircle, Download, ChevronLeft, ChevronRight } from "lucide-react";
import { DriverName } from "./driver-name";

interface DriverRow {
  driver_id: string;
  driver_name: string;
  days_worked: number;
  jobs: number;
  km: number;
  worked_mins: number;
  hour_pay: number;
  km_pay: number;
  total_pay: number;
  open_in_days: number;
}

interface PayTeamReport {
  ok: boolean;
  month: string;
  from: string;
  to: string;
  rates: { per_hour: number; per_km: number };
  driver_count: number;
  totals: Omit<DriverRow, "driver_id" | "driver_name">;
  drivers: DriverRow[];
  error?: string;
}

const vnd = new Intl.NumberFormat("vi-VN");
const fmtVnd = (v: number) => `${vnd.format(Math.round(v))}đ`;

/** Money at a glance, in the unit a payables list is read in. A month's pay runs
 *  to seven digits, and seven digits in a table column is a wall — so anything
 *  past a million is shown in millions to one decimal and the exact figure lives
 *  in the CSV, which is where it gets acted on anyway. */
const fmtCompact = (v: number) =>
  v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}tr` : vnd.format(Math.round(v));

const fmtHours = (mins: number) => `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}`;

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

export function PayTeamPanel() {
  const [month, setMonth] = useState<string>(defaultMonth);
  const [data, setData] = useState<PayTeamReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (m: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/pay/team?month=${m}`);
      const j = await res.json();
      if (!res.ok || !j.ok) { setError(j.error ?? "Không tải được bảng lương."); setData(null); return; }
      setData(j as PayTeamReport);
    } catch {
      setError("Không kết nối được máy chủ.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(month); }, [month, load]);

  /** CSV for the payroll conversation. Every figure is EXACT here — the screen
   *  rounds to millions to stay readable, this file is what a number gets paid
   *  from, and the two must not be confused. The per-rate columns travel too, so
   *  a disputed total can be re-derived without opening the dashboard. */
  function exportCsv() {
    if (!data) return;
    const head = ["Tài xế", "Số ngày", "Số chuyến", "Tổng km", "Giờ chấm công (phút)",
                  "Tiền giờ (đ)", "Tiền km (đ)", "Tổng (đ)", "Ngày thiếu chấm công ra"];
    const rows = data.drivers.map((d) => [
      // FULL name here, staff code and all, unlike the table on screen. This file
      // gets matched against attendance and leave in a spreadsheet, and the code
      // is what those are keyed on — two drivers share a display name today.
      d.driver_name, d.days_worked, d.jobs, d.km, d.worked_mins,
      d.hour_pay, d.km_pay, d.total_pay, d.open_in_days,
    ]);
    const csv = [head, ...rows]
      .map((r) => r.map((c) => (typeof c === "string" && /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","))
      .join("\n");
    // BOM so Excel opens Vietnamese diacritics correctly instead of mojibake.
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `luong-pt-${data.month}.csv`;
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
            disabled={month >= shiftMonth(defaultMonth(), 1)}
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

      {/* Fleet totals. The money leads, because that is what this panel is for. */}
      {data && data.drivers.length > 0 && (
        <div className="grid grid-cols-4 gap-px bg-slate-200 border-b border-slate-200 shrink-0">
          {[
            ["Tổng chi", fmtVnd(data.totals.total_pay)],
            ["Tài xế PT", String(data.driver_count)],
            ["Giờ", fmtHours(data.totals.worked_mins)],
            ["Km", Math.round(data.totals.km).toLocaleString("vi-VN")],
          ].map(([label, value]) => (
            <div key={label} className="bg-white px-2 py-2 text-center">
              <p className="text-base font-bold text-slate-800 leading-tight">{value}</p>
              <p className="text-[11px] text-slate-500">{label}</p>
            </div>
          ))}
        </div>
      )}

      {/* The one thing here that is a to-do rather than a report. */}
      {data && data.totals.open_in_days > 0 && (
        <div className="flex items-start gap-2 text-[11px] text-amber-800 bg-amber-50 border-b border-amber-200 px-3 py-2 shrink-0">
          <AlertCircle className="size-3.5 mt-0.5 shrink-0" />
          <span>
            {data.totals.open_in_days} ngày có chấm công vào nhưng không có chấm công ra —
            những ca đó <strong>chưa được tính giờ</strong>. Xem cột ⚠ và bổ sung trước kỳ lương.
          </span>
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
                <th className="text-right font-semibold px-2 py-2">Giờ</th>
                <th className="text-right font-semibold px-2 py-2">Km</th>
                <th className="text-right font-semibold px-3 py-2">Tổng</th>
                <th className="text-right font-semibold px-2 py-2" title="Ngày thiếu chấm công ra">⚠</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.drivers.map((d, i) => (
                <tr key={d.driver_id} className="hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <span className="text-slate-400 text-xs mr-1.5">{i + 1}</span>
                    {/* The staff code and the FT/PT chip both stay: about a dozen
                        drivers hold a part-time and a full-time account under one
                        personal name, and pay is filed against the ACCOUNT. */}
                    <DriverName full={d.driver_name} className="font-medium text-slate-800" />
                  </td>
                  <td className="text-right px-2 py-2 text-slate-600">{d.days_worked}</td>
                  <td className="text-right px-2 py-2 text-slate-600 tabular-nums">{fmtHours(d.worked_mins)}</td>
                  <td className="text-right px-2 py-2 text-slate-600 tabular-nums">{Math.round(d.km)}</td>
                  <td
                    className="text-right px-3 py-2 font-semibold text-slate-800 tabular-nums"
                    title={`${fmtVnd(d.hour_pay)} giờ + ${fmtVnd(d.km_pay)} km = ${fmtVnd(d.total_pay)}`}
                  >
                    {fmtCompact(d.total_pay)}
                  </td>
                  <td className="text-right px-2 py-2 tabular-nums">
                    {d.open_in_days > 0
                      ? <span className="text-amber-600 font-semibold">{d.open_in_days}</span>
                      : <span className="text-slate-300">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* The rule, stated once, where the numbers are. */}
      {data && (
        <div className="px-3 py-2 border-t border-slate-200 shrink-0">
          <p className="text-[11px] text-slate-500">
            {vnd.format(data.rates.per_hour)}đ/giờ chấm công (tính theo phút) +{" "}
            {vnd.format(data.rates.per_km)}đ/km lấy mẫu → giao mẫu của mỗi chuyến đã hoàn thành.
            Số liệu tính đến hết {data.to}. Tải CSV để lấy số chính xác.
          </p>
        </div>
      )}
    </div>
  );
}
