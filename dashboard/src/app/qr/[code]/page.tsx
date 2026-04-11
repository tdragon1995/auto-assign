"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useSearchParams } from "next/navigation";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface PscRoute {
  psc_pickup: string;
  dropoff_location: string;
  pickup: string;
  dropoff: string;
  ref_number: string;
  driver_id: string | null;
  driver_name: string | null;
}

interface Stop {
  stop_id: number;
  stop_type_id: number;
  stop_status_id: number;
  customer_id: string;
  customer_name: string;
  address_line_1?: string;
  activity_started_ts?: string | null;
  activity_arrived_ts?: string | null;
  activity_completed_ts?: string | null;
  todos?: { todo_type_id: number; description?: string }[];
}

interface Job {
  job_id: number;
  reference_number: string;
  job_status_id: number;
  scheduled_delivery_ts: string | null;
  driver?: { last_name?: string } | null;
  stops: Stop[];
}

type Status = "idle" | "loading" | "success" | "error";
type TabType = "active" | "done";

const STOP_STATUS: Record<number, { label: string; color: string }> = {
  1: { label: "Chờ",        color: "bg-slate-100 text-slate-600"  },
  2: { label: "Đang đến",   color: "bg-blue-100 text-blue-700"    },
  3: { label: "Đã đến",     color: "bg-indigo-100 text-indigo-700"},
  4: { label: "Hoàn thành", color: "bg-green-100 text-green-700"  },
  5: { label: "Từ chối",    color: "bg-red-100 text-red-700"      },
};

const STOP_TYPE: Record<number, string> = { 1: "Lấy", 2: "Giao", 3: "Dropoff" };

const TODO_EMOJI: Record<number, string> = {
  1: "✍️",
  2: "📸",
  3: "🔗",
  5: "📝",
};

function latestTs(stop: Stop): string | null {
  return stop.activity_completed_ts ?? stop.activity_arrived_ts ?? stop.activity_started_ts ?? null;
}

function fmtTs(ts: string | null): string {
  if (!ts) return "—";
  return ts.slice(11, 16);
}

function driverName(job: Job): string {
  return job.driver?.last_name?.trim() || "—";
}

function todayVN(): string {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().split("T")[0];
}

