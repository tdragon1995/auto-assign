"use client";

/**
 * Part-time pay for a whole month, every PT driver — the supervisor side of the
 * Thu Nhập tab drivers see in /cham-cong, and the sibling of TatTeamPanel.
 *
 * Defaults to this payroll month: the previous 15th through this 14th.
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
import { Loader2, AlertCircle, Download, ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { foldName } from "@/lib/driver-cell";
import { DriverName } from "./driver-name";

interface DriverRow {
  driver_id: string;
  driver_name: string;
  days_worked: number;
  jobs: number;
  km: number;
  /** Km actually ridden (every leg, paid or not) — the Hiệu Suất measure. */
  real_km: number;
  worked_mins: number;
  hour_pay: number;
  km_pay: number;
  total_pay: number;
  open_in_days: number;
  unpriced_jobs: number;
}

interface PayTeamReport {
  ok: boolean;
  month: string;
  from: string;
  to: string;
  rates: { per_hour: number; per_km: number };
  driver_count: number;
  coverage: { expected_days: number; missing_days: string[]; period_closed: boolean; ready: boolean };
  totals: Omit<DriverRow, "driver_id" | "driver_name">;
  drivers: DriverRow[];
  error?: string;
}

interface DetailJob {
  job_id: number;
  reference_number: string | null;
  driver_name: string | null;
  trip_date: string;
  pickup_name: string | null;
  dropoff_name: string | null;
  pickup_completed_ts: string | null;
  dropoff_completed_ts: string | null;
  distance_km: number | string | null;
}

const staffCode = (name: string | null) => /\b(PT\w+|DC\w+)/.exec(name ?? "")?.[1] ?? "";
const hhmmFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false });
const hhmm = (iso: string | null) => (iso ? hhmmFmt.format(new Date(iso)) : "");

const vnd = new Intl.NumberFormat("vi-VN");
const fmtVnd = (v: number) => `${vnd.format(Math.round(v))}đ`;

/** ONE scale for the money column, and the exact figure. It used to switch to
 *  "17.2tr" above a million and print grouped đồng below it, with no unit either
 *  way — two conventions in the column an approval is read off, and the exact
 *  number reachable only through a hover tooltip. tabular-nums keeps it aligned. */

const fmtHours = (mins: number) => `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}`;

/** Kilometres in Vietnamese notation: 2.199 not 2199. Whole km in the table —
 *  the decimals live in the CSV, which is what a figure gets paid from. */
const fmtKm = (km: number) => vnd.format(Math.round(km));

/** What a kilometre actually costs: EVERYTHING a driver earns — hours and km
 *  together — over every kilometre they rode. Deliberately not comparable to the
 *  2.000đ rate, which prices distance alone; this is the whole wage bill per
 *  kilometre, and it sits well above the rate wherever attendance hours are long
 *  against the distance covered.
 *
 *  Three things move it, and a reader should know which one they are seeing:
 *  unpaid riding (to the next pickup, the run home) pushes it down per km of
 *  paid work, a multi-clinic loop pushes it up (each job pays its own
 *  pickup→lab distance while the loop is ridden once), and the hourly component
 *  pushes it up wherever a driver was on the clock without covering ground.
 *
 *  Null where the day's legs are missing: dividing by an unarchived zero would
 *  print a number nobody could defend. */
const realRate = (totalPay: number, realKm: number): number | null =>
  realKm > 0 ? Math.round(totalPay / realKm) : null;
const fmtRate = (r: number | null) => (r == null ? "—" : vnd.format(r));

const monthLabel = (m: string) => `Tháng ${Number(m.slice(5, 7))}/${m.slice(0, 4)}`;

