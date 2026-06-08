"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { LogEntry, LogLevel, PickupWarning } from "@/lib/types";

interface ActivityLogProps {
  logs: LogEntry[];
  warnings?: PickupWarning[];
}

const FILTERS = ["All", "OK", "ERROR", "WARN", "INFO"] as const;
type Filter = (typeof FILTERS)[number];

const LEVEL_STYLES: Record<LogLevel, string> = {
  OK: "text-green-600",
  ERROR: "text-red-600",
  WARN: "text-orange-500",
  INFO: "text-blue-600",
};

const LEVEL_BG: Record<LogLevel, string> = {
  OK: "bg-green-50 border-green-200",
  ERROR: "bg-red-50 border-red-200",
  WARN: "bg-orange-50 border-orange-200",
  INFO: "bg-blue-50 border-blue-200",
};

const JOB_ID_RE = /\bJob (\d+)\b/g;

function renderMsg(msg: string) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  for (const match of msg.matchAll(JOB_ID_RE)) {
    const jobId = match[1];
    const start = match.index!;
    if (start > lastIndex) parts.push(msg.slice(lastIndex, start));
    parts.push(
      <a
        key={start}
        href={`https://fleetweb-vn.cartrack.com/delivery/map?job=${jobId}`}
        target="_blank"
        rel="noopener noreferrer"
        className="underline text-indigo-600 hover:text-indigo-800"
      >
        Job {jobId}
      </a>
    );
    lastIndex = start + match[0].length;
  }

  if (lastIndex < msg.length) parts.push(msg.slice(lastIndex));
  if (parts.length === 0) return msg;
  return <>{parts}</>;
}

const LOG_PREVIEW_LIMIT = 160;

/** One log row. Long messages collapse to a single truncated line with the
 *  blue toggle inline on that same row (never dropping to its own row). */
function LogLine({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const isNote =
    entry.msg.includes("has note") || entry.msg.includes("despite note");
  const isLong = entry.msg.length > LOG_PREVIEW_LIMIT;
  const collapsed = isLong && !expanded;

  const tag = isNote ? (
    <span className="shrink-0 font-semibold text-purple-700">📝 NOTE </span>
  ) : (
    <span className={`shrink-0 font-semibold ${LEVEL_STYLES[entry.level]}`}>[{entry.level}] </span>
  );

  return (
    <div
      className={`p-1.5 rounded border ${
        isNote
          ? "bg-purple-50 border-purple-300 border-l-4 border-l-purple-500"
          : LEVEL_BG[entry.level]
      }`}
    >
      <div>
        <span className="text-muted-foreground">{entry.ts.slice(11, 19)} </span>
        {tag}
        {collapsed ? (
          <>
            {renderMsg(entry.msg.slice(0, LOG_PREVIEW_LIMIT))}
            <span>… </span>
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              className="font-semibold text-blue-600 hover:text-blue-800 whitespace-nowrap"
            >
              Xem thêm
            </button>
          </>
        ) : (
          <>
            {renderMsg(entry.msg)}
            {isLong && (
              <button
                type="button"
                onClick={() => setExpanded((e) => !e)}
                className="ml-1 font-semibold text-blue-600 hover:text-blue-800"
              >
                {" Thu gọn"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function ActivityLog({ logs, warnings = [] }: ActivityLogProps) {
  const [filter, setFilter] = useState<Filter>("All");

  const filtered =
    filter === "All" ? logs : logs.filter((l) => l.level === filter);

  return (
    <Card className="flex flex-col h-full py-4">
      <CardHeader className="pb-2 shrink-0">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">Activity Log</CardTitle>
          <span className="text-xs text-muted-foreground">
            {logs.length} entries
          </span>
        </div>
        <div className="flex gap-1 mt-1">
          {FILTERS.map((f) => (
            <Button
              key={f}
              variant={filter === f ? "default" : "outline"}
              size="sm"
              className="h-6 text-xs px-2"
              onClick={() => setFilter(f)}
            >
              {f}
            </Button>
          ))}
        </div>
        {warnings.length > 0 && (
          <div className="mt-1.5 min-w-0">
            <div className="flex items-center gap-1 mb-1 text-xs font-semibold text-amber-700">
              <span className="leading-none">⚠</span>
              <span>Lấy mẫu chậm</span>
              <span className="rounded-full bg-amber-100 border border-amber-300 px-1.5 leading-none py-0.5 text-amber-800">
                {warnings.length}
              </span>
            </div>
            <div className="flex gap-2 overflow-x-auto min-w-0 w-full pb-1">
              {warnings.map((w) => (
                <div
                  key={w.job_id}
                  className="shrink-0 bg-amber-50 border border-amber-300 rounded-lg px-2.5 py-1.5 text-xs w-[190px] space-y-0.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <a
                      href={`https://fleetweb-vn.cartrack.com/delivery/map?job=${w.job_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono font-semibold text-indigo-600 underline hover:text-indigo-800"
                    >
                      {w.job_id}
                    </a>
                    <span className="font-bold text-red-600 bg-red-50 border border-red-200 rounded px-1.5 py-0.5 leading-none whitespace-nowrap">
                      +{w.minutes_late ?? 0}&apos;
                    </span>
                  </div>
                  {w.pickup_customer_name && (
                    <p
                      className="text-slate-700 font-medium truncate leading-snug"
                      title={w.pickup_customer_name}
                    >
                      {w.pickup_customer_name}
                    </p>
                  )}
                  {w.driver_name && (
                    <p className="text-slate-400 truncate leading-snug" title={w.driver_name}>
                      {w.driver_name}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardHeader>
      <CardContent className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div className="space-y-1 font-mono text-xs pr-3">
            {filtered.length === 0 && (
              <p className="text-muted-foreground text-center py-8">
                No log entries yet
              </p>
            )}
            {[...filtered].reverse().map((entry, i) => (
              <LogLine key={`${entry.ts}-${i}`} entry={entry} />
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
