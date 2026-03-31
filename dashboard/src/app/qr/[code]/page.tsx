"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useSearchParams } from "next/navigation";
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

interface TodoImage {
  image_id: number;
  image_url: string;
}

interface Todo {
  stop_todo_id: number;
  todo_type_id: number;
  description: string;
  note: string | null;
  images: TodoImage[];
}

interface Stop {
  stop_id: number;
  stop_type_id: number;
  stop_status_id: number;
  customer_id: string;
  customer_name: string;
  scheduled_delivery_ts: string | null;
  activity_started_ts: string | null;
  activity_arrived_ts: string | null;
  activity_completed_ts: string | null;
  todos: Todo[];
}

interface PscJob {
  job_id: number;
  job_status_id: number;
  reference_number: string;
  scheduled_delivery_ts: string | null;
  create_ts: string;
  driver: { first_name: string; last_name: string } | null;
  stops: Stop[];
}

const STOP_STATUS: Record<number, { label: string; icon: string; color: string }> = {
  1: { label: "Chờ",        icon: "⏳", color: "text-slate-500" },
  2: { label: "Đang đến",   icon: "🛵", color: "text-blue-600"  },
  3: { label: "Đã đến",     icon: "📍", color: "text-orange-500"},
  4: { label: "Xong",       icon: "✅", color: "text-green-600" },
  5: { label: "Thất bại",   icon: "❌", color: "text-red-500"   },
};

const JOB_STATUS_BADGE: Record<number, { label: string; cls: string }> = {
  2: { label: "Chờ tài xế",    cls: "bg-yellow-100 text-yellow-800" },
  4: { label: "Đã có tài xế",  cls: "bg-blue-100 text-blue-800"     },
  5: { label: "Hoàn thành",    cls: "bg-green-100 text-green-800"   },
  3: { label: "Thất bại",      cls: "bg-red-100 text-red-800"       },
};

function fmtTime(ts: string | null | undefined): string {
  if (!ts) return "—";
  return ts.slice(11, 16);
}

type AssignStatus = "idle" | "loading" | "success" | "error";