function StopCard({ stop }: { stop: Stop }) {
  const s = STOP_STATUS[stop.stop_status_id] ?? { label: "?", color: "bg-slate-100 text-slate-600" };
  const ts = latestTs(stop);
  const todos = (stop.todos ?? []).filter((t) => TODO_EMOJI[t.todo_type_id]);

  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-500">{STOP_TYPE[stop.stop_type_id] ?? "Stop"}</span>
        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-md ${s.color}`}>{s.label}</span>
      </div>
      <p className="text-sm font-medium text-slate-800">{stop.customer_name}</p>
      {stop.address_line_1 && <p className="text-xs text-slate-500">{stop.address_line_1}</p>}
      <div className="flex items-center gap-2 flex-wrap">
        {todos.map((t) => (
          <span key={t.todo_type_id} className="text-base">{TODO_EMOJI[t.todo_type_id]}</span>
        ))}
        {ts && <span className="text-[10px] text-slate-400 ml-auto">{fmtTs(ts)}</span>}
      </div>
    </div>
  );
}

function JobCard({ job }: { job: Job }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 space-y-2 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-slate-400">#{job.job_id}</span>
        <span className="text-xs text-slate-500 truncate max-w-[60%] text-right">{job.reference_number}</span>
      </div>
      <p className="text-xs text-slate-600">Tài xế: <span className="font-semibold">{driverName(job)}</span></p>
      <div className="space-y-1.5">
        {job.stops.map((s) => <StopCard key={s.stop_id} stop={s} />)}
      </div>
    </div>
  );
}

export default function QrPage() {
  const params = useParams<{ code: string }>();
  const searchParams = useSearchParams();
  const code = decodeURIComponent(params.code ?? "").trim();
  const isStaging = searchParams.get("env") === "uat";
  const envParam = isStaging ? "?env=uat" : "";

  const [route, setRoute] = useState<PscRoute | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [assignStatus, setAssignStatus] = useState<Status>("idle");
  const [assignResult, setAssignResult] = useState<string>("");

  const [tab, setTab] = useState<TabType | null>(null);
  const [date, setDate] = useState(todayVN());
  const [activeJobs, setActiveJobs] = useState<Job[]>([]);
  const [doneJobs, setDoneJobs] = useState<Job[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);

  // Fetch route config
  useEffect(() => {
    fetch("/api/psc-routes")
      .then((r) => r.json())
      .then((d) => {
        const routes: PscRoute[] = d.data ?? [];
        const match = routes.find((r) => r.pickup === code);
        if (match) setRoute(match);
        else setNotFound(true);
        setLoading(false);
      })
      .catch(() => { setNotFound(true); setLoading(false); });
  }, [code]);

  const loadJobs = useCallback(async () => {
    setJobsLoading(true);
    try {
      const [activeRes, doneRes] = await Promise.all([
        fetch(`/api/location-jobs?date=${date}&status=4`),
        fetch(`/api/location-jobs?date=${date}&status=5`),
      ]);
      const [activeData, doneData] = await Promise.all([activeRes.json(), doneRes.json()]);

      const filterByLocation = (jobs: Job[]) =>
        jobs.filter((j) =>
          (j.stops ?? []).some((s) => s.customer_id === code)
        );

      setActiveJobs(filterByLocation(activeData.jobs ?? []));
      setDoneJobs(filterByLocation(doneData.jobs ?? []));
    } catch {
      setActiveJobs([]);
      setDoneJobs([]);
    } finally {
      setJobsLoading(false);
    }
  }, [date, code]);

  // Load jobs when tab is open and date changes
  useEffect(() => { if (tab !== null) loadJobs(); }, [loadJobs, tab]);

  const handleAssign = async () => {
    if (!route) return;
    setAssignStatus("loading");
    setAssignResult("");
    try {
      const res = await fetch(`/api/psc-assign${envParam}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          psc_pickup: route.psc_pickup,
          dropoff_location: route.dropoff_location,
          pickup: route.pickup,
          dropoff: route.dropoff,
          ref_number: route.ref_number,
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setAssignStatus("success");
        setAssignResult(`Job submitted → ${data.reference}`);
      } else if (res.status === 409) {
        setAssignStatus("error");
        setAssignResult(`Job #${data.job_id}: Đơn liền trước chưa nhận mẫu, vui lòng chờ thêm hoặc liên hệ đội điều phối. Xin cám ơn!`);
      } else {
        setAssignStatus("error");
        setAssignResult(data.error || "Unknown error");
      }
    } catch (e) {
      setAssignStatus("error");
      setAssignResult(String(e));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background p-4">
        <Card className="max-w-sm w-full">
          <CardHeader><CardTitle className="text-destructive">Not Found</CardTitle></CardHeader>
          <CardContent>
            <p className="text-muted-foreground">No PSC route found for code <strong>{code}</strong>.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const displayJobs = tab === "active" ? activeJobs : tab === "done" ? doneJobs : [];

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col items-center p-4 gap-4">

      {/* Request card */}
      <Card className="max-w-md w-full">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            PSC Transport
            <Badge variant="outline">{route!.psc_pickup}</Badge>
            {isStaging && <Badge variant="destructive">STAGING</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border p-4 space-y-3">
            <Row label="Pickup" value={route!.psc_pickup} icon="📦" />
            <Row label="Dropoff" value={route!.dropoff_location} icon="📍" />
            <Row label="Route" value={`${route!.psc_pickup} ➡ ${route!.dropoff_location}`} icon="🛵" />
            {route!.ref_number && <Row label="Ref" value={route!.ref_number} icon="🏷️" />}
          </div>
          {assignStatus === "success" && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">{assignResult}</div>
          )}
          {assignStatus === "error" && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{assignResult}</div>
          )}
        </CardContent>
        <CardFooter className="flex flex-col gap-2">
          <Button
            className="w-full"
            size="lg"
            onClick={handleAssign}
            disabled={assignStatus === "loading" || assignStatus === "success"}
          >
            {assignStatus === "loading" ? "Creating job..." : assignStatus === "success" ? "Job created" : "Đề Nghị Giao Mẫu"}
          </Button>
          {assignStatus === "success" && (
            <Button variant="outline" className="w-full" onClick={() => { setAssignStatus("idle"); setAssignResult(""); }}>
              Create another
            </Button>
          )}
        </CardFooter>
      </Card>

      {/* Jobs card */}
      <div className="w-full max-w-md bg-white rounded-2xl shadow border overflow-hidden">
        {/* Tab switcher */}
        <div className="grid grid-cols-2 border-b border-slate-100">
          <button
            onClick={() => setTab("active")}
            className={`py-2.5 text-sm font-semibold transition-colors ${tab === "active" ? "bg-blue-600 text-white" : "bg-white text-slate-500 hover:bg-slate-50"}`}
          >
            Đang diễn ra {activeJobs.length > 0 && `(${activeJobs.length})`}
          </button>
          <button
            onClick={() => setTab("done")}
            className={`py-2.5 text-sm font-semibold transition-colors border-l border-slate-100 ${tab === "done" ? "bg-blue-600 text-white" : "bg-white text-slate-500 hover:bg-slate-50"}`}
          >
            Xong {doneJobs.length > 0 && `(${doneJobs.length})`}
          </button>
        </div>

        {tab !== null && (
          <div className="p-4 space-y-3">
            {/* Date picker + refresh */}
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="flex-1 border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
              <button onClick={loadJobs} className="text-xs text-blue-500 hover:underline whitespace-nowrap">Làm mới</button>
            </div>

            {jobsLoading ? (
              <p className="text-xs text-slate-400 text-center py-6">Đang tải...</p>
            ) : displayJobs.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-6">Không có đơn hàng.</p>
            ) : (
              <div className="space-y-2">
                {displayJobs.map((j) => <JobCard key={j.job_id} job={j} />)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, icon }: { label: string; value: string; icon: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground flex items-center gap-1.5">
        <span>{icon}</span>{label}
      </span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
