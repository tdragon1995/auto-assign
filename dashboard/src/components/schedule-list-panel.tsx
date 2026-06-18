"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DIAG_LOCATIONS } from "@/lib/diag-locations";
import { toast } from "sonner";

type Env = "prod" | "uat";

interface ScheduleRow {
  rowIndex: number;
  pickup_id: string;
  pickup_name: string;
  dropoff_id: string;
  dropoff_name: string;
  delivery_window: string;
  reference: string;
  sent_to_driver_before: number;
  days: boolean[]; // index 0=Sun .. 6=Sat
}

// customer_id → short name ("D001"), used only as a fallback when the sheet has
// no name for a row.
const NAME_BY_ID = new Map(DIAG_LOCATIONS.map((l) => [l.customer_id, l.name]));
// Prefer the sheet's own pickup/dropoff name column; fall back to the branch
// list, then the raw id.
const labelFor = (name: string, id: string) => name || NAME_BY_ID.get(id) || id;

// Sheet days are Sun..Sat; show the week starting Monday for readability.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_FULL = ["Chủ nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];
const DAY_SHORT = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

/** Subtract `mins` from "HH:MM", clamped to 00:00. */
function minusMinutes(hhmm: string, mins: number): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  let total = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) - mins;
  if (total < 0) total = 0;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function activeDays(days: boolean[]): number[] {
  return WEEK_ORDER.filter((i) => days[i]);
}

/**
 * The "Lịch cố định" tab: read-only list of every fixed schedule, with live
 * filtering by pickup/dropoff (name or code) and weekday. Run incidents are
 * surfaced separately in the "Cần xử lý" tab, not here.
 */
export function ScheduleListPanel({ env }: { env: Env }) {
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [dayFilter, setDayFilter] = useState<Set<number>>(new Set());
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch("/api/schedule-job/list", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (alive) setRows(Array.isArray(d.rows) ? d.rows : []); })
      .catch(() => { if (alive) setRows([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const runNow = useCallback(async () => {
    setRunning(true);
    try {
      const res = await fetch(`/api/schedule-job?env=${env}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) toast.error(`Lịch cố định: ${data.error ?? `HTTP ${res.status}`}`);
      else if (data.counts) {
        const { ok, skipped, error } = data.counts;
        toast.success(`Lịch cố định: ${ok} tạo / ${skipped} bỏ qua / ${error} lỗi`);
      } else toast.info(data.message ?? "Không có gì để chạy");
    } catch (e) {
      toast.error(`Lịch cố định lỗi: ${String(e)}`);
    } finally {
      setRunning(false);
    }
  }, [env]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => r.pickup_id && r.dropoff_id && r.delivery_window)
      .filter((r) => {
        if (dayFilter.size > 0 && !WEEK_ORDER.some((i) => dayFilter.has(i) && r.days[i])) return false;
        if (!q) return true;
        const hay = `${r.pickup_name} ${r.pickup_id} ${r.dropoff_name} ${r.dropoff_id}`.toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => a.delivery_window.localeCompare(b.delivery_window));
  }, [rows, query, dayFilter]);

  const toggleDay = (i: number) =>
    setDayFilter((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });

  return (
    <Card className="flex flex-col h-full py-4">
      <CardHeader className="pb-2 shrink-0 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">📅 Lịch cố định</CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{filtered.length}/{rows.length}</span>
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={running} onClick={runNow}>
              {running ? "Đang chạy…" : "Chạy thủ công"}
            </Button>
          </div>
        </div>

        {/* Filters: free text (pickup/dropoff, name or code) + weekday chips */}
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Lọc theo điểm lấy / điểm giao (tên hoặc mã)…"
          className="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
        />
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mr-1">Thứ</span>
          {WEEK_ORDER.map((i) => (
            <button
              key={i}
              type="button"
              onClick={() => toggleDay(i)}
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold transition-colors ${
                dayFilter.has(i) ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {DAY_SHORT[i]}
            </button>
          ))}
          {dayFilter.size > 0 && (
            <button
              type="button"
              onClick={() => setDayFilter(new Set())}
              className="text-[10px] font-semibold text-slate-400 hover:text-slate-600 ml-1"
            >
              Xoá
            </button>
          )}
        </div>
      </CardHeader>

      <CardContent className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div className="space-y-1.5 pr-3 text-xs">
            {loading && <p className="text-muted-foreground text-center py-8">Đang tải…</p>}
            {!loading && filtered.length === 0 && (
              <p className="text-muted-foreground text-center py-8">Không có lịch nào khớp.</p>
            )}
            {filtered.map((r) => {
              const sendTime = minusMinutes(r.delivery_window, r.sent_to_driver_before);
              const days = activeDays(r.days);
              return (
                <div key={r.rowIndex} className="rounded border bg-white p-2 space-y-1">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 font-semibold text-slate-800 break-words">
                      {labelFor(r.pickup_name, r.pickup_id)} <span className="text-slate-400">→</span> {labelFor(r.dropoff_name, r.dropoff_id)}
                    </span>
                    <span className="shrink-0 rounded bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 font-mono font-semibold text-indigo-700">
                      {r.delivery_window}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
                    <span>{days.length ? days.map((i) => DAY_FULL[i]).join(" · ") : "—"}</span>
                    <span>
                      <span className="font-semibold text-slate-400">Gửi:</span>{" "}
                      {sendTime} <span className="text-slate-400">(trước {r.sent_to_driver_before}′)</span>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
