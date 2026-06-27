"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
// PSC routes are a hard-coded constant ([[psc-routes-data]]); look up directly instead of
// fetching /api/psc-routes — no function invocation, no network round-trip, instant render.
import { PSC_ROUTES } from "@/lib/psc-routes-data";

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
  todos?: {
    todo_type_id: number;
    description?: string;
    note?: string;
    images?: { image_id: number; image_url: string; is_deleted: boolean }[];
  }[];
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

const STOP_TYPE: Record<number, string> = { 1: "Lấy", 2: "Giao", 3: "Giao hàng" };

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
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date()).slice(0, 10);
}

function TodoItem({ todo }: { todo: Stop["todos"] extends (infer T)[] | undefined ? T : never }) {
  const [expanded, setExpanded] = useState(false);
  if (!todo) return null;

  const emoji = TODO_EMOJI[todo.todo_type_id];
  if (!emoji) return null;

  const images = (todo.images ?? []).filter((img) => !img.is_deleted);
  const hasImages = images.length > 0;
  const isNote = todo.todo_type_id === 5;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        {hasImages ? (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-sm active:opacity-70"
          >
            <span>{emoji}</span>
            <span className="text-[11px] text-slate-500">×{images.length}</span>
            <span className="text-[10px] text-blue-400">{expanded ? "▲" : "▼"}</span>
          </button>
        ) : (
          <span className="text-sm">{emoji}</span>
        )}
        {isNote && todo.note && (
          <span className="text-xs text-slate-600 italic">{todo.note}</span>
        )}
      </div>
      {expanded && hasImages && (
        <div className="grid grid-cols-2 gap-1.5 mt-1">
          {images.map((img) => (
            <a key={img.image_id} href={img.image_url} target="_blank" rel="noopener noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.image_url}
                alt=""
                className="w-full rounded-lg object-cover aspect-square border border-slate-200"
              />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// Compact stop tile — truncated name, status, timestamp, chevron hint
function StopTile({ stop, onClick }: { stop: Stop; onClick: () => void }) {
  const s = STOP_STATUS[stop.stop_status_id] ?? { label: "?", color: "bg-slate-100 text-slate-600" };
  const ts = latestTs(stop);

  return (
    <button
      onClick={onClick}
      className="w-full text-left rounded-lg border border-slate-100 bg-slate-50 px-2.5 py-2 space-y-1 active:bg-slate-100 transition-colors"
    >
      <div className="flex items-center justify-between gap-1">
        <span className="text-[10px] font-semibold text-slate-400 uppercase">{STOP_TYPE[stop.stop_type_id] ?? "Stop"}</span>
        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-md ${s.color}`}>{s.label}</span>
      </div>
      <div className="flex items-center justify-between gap-1">
        <p className="text-xs font-semibold text-slate-800 leading-tight truncate" title={stop.customer_name}>{stop.customer_name}</p>
        <span className="text-slate-300 text-xs flex-shrink-0">›</span>
      </div>
      {ts && <p className="text-[10px] text-slate-400">{fmtTs(ts)}</p>}
    </button>
  );
}

// Full stop detail block used inside the job sheet
function StopDetail({ stop }: { stop: Stop }) {
  const s = STOP_STATUS[stop.stop_status_id] ?? { label: "?", color: "bg-slate-100 text-slate-600" };
  const todos = (stop.todos ?? []).filter((t) => TODO_EMOJI[t.todo_type_id]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold text-slate-400 uppercase">{STOP_TYPE[stop.stop_type_id] ?? "Stop"}</p>
          <p className="text-sm font-bold text-slate-800">{stop.customer_name}</p>
        </div>
        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-md whitespace-nowrap ${s.color}`}>{s.label}</span>
      </div>
      {stop.address_line_1 && (
        <p className="text-xs text-slate-500">{stop.address_line_1}</p>
      )}
      {(stop.activity_started_ts || stop.activity_arrived_ts || stop.activity_completed_ts) && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
          {stop.activity_started_ts   && <span>Bắt đầu <span className="font-semibold text-slate-700">{fmtTs(stop.activity_started_ts)}</span></span>}
          {stop.activity_arrived_ts   && <span>Đến <span className="font-semibold text-slate-700">{fmtTs(stop.activity_arrived_ts)}</span></span>}
          {stop.activity_completed_ts && <span>Xong <span className="font-semibold text-slate-700">{fmtTs(stop.activity_completed_ts)}</span></span>}
        </div>
      )}
      {todos.length > 0 && (
        <div className="space-y-1.5 pt-0.5">
          {todos.map((t) => <TodoItem key={t.todo_type_id} todo={t} />)}
        </div>
      )}
    </div>
  );
}

// Bottom sheet showing full job (both stops, driver, ref) — tap backdrop or Đóng to close
function JobSheet({ job, onClose }: { job: Job; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-5 space-y-4 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-bold text-slate-800">Giao Nhận Mẫu: {driverName(job)}</p>
          <p className="text-[10px] text-slate-400 text-right break-all max-w-[55%]">{job.reference_number}</p>
        </div>
        {job.stops.map((s, i) => (
          <div key={s.stop_id} className={i > 0 ? "pt-3 border-t border-slate-100" : ""}>
            <StopDetail stop={s} />
          </div>
        ))}
        <button
          onClick={onClose}
          className="w-full py-2.5 rounded-xl text-sm font-semibold border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
        >
          Đóng
        </button>
      </div>
    </div>
  );
}

function JobCard({ job, code, onCancel }: {
  job: Job;
  code: string;
  onCancel: (t: { job_id: number; reference: string }) => void;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const isSingleStop = job.stops.length === 1;

  // Cancellable while this location's pickup hasn't been started by the driver.
  const pickup = job.stops.find((s) => s.stop_type_id === 1);
  const cancellable =
    !!pickup &&
    pickup.customer_id === code &&
    pickup.stop_status_id === 1 &&
    !pickup.activity_started_ts &&
    !pickup.activity_arrived_ts &&
    !pickup.activity_completed_ts;

  return (
    <>
      <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm space-y-2">
        <div className={`grid gap-2 ${isSingleStop ? "grid-cols-1" : "grid-cols-2"}`}>
          {job.stops.map((s) => (
            <StopTile key={s.stop_id} stop={s} onClick={() => setSheetOpen(true)} />
          ))}
        </div>
        {cancellable && (
          <button
            onClick={() => onCancel({ job_id: job.job_id, reference: job.reference_number })}
            className="w-full py-2 rounded-lg text-xs font-bold text-red-600 border border-red-200 hover:bg-red-50 active:bg-red-100 transition-colors"
          >
            Huỷ chuyến
          </button>
        )}
      </div>
      {sheetOpen && <JobSheet job={job} onClose={() => setSheetOpen(false)} />}
    </>
  );
}

export default function QrPage() {
  const params = useParams<{ code: string }>();
  const searchParams = useSearchParams();
  const code = decodeURIComponent(params.code ?? "").trim();
  const isStaging = searchParams.get("env") === "uat";
  const envParam = isStaging ? "?env=uat" : "";

  const route = useMemo(() => PSC_ROUTES.find((r) => r.pickup === code) ?? null, [code]);
  const notFound = !route;

  const [assignStatus, setAssignStatus] = useState<Status>("idle");
  const [assignResult, setAssignResult] = useState<string>("");
  const [lastCreated, setLastCreated] = useState<{ job_id: number; reference: string } | null>(null);

  const [cancelTarget, setCancelTarget] = useState<{ job_id: number; reference: string } | null>(null);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelError, setCancelError] = useState("");

  const [tab, setTab] = useState<TabType | null>(null);
  const [date, setDate] = useState(todayVN());
  const [activeJobs, setActiveJobs] = useState<Job[]>([]);
  const [doneJobs, setDoneJobs] = useState<Job[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [search, setSearch] = useState("");

  // Locations that don't accept self-requests open straight to the "Đang giao" tab.
  useEffect(() => {
    if (route?.no_request) setTab("active");
  }, [route]);

  const filterByLocation = useCallback(
    (jobs: Job[]) => jobs.filter((j) => (j.stops ?? []).some((s) => s.customer_id === code)),
    [code]
  );

  const loadJobs = useCallback(async (status: 4 | 5) => {
    setJobsLoading(true);
    try {
      const res = await fetch(`/api/location-jobs?date=${date}&status=${status}`);
      const data = await res.json();
      const filtered = filterByLocation(data.jobs ?? []);
      // Sort by latest stop activity timestamp, most recent first
      filtered.sort((a, b) => {
        const tsA = a.stops.map((s) => latestTs(s)).filter(Boolean).sort().at(-1) ?? "";
        const tsB = b.stops.map((s) => latestTs(s)).filter(Boolean).sort().at(-1) ?? "";
        return tsB.localeCompare(tsA);
      });
      if (status === 4) setActiveJobs(filtered);
      else setDoneJobs(filtered);
    } catch {
      if (status === 4) setActiveJobs([]);
      else setDoneJobs([]);
    } finally {
      setJobsLoading(false);
    }
  }, [date, filterByLocation]);

  // Load when tab switches or date changes
  useEffect(() => {
    if (tab === "active") loadJobs(4);
    else if (tab === "done") loadJobs(5);
  }, [tab, loadJobs]);

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
          via_pickup: route.via_pickup,
          via_pickup_name: route.via_pickup_name,
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setAssignStatus("success");
        setAssignResult(`Job submitted → ${data.reference}`);
        setLastCreated(data.job_id ? { job_id: data.job_id, reference: data.reference } : null);
      } else if (res.status === 409) {
        setAssignStatus("error");
        setAssignResult(
          data.job_id
            ? `Job #${data.job_id}${data.reference_number ? ` (${data.reference_number})` : ""}: Đơn liền trước chưa nhận mẫu, vui lòng chờ thêm hoặc liên hệ đội điều phối. Xin cám ơn!`
            : (data.message ?? "Đang xử lý yêu cầu, vui lòng đợi.")
        );
      } else {
        setAssignStatus("error");
        setAssignResult(data.error || "Unknown error");
      }
    } catch (e) {
      setAssignStatus("error");
      setAssignResult(String(e));
    }
  };

  const handleCancel = async () => {
    if (!cancelTarget) return;
    setCancelLoading(true);
    setCancelError("");
    try {
      const sep = envParam ? "&" : "?";
      const res = await fetch(`/api/psc-assign${envParam}${sep}job_id=${cancelTarget.job_id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setCancelError(data.error ?? "Huỷ thất bại");
        return;
      }
      // If we just cancelled the request we created, reset the create form.
      if (lastCreated?.job_id === cancelTarget.job_id) {
        setAssignStatus("idle");
        setAssignResult("");
        setLastCreated(null);
      }
      setCancelTarget(null);
      // Refresh the open jobs tab so the cancelled trip drops off.
      if (tab === "active") loadJobs(4);
      else if (tab === "done") loadJobs(5);
    } catch {
      setCancelError("Không thể kết nối. Vui lòng thử lại.");
    } finally {
      setCancelLoading(false);
    }
  };

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

  const baseJobs = tab === "active" ? activeJobs : tab === "done" ? doneJobs : [];
  const displayJobs = search.trim()
    ? baseJobs.filter((j) =>
        j.stops.some((s) => s.customer_name.toLowerCase().includes(search.toLowerCase()))
      )
    : baseJobs;

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col items-center p-4 gap-4">

      {/* Single card */}
      <div className="w-full max-w-sm bg-white rounded-2xl shadow border overflow-hidden">

        {/* Header */}
        <div className="px-6 pt-5 pb-4">
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">PSC Transport</p>
          <h1 className="text-xl font-bold text-slate-800 mt-0.5 flex items-center gap-2">
            {route!.psc_pickup}
            {isStaging && <Badge variant="destructive">STAGING</Badge>}
          </h1>
          <p className="text-sm text-slate-500">Điểm đến: {route!.dropoff_location}</p>
        </div>

        {/* Tab switcher */}
        <div className={`grid border-t border-slate-100 ${route!.no_request ? "grid-cols-2" : "grid-cols-3"}`}>
          {!route!.no_request && (
            <button
              onClick={() => { setTab(null); setAssignStatus("idle"); setAssignResult(""); }}
              className={`py-2.5 text-sm font-semibold transition-colors ${tab === null ? "bg-blue-600 text-white" : "bg-white text-slate-500 hover:bg-slate-50"}`}
            >
              Tạo yêu cầu
            </button>
          )}
          <button
            onClick={() => setTab("active")}
            className={`py-2.5 text-sm font-semibold transition-colors ${!route!.no_request ? "border-l border-slate-100" : ""} ${tab === "active" ? "bg-blue-600 text-white" : "bg-white text-slate-500 hover:bg-slate-50"}`}
          >
            Đang giao {activeJobs.length > 0 && `(${activeJobs.length})`}
          </button>
          <button
            onClick={() => setTab("done")}
            className={`py-2.5 text-sm font-semibold transition-colors border-l border-slate-100 ${tab === "done" ? "bg-blue-600 text-white" : "bg-white text-slate-500 hover:bg-slate-50"}`}
          >
            Xong {doneJobs.length > 0 && `(${doneJobs.length})`}
          </button>
        </div>

        {/* Giao mẫu tab */}
        {tab === null && (
          <div className="p-6 space-y-4">
            <div className="space-y-2 text-sm">
              <Row label="Pickup" value={route!.psc_pickup} icon="📦" />
              <Row label="Dropoff" value={route!.dropoff_location} icon="📍" />
            </div>
            {assignStatus === "success" && (
              <div className="rounded-xl border border-green-200 bg-green-50 p-3.5 text-sm font-medium text-green-800">{assignResult}</div>
            )}
            {assignStatus === "error" && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3.5 text-sm font-medium text-red-800">{assignResult}</div>
            )}
            <button
              onClick={handleAssign}
              disabled={assignStatus === "loading" || assignStatus === "success"}
              className="w-full py-3.5 rounded-xl font-bold text-white text-base bg-blue-600 hover:bg-blue-700 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              {assignStatus === "loading" ? "Đang tạo..." : assignStatus === "success" ? "Đã tạo" : "Đề Nghị Giao Mẫu"}
            </button>
            {assignStatus === "success" && (
              <div className="space-y-2">
                {lastCreated && (
                  <button
                    onClick={() => { setCancelTarget(lastCreated); setCancelError(""); }}
                    className="w-full py-3 rounded-xl font-semibold text-red-600 text-sm border border-red-200 hover:bg-red-50 transition-all"
                  >
                    Huỷ yêu cầu
                  </button>
                )}
                <button
                  onClick={() => { setAssignStatus("idle"); setAssignResult(""); setLastCreated(null); }}
                  className="w-full py-3 rounded-xl font-semibold text-slate-600 text-sm border border-slate-200 hover:bg-slate-50 transition-all"
                >
                  Tạo thêm
                </button>
              </div>
            )}
          </div>
        )}

        {/* Jobs tabs */}
        {tab !== null && (
          <div className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="flex-1 border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
              <button onClick={() => tab === "active" ? loadJobs(4) : loadJobs(5)} className="text-xs text-blue-500 hover:underline whitespace-nowrap">Làm mới</button>
            </div>
            <div className="relative">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Tìm tên địa điểm..."
                className="w-full border rounded-lg px-3 py-1.5 pr-7 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-base leading-none"
                >
                  ×
                </button>
              )}
            </div>

            {jobsLoading ? (
              <p className="text-xs text-slate-400 text-center py-6">Đang tải...</p>
            ) : displayJobs.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-6">{search ? "Không tìm thấy kết quả." : "Không có đơn hàng."}</p>
            ) : (
              <div className="space-y-2">
                {search && (
                  <p className="text-[11px] text-slate-400 text-right">{displayJobs.length} kết quả</p>
                )}
                {displayJobs.map((j) => (
                  <JobCard
                    key={j.job_id}
                    job={j}
                    code={code}
                    onCancel={(t) => { setCancelTarget(t); setCancelError(""); }}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Cancel confirm overlay */}
      {cancelTarget && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4" onClick={() => { if (!cancelLoading) { setCancelTarget(null); setCancelError(""); } }}>
          <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="space-y-1">
              <p className="text-sm font-bold text-slate-800">Huỷ chuyến?</p>
              <p className="text-xs text-slate-500 font-semibold break-all">{cancelTarget.reference}</p>
              <p className="text-xs text-slate-500">Chỉ huỷ được khi tài xế chưa bắt đầu lấy mẫu. Hành động này không thể hoàn tác.</p>
            </div>
            {cancelError && (
              <p className="text-xs text-red-600 font-medium">{cancelError}</p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => { setCancelTarget(null); setCancelError(""); }}
                disabled={cancelLoading}
                className="py-2.5 rounded-xl text-sm font-semibold border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 transition-colors"
              >
                Quay lại
              </button>
              <button
                onClick={handleCancel}
                disabled={cancelLoading}
                className="py-2.5 rounded-xl text-sm font-bold bg-red-600 hover:bg-red-700 text-white disabled:opacity-40 transition-colors"
              >
                {cancelLoading ? "Đang huỷ..." : "Xác nhận huỷ"}
              </button>
            </div>
          </div>
        </div>
      )}
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
