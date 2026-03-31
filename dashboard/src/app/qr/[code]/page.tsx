"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
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
  activity_started_ts: string | null;
  activity_arrived_ts: string | null;
  activity_completed_ts: string | null;
}

interface PscJob {
  job_id: number;
  job_status_id: number;
  reference_number: string;
  create_ts: string;
  driver: { first_name: string; last_name: string } | null;
  stops: Stop[];
}

const JOB_STATUS: Record<number, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  2: { label: "Chờ tài xế", variant: "secondary" },
  4: { label: "Đã có tài xế", variant: "default" },
  5: { label: "Hoàn thành", variant: "outline" },
  3: { label: "Thất bại", variant: "destructive" },
};

const STOP_STATUS: Record<number, { label: string; icon: string }> = {
  1: { label: "Chờ", icon: "⏳" },
  2: { label: "Đang đến", icon: "🛵" },
  3: { label: "Đã đến nơi", icon: "📍" },
  4: { label: "Hoàn thành", icon: "✅" },
  5: { label: "Không thành công", icon: "❌" },
};

function fmtTime(ts: string | null): string {
  if (!ts) return "";
  return ts.slice(11, 16);
}

type AssignStatus = "idle" | "loading" | "success" | "error";

export default function QrPage() {
  const params = useParams<{ code: string }>();
  const searchParams = useSearchParams();
  const code = decodeURIComponent(params.code ?? "").trim();
  const isStaging = searchParams.get("env") === "uat";
  const envQuery = isStaging ? "?env=uat" : "";

  const [route, setRoute] = useState<PscRoute | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [assignStatus, setAssignStatus] = useState<AssignStatus>("idle");
  const [assignResult, setAssignResult] = useState<string>("");

  const [activeJobs, setActiveJobs] = useState<PscJob[]>([]);
  const [doneJobs, setDoneJobs] = useState<PscJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [showDone, setShowDone] = useState(false);

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

  const fetchJobs = useCallback(async (pickupId: string) => {
    setJobsLoading(true);
    try {
      const res = await fetch(`/api/psc-jobs${envQuery}`);
      if (!res.ok) return;
      const data = await res.json();
      // Filter client-side — one shared API call serves all PSCs
      const mine: PscJob[] = (data.jobs ?? []).filter((j: PscJob) =>
        j.stops?.some((s) => s.customer_id === pickupId)
      );
      setActiveJobs(mine.filter((j) => j.job_status_id !== 5 && j.job_status_id !== 3));
      setDoneJobs(mine.filter((j) => j.job_status_id === 5 || j.job_status_id === 3));
    } finally {
      setJobsLoading(false);
    }
  }, [envQuery]);

  useEffect(() => {
    if (!route) return;
    fetchJobs(route.pickup);
    const interval = setInterval(() => fetchJobs(route.pickup), 30_000);
    return () => clearInterval(interval);
  }, [route, fetchJobs]);

  const handleAssign = async () => {
    if (!route) return;
    setAssignStatus("loading");
    setAssignResult("");
    try {
      const res = await fetch(`/api/psc-assign${envQuery}`, {
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
        setAssignResult(`Đã gửi yêu cầu → ${data.reference}`);
        fetchJobs(route.pickup);
      } else if (res.status === 409) {
        setAssignStatus("error");
        setAssignResult(`Đã có yêu cầu hôm nay — Job #${data.job_id}`);
      } else {
        setAssignStatus("error");
        setAssignResult(data.error || "Lỗi không xác định");
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
          <CardHeader><CardTitle className="text-destructive">Không tìm thấy</CardTitle></CardHeader>
          <CardContent>
            <p className="text-muted-foreground">Không tìm thấy tuyến PSC cho mã <strong>{code}</strong>.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-4 flex flex-col items-center gap-4 max-w-md mx-auto">

      {/* Request pickup */}
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            Vận chuyển mẫu
            <Badge variant="outline">{route!.psc_pickup}</Badge>
            {isStaging && <Badge variant="destructive">STAGING</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border p-4 space-y-3">
            <Row label="Điểm lấy" value={route!.psc_pickup} icon="📦" />
            <Row label="Điểm đến" value={route!.dropoff_location} icon="📍" />
          </div>
          {assignStatus === "success" && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">{assignResult}</div>
          )}
          {assignStatus === "error" && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{assignResult}</div>
          )}
        </CardContent>
        <CardFooter className="flex flex-col gap-2">
          <Button
            className="w-full" size="lg"
            onClick={handleAssign}
            disabled={assignStatus === "loading" || assignStatus === "success"}
          >
            {assignStatus === "loading" ? "Đang gửi..." : assignStatus === "success" ? "Đã gửi yêu cầu" : "Yêu cầu lấy mẫu"}
          </Button>
          {assignStatus === "success" && (
            <Button variant="outline" className="w-full" onClick={() => { setAssignStatus("idle"); setAssignResult(""); }}>
              Tạo thêm
            </Button>
          )}
        </CardFooter>
      </Card>

      {/* Today's trips */}
      <Card className="w-full">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Chuyến hôm nay</CardTitle>
            <button
              onClick={() => route && fetchJobs(route.pickup)}
              disabled={jobsLoading}
              className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {jobsLoading ? "..." : "🔄 Làm mới"}
            </button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {!jobsLoading && activeJobs.length === 0 && doneJobs.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-6">Chưa có chuyến nào hôm nay</p>
          )}

          {activeJobs.map((job) => <JobCard key={job.job_id} job={job} pickupId={route!.pickup} />)}

          {doneJobs.length > 0 && (
            <div>
              <button
                className="flex items-center gap-2 text-sm text-muted-foreground w-full py-2 hover:text-foreground"
                onClick={() => setShowDone((v) => !v)}
              >
                <span>{showDone ? "▾" : "▸"}</span>
                <span>Đã hoàn thành ({doneJobs.length})</span>
              </button>
              {showDone && (
                <div className="space-y-3 mt-1">
                  {doneJobs.map((job) => <JobCard key={job.job_id} job={job} pickupId={route!.pickup} done />)}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function JobCard({ job, pickupId, done = false }: { job: PscJob; pickupId: string; done?: boolean }) {
  const pscStop = job.stops?.find((s) => s.customer_id === pickupId);
  const otherStop = job.stops?.find((s) => s.customer_id !== pickupId);
  const isPickup = pscStop?.stop_type_id === 1;

  const driverName = job.driver
    ? `${job.driver.first_name} ${job.driver.last_name}`.trim()
    : null;

  const statusInfo = JOB_STATUS[job.job_status_id] ?? { label: `#${job.job_status_id}`, variant: "outline" as const };

  return (
    <div className={`rounded-lg border p-3 space-y-2 ${done ? "opacity-50" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-mono text-muted-foreground truncate">{job.reference_number || `#${job.job_id}`}</span>
        <Badge variant={statusInfo.variant} className="shrink-0">{statusInfo.label}</Badge>
      </div>

      {driverName && (
        <div className="text-sm">🧑‍💼 <span className="font-medium">{driverName}</span></div>
      )}

      <div className="space-y-1">
        {pscStop && (
          <StopRow
            label={isPickup ? "Lấy mẫu tại đây" : "Giao đến đây"}
            stop={pscStop}
          />
        )}
        {otherStop && (
          <StopRow
            label={isPickup ? `Giao đến: ${otherStop.customer_name}` : `Lấy từ: ${otherStop.customer_name}`}
            stop={otherStop}
          />
        )}
      </div>

      <div className="text-xs text-muted-foreground">Tạo lúc {fmtTime(job.create_ts)}</div>
    </div>
  );
}

function StopRow({ label, stop }: { label: string; stop: Stop }) {
  const info = STOP_STATUS[stop.stop_status_id] ?? { label: `#${stop.stop_status_id}`, icon: "?" };
  const time = fmtTime(stop.activity_completed_ts ?? stop.activity_arrived_ts ?? stop.activity_started_ts);
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground text-xs truncate max-w-[50%]">{label}</span>
      <span className="flex items-center gap-1 text-xs shrink-0">
        <span>{info.icon}</span>
        <span>{info.label}</span>
        {time && <span className="text-muted-foreground">· {time}</span>}
      </span>
    </div>
  );
}

function Row({ label, value, icon }: { label: string; value: string; icon: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground flex items-center gap-1.5"><span>{icon}</span>{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
