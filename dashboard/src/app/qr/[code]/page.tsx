"use client";

import { useEffect, useState, useCallback, useRef } from "react";
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

// stop_status_id descriptions (from Cartrack)
const STOP_STATUS: Record<number, { label: string; color: string }> = {
  1: { label: "Tạo",          color: "text-slate-400"  },
  2: { label: "Đang di chuyển", color: "text-blue-600" },
  3: { label: "Tới Nơi",      color: "text-orange-500" },
  4: { label: "Hoàn Thành",   color: "text-green-600"  },
  5: { label: "Hủy",          color: "text-red-500"    },
};

const JOB_BADGE: Record<number, { label: string; cls: string }> = {
  2: { label: "Chờ điều phối", cls: "bg-yellow-100 text-yellow-700" },
  4: { label: "Đang xử lý",   cls: "bg-blue-100   text-blue-700"   },
  5: { label: "Hoàn Thành",   cls: "bg-green-100  text-green-700"  },
  3: { label: "Hủy",          cls: "bg-red-100    text-red-700"    },
};

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtTime(ts?: string | null): string {
  if (!ts) return "";
  return ts.slice(11, 16);
}

function shouldShow(job: PscJob): boolean {
  const ss = (job.stops ?? []).map((s) => s.stop_status_id);
  if (!ss.length) return false;
  // Only hide if all stops are Hủy (5) — pending jobs (all status 1) must still show
  if (ss.every((s) => s === 5)) return false;
  return true;
}

