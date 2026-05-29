"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { LogEntry, LogLevel } from "@/lib/types";

interface ActivityLogProps {
  logs: LogEntry[];
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

export function ActivityLog({ logs }: ActivityLogProps) {
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
      </CardHeader>
      <CardContent className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div className="space-y-1 font-mono text-xs pr-3">
            {filtered.length === 0 && (
              <p className="text-muted-foreground text-center py-8">
                No log entries yet
              </p>
            )}
            {[...filtered].reverse().map((entry, i) => {
              const isNote =
                entry.msg.includes("has note") || entry.msg.includes("despite note");
              return (
                <div
                  key={`${entry.ts}-${i}`}
                  className={`p-1.5 rounded border ${
                    isNote
                      ? "bg-purple-50 border-purple-300 border-l-4 border-l-purple-500"
                      : LEVEL_BG[entry.level]
                  }`}
                >
                  <span className="text-muted-foreground">
                    {entry.ts.slice(11, 19)}{" "}
                  </span>
                  {isNote ? (
                    <span className="font-semibold text-purple-700">📝 NOTE{" "}</span>
                  ) : (
                    <span className={`font-semibold ${LEVEL_STYLES[entry.level]}`}>
                      [{entry.level}]{" "}
                    </span>
                  )}
                  <span>{renderMsg(entry.msg)}</span>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
