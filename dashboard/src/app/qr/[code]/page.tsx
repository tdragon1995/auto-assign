"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";

// ── Types ──────────────────────────────────────────────────────────────────

interface PscRoute {
  psc_pickup: string;
  dropoff_location: string;
  pickup: string;
  dropoff: string;
  ref_number: string;
  driver_id: string | null;
  driver_name: string | null;
}

interface TodoImage { image_id: number; image_url: string; }
interface Todo { stop_todo_id: number; todo_type_id: number; description: string; note: string | null; images: TodoImage[]; }

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

// ── Constants ──────────────────────────────────────────────────────────────

const STOP_STATUS: Record<number, { label: string; icon: string; color: string }> = {
  1: { label: "Chờ",       icon: "⏳", color: "text-slate-400"  },
  2: { label: "Đang đến",  icon: "🛵", color: "text-blue-600"   },
  3: { label: "Đã đến",    icon: "📍", color: "text-orange-500" },
  4: { label: "Xong",      icon: "✅", color: "text-green-600"  },
  5: { label: "Thất bại",  icon: "❌", color: "text-red-500"    },
};

const JOB_BADGE: Record<number, { label: string; cls: string }> = {
  2: { label: "Chờ điều phối", cls: "bg-yellow-100 text-yellow-800" },
  4: { label: "Đang xử lý",   cls: "bg-blue-100   text-blue-800"   },
  5: { label: "Hoàn thành",   cls: "bg-green-100  text-green-800"  },
  3: { label: "Thất bại",     cls: "bg-red-100    text-red-800"    },
};

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtTime(ts?: string | null): string {
  if (!ts) return "";
  return ts.slice(11, 16);
}

// Exclude jobs where all stops are still pending (1) or all failed (5)
function shouldShow(job: PscJob): boolean {
  const ss = (job.stops ?? []).map((s) => s.stop_status_id);
  if (!ss.length) return false;
  if (ss.every((s) => s === 1)) return false;
  if (ss.every((s) => s === 5)) return false;
  return true;
}

function tabPillCls(jobs: PscJob[]): string {
  const statuses = jobs.flatMap((j) => j.stops.map((s) => s.stop_status_id));
  if (statuses.some((s) => s === 2)) return "bg-blue-100 text-blue-700";
  if (statuses.some((s) => s === 4)) return "bg-green-100 text-green-700";
  return "bg-slate-100 text-slate-600";
}

type AssignStatus = "idle" | "loading" | "success" | "error" | "duplicate";

// ── Page ───────────────────────────────────────────────────────────────────

