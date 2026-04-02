"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

interface AssignedRow {
  job_id: number;
  driver_name: string;
  pickup: string;
  distance_km: number;
  unscheduled: boolean;
}

interface UnmatchedRow {
  job_id: number;
  reason: string;
}

interface Result {
  assigned: AssignedRow[];
  unmatched: UnmatchedRow[];
  drivers_with_gps: number;
}

export default function SmartAssignPage() {
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");

  const run = async () => {
    setStatus("loading");
    setResult(null);
    setError("");
    try {
      const res = await fetch("/api/smart-assign", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unknown error");
      setResult(data);
      setStatus("done");
    } catch (e) {
      setError(String(e));
      setStatus("error");
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-3xl mx-auto space-y-6">

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold">Smart Assign</h1>
          <p className="text-sm text-slate-500 mt-1">
            Assigns nearest available driver to each unassigned pickup using GPS distance.
          </p>
        </div>

        {/* Action */}
        <Button onClick={run} disabled={status === "loading"} className="w-full h-12 text-base font-semibold">
          {status === "loading" ? "Calculating..." : "🧭 Preview Suggestions"}
        </Button>

        {status === "error" && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="space-y-4">
            {/* Summary */}
            <div className="flex gap-3 text-sm">
              <span className="rounded-full bg-green-100 text-green-700 px-3 py-1 font-medium">
                🧭 {result.assigned.length} suggested
              </span>
              {result.unmatched.length > 0 && (
                <span className="rounded-full bg-red-100 text-red-700 px-3 py-1 font-medium">
                  ⚠️ {result.unmatched.length} unmatched
                </span>
              )}
              <span className="rounded-full bg-slate-100 text-slate-600 px-3 py-1 font-medium">
                📍 {result.drivers_with_gps} drivers with GPS
              </span>
            </div>

            {/* Assigned table */}
            {result.assigned.length > 0 && (
              <div className="rounded-lg border bg-white overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
                    <tr>
                      <th className="px-4 py-2 text-left">Job</th>
                      <th className="px-4 py-2 text-left">Pickup</th>
                      <th className="px-4 py-2 text-left">Driver</th>
                      <th className="px-4 py-2 text-right">Distance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {result.assigned.map((row) => (
                      <tr key={row.job_id}>
                        <td className="px-4 py-2 font-mono text-xs text-slate-500">#{row.job_id}</td>
                        <td className="px-4 py-2 font-medium">
                          {row.pickup}
                          {row.unscheduled && <span className="ml-1.5 text-[10px] bg-amber-100 text-amber-700 rounded px-1 py-0.5 font-semibold">No schedule</span>}
                        </td>
                        <td className="px-4 py-2">{row.driver_name}</td>
                        <td className="px-4 py-2 text-right text-slate-500">{row.distance_km} km</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Unmatched */}
            {result.unmatched.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-1">
                <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-2">Unmatched Jobs</p>
                {result.unmatched.map((row) => (
                  <p key={row.job_id} className="text-sm text-amber-800">
                    <span className="font-mono">#{row.job_id}</span> — {row.reason}
                  </p>
                ))}
              </div>
            )}

            {result.assigned.length === 0 && result.unmatched.length === 0 && (
              <p className="text-sm text-slate-400 text-center py-6">No unassigned jobs found.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
