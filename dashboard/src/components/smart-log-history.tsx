"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { LogEntry, LogLevel } from "@/lib/types";

interface SmartRunEntry {
  ts: string;
  ok: number;
  warn: number;
  error: number;
  entries: LogEntry[];
}

const LEVEL_STYLES: Record<LogLevel, string> = {
  OK:    "text-green-600",
  ERROR: "text-red-600",
  WARN:  "text-orange-500",
  INFO:  "text-blue-600",
};

const LEVEL_BG: Record<LogLevel, string> = {
  OK:    "bg-green-50 border-green-200",
  ERROR: "bg-red-50 border-red-200",
  WARN:  "bg-orange-50 border-orange-200",
  INFO:  "bg-blue-50 border-blue-200",
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
      <a key={start} href={`https://fleetweb-vn.cartrack.com/delivery/map?job=${jobId}`}
        target="_blank" rel="noopener noreferrer"
        className="underline text-indigo-600 hover:text-indigo-800">
        Job {jobId}
      </a>
    );
    lastIndex = start + match[0].length;
  }
  if (lastIndex < msg.length) parts.push(msg.slice(lastIndex));
  return parts.length === 0 ? msg : <>{parts}</>;
}

function RunCard({ run, index }: { run: SmartRunEntry; index: number }) {
  const [open, setOpen] = useState(index === 0);
  const hasIssue = run.error > 0 || run.warn > 0;
  const borderColor = run.error > 0 ? "border-red-300" : run.warn > 0 ? "border-orange-300" : "border-green-200";

  return (
    <div className={`border rounded-md ${borderColor} overflow-hidden`}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 px-3 py-2 text-xs font-mono hover:bg-muted/50 text-left"
      >
        <span className="text-muted-foreground shrink-0">{run.ts.slice(0, 19)}</span>
        <span className="flex gap-2 shrink-0">
          {run.ok > 0 && <span className="text-green-600 font-semibold">✓{run.ok}</span>}
          {run.warn > 0 && <span className="text-orange-500 font-semibold">⚠{run.warn}</span>}
          {run.error > 0 && <span className="text-red-600 font-semibold">✗{run.error}</span>}
          {!hasIssue && run.ok === 0 && <span className="text-muted-foreground">no smart jobs</span>}
        </span>
        <span className="ml-auto text-muted-foreground">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="border-t px-3 py-2 space-y-1 font-mono text-xs bg-background">
          {run.entries.map((entry, i) => (
            <div key={i} className={`p-1.5 rounded border ${LEVEL_BG[entry.level]}`}>
              <span className="text-muted-foreground">{entry.ts.slice(11, 19)} </span>
              <span className={`font-semibold ${LEVEL_STYLES[entry.level]}`}>[{entry.level}] </span>
              <span>{renderMsg(entry.msg)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SmartLogHistory() {
  const [runs, setRuns] = useState<SmartRunEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/smart-log?limit=240");
      const data = await res.json();
      setConfigured(data.configured ?? false);
      if (data.error) throw new Error(data.error);
      setRuns(data.runs ?? []);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="flex flex-col h-full rounded-lg border bg-card text-card-foreground shadow-sm">
      <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
        <span className="text-xs text-muted-foreground">{runs.length} runs (last 24h)</span>
        <Button size="sm" variant="outline" className="h-6 text-xs px-2" onClick={load} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </Button>
      </div>

      {configured === false && !loading && (
        <div className="mx-3 mt-2 text-xs bg-orange-50 border border-orange-200 rounded p-2 font-mono shrink-0">
          <span className="text-orange-700 font-semibold">Redis not connected.</span>
          {" "}Vercel dashboard → Storage → Upstash → Redis → Connect to this project.
        </div>
      )}
      {configured === true && !loading && runs.length === 0 && (
        <div className="mx-3 mt-2 text-xs bg-blue-50 border border-blue-200 rounded p-2 font-mono text-blue-700 shrink-0">
          Redis connected. Waiting for first smart-assign cycle to complete.
        </div>
      )}
      {error && (
        <p className="mx-3 mt-2 text-xs text-red-600 font-mono shrink-0">{error}</p>
      )}

      <ScrollArea className="flex-1 min-h-0">
        <div className="space-y-1 p-2">
          {!loading && runs.length === 0 && !error && configured !== false && (
            <p className="text-xs text-muted-foreground text-center py-12">
              No runs stored yet.
            </p>
          )}
          {runs.map((run, i) => (
            <RunCard key={`${run.ts}-${i}`} run={run} index={i} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
