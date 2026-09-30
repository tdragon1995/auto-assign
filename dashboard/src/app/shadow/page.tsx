"use client";

import { useEffect, useState } from "react";

type Decision = { mode: string; status: string; driverIds: string[]; leave?: string[][]; alternateDropoffId: string };
type Comparison = { jobId: number; route: string; actualDriverId: string | null; sheet: Decision; supabase: Decision; match: boolean };
type Log = { ts: string; level: string; msg: string };
type Snapshot = { sampledAt: string; source: string; sheetRules: number; supabaseRules: number;
  ruleDifferenceCount: number; ruleDifferenceRows: number[]; leaveDifferenceCount: number;
  comparisons: Comparison[]; productionLog: Log[]; assignmentsPerformed: number };

const WINDOW_MS = 60 * 60 * 1000;
const POLL_MS = 3 * 60 * 1000;

export default function ShadowPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [history, setHistory] = useState<{ at: string; compared: number; differences: number; smart: number }[]>([]);
  const [started, setStarted] = useState<number | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!started) return;
    let stopped = false;
    async function sample() {
      try {
        const response = await fetch("/api/shadow", { cache: "no-store" });
        if (!response.ok) throw new Error(`Snapshot failed (${response.status})`);
        const next = await response.json() as Snapshot;
        if (stopped) return;
        setSnapshot(next);
        setHistory(previous => [...previous, { at: next.sampledAt, compared: next.comparisons.length,
          differences: next.comparisons.filter(job => !job.match).length,
          smart: next.comparisons.filter(job => job.sheet.mode.startsWith("smart")).length }]);
        setError("");
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : "Snapshot failed");
      }
    }
    void sample();
    const interval = window.setInterval(() => {
      if (Date.now() - started >= WINDOW_MS) { window.clearInterval(interval); setStarted(null); }
      else void sample();
    }, POLL_MS);
    return () => { stopped = true; window.clearInterval(interval); };
  }, [started]);

  const differences = snapshot?.comparisons.filter(job => !job.match) ?? [];
  return <main style={{ fontFamily: "Arial, sans-serif", maxWidth: 1100, margin: "0 auto", padding: 24, color: "#15213b" }}>
    <h1>Fleet Auto-Assign · Shadow comparison</h1>
    <p>Read-only comparison of Google Sheet and Supabase. Fixed and Smart(1) show the configured driver; multi-driver Smart compares the candidate pool and leave coverage. Live ranking is not rerun. No shadow assignments are sent to Cartrack.</p>
    <button onClick={() => { setHistory([]); setStarted(Date.now()); }} disabled={started !== null}>
      {started ? "Comparing for one hour…" : "Start one-hour comparison"}
    </button>
    {started && <button onClick={() => setStarted(null)} style={{ marginLeft: 8 }}>Stop</button>}
    {error && <p role="alert" style={{ color: "#a00" }}>{error}</p>}
    {snapshot && <>
      <p>Sampled {new Date(snapshot.sampledAt).toLocaleString("vi-VN")} · {snapshot.source} · {snapshot.assignmentsPerformed} shadow writes</p>
      <p>Rules: Sheet {snapshot.sheetRules}, Supabase {snapshot.supabaseRules}; differing rows {snapshot.ruleDifferenceCount}
        {snapshot.ruleDifferenceRows.length > 0 && ` (first rows: ${snapshot.ruleDifferenceRows.join(", ")})`}. Today’s leave differences: {snapshot.leaveDifferenceCount}.</p>
      <p>Samples: {history.length} · live jobs compared: {snapshot.comparisons.length} · Smart jobs: {snapshot.comparisons.filter(job => job.sheet.mode.startsWith("smart")).length} · differences: {differences.length}</p>
      <h2>Differences</h2>
      {differences.length === 0 ? <p>No differences in this snapshot.</p> : differences.map(job => <article key={job.jobId} style={{ border: "1px solid #f5a9a9", padding: 10, marginBottom: 6 }}>
        <strong>Job {job.jobId}</strong> · {job.route}<br />Sheet {job.sheet.mode}: {job.sheet.status} [{job.sheet.driverIds.join(", ")}]<br />Supabase {job.supabase.mode}: {job.supabase.status} [{job.supabase.driverIds.join(", ")}]
      </article>)}
      <h2>Current shadow decisions</h2>
      {snapshot.comparisons.map(job => <div key={job.jobId} style={{ padding: 7, borderBottom: "1px solid #ddd", background: job.match ? "#e9f9ee" : "#fff1ef" }}>
        {job.match ? "[OK]" : "[DIFF]"} Job {job.jobId} · {job.route} · {job.supabase.mode} · {job.supabase.status}
        {job.supabase.mode === "smart" && ` · candidate IDs: ${job.supabase.driverIds.join(", ")}`}
        {job.actualDriverId && ` · Cartrack: ${job.actualDriverId}`}
      </div>)}
      <h2>Production activity log (Sheet engine)</h2>
      {snapshot.productionLog.slice().reverse().map((line, i) => <div key={`${line.ts}-${i}`} style={{ padding: 6, borderBottom: "1px solid #ddd", background: line.level === "OK" ? "#e9f9ee" : line.level === "ERROR" ? "#fff1ef" : "#fff9e9" }}>
        {line.ts} [{line.level}] {line.msg}
      </div>)}
    </>}
    <p style={{ marginTop: 20, color: "#667" }}>Keep this tab open for the one-hour sample. It reads only while the comparison is running, every three minutes.</p>
  </main>;
}