function tabPillCls(jobs: PscJob[]): string {
  const statuses = jobs.flatMap((j) => j.stops.map((s) => s.stop_status_id));
  if (statuses.some((s) => s === 2 || s === 3)) return "bg-blue-100 text-blue-700";
  if (statuses.some((s) => s === 4)) return "bg-green-100 text-green-700";
  return "bg-slate-100 text-slate-500";
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

  // Photo lightbox
  const [lightbox, setLightbox] = useState<string | null>(null);

  // Shared jobs cache so the periodic refresh reuses the same fetch
  const jobsCacheRef = useRef<PscJob[] | null>(null);

  const filterAndSetJobs = useCallback((allJobs: PscJob[], pickupId: string) => {
    const mine = allJobs.filter((j) =>
      j.stops?.some((s) => s.customer_id === pickupId) && shouldShow(j)
    );
    const sortFn = (a: PscJob, b: PscJob) =>
      (a.scheduled_delivery_ts ?? a.create_ts ?? "").localeCompare(b.scheduled_delivery_ts ?? b.create_ts ?? "");
    const active = mine.filter((j) => j.job_status_id !== 5).sort(sortFn);
    const done   = mine.filter((j) => j.job_status_id === 5).sort(sortFn);
    const sorted = [...active, ...done];
    setPickupJobs(sorted.filter((j) => j.stops.some((s) => s.customer_id === pickupId && s.stop_type_id === 1)));
    setDropoffJobs(sorted.filter((j) => j.stops.some((s) => s.customer_id === pickupId && s.stop_type_id === 2)));
    setLastUpdated(new Date());
  }, []);

  const fetchJobs = useCallback(async (pickupId: string) => {
    setJobsLoading(true);
    try {
      const res = await fetch(`/api/psc-jobs${envQuery}`);
      if (!res.ok) return;
      const data = await res.json();
      const allJobs: PscJob[] = data.jobs ?? [];
      jobsCacheRef.current = allJobs;
      filterAndSetJobs(allJobs, pickupId);
    } finally {
      setJobsLoading(false);
    }
  }, [envQuery, filterAndSetJobs]);

  // Fetch routes and jobs in parallel on mount
  useEffect(() => {
    const routesPromise = fetch("/api/psc-routes").then((r) => r.json());
    const jobsPromise = fetch(`/api/psc-jobs${envQuery}`).then((r) => r.json());

    Promise.all([routesPromise, jobsPromise])
      .then(([routesData, jobsData]) => {
        const match = (routesData.data ?? []).find((r: PscRoute) => r.pickup === code);
        if (!match) { setNotFound(true); setPageLoading(false); return; }
        setRoute(match);
        setPageLoading(false);
        const allJobs: PscJob[] = jobsData.jobs ?? [];
        jobsCacheRef.current = allJobs;
        filterAndSetJobs(allJobs, match.pickup);
      })
      .catch(() => { setNotFound(true); setPageLoading(false); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  useEffect(() => {
    if (!route) return;
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
  const hasActiveDriver = pickupJobs.some((j) => j.job_status_id === 4 && j.stops.some((s) => s.stop_status_id === 2 || s.stop_status_id === 3));
  const allPickupsDone = pickupJobs.length > 0 && pickupJobs.every((j) => j.job_status_id === 5);
  const showRequestBtn = assignStatus !== "success" && assignStatus !== "duplicate";

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col text-sm">

      {/* Lightbox overlay */}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setLightbox(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox} alt="" className="max-w-full max-h-full rounded-lg" />
        </div>
      )}

      {/* ── Sticky header ── */}
      <div className="sticky top-0 z-20 bg-white border-b px-3 py-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div>
            <p className="font-bold text-sm leading-none">{route!.psc_pickup}</p>
            <p className="text-[10px] text-slate-400 mt-0.5">→ {route!.dropoff_location}</p>
          </div>
          {isStaging && <span className="text-[10px] font-bold bg-red-100 text-red-700 px-1.5 py-0.5 rounded">STAGING</span>}
        </div>
        <button
          onClick={() => route && fetchJobs(route.pickup)}
          disabled={jobsLoading}
          className="size-7 flex items-center justify-center rounded-full hover:bg-slate-100 disabled:opacity-40"
        >
          <span className={jobsLoading ? "animate-spin inline-block text-xs" : "text-xs"}>🔄</span>
        </button>
      </div>

      {/* ── Banners ── */}
      {assignStatus === "success" && (
        <div className="bg-green-50 border-b border-green-200 px-3 py-2 flex items-center justify-between gap-2">
          <p className="text-xs text-green-800 font-medium">✅ Đã đặt Giao Nhận Mẫu — chuẩn bị mẫu sẵn sàng</p>
          <button onClick={() => { setAssignStatus("idle"); setAssignRef(""); }} className="text-[11px] text-green-700 underline shrink-0">Đặt thêm</button>
        </div>
      )}
      {assignStatus === "duplicate" && (
        <div className="bg-amber-50 border-b border-amber-200 px-3 py-2">
          <p className="text-xs text-amber-800 font-medium">⚠️ Đã có yêu cầu hôm nay — xem bên dưới</p>
        </div>
      )}
      {assignStatus === "error" && (
        <div className="bg-red-50 border-b border-red-200 px-3 py-2">
          <p className="text-xs text-red-700">❌ {assignRef || "Lỗi không xác định. Vui lòng thử lại."}</p>
        </div>
      )}
      {hasActiveDriver && assignStatus === "idle" && (
        <div className="bg-blue-50 border-b border-blue-200 px-3 py-2 flex items-center gap-2">
          <span className="relative flex size-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex rounded-full size-2 bg-blue-500" />
          </span>
          <p className="text-xs font-medium text-blue-800">🛵 Giao Nhận Mẫu đang đến — chuẩn bị sẵn nhé!</p>
        </div>
      )}
      {allPickupsDone && assignStatus === "idle" && (
        <div className="bg-green-50 border-b border-green-200 px-3 py-2">
          <p className="text-xs font-medium text-green-800">✅ Tất cả mẫu đã được lấy hôm nay</p>
        </div>
      )}

      {/* ── Request button ── */}
      {showRequestBtn && (
        <div className="bg-white border-b px-3 py-2">
          <Button className="w-full h-10 font-semibold" onClick={handleAssign} disabled={assignStatus === "loading"}>
            {assignStatus === "loading" ? "Đang gửi..." : "🛵 Đặt Giao Nhận Mẫu"}
          </Button>
        </div>
      )}

      {/* ── Tabs ── */}
      <div className="sticky top-[41px] z-10 flex bg-white border-b">
        {(["pickup", "dropoff"] as const).map((tab) => {
          const jobs = tab === "pickup" ? pickupJobs : dropoffJobs;
          const label = tab === "pickup" ? "🛵 GNM đến lấy" : "📥 Mẫu đến PSC";
          const pillCls = tabPillCls(jobs);
          return (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className={`flex-1 py-2 px-2 text-xs font-medium border-b-2 flex items-center justify-center gap-1 ${
                activeTab === tab ? "border-primary text-primary" : "border-transparent text-slate-500"
              }`}
            >
              {label}
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${pillCls}`}>{jobs.length}</span>
            </button>
          );
        })}
      </div>

      {/* ── Table ── */}
      <div className="flex-1 overflow-auto">
        {/* Column headers */}
        {currentJobs.length > 0 && (
          <div className="grid grid-cols-[1fr_1fr_auto] gap-x-2 px-3 pt-2 pb-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wide border-b bg-slate-50">
            <span>{activeTab === "pickup" ? "Lấy mẫu" : "Lấy từ"}</span>
            <span>{activeTab === "pickup" ? "Giao đến" : "Giao tới đây"}</span>
            <span>GNM</span>
          </div>
        )}

        {currentJobs.length === 0 && !jobsLoading && (
          <div className="flex flex-col items-center justify-center py-12 text-center gap-1">
            <p className="text-2xl">{activeTab === "pickup" ? "🛵" : "📥"}</p>
            <p className="text-xs text-slate-400 max-w-[200px] leading-relaxed">
              {activeTab === "pickup"
                ? "Chưa có chuyến nào. Bấm nút bên trên để đặt."
                : "Hôm nay chưa có mẫu nào giao đến đây."}
            </p>
          </div>
        )}

        <div className="divide-y divide-slate-100">
          {currentJobs.map((job) => (
            <JobRow key={job.job_id} job={job} pickupId={route!.pickup} tab={activeTab} onPhoto={setLightbox} />
          ))}
        </div>

        {lastUpdated && (
          <p className="text-center text-[10px] text-slate-300 py-3">
            Cập nhật {lastUpdated.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · tự động mỗi 30s
          </p>
        )}
      </div>
    </div>
  );
}

// ── JobRow ─────────────────────────────────────────────────────────────────

function JobRow({ job, pickupId, tab, onPhoto }: {
  job: PscJob;
  pickupId: string;
  tab: "pickup" | "dropoff";
  onPhoto: (url: string) => void;
}) {
  const pscStop   = job.stops?.find((s) => s.customer_id === pickupId);
  const otherStop = job.stops?.find((s) => s.customer_id !== pickupId);
  const pickupStop  = tab === "pickup" ? pscStop   : otherStop;
  const dropoffStop = tab === "pickup" ? otherStop : pscStop;

  const isDone        = job.job_status_id === 5;
  const driverLastName = job.driver?.last_name?.trim() || "—";
  const badge         = JOB_BADGE[job.job_status_id] ?? { label: "—", cls: "bg-slate-100 text-slate-600" };
  const isEnRoute     = pscStop?.stop_status_id === 2 || pscStop?.stop_status_id === 3;

  const pickupSt  = STOP_STATUS[pickupStop?.stop_status_id  ?? 1];
  const dropoffSt = STOP_STATUS[dropoffStop?.stop_status_id ?? 1];

  const pickupTime  = fmtTime(pickupStop?.activity_completed_ts  ?? pickupStop?.activity_arrived_ts  ?? pickupStop?.activity_started_ts);
  const dropoffTime = fmtTime(dropoffStop?.activity_completed_ts ?? dropoffStop?.activity_arrived_ts ?? dropoffStop?.activity_started_ts);

  const allPhotos = (job.stops ?? []).flatMap((s) => (s.todos ?? []).flatMap((t) => t.images ?? []));

  return (
    <div className={`px-3 py-2.5 ${isDone ? "bg-slate-50/60" : "bg-white"}`}>
      {/* Row: 2 stop columns + driver column */}
      <div className="grid grid-cols-[1fr_1fr_auto] gap-x-2 items-start">

        {/* Pickup stop */}
        <div>
          <p className="text-[11px] font-medium text-slate-700 leading-tight truncate">
            {pickupStop?.customer_name ?? "—"}
          </p>
          <p className={`text-[11px] font-semibold mt-0.5 ${pickupSt.color}`}>
            {pickupSt.label}
            {pickupTime && <span className="text-slate-400 font-normal ml-1">{pickupTime}</span>}
          </p>
        </div>

        {/* Dropoff stop */}
        <div>
          <p className="text-[11px] font-medium text-slate-700 leading-tight truncate">
            {dropoffStop?.customer_name ?? "—"}
          </p>
          <p className={`text-[11px] font-semibold mt-0.5 ${dropoffSt.color}`}>
            {dropoffSt.label}
            {dropoffTime && <span className="text-slate-400 font-normal ml-1">{dropoffTime}</span>}
          </p>
        </div>

        {/* Driver + badge */}
        <div className="flex flex-col items-end gap-1 min-w-[72px]">
          {isEnRoute && (
            <span className="relative flex size-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full size-1.5 bg-blue-500" />
            </span>
          )}
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${badge.cls}`}>{badge.label}</span>
          <span className="text-[11px] text-slate-500 text-right">{driverLastName}</span>
        </div>
      </div>

      {/* Photos — only if present, shown as small tappable thumbnails */}
      {allPhotos.length > 0 && (
        <div className="flex gap-1.5 mt-1.5 overflow-x-auto">
          {allPhotos.map((img) => (
            <button key={img.image_id} onClick={() => onPhoto(img.image_url)} className="shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.image_url} alt="" className="size-10 rounded object-cover border border-slate-200" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