// Exclude jobs where ALL stops are status 1 (pending) or all are 5 (failed/rejected)
function shouldShow(job: PscJob): boolean {
  const statuses = (job.stops ?? []).map((s) => s.stop_status_id);
  if (statuses.length === 0) return false;
  if (statuses.every((s) => s === 1)) return false;
  if (statuses.every((s) => s === 5)) return false;
  return true;
}

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

  // Two separate lists — pickup leg & dropoff leg
  const [pickupJobs, setPickupJobs] = useState<PscJob[]>([]);
  const [dropoffJobs, setDropoffJobs] = useState<PscJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"pickup" | "dropoff">("pickup");

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

      const mine: PscJob[] = (data.jobs ?? []).filter((j: PscJob) =>
        j.stops?.some((s) => s.customer_id === pickupId) && shouldShow(j)
      );

      // Sort by scheduled_delivery_ts ascending
      mine.sort((a, b) => {
        const ta = a.scheduled_delivery_ts ?? a.create_ts ?? "";
        const tb = b.scheduled_delivery_ts ?? b.create_ts ?? "";
        return ta.localeCompare(tb);
      });

      // Split by whether this PSC is the pickup or dropoff stop
      setPickupJobs(mine.filter((j) => j.stops?.some((s) => s.customer_id === pickupId && s.stop_type_id === 1)));
      setDropoffJobs(mine.filter((j) => j.stops?.some((s) => s.customer_id === pickupId && s.stop_type_id === 2)));
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
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="flex items-center justify-center min-h-screen p-4">
        <div className="max-w-sm w-full rounded-xl border p-6">
          <p className="text-destructive font-semibold mb-1">Không tìm thấy</p>
          <p className="text-muted-foreground text-sm">Không có tuyến PSC cho mã <strong>{code}</strong>.</p>
        </div>
      </div>
    );
  }

  const currentJobs = activeTab === "pickup" ? pickupJobs : dropoffJobs;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">

      {/* ── Header ── */}
      <div className="bg-white border-b px-4 py-3 flex items-center justify-between">
        <div>
          <p className="text-xs text-muted-foreground">Điểm lấy mẫu</p>
          <p className="font-semibold text-sm">{route!.psc_pickup}</p>
        </div>
        {isStaging && <Badge variant="destructive">STAGING</Badge>}
      </div>

      {/* ── Request button ── */}
      <div className="bg-white border-b px-4 py-3 space-y-2">
        <Button
          className="w-full" size="lg"
          onClick={handleAssign}
          disabled={assignStatus === "loading" || assignStatus === "success"}
        >
          {assignStatus === "loading" ? "Đang gửi..." : assignStatus === "success" ? "✓ Đã gửi yêu cầu" : "📦 Yêu cầu lấy mẫu"}
        </Button>
        {assignStatus === "success" && (
          <Button variant="outline" size="sm" className="w-full" onClick={() => { setAssignStatus("idle"); setAssignResult(""); }}>
            Tạo thêm
          </Button>
        )}
        {assignStatus === "success" && (
          <p className="text-xs text-green-700 text-center">{assignResult}</p>
        )}
        {assignStatus === "error" && (
          <p className="text-xs text-red-600 text-center">{assignResult}</p>
        )}
      </div>

      {/* ── Tabs ── */}
      <div className="flex bg-white border-b">
        <TabBtn active={activeTab === "pickup"} onClick={() => setActiveTab("pickup")} count={pickupJobs.length}>
          📦 Lấy mẫu từ đây
        </TabBtn>
        <TabBtn active={activeTab === "dropoff"} onClick={() => setActiveTab("dropoff")} count={dropoffJobs.length}>
          📍 Giao đến đây
        </TabBtn>
      </div>

      {/* ── Table ── */}
      <div className="flex-1 overflow-auto">
        <div className="flex items-center justify-between px-4 py-2">
          <p className="text-xs text-muted-foreground">{currentJobs.length} chuyến hôm nay</p>
          <button
            onClick={() => route && fetchJobs(route.pickup)}
            disabled={jobsLoading}
            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            {jobsLoading ? "..." : "🔄 Làm mới"}
          </button>
        </div>

        {currentJobs.length === 0 && !jobsLoading && (
          <p className="text-sm text-muted-foreground text-center py-12">Chưa có chuyến nào</p>
        )}

        {currentJobs.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-100 sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2 font-medium text-slate-600">Giờ</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-600">Tài xế</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-600">
                    {activeTab === "pickup" ? "Giao đến" : "Lấy từ"}
                  </th>
                  <th className="text-left px-3 py-2 font-medium text-slate-600">Lấy mẫu</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-600">Giao hàng</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-600">Trạng thái</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {currentJobs.map((job) => <JobRow key={job.job_id} job={job} pickupId={route!.pickup} tab={activeTab} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, count, children }: { active: boolean; onClick: () => void; count: number; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-2 px-3 text-xs font-medium border-b-2 transition-colors ${
        active ? "border-blue-600 text-blue-700 bg-blue-50" : "border-transparent text-slate-500 hover:text-slate-700"
      }`}
    >
      {children} <span className="ml-1 rounded-full bg-slate-200 text-slate-700 px-1.5 py-0.5">{count}</span>
    </button>
  );
}

function JobRow({ job, pickupId, tab }: { job: PscJob; pickupId: string; tab: "pickup" | "dropoff" }) {
  const pscStop = job.stops?.find((s) => s.customer_id === pickupId);
  const otherStop = job.stops?.find((s) => s.customer_id !== pickupId);

  const driverLastName = job.driver?.last_name?.trim() || "—";
  const otherName = otherStop?.customer_name ?? "—";

  const pickupStop = tab === "pickup" ? pscStop : otherStop;
  const dropoffStop = tab === "pickup" ? otherStop : pscStop;

  const pickupStatus = STOP_STATUS[pickupStop?.stop_status_id ?? 1];
  const dropoffStatus = STOP_STATUS[dropoffStop?.stop_status_id ?? 1];

  const pickupPhotos = (pickupStop?.todos ?? []).flatMap((t) => t.images ?? []);
  const dropoffPhotos = (dropoffStop?.todos ?? []).flatMap((t) => t.images ?? []);

  const jobBadge = JOB_STATUS_BADGE[job.job_status_id] ?? { label: `#${job.job_status_id}`, cls: "bg-slate-100 text-slate-700" };

  const schedTime = fmtTime(job.scheduled_delivery_ts);

  return (
    <tr className="hover:bg-slate-50 align-top">
      <td className="px-3 py-2 whitespace-nowrap text-slate-500">{schedTime}</td>
      <td className="px-3 py-2 whitespace-nowrap font-medium">{driverLastName}</td>
      <td className="px-3 py-2 text-slate-600 max-w-[120px]">
        <span className="line-clamp-2">{otherName}</span>
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        <span className={`${pickupStatus.color} font-medium`}>{pickupStatus.icon} {pickupStatus.label}</span>
        {fmtTime(pickupStop?.activity_completed_ts ?? pickupStop?.activity_arrived_ts ?? pickupStop?.activity_started_ts) !== "—" && (
          <span className="block text-slate-400">{fmtTime(pickupStop?.activity_completed_ts ?? pickupStop?.activity_arrived_ts ?? pickupStop?.activity_started_ts)}</span>
        )}
        {pickupPhotos.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-0.5">
            {pickupPhotos.map((img, i) => (
              <a key={img.image_id} href={img.image_url} target="_blank" rel="noreferrer" className="text-blue-500 underline">📷{i + 1}</a>
            ))}
          </div>
        )}
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        <span className={`${dropoffStatus.color} font-medium`}>{dropoffStatus.icon} {dropoffStatus.label}</span>
        {fmtTime(dropoffStop?.activity_completed_ts ?? dropoffStop?.activity_arrived_ts ?? dropoffStop?.activity_started_ts) !== "—" && (
          <span className="block text-slate-400">{fmtTime(dropoffStop?.activity_completed_ts ?? dropoffStop?.activity_arrived_ts ?? dropoffStop?.activity_started_ts)}</span>
        )}
        {dropoffPhotos.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-0.5">
            {dropoffPhotos.map((img, i) => (
              <a key={img.image_id} href={img.image_url} target="_blank" rel="noreferrer" className="text-blue-500 underline">📷{i + 1}</a>
            ))}
          </div>
        )}
      </td>
      <td className="px-3 py-2">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${jobBadge.cls}`}>{jobBadge.label}</span>
      </td>
    </tr>
  );
}
