"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

type Env = "prod" | "uat";

interface ScheduleJobResult {
  rowIndex: number;
  pickup_id: string;
  dropoff_id: string;
  delivery_window: string;
  reference_number: string;
  status: "OK" | "SKIPPED" | "ERROR";
  message: string;
  job_id?: number;
}

interface ScheduleRunRecord {
  ts: string;
  date: string;
  weekday: number;
  trigger: "cron" | "manual" | "retry";
  results: ScheduleJobResult[];
}

interface LogResponse {
  record: ScheduleRunRecord | null;
  counts?: { ok: number; skipped: number; error: number };
}

interface Props {
  env: Env;
}

const STATUS_STYLES: Record<ScheduleJobResult["status"], string> = {
  OK: "bg-emerald-100 text-emerald-700 border-emerald-300",
  SKIPPED: "bg-slate-100 text-slate-600 border-slate-300",
  ERROR: "bg-red-100 text-red-700 border-red-300",
};

export function ScheduleJobPanel({ env }: Props) {
  const [record, setRecord] = useState<ScheduleRunRecord | null>(null);
  const [counts, setCounts] = useState({ ok: 0, skipped: 0, error: 0 });
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const loadLog = useCallback(async () => {
    try {
      const res = await fetch("/api/schedule-job/log", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as LogResponse;
      setRecord(data.record);
      setCounts(data.counts ?? { ok: 0, skipped: 0, error: 0 });
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    loadLog();
  }, [loadLog]);

  const runNow = useCallback(
    async (mode?: "retry") => {
      setBusy(true);
      try {
        const params = new URLSearchParams({ env });
        if (mode) params.set("mode", mode);
        const res = await fetch(`/api/schedule-job?${params}`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) {
          toast.error(`Lịch cố định: ${data.error ?? `HTTP ${res.status}`}`);
        } else if (data.counts) {
          const { ok, skipped, error } = data.counts;
          toast.success(
            `Lịch cố định: ${ok} tạo / ${skipped} bỏ qua / ${error} lỗi`,
          );
        } else {
          toast.info(data.message ?? "Không có gì để chạy");
        }
        await loadLog();
      } catch (e) {
        toast.error(`Lịch cố định lỗi: ${String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [env, loadLog],
  );

  const hasErrors = counts.error > 0;
  const lastRunTime = record
    ? new Date(record.ts).toLocaleString("vi-VN", {
        timeZone: "Asia/Ho_Chi_Minh",
        hour: "2-digit",
        minute: "2-digit",
        day: "2-digit",
        month: "2-digit",
      })
    : null;

  return (
    <Card className="py-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span>📅 Lịch cố định</span>
          {hasErrors && (
            <span className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-red-600 text-white text-xs font-bold">
              {counts.error}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {record ? (
          <>
            <div className="text-xs text-muted-foreground">
              Chạy lần cuối: <span className="font-medium">{lastRunTime}</span>
              {" · "}
              <span className="uppercase">{record.trigger}</span>
            </div>
            <div className="flex gap-2 text-xs">
              <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
                OK {counts.ok}
              </span>
              <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                Bỏ qua {counts.skipped}
              </span>
              <span
                className={`px-1.5 py-0.5 rounded ${hasErrors ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-500"}`}
              >
                Lỗi {counts.error}
              </span>
            </div>
            {expanded && record.results.length > 0 && (
              <div className="max-h-64 overflow-y-auto border rounded text-xs">
                {record.results.map((r) => (
                  <div
                    key={r.reference_number}
                    className={`border-l-2 px-2 py-1 border-b last:border-b-0 ${STATUS_STYLES[r.status]}`}
                  >
                    <div className="font-medium text-[11px]">{r.message}</div>
                    <div className="text-[10px] opacity-60 truncate">{r.reference_number}</div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex flex-col gap-1 pt-1">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? "Ẩn chi tiết" : "Xem chi tiết"}
              </Button>
              {hasErrors && (
                <Button
                  size="sm"
                  className="h-7 text-xs bg-red-600 hover:bg-red-700"
                  disabled={busy}
                  onClick={() => runNow("retry")}
                >
                  Chạy lại {counts.error} lỗi
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                disabled={busy}
                onClick={() => runNow()}
              >
                Chạy thủ công
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Chưa có lần chạy nào. Cron tự động lúc 5:00 sáng.
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs w-full"
              disabled={busy}
              onClick={() => runNow()}
            >
              Chạy thủ công
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