export default function QrPage() {
  const params = useParams<{ code: string }>();
  const searchParams = useSearchParams();
  const code = decodeURIComponent(params.code ?? "").trim();
  const isStaging = searchParams.get("env") === "uat";
  const envQuery = isStaging ? "?env=uat" : "";

  const [route, setRoute] = useState<PscRoute | null>(null);
  const [pageLoading, setPageLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [assignStatus, setAssignStatus] = useState<AssignStatus>("idle");
  const [assignRef, setAssignRef] = useState("");

  const [pickupJobs, setPickupJobs] = useState<PscJob[]>([]);
  const [dropoffJobs, setDropoffJobs] = useState<PscJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [activeTab, setActiveTab] = useState<"pickup" | "dropoff">("pickup");

  useEffect(() => {
    fetch("/api/psc-routes")
      .then((r) => r.json())
      .then((d) => {
        const match = (d.data ?? []).find((r: PscRoute) => r.pickup === code);
        if (match) setRoute(match); else setNotFound(true);
        setPageLoading(false);
      })
      .catch(() => { setNotFound(true); setPageLoading(false); });
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
      // Active jobs (not completed) first, then completed — each group sorted by scheduled time
      const sortFn = (a: PscJob, b: PscJob) =>
        (a.scheduled_delivery_ts ?? a.create_ts ?? "").localeCompare(b.scheduled_delivery_ts ?? b.create_ts ?? "");
      const active = mine.filter((j) => j.job_status_id !== 5).sort(sortFn);
      const done = mine.filter((j) => j.job_status_id === 5).sort(sortFn);
      const sorted = [...active, ...done];

      setPickupJobs(sorted.filter((j) => j.stops.some((s) => s.customer_id === pickupId && s.stop_type_id === 1)));
      setDropoffJobs(sorted.filter((j) => j.stops.some((s) => s.customer_id === pickupId && s.stop_type_id === 2)));
      setLastUpdated(new Date());
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
        setAssignRef(data.reference);
        setActiveTab("pickup");
        fetchJobs(route.pickup);
      } else if (res.status === 409) {
        setAssignStatus("duplicate");
        setActiveTab("pickup");
        fetchJobs(route.pickup);
      } else {
        setAssignStatus("error");
        setAssignRef(data.error || "Lỗi không xác định");
      }
    } catch (e) {
      setAssignStatus("error");
      setAssignRef(String(e));
    }
  };

  if (pageLoading) return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
    </div>
  );

  if (notFound) return (
    <div className="flex items-center justify-center min-h-screen p-4">
      <div className="max-w-sm w-full rounded-xl border p-6 bg-white">
        <p className="font-semibold text-red-600 mb-1">Không tìm thấy</p>
        <p className="text-sm text-slate-500">Không có điểm PSC nào cho mã này.</p>
      </div>
    </div>
  );

  const currentJobs = activeTab === "pickup" ? pickupJobs : dropoffJobs;
  const hasActiveDriver = pickupJobs.some((j) => j.job_status_id === 4 && j.stops.some((s) => s.stop_status_id === 2));
  const allPickupsDone = pickupJobs.length > 0 && pickupJobs.every((j) => j.job_status_id === 5);
  const showRequestBtn = assignStatus !== "success" && assignStatus !== "duplicate";

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">

      {/* ── Sticky header ── */}
      <div className="sticky top-0 z-20 bg-white border-b px-4 py-2.5 flex items-center justify-between shadow-sm">
        <div>
          <p className="text-[11px] text-slate-400 uppercase tracking-wide">Điểm lấy mẫu</p>
          <p className="font-bold text-sm leading-tight">{route!.psc_pickup}</p>
        </div>
        <div className="flex items-center gap-2">
          {isStaging && <span className="text-[10px] font-bold bg-red-100 text-red-700 px-2 py-0.5 rounded-full">STAGING</span>}
          <button
            onClick={() => route && fetchJobs(route.pickup)}
            disabled={jobsLoading}
            className="size-8 flex items-center justify-center rounded-full hover:bg-slate-100 disabled:opacity-40 transition-colors"
          >
            <span className={jobsLoading ? "animate-spin inline-block" : ""}>🔄</span>
          </button>
        </div>
      </div>

      {/* ── Banners ── */}
      {assignStatus === "success" && (
        <div className="bg-green-50 border-b border-green-200 px-4 py-3 flex items-start gap-3">
          <span className="text-lg">✅</span>
          <div className="flex-1">
            <p className="text-sm font-semibold text-green-800">Đã đặt Giao Nhận Mẫu thành công</p>
            <p className="text-xs text-green-700">Vui lòng chuẩn bị mẫu sẵn sàng</p>
          </div>
          <button onClick={() => { setAssignStatus("idle"); setAssignRef(""); }} className="text-xs text-green-700 underline shrink-0 mt-0.5">Đặt thêm</button>
        </div>
      )}
      {assignStatus === "duplicate" && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-3 flex items-start gap-3">
          <span className="text-lg">⚠️</span>
          <div>
            <p className="text-sm font-semibold text-amber-800">Đã có yêu cầu hôm nay rồi</p>
            <p className="text-xs text-amber-700">Xem trạng thái bên dưới</p>
          </div>
        </div>
      )}
      {assignStatus === "error" && (
        <div className="bg-red-50 border-b border-red-200 px-4 py-3 flex items-start gap-2">
          <span className="text-lg">❌</span>
          <p className="text-sm text-red-700">{assignRef || "Lỗi không xác định. Vui lòng thử lại."}</p>
        </div>
      )}
      {hasActiveDriver && assignStatus === "idle" && (
        <div className="bg-blue-50 border-b border-blue-200 px-4 py-3 flex items-center gap-3">
          <span className="relative flex size-2.5 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex rounded-full size-2.5 bg-blue-500" />
          </span>
          <p className="text-sm font-medium text-blue-800">🛵 Giao Nhận Mẫu đang đến lấy mẫu — chuẩn bị sẵn nhé!</p>
        </div>
      )}
      {allPickupsDone && assignStatus === "idle" && (
        <div className="bg-green-50 border-b border-green-200 px-4 py-3 flex items-center gap-2">
          <span>✅</span>
          <p className="text-sm font-medium text-green-800">Tất cả mẫu đã được lấy hôm nay</p>
        </div>
      )}

      {/* ── Request button ── */}
      {showRequestBtn && (
        <div className="bg-white border-b px-4 py-3">
          <Button
            className="w-full h-12 text-base font-semibold"
            onClick={handleAssign}
            disabled={assignStatus === "loading"}
          >
            {assignStatus === "loading" ? "Đang gửi..." : "🛵 Đặt Giao Nhận Mẫu"}
          </Button>
          <p className="text-[11px] text-slate-400 text-center mt-1.5">
            Mẫu sẽ được giao đến <span className="font-medium text-slate-600">{route!.dropoff_location}</span>
          </p>
        </div>
      )}

      {/* ── Tabs ── */}
      <div className="sticky top-[53px] z-10 flex bg-white border-b shadow-sm">
        {(["pickup", "dropoff"] as const).map((tab) => {
          const jobs = tab === "pickup" ? pickupJobs : dropoffJobs;
          const label = tab === "pickup" ? "🛵 Giao Nhận Mẫu đến lấy" : "📥 Mẫu giao đến PSC";
          const pillCls = tabPillCls(jobs);
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 py-2.5 px-2 text-xs font-medium border-b-2 transition-colors flex items-center justify-center gap-1.5 ${
                activeTab === tab
                  ? "border-primary text-primary bg-blue-50/50"
                  : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
            >
              {label}
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${pillCls}`}>{jobs.length}</span>
            </button>
          );
        })}
      </div>

      {/* ── Last updated ── */}
      <div className="px-4 pt-2 pb-1 flex items-center justify-between">
        <p className="text-[11px] text-slate-400">
          {lastUpdated
            ? `Cập nhật lúc ${lastUpdated.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
            : "Đang tải..."}
        </p>
        <p className="text-[11px] text-slate-400">Tự động làm mới mỗi 30s</p>
      </div>

      {/* ── Job cards ── */}
      <div className="flex-1 px-4 pb-6 space-y-3">
        {currentJobs.length === 0 && !jobsLoading && (
          <div className="flex flex-col items-center justify-center py-16 text-center gap-2">
            <p className="text-4xl">{activeTab === "pickup" ? "🛵" : "📥"}</p>
            <p className="text-sm text-slate-500 max-w-[240px] leading-relaxed">
              {activeTab === "pickup"
                ? "Chưa có Giao Nhận Mẫu nào hôm nay.\nBấm nút bên trên để đặt."
                : "Hôm nay chưa có mẫu nào được giao đến PSC này."}
            </p>
          </div>
        )}
        {currentJobs.map((job) => (
          <JobCard key={job.job_id} job={job} pickupId={route!.pickup} tab={activeTab} />
        ))}
      </div>
    </div>
  );
}

// ── JobCard ────────────────────────────────────────────────────────────────

function JobCard({ job, pickupId, tab }: { job: PscJob; pickupId: string; tab: "pickup" | "dropoff" }) {
  const pscStop = job.stops?.find((s) => s.customer_id === pickupId);
  const otherStop = job.stops?.find((s) => s.customer_id !== pickupId);
  const pickupStop = tab === "pickup" ? pscStop : otherStop;
  const dropoffStop = tab === "pickup" ? otherStop : pscStop;

  const isDone = job.job_status_id === 5;
  const driverLastName = job.driver?.last_name?.trim() || null;
  const otherName = otherStop?.customer_name ?? "—";
  const schedTime = fmtTime(job.scheduled_delivery_ts);
  const badge = JOB_BADGE[job.job_status_id] ?? { label: "—", cls: "bg-slate-100 text-slate-700" };

  const pickupSt = STOP_STATUS[pickupStop?.stop_status_id ?? 1];
  const dropoffSt = STOP_STATUS[dropoffStop?.stop_status_id ?? 1];

  const pickupPhotos = (pickupStop?.todos ?? []).flatMap((t) => t.images ?? []);
  const dropoffPhotos = (dropoffStop?.todos ?? []).flatMap((t) => t.images ?? []);

  const isEnRoute = pscStop?.stop_status_id === 2;

  return (
    <div className={`bg-white rounded-xl border shadow-sm overflow-hidden ${isDone ? "opacity-60" : ""}`}>

      {/* ── Header row ── */}
      <div className="px-4 pt-3 pb-2 flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            {isEnRoute && (
              <span className="relative flex size-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full size-2 bg-blue-500" />
              </span>
            )}
            <p className="text-sm font-semibold text-slate-800">
              {driverLastName ? `Giao Nhận Mẫu: ${driverLastName}` : "Chờ điều phối"}
            </p>
          </div>
          {/* Other location — the answer to "from where / going where" */}
          <p className="text-xs text-slate-500 truncate">
            {tab === "pickup" ? `Đến: ${otherName}` : `Từ: ${otherName}`}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.cls}`}>{badge.label}</span>
          {schedTime && <span className="text-[11px] text-slate-400 tabular-nums">{schedTime}</span>}
        </div>
      </div>

      <div className="border-t border-slate-100 mx-4" />

      {/* ── Stop statuses ── */}
      <div className="px-4 py-2.5 space-y-2.5">
        <StopLine
          label={tab === "pickup" ? "Lấy mẫu tại đây" : otherStop?.customer_name ?? "Điểm lấy"}
          stop={pickupStop}
          statusInfo={pickupSt}
        />
        <StopLine
          label={tab === "pickup" ? (otherStop?.customer_name ?? "Điểm đến") : "Giao đến đây"}
          stop={dropoffStop}
          statusInfo={dropoffSt}
        />
      </div>

      {/* ── Photos ── */}
      {(pickupPhotos.length > 0 || dropoffPhotos.length > 0) && (
        <div className="px-4 pb-3 space-y-2 border-t border-slate-100 pt-2.5">
          {pickupPhotos.length > 0 && (
            <div>
              <p className="text-[11px] text-slate-400 mb-1.5">📸 Ảnh khi lấy mẫu</p>
              <div className="flex gap-2 overflow-x-auto pb-0.5">
                {pickupPhotos.map((img) => (
                  <a key={img.image_id} href={img.image_url} target="_blank" rel="noreferrer" className="shrink-0">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img.image_url} alt="" className="size-16 rounded-lg object-cover border border-slate-200" />
                  </a>
                ))}
              </div>
            </div>
          )}
          {dropoffPhotos.length > 0 && (
            <div>
              <p className="text-[11px] text-slate-400 mb-1.5">📸 Ảnh khi giao mẫu</p>
              <div className="flex gap-2 overflow-x-auto pb-0.5">
                {dropoffPhotos.map((img) => (
                  <a key={img.image_id} href={img.image_url} target="_blank" rel="noreferrer" className="shrink-0">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img.image_url} alt="" className="size-16 rounded-lg object-cover border border-slate-200" />
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── StopLine ───────────────────────────────────────────────────────────────

function StopLine({ label, stop, statusInfo }: {
  label: string;
  stop: Stop | undefined;
  statusInfo: { label: string; icon: string; color: string };
}) {
  const time = fmtTime(stop?.activity_completed_ts ?? stop?.activity_arrived_ts ?? stop?.activity_started_ts);
  return (
    <div className="flex items-center justify-between gap-2">
      <p className="text-xs text-slate-600 truncate max-w-[55%] font-medium">{label}</p>
      <div className="flex items-center gap-1 shrink-0">
        <span className={`text-xs font-semibold ${statusInfo.color}`}>{statusInfo.icon} {statusInfo.label}</span>
        {time && <span className="text-[11px] text-slate-400 tabular-nums">· {time}</span>}
      </div>
    </div>
  );
}