function shiftMonth(m: string, delta: number): string {
  const d = new Date(`${m}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.toISOString().slice(0, 7);
}

function defaultMonth(): string {
  const vnNow = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" })
    .format(new Date()).slice(0, 7);
  return vnNow;
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
  const [exporting, setExporting] = useState(false);
  /** Free-text driver filter. Accent-insensitive, and it searches the staff code
   *  too ("pt1015", "quynh") because that is what payroll keys on. */
  const [q, setQ] = useState("");
  /** Set from the amber banner: show only the drivers with an unclosed shift. */
  const [onlyFlagged, setOnlyFlagged] = useState(false);

  async function exportCsv() {
    if (!data) return;
    setExporting(true);
    try {
      // The job lines are fetched on demand — the table view never needs them.
      const res = await fetch(`/api/pay/team?month=${data.month}&detail=1`);
      const j = await res.json();
      if (!res.ok || !j.ok) { setError(j.error ?? "Không tải được chi tiết chuyến."); return; }
      const jobs = j.jobs as DetailJob[];

      const head = ["Tài xế", "Số ngày", "Số chuyến", "Km tính tiền", "Km thực chạy", "Giờ chấm công (phút)",
                    "Tiền giờ (đ)", "Tiền km (đ)", "Tổng (đ)", "Tổng tiền / km thực (đ)",
                    "Ngày thiếu chấm công ra", "Chuyến chưa có km"];
      const rows: (string | number)[][] = data.drivers.map((d) => [
        // FULL name here, staff code and all, unlike the table on screen. This file
        // gets matched against attendance and leave in a spreadsheet, and the code
        // is what those are keyed on — two drivers share a display name today.
        d.driver_name, d.days_worked, d.jobs, d.km, d.real_km, d.worked_mins,
        d.hour_pay, d.km_pay, d.total_pay, realRate(d.total_pay, d.real_km) ?? "",
        d.open_in_days, d.unpriced_jobs,
      ]);
      // An incomplete payroll must not leave this screen looking final.
      if (!data.coverage.ready) {
        rows.unshift([`CHƯA ĐỦ DỮ LIỆU — thiếu ${data.coverage.missing_days.length} ngày, ${data.totals.unpriced_jobs} chuyến chưa có km`]);
      }

      // Every paid job, one line each, so any driver's km can be checked trip by trip.
      const detailHead = ["Mã chuyến", "Mã tham chiếu", "Tài khoản giao nhận", "Mã số nhân viên", "Ngày",
                          "Giờ lấy", "Giờ giao", "Điểm đi", "Điểm đến", "Số km", "Tiền km (đ)"];
      const detail = jobs.map((x) => [
        x.job_id, x.reference_number ?? "", x.driver_name ?? "", staffCode(x.driver_name), x.trip_date,
        hhmm(x.pickup_completed_ts), hhmm(x.dropoff_completed_ts), x.pickup_name ?? "", x.dropoff_name ?? "",
        x.distance_km == null ? "" : Number(x.distance_km),
        x.distance_km == null ? "" : Math.round(Number(x.distance_km) * data.rates.per_km),
      ]);

      const csv = [head, ...rows, [], ["CHI TIẾT CHUYẾN"], detailHead, ...detail]
        .map((r) => r.map((c) => (typeof c === "string" && /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","))
        .join("\n");
      // BOM so Excel opens Vietnamese diacritics correctly instead of mojibake.
      const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `luong-pt-${data.month}_${data.from}_${data.to}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      setError("Không kết nối được máy chủ.");
    } finally {
      setExporting(false);
    }
  }

  const needle = foldName(q.trim());
  const shown = !data ? [] : data.drivers
    .filter((d) => (needle ? foldName(d.driver_name).includes(needle) : true))
    .filter((d) => (onlyFlagged ? d.open_in_days > 0 : true));

  return (
    <div className="h-full flex flex-col rounded-xl border border-slate-200 bg-white overflow-hidden">
      {/* Month navigator */}
      <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-slate-200 shrink-0">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setMonth(shiftMonth(month, -1))}
            className="size-11 grid place-items-center rounded-lg text-slate-600 hover:bg-slate-100"
            title="Tháng trước"
          >
            <ChevronLeft className="size-4" />
          </button>
          <span className="text-sm font-semibold text-slate-800 min-w-[120px] text-center">
            {monthLabel(month)}
          </span>
          <button
            onClick={() => setMonth(shiftMonth(month, 1))}
            disabled={month >= defaultMonth()}
            className="size-11 grid place-items-center rounded-lg text-slate-600 hover:bg-slate-100 disabled:opacity-40"
            title="Tháng sau"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
        {/* Driver search. 80+ PT drivers is more than a screen, and the list is
            sorted by money owed, so finding one person means scrolling and
            reading. Typing beats scrolling; the code works as well as the name. */}
        <div className="relative flex-1 min-w-0 max-w-[220px]">
          <Search className="size-3.5 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Tìm tài xế..."
            aria-label="Tìm tài xế"
            className="w-full min-h-11 text-xs border border-slate-300 rounded-lg pl-7 pr-7 py-1.5 text-slate-700 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-slate-300"
          />
          {q && (
            <button
              onClick={() => setQ("")}
              aria-label="Xoá tìm kiếm"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <button
          onClick={exportCsv}
          disabled={!data || data.drivers.length === 0 || exporting}
          className="flex items-center gap-1.5 min-h-11 text-xs font-semibold text-slate-700 border border-slate-300 rounded-lg px-3 hover:bg-slate-50 disabled:opacity-40"
        >
          <Download className="size-3.5" />
          CSV
        </button>
      </div>

      {data && (
        <p className="px-3 py-2 text-xs text-slate-600 border-b border-slate-200">
          Kỳ lương: {data.from.split("-").reverse().join("/")} – {data.to.split("-").reverse().join("/")}
        </p>
      )}

      {/* Fleet totals. The money leads, because that is what this panel is for. */}
      {data && data.drivers.length > 0 && (
        <div className="grid grid-cols-5 gap-px bg-slate-200 border-b border-slate-200 shrink-0">
          {[
            ["Tổng chi", fmtVnd(data.totals.total_pay), `${fmtVnd(data.totals.hour_pay)} giờ + ${fmtVnd(data.totals.km_pay)} km`],
            ["Tài xế PT", String(data.driver_count), ""],
            ["Giờ", fmtHours(data.totals.worked_mins), ""],
            ["Km tính tiền", fmtKm(data.totals.km), "Quãng đường lấy mẫu → giao mẫu của các chuyến được tính tiền"],
            // The fleet average, and the point of the two columns below: it is the
            // whole wage bill over every kilometre actually ridden, so it answers
            // "what do we pay per kilometre" rather than "what is the rate".
            ["đ/km thực", fmtRate(realRate(data.totals.total_pay, data.totals.real_km)),
             `Tổng chi (giờ + km) ÷ ${fmtKm(data.totals.real_km)} km thực chạy`],
          ].map(([label, value, hint]) => (
            <div key={label} className="bg-white px-2 py-2 text-center" title={hint || undefined}>
              <p className="text-base font-bold text-slate-800 leading-tight">{value}</p>
              <p className="text-[11px] text-slate-500">{label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Incomplete coverage comes first: every figure below is short until it clears. */}
      {data && !data.coverage.ready && (
        <div className="flex items-start gap-2 text-[11px] text-red-800 bg-red-50 border-b border-red-200 px-3 py-2 shrink-0">
          <AlertCircle className="size-3.5 mt-0.5 shrink-0" />
          <span>
            <strong>Chưa đủ dữ liệu — chưa duyệt lương kỳ này.</strong>{" "}
            {!data.coverage.period_closed && "Kỳ lương chưa kết thúc. "}
            {data.coverage.missing_days.length > 0 &&
              `Thiếu ${data.coverage.missing_days.length}/${data.coverage.expected_days} ngày: ${data.coverage.missing_days.map((d) => d.slice(8, 10) + "/" + d.slice(5, 7)).join(", ")}. `}
            {data.totals.unpriced_jobs > 0 && `${data.totals.unpriced_jobs} chuyến chưa có km (đang tính 0đ).`}
          </span>
        </div>
      )}

      {/* The one thing here that is a to-do rather than a report. */}
      {data && data.totals.open_in_days > 0 && (
        <div className="flex items-start gap-2 text-xs text-amber-900 bg-amber-50 border-b border-amber-200 px-3 py-2 shrink-0">
          <AlertCircle className="size-3.5 mt-0.5 shrink-0" />
          <span>
            {data.totals.open_in_days} ngày có chấm công vào nhưng không có chấm công ra —
            những ca đó <strong>chưa được tính giờ</strong>.{" "}
            {/* The banner IS the filter. Telling a supervisor to eye-scan 82 rows for
                a low-contrast digit is not a to-do, it is a search task. */}
            <button
              onClick={() => setOnlyFlagged((v) => !v)}
              className="font-semibold underline underline-offset-2 hover:text-amber-950"
            >
              {onlyFlagged
                ? "Hiện tất cả tài xế"
                : `Chỉ hiện ${data.drivers.filter((d) => d.open_in_days > 0).length} tài xế cần bổ sung`}
            </button>
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
        ) : shown.length === 0 ? (
          <p className="text-center text-sm text-slate-500 py-16">
            {q ? `Không có tài xế nào khớp "${q}".` : "Không có tài xế nào cần bổ sung chấm công."}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-slate-600 text-[11px] uppercase tracking-wide">
              <tr>
                <th className="text-left font-semibold px-3 py-2">Tài xế</th>
                <th className="text-right font-semibold px-2 py-2">Ngày</th>
                <th className="text-right font-semibold px-2 py-2">Giờ</th>
                <th className="text-right font-semibold px-2 py-2" title="Quãng đường lấy mẫu → giao mẫu của các chuyến được tính tiền">Km tính tiền</th>
                <th className="text-right font-semibold px-2 py-2" title="Quãng đường thực tế đã chạy, gồm cả đoạn di chuyển giữa các chuyến và chuyến không tính tiền (theo Hiệu Suất)">Km thực</th>
                <th className="text-right font-semibold px-3 py-2">Tổng (đ)</th>
                <th className="text-right font-semibold px-2 py-2" title="(Tiền giờ + tiền km) ÷ km thực chạy">đ/km thực</th>
                {/* A word, not a glyph: the column is a task list and screen readers
                    got nothing from "⚠". */}
                <th className="text-right font-semibold px-2 py-2">Thiếu ra</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {shown.map((d, i) => (
                // No hover highlight: it promised a row click that does not exist.
                <tr key={d.driver_id}>
                  <td className="px-3 py-2">
                    <span className="text-slate-500 text-xs mr-1.5">{i + 1}</span>
                    {/* The staff code and the FT/PT chip both stay: about a dozen
                        drivers hold a part-time and a full-time account under one
                        personal name, and pay is filed against the ACCOUNT. */}
                    <DriverName full={d.driver_name} className="font-medium text-slate-800" />
                  </td>
                  <td className="text-right px-2 py-2 text-slate-600">{d.days_worked}</td>
                  <td className="text-right px-2 py-2 text-slate-600 tabular-nums">{fmtHours(d.worked_mins)}</td>
                  <td className="text-right px-2 py-2 text-slate-600 tabular-nums">{fmtKm(d.km)}</td>
                  <td className="text-right px-2 py-2 text-slate-600 tabular-nums">{fmtKm(d.real_km)}</td>
                  <td
                    className="text-right px-3 py-2 font-semibold text-slate-800 tabular-nums"
                    title={`${fmtVnd(d.hour_pay)} giờ + ${fmtVnd(d.km_pay)} km = ${fmtVnd(d.total_pay)}`}
                  >
                    {vnd.format(Math.round(d.total_pay))}
                  </td>
                  <td
                    className="text-right px-2 py-2 text-slate-600 tabular-nums"
                    title={d.real_km > 0 ? `${fmtVnd(d.total_pay)} ÷ ${fmtKm(d.real_km)} km thực` : "Chưa có dữ liệu km thực"}
                  >
                    {fmtRate(realRate(d.total_pay, d.real_km))}
                  </td>
                  <td className="text-right px-2 py-2 tabular-nums">
                    {d.open_in_days > 0
                      ? <span className="text-amber-700 font-semibold">{d.open_in_days}</span>
                      : <span className="text-slate-500">—</span>}
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
            {vnd.format(data.rates.per_km)}đ/km lấy mẫu → giao mẫu của mỗi chuyến đã hoàn thành.{" "}
            <em>đ/km thực</em> = (tiền giờ + tiền km) ÷ quãng đường thực chạy — gồm cả đoạn di chuyển
            giữa các chuyến, đường về và chuyến không tính tiền. Đây là chi phí thật cho mỗi km,
            không so trực tiếp được với mức {vnd.format(data.rates.per_km)}đ/km.
            Kỳ lương từ {data.from} đến {data.to}. Tải CSV để lấy số chính xác.
          </p>
        </div>
      )}
    </div>
  );
}
