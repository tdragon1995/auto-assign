"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import { Copy, Check, Calendar, Clock, ClipboardCheck, FileText, NotepadText, Share2, CalendarDays, Search } from "lucide-react";

interface Driver {
  driver_id: string;
  driver_name: string;
}

interface Location {
  customer_id: string;
  name: string;
  address: string;
}

interface ShiftState {
  checkInCount: number;
  completedCheckOuts: number;
  activeCheckOuts: number;
  pendingJobs: number;
  pendingJobNames: string[];
  fetchedAt: number;
}

type ActionType = "check-in" | "check-out";
type Status = "idle" | "loading" | "success" | "error";
type Tab = "cham-cong" | "nghi-phep" | "lich-cn";
type LeaveType = "" | "nguyen_buoi" | "nua_buoi" | "nghi_viec";

interface ScheduleEntry {
  stt: string;
  name: string;
  addr: string;
  ca: string;
  note: string;
  phone: string;
}

interface ScheduleData {
  morning: ScheduleEntry[];
  afternoon: ScheduleEntry[];
  dateLabel: string;
}

function ShiftSection({ title, accent, rows }: { title: string; accent: "amber" | "blue"; rows: ScheduleEntry[] }) {
  if (rows.length === 0) return null;
  const head = accent === "amber" ? "bg-amber-500" : "bg-blue-600";
  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden">
      <div className={`${head} text-white text-sm font-bold px-4 py-2.5 flex items-center justify-between`}>
        <span>{title}</span>
        <span className="text-xs font-semibold opacity-90">{rows.length}</span>
      </div>
      <ul className="divide-y divide-gray-100">
        {rows.map((r, i) => (
          <li key={`${r.stt}-${i}`} className="px-4 py-2.5 flex gap-2">
            <span className="text-xs text-gray-400 w-5 shrink-0 pt-0.5">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-gray-800">
                {r.name || <span className="text-red-600">— Chưa có người —</span>}
              </p>
              {r.addr && <p className="text-sm text-gray-600">{r.addr}</p>}
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {r.ca && (
                  <span className="inline-block text-xs font-medium text-gray-700 bg-gray-100 rounded px-1.5 py-0.5">
                    {r.ca}
                  </span>
                )}
                {r.note && (
                  <span className="inline-block text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                    {r.note}
                  </span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const LS_DRIVER_ID   = "cc_driver_id";
const LS_DRIVER_NAME = "cc_driver_name";
const SHIFT_STATE_TTL_MS = 2 * 60 * 1000;
const SS_DRIVERS_KEY = "cc_drivers_cache";

const TIME_SLOTS: string[] = (() => {
  const slots: string[] = [];
  for (let h = 5; h <= 22; h++) {
    for (let m = 0; m < 60; m += 30) {
      if (h === 22 && m > 0) break;
      slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return slots;
})();

async function fetchDriversCached(): Promise<unknown> {
  if (typeof window !== "undefined") {
    try {
      const raw = sessionStorage.getItem(SS_DRIVERS_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
  }
  const data = await fetch("/api/drivers").then((r) => r.json());
  try {
    sessionStorage.setItem(SS_DRIVERS_KEY, JSON.stringify(data));
  } catch { /* ignore */ }
  return data;
}

function todayVnStr(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date()).slice(0, 10);
}

function vnWeekday(dateStr: string): string {
  if (!dateStr) return "";
  const [y, mo, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, mo - 1, d);
  const days = ["Chủ Nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];
  return days[dt.getDay()];
}

function fmtDate(dateStr: string): string {
  if (!dateStr) return "";
  const [y, mo, d] = dateStr.split("-").map(Number);
  return `Ngày ${d} tháng ${mo}, ${y}`;
}

function DateField({ value, min, onChange }: { value: string; min: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);

  function open() {
    try { ref.current?.showPicker(); } catch { ref.current?.focus(); }
  }

  return (
    <div className="relative cursor-pointer" onClick={open}>
      <Calendar size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none z-10" />
      <div className="w-full border border-gray-300 rounded-lg pl-9 pr-10 py-2 text-sm min-h-[38px] select-none">
        {value
          ? <span className="text-gray-900">{fmtDate(value)}</span>
          : <span className="text-gray-400">Chọn ngày</span>
        }
      </div>
      {/* Visible calendar toggle icon on the right (desktop hint) */}
      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none text-xs">▼</span>
      <input
        ref={ref}
        type="date"
        min={min}
        value={value}
        onChange={(e) => { if (!e.target.value || e.target.value >= min) onChange(e.target.value); }}
        className="opacity-0 absolute inset-0 w-full h-full cursor-pointer"
        tabIndex={-1}
      />
    </div>
  );
}

export default function ChamCongPage() {
  // ── Shared ────────────────────────────────────────────────────────────────
  const [tab, setTab] = useState<Tab>("cham-cong");
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);

  const [driverId,       setDriverId]      = useState(() => typeof window !== "undefined" ? localStorage.getItem(LS_DRIVER_ID)   ?? "" : "");
  const [driverName,     setDriverName]    = useState(() => typeof window !== "undefined" ? localStorage.getItem(LS_DRIVER_NAME) ?? "" : "");
  const [driverSearch,   setDriverSearch]  = useState(() => typeof window !== "undefined" ? localStorage.getItem(LS_DRIVER_NAME) ?? "" : "");
  const [showDriverList, setShowDriverList] = useState(false);

  // ── Chấm Công tab ─────────────────────────────────────────────────────────
  const [locationId,       setLocationId]      = useState("");
  const [locationName,     setLocationName]    = useState("");
  const [locationSearch,   setLocationSearch]  = useState("");
  const [showLocationList, setShowLocationList] = useState(false);
  const [ccStatus,   setCcStatus]  = useState<Status>("idle");
  const [ccMessage,  setCcMessage] = useState("");
  const [pendingNames, setPendingNames] = useState<string[]>([]);
  const shiftStateRef  = useRef<ShiftState | null>(null);
  const [shiftFetching, setShiftFetching] = useState(false);

  // ── Nộp Đơn Nghỉ tab ──────────────────────────────────────────────────────
  const [leaveType,         setLeaveType]         = useState<LeaveType>("");
  const [leaveFromDate,     setLeaveFromDate]     = useState("");
  const [leaveToDate,       setLeaveToDate]       = useState("");
  const [leaveDate,         setLeaveDate]         = useState("");
  const [leaveStartTime,    setLeaveStartTime]    = useState("");
  const [leaveEndTime,      setLeaveEndTime]      = useState("");
  const [leaveStatus,       setLeaveStatus]       = useState<Status>("idle");
  const [leaveError,        setLeaveError]        = useState("");
  const [leaveCopyText,     setLeaveCopyText]     = useState("");
  const [leaveSuccessTitle, setLeaveSuccessTitle] = useState("");
  const [copied, setCopied] = useState(false);

  // ── Lịch CN tab ───────────────────────────────────────────────────────────
  const [schedule,       setSchedule]       = useState<ScheduleData | null>(null);
  const [scheduleStatus, setScheduleStatus] = useState<Status>("idle");
  const [scheduleSearch, setScheduleSearch] = useState("");

  // ── Init ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const savedId = typeof window !== "undefined" ? localStorage.getItem(LS_DRIVER_ID) : null;

    Promise.all([
      fetchDriversCached(),
      fetch("/api/cham-cong").then((r) => r.json()),
    ]).then(([driversData, chamCongData]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sorted = ((driversData as any).data ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((d: any) => d.is_active !== false)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((d: any): Driver => ({
          driver_id: d.delivery_driver_id,
          driver_name: `${d.first_name ?? ""} ${d.last_name ?? ""}`.trim(),
        }))
        .filter((d: Driver) => d.driver_id && d.driver_name && d.driver_name.startsWith("P - "))
        .sort((a: Driver, b: Driver) => a.driver_name.localeCompare(b.driver_name, "vi"));
      setDrivers(sorted);
      setLocations(chamCongData.pscs ?? []);
    }).finally(() => setInitialLoading(false));

    if (savedId) fetchShiftState(savedId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Shift state ───────────────────────────────────────────────────────────
  async function fetchShiftState(id: string): Promise<ShiftState | null> {
    setShiftFetching(true);
    try {
      const res = await fetch(`/api/cham-cong?driver_id=${id}`);
      if (res.ok) {
        const data = await res.json();
        const state: ShiftState = { ...data, fetchedAt: Date.now() };
        shiftStateRef.current = state;
        return state;
      }
      return null;
    } catch {
      shiftStateRef.current = null;
      return null;
    } finally {
      setShiftFetching(false);
    }
  }

  async function getShiftState(): Promise<ShiftState | null> {
    const cached = shiftStateRef.current;
    if (cached && (Date.now() - cached.fetchedAt < SHIFT_STATE_TTL_MS || shiftFetching)) return cached;
    try {
      const res = await fetch(`/api/cham-cong?driver_id=${driverId}`);
      if (!res.ok) return null;
      const data = await res.json();
      const state: ShiftState = { ...data, fetchedAt: Date.now() };
      shiftStateRef.current = state;
      return state;
    } catch {
      return null;
    }
  }

  // Strip leading payroll prefix e.g. "P - P - PT101639 " → "Đặng Thanh Duy"
  const driverCleanName = useMemo(
    () => driverName.replace(/^.*?(?:PT|DC)\d+\s+/i, "").trim(),
    [driverName]
  );

  // Count of schedule rows matching the selected driver (0 when schedule not loaded yet).
  const driverShiftCount = useMemo(() => {
    if (!schedule || !driverCleanName) return 0;
    const q = driverCleanName.toLowerCase();
    return (
      schedule.morning.filter((e) => e.name.toLowerCase().includes(q)).length +
      schedule.afternoon.filter((e) => e.name.toLowerCase().includes(q)).length
    );
  }, [schedule, driverCleanName]);

  // ── Lịch CN: lazy-load on first open ──────────────────────────────────────
  useEffect(() => {
    if (tab !== "lich-cn" || schedule || scheduleStatus === "loading") return;
    setScheduleStatus("loading");
    fetch("/api/sunday-schedule")
      .then((r) => r.json())
      .then((d: ScheduleData & { error?: string }) => {
        if (d.error) { setScheduleStatus("error"); return; }
        setSchedule({ morning: d.morning ?? [], afternoon: d.afternoon ?? [], dateLabel: d.dateLabel ?? "" });
        setScheduleStatus("success");
      })
      .catch(() => setScheduleStatus("error"));
  }, [tab, schedule, scheduleStatus]);

  const filteredSchedule = useMemo(() => {
    if (!schedule) return { morning: [], afternoon: [] };
    const q = scheduleSearch.toLowerCase().trim();
    if (!q) return { morning: schedule.morning, afternoon: schedule.afternoon };
    const match = (e: ScheduleEntry) =>
      e.name.toLowerCase().includes(q) || e.addr.toLowerCase().includes(q);
    return { morning: schedule.morning.filter(match), afternoon: schedule.afternoon.filter(match) };
  }, [schedule, scheduleSearch]);

  // ── Driver dropdown ───────────────────────────────────────────────────────
  const filteredDrivers = useMemo(() =>
    driverSearch.trim() && !driverId
      ? drivers.filter((d) => d.driver_name.toLowerCase().includes(driverSearch.toLowerCase()))
      : drivers,
    [drivers, driverSearch, driverId]
  );

  function selectDriver(d: Driver) {
    setDriverId(d.driver_id);
    setDriverName(d.driver_name);
    setDriverSearch(d.driver_name);
    setShowDriverList(false);
    localStorage.setItem(LS_DRIVER_ID, d.driver_id);
    localStorage.setItem(LS_DRIVER_NAME, d.driver_name);
    shiftStateRef.current = null;
    fetchShiftState(d.driver_id);
  }

  function clearDriver() {
    setDriverId("");
    setDriverName("");
    setDriverSearch("");
    shiftStateRef.current = null;
    localStorage.removeItem(LS_DRIVER_ID);
    localStorage.removeItem(LS_DRIVER_NAME);
  }

  // ── Location dropdown ─────────────────────────────────────────────────────
  const filteredLocations = useMemo(() =>
    locationSearch.trim() && !locationId
      ? locations.filter((l) =>
          l.name.toLowerCase().includes(locationSearch.toLowerCase()) ||
          l.address.toLowerCase().includes(locationSearch.toLowerCase())
        )
      : locations,
    [locations, locationSearch, locationId]
  );

  function selectLocation(l: Location) {
    setLocationId(l.customer_id);
    setLocationName(l.name);
    setLocationSearch(l.name);
    setShowLocationList(false);
  }

  function clearLocation() {
    setLocationId("");
    setLocationName("");
    setLocationSearch("");
  }

  // ── Chấm Công submit ──────────────────────────────────────────────────────
  async function submitChamCong(type: ActionType) {
    if (!driverId || !locationId) {
      setCcStatus("error");
      setCcMessage("Vui lòng chọn tên và địa điểm");
      return;
    }
    setCcStatus("loading");
    setCcMessage("");
    setPendingNames([]);

    const shift = await getShiftState();
    if (shift) {
      const hasOpenShift = shift.checkInCount > shift.completedCheckOuts;
      if (type === "check-in" && hasOpenShift) {
        setCcStatus("error");
        setCcMessage("Đã có task vào ca chưa hoàn thành. Vui lòng mở app Cartrack và hoàn thành task trước khi tạo mới!");
        return;
      }
      if (type === "check-out" && shift.activeCheckOuts > 0) {
        setCcStatus("error");
        setCcMessage("Đã có task ra ca chưa hoàn thành. Vui lòng mở app Cartrack và hoàn thành task!");
        return;
      }
    }

    try {
      const res = await fetch("/api/cham-cong", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ driver_id: driverId, driver_name: driverName, psc_customer_id: locationId, psc_name: locationName, type }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCcStatus("error");
        setCcMessage(data.error ?? "Có lỗi xảy ra.");
        return;
      }
      shiftStateRef.current = null;
      fetchShiftState(driverId);
      setCcStatus("success");
      if (type === "check-in") {
        setCcMessage(`Đã tạo task vào ca (Job #${data.job_id}). Vui lòng mở app Cartrack và hoàn thành task để chấm công vào ca!`);
      } else {
        const names = shift?.pendingJobNames ?? [];
        setPendingNames(names);
        setCcMessage(`Đã tạo task ra ca (Job #${data.job_id}). Vui lòng mở app Cartrack và hoàn thành task để chấm công ra ca!`);
      }
    } catch {
      setCcStatus("error");
      setCcMessage("Không thể kết nối. Vui lòng thử lại.");
    }
  }

  // ── Leave form ────────────────────────────────────────────────────────────
  const canSubmitLeave = useMemo(() => {
    if (!driverId || !leaveType) return false;
    if (leaveType === "nguyen_buoi") return !!(leaveFromDate && leaveToDate);
    if (leaveType === "nua_buoi")    return !!(leaveDate && leaveStartTime && leaveEndTime);
    if (leaveType === "nghi_viec")   return !!leaveDate;
    return false;
  }, [driverId, leaveType, leaveFromDate, leaveToDate, leaveDate, leaveStartTime, leaveEndTime]);

  const endTimeSlots = useMemo(() => {
    if (!leaveStartTime) return TIME_SLOTS;
    const [sh, sm] = leaveStartTime.split(":").map(Number);
    const minMins = sh * 60 + sm + 60;
    return TIME_SLOTS.filter((t) => {
      const [eh, em] = t.split(":").map(Number);
      return eh * 60 + em >= minMins;
    });
  }, [leaveStartTime]);

  function resetLeaveForm() {
    setLeaveType("");
    setLeaveFromDate("");
    setLeaveToDate("");
    setLeaveDate("");
    setLeaveStartTime("");
    setLeaveEndTime("");
    setLeaveStatus("idle");
    setLeaveError("");
    setLeaveCopyText("");
    setLeaveSuccessTitle("");
    setCopied(false);
  }

  async function submitLeave() {
    setLeaveError("");
    if (!driverId) { setLeaveError("Vui lòng chọn tên nhân viên"); return; }
    if (!leaveType) { setLeaveError("Vui lòng chọn loại nghỉ"); return; }
    if (leaveType === "nguyen_buoi") {
      if (!leaveFromDate || !leaveToDate) { setLeaveError("Vui lòng chọn đầy đủ ngày nghỉ từ và đến"); return; }
      if (leaveToDate < leaveFromDate)    { setLeaveError("Ngày kết thúc phải bằng hoặc sau ngày bắt đầu"); return; }
    } else if (leaveType === "nua_buoi") {
      if (!leaveDate)      { setLeaveError("Vui lòng chọn ngày nghỉ"); return; }
      if (!leaveStartTime) { setLeaveError("Vui lòng chọn giờ bắt đầu"); return; }
      if (!leaveEndTime)   { setLeaveError("Vui lòng chọn giờ kết thúc"); return; }
    } else {
      if (!leaveDate) { setLeaveError("Vui lòng chọn ngày làm việc cuối cùng"); return; }
    }

    setLeaveStatus("loading");

    const payload = {
      driver_id: driverId,
      driver_name: driverName,
      loai_nghi: leaveType,
      ngay_bat_dau: leaveType === "nguyen_buoi" ? leaveFromDate : leaveDate,
      ngay_ket_thuc: leaveType === "nguyen_buoi" ? leaveToDate : undefined,
      gio_bat_dau:   leaveType === "nua_buoi"    ? leaveStartTime : undefined,
      gio_ket_thuc:  leaveType === "nua_buoi"    ? leaveEndTime   : undefined,
    };

    try {
      const res = await fetch("/api/nghi-phep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setLeaveError(errData.error ?? "Đơn bị lỗi, vui lòng gửi lại hoặc chụp màn hình gửi vào nhóm Zalo công việc để được hỗ trợ!");
        setLeaveStatus("error");
        return;
      }

      let title = "";
      let copyText = "";

      if (leaveType === "nguyen_buoi") {
        title = "Nộp đơn nghỉ thành công!";
        copyText = `⚠️ Thông Báo Nghỉ Nguyên Buổi, ${driverName} đã nộp yêu cầu nghỉ từ ${fmtDate(leaveFromDate)} (${vnWeekday(leaveFromDate)}) đến ${fmtDate(leaveToDate)} (${vnWeekday(leaveToDate)}). Nhờ đội điều phối hỗ trợ sắp xếp để không gián đoạn công việc!`;
      } else if (leaveType === "nua_buoi") {
        title = "Nộp đơn nghỉ thành công!";
        copyText = `⚠️ Thông Báo Nghỉ Nửa Buổi, ${driverName} đã nộp yêu cầu nghỉ từ ${leaveStartTime} đến ${leaveEndTime} ngày ${fmtDate(leaveDate)} (${vnWeekday(leaveDate)}). Nhờ đội điều phối hỗ trợ sắp xếp để không gián đoạn công việc!`;
      } else {
        title = "Hoàn tất nộp đơn nghỉ việc, xin cám ơn bạn đã hợp tác trong thời gian qua!";
        copyText = `⚠️ Thông Báo Nghỉ Việc, ${driverName} đã nộp đơn chấm dứt hợp tác làm việc với Diag. Ngày cuối cùng làm việc là ${fmtDate(leaveDate)} (${vnWeekday(leaveDate)}). Nhờ đội điều phối hỗ trợ sắp xếp và hướng dẫn các thủ tục bàn giao!`;
      }

      setLeaveSuccessTitle(title);
      setLeaveCopyText(copyText);
      setLeaveStatus("success");
    } catch (e) {
      setLeaveError(`Lỗi kết nối: ${String(e)}`);
      setLeaveStatus("error");
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(leaveCopyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  }

  async function handleShare() {
    try {
      await navigator.share({ text: leaveCopyText });
    } catch { /* user cancelled or unsupported */ }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  if (initialLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-3">
        <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-gray-400">Đang tải...</p>
      </div>
    );
  }

  const today = todayVnStr();

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 w-full max-w-md overflow-hidden">

        {/* Tab bar */}
        <div className="flex border-b border-gray-200">
          <button
            onClick={() => setTab("cham-cong")}
            className={`flex-1 py-3 text-xs font-semibold transition-colors flex items-center justify-center gap-1 whitespace-nowrap ${
              tab === "cham-cong"
                ? "text-blue-600 border-b-2 border-blue-600 bg-blue-50/40"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            <ClipboardCheck size={14} />
            Chấm Công
          </button>
          <button
            onClick={() => setTab("nghi-phep")}
            className={`flex-1 py-3 text-xs font-semibold transition-colors flex items-center justify-center gap-1 whitespace-nowrap ${
              tab === "nghi-phep"
                ? "text-blue-600 border-b-2 border-blue-600 bg-blue-50/40"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            <FileText size={14} />
            Đơn Nghỉ
          </button>
          <button
            onClick={() => {
              setTab("lich-cn");
              if (driverCleanName) setScheduleSearch(driverCleanName);
            }}
            className={`flex-1 py-3 text-xs font-semibold transition-colors flex items-center justify-center gap-1 whitespace-nowrap relative ${
              tab === "lich-cn"
                ? "text-blue-600 border-b-2 border-blue-600 bg-blue-50/40"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            <CalendarDays size={14} />
            Lịch CN
            {driverShiftCount > 0 && tab !== "lich-cn" && (
              <span className="absolute top-1.5 right-2 min-w-[16px] h-4 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center px-1 leading-none">
                {driverShiftCount}
              </span>
            )}
          </button>
        </div>

        <div className="p-6 space-y-5">

          {/* ── Shared: Driver dropdown (hidden on the read-only schedule tab) ── */}
          {tab !== "lich-cn" && (
          <div className="space-y-1 relative">
            <label className="text-sm font-medium text-gray-700">
              Nhân Viên Giao Nhận
              {shiftFetching && tab === "cham-cong" && (
                <span className="ml-2 text-xs text-gray-400">Đang kiểm tra ca...</span>
              )}
            </label>
            <div className="relative">
              <input
                type="text"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder={drivers.length ? "Chọn tên..." : "Đang tải..."}
                value={driverSearch}
                onChange={(e) => { setDriverSearch(e.target.value); setDriverId(""); setShowDriverList(true); }}
                onFocus={() => setShowDriverList(true)}
                onBlur={() => setTimeout(() => setShowDriverList(false), 150)}
              />
              {driverSearch && (
                <button
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  onMouseDown={(e) => { e.preventDefault(); clearDriver(); }}
                >
                  ×
                </button>
              )}
            </div>
            {showDriverList && !driverId && filteredDrivers.length > 0 && (
              <ul className="absolute z-10 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-52 overflow-y-auto mt-1">
                {filteredDrivers.map((d) => (
                  <li
                    key={d.driver_id}
                    className="px-3 py-2 text-sm hover:bg-blue-50 cursor-pointer"
                    onMouseDown={() => selectDriver(d)}
                  >
                    {d.driver_name}
                  </li>
                ))}
              </ul>
            )}
          </div>
          )}

          {/* ── Chấm Công tab ───────────────────────────────────────────── */}
          {tab === "cham-cong" && (
            <>
              {/* Location dropdown */}
              <div className="space-y-1 relative">
                <label className="text-sm font-medium text-gray-700">Địa điểm</label>
                <div className="relative">
                  <input
                    type="text"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder={locations.length ? "Tìm địa điểm..." : "Đang tải..."}
                    value={locationSearch}
                    onChange={(e) => { setLocationSearch(e.target.value); setLocationId(""); setShowLocationList(true); }}
                    onFocus={() => setShowLocationList(true)}
                    onBlur={() => setTimeout(() => setShowLocationList(false), 150)}
                  />
                  {locationSearch && (
                    <button
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      onMouseDown={(e) => { e.preventDefault(); clearLocation(); }}
                    >
                      ×
                    </button>
                  )}
                </div>
                {showLocationList && !locationId && filteredLocations.length > 0 && (
                  <ul className="absolute z-10 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-52 overflow-y-auto mt-1">
                    {filteredLocations.map((l) => (
                      <li
                        key={l.customer_id}
                        className="px-3 py-2 cursor-pointer hover:bg-blue-50"
                        onMouseDown={() => selectLocation(l)}
                      >
                        <div className="text-sm font-medium text-gray-800">{l.name}</div>
                        {l.address && <div className="text-xs text-gray-400">{l.address}</div>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Check-in / Check-out buttons */}
              <div className="grid grid-cols-2 gap-3 pt-1">
                <button
                  disabled={ccStatus === "loading"}
                  onClick={() => submitChamCong("check-in")}
                  className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold rounded-xl py-3 text-sm transition-colors"
                >
                  {ccStatus === "loading" ? "Đang xử lý..." : "Vào Ca"}
                </button>
                <button
                  disabled={ccStatus === "loading"}
                  onClick={() => submitChamCong("check-out")}
                  className="bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white font-semibold rounded-xl py-3 text-sm transition-colors"
                >
                  {ccStatus === "loading" ? "Đang xử lý..." : "Ra Ca"}
                </button>
              </div>

              {/* Chấm công status message */}
              {ccMessage && (
                <div className="space-y-3">
                  <div
                    className={`rounded-lg px-4 py-3 text-sm font-medium ${
                      ccStatus === "success"
                        ? "bg-green-50 text-green-700 border border-green-200"
                        : ccStatus === "error"
                        ? "bg-red-50 text-red-700 border border-red-200"
                        : ""
                    }`}
                  >
                    {ccMessage}
                  </div>
                  {pendingNames.length > 0 && (
                    <div className="rounded-lg px-4 py-3 text-sm border border-yellow-300 bg-yellow-50 text-yellow-800">
                      <p className="font-semibold flex items-center gap-1.5">
                        <span>⚠️</span> Lưu ý, vẫn còn những công việc chưa hoàn tất:
                      </p>
                      <ol className="list-decimal list-inside mt-1.5 space-y-0.5 font-normal">
                        {pendingNames.map((name, i) => <li key={i}>{name}</li>)}
                      </ol>
                      <p className="mt-1.5 font-medium">Vui lòng liên hệ điều phối trước khi rời ca!</p>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* ── Nộp Đơn Nghỉ tab ────────────────────────────────────────── */}
          {tab === "nghi-phep" && (
            <>
              {leaveStatus === "success" ? (
                /* Success view */
                <div className="space-y-4">
                  <div className="rounded-lg px-4 py-3 bg-green-50 border border-green-200">
                    <p className="text-sm font-semibold text-green-700">{leaveSuccessTitle}</p>
                  </div>

                  {/* Zalo copy box */}
                  <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                    <p className="text-sm text-gray-800 leading-relaxed">{leaveCopyText}</p>
                    <div className="flex items-center gap-2 mt-2.5">
                      <button
                        onClick={handleCopy}
                        className="flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800 transition-colors"
                      >
                        {copied ? (
                          <Check size={14} className="text-green-600 shrink-0" />
                        ) : (
                          <Copy size={14} className="shrink-0" />
                        )}
                        <span>{copied ? "Đã copy!" : "Copy"}</span>
                      </button>
                      {typeof navigator !== "undefined" && !!navigator.share && (
                        <>
                          <span className="text-gray-300">|</span>
                          <button
                            onClick={handleShare}
                            className="flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800 transition-colors"
                          >
                            <Share2 size={14} className="shrink-0" />
                            <span>Chia sẻ</span>
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  <button
                    onClick={resetLeaveForm}
                    className="w-full border border-gray-300 rounded-xl py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    Nộp thêm đơn khác
                  </button>
                </div>
              ) : (
                /* Leave form */
                <>
                  {/* Loại nghỉ */}
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-gray-700">Loại nghỉ</label>
                    <select
                      value={leaveType}
                      onChange={(e) => {
                        setLeaveType(e.target.value as LeaveType);
                        setLeaveFromDate(""); setLeaveToDate(""); setLeaveDate("");
                        setLeaveStartTime(""); setLeaveEndTime(""); setLeaveError("");
                      }}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                    >
                      <option value="">-- Chọn loại nghỉ --</option>
                      <option value="nguyen_buoi">Nghỉ nguyên buổi (nghỉ toàn bộ ca làm)</option>
                      <option value="nua_buoi">Nghỉ nửa buổi (nghỉ một/một vài tiếng ở đầu hoặc cuối ca)</option>
                      <option value="nghi_viec">Nghỉ việc (Kết thúc hợp tác)</option>
                    </select>
                  </div>

                  {/* Disclaimers — always right beneath the selector */}
                  {(leaveType === "nguyen_buoi" || leaveType === "nua_buoi") && (
                    <p className="flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                      <NotepadText size={13} className="shrink-0" />
                      Cần báo trước 3 – 7 ngày để không gián đoạn công việc
                    </p>
                  )}
                  {leaveType === "nghi_viec" && (
                    <p className="flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                      <NotepadText size={13} className="shrink-0" />
                      Cần báo trước tối thiểu 14 ngày để không gián đoạn công việc
                    </p>
                  )}

                  {/* Nghỉ nguyên buổi: date range */}
                  {leaveType === "nguyen_buoi" && (
                    <div className="space-y-3">
                      <div className="space-y-1">
                        <label className="text-sm font-medium text-gray-700">Nghỉ từ ngày</label>
                        <DateField
                          value={leaveFromDate}
                          min={today}
                          onChange={(v) => { setLeaveFromDate(v); if (leaveToDate && v > leaveToDate) setLeaveToDate(""); }}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-sm font-medium text-gray-700">Đến ngày</label>
                        <DateField
                          value={leaveToDate}
                          min={leaveFromDate || today}
                          onChange={setLeaveToDate}
                        />
                      </div>
                    </div>
                  )}

                  {/* Nghỉ nửa buổi: date + time range */}
                  {leaveType === "nua_buoi" && (
                    <div className="space-y-3">
                      <div className="space-y-1">
                        <label className="text-sm font-medium text-gray-700">Ngày nghỉ</label>
                        <DateField value={leaveDate} min={today} onChange={setLeaveDate} />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <label className="text-sm font-medium text-gray-700">Giờ bắt đầu</label>
                          <div className="relative">
                            <Clock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none z-10" />
                            <select
                              value={leaveStartTime}
                              onChange={(e) => { setLeaveStartTime(e.target.value); setLeaveEndTime(""); }}
                              className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                            >
                              <option value="">-- Chọn --</option>
                              {TIME_SLOTS.map((t) => <option key={t} value={t}>{t}</option>)}
                            </select>
                          </div>
                        </div>
                        <div className="space-y-1">
                          <label className="text-sm font-medium text-gray-700">Giờ kết thúc</label>
                          <div className="relative">
                            <Clock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none z-10" />
                            <select
                              value={leaveEndTime}
                              onChange={(e) => setLeaveEndTime(e.target.value)}
                              disabled={!leaveStartTime}
                              className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white disabled:opacity-50"
                            >
                              <option value="">-- Chọn --</option>
                              {endTimeSlots.map((t) => <option key={t} value={t}>{t}</option>)}
                            </select>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Nghỉ việc: last working day */}
                  {leaveType === "nghi_viec" && (
                    <div className="space-y-1">
                      <label className="text-sm font-medium text-gray-700">Ngày làm việc cuối cùng</label>
                      <DateField value={leaveDate} min={today} onChange={setLeaveDate} />
                    </div>
                  )}

                  {/* Error */}
                  {(leaveError || leaveStatus === "error") && (
                    <div className="rounded-lg px-4 py-3 bg-red-50 border border-red-200 text-sm text-red-700">
                      {leaveError || "Đơn bị lỗi, vui lòng gửi lại hoặc chụp màn hình gửi vào nhóm Zalo công việc để được hỗ trợ!"}
                    </div>
                  )}

                  <button
                    disabled={leaveStatus === "loading" || !canSubmitLeave}
                    onClick={submitLeave}
                    className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-xl py-3 text-sm transition-colors"
                  >
                    {leaveStatus === "loading" ? "Đang gửi..." : "Nộp Đơn"}
                  </button>
                </>
              )}
            </>
          )}

          {/* ── Lịch CN tab ─────────────────────────────────────────────── */}
          {tab === "lich-cn" && (
            <>
              {scheduleStatus === "loading" && (
                <div className="flex flex-col items-center justify-center py-10 gap-3">
                  <div className="w-7 h-7 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  <p className="text-sm text-gray-400">Đang tải lịch...</p>
                </div>
              )}

              {scheduleStatus === "error" && (
                <div className="rounded-lg px-4 py-3 bg-red-50 border border-red-200 text-sm text-red-700">
                  Không tải được lịch. Vui lòng thử lại sau.
                </div>
              )}

              {scheduleStatus === "success" && schedule && (
                <>
                  <div className="text-center">
                    <p className="text-xs uppercase tracking-wide text-gray-400 font-semibold">
                      Lịch làm việc Chủ Nhật
                    </p>
                    {schedule.dateLabel && (
                      <p className="text-base font-bold text-gray-800">Ngày {schedule.dateLabel}</p>
                    )}
                  </div>

                  <div className="relative">
                    <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                    <input
                      type="text"
                      className="w-full border border-gray-300 rounded-lg pl-9 pr-8 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="Tìm tên hoặc địa điểm..."
                      value={scheduleSearch}
                      onChange={(e) => setScheduleSearch(e.target.value)}
                    />
                    {scheduleSearch && (
                      <button
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                        onClick={() => setScheduleSearch("")}
                      >
                        ×
                      </button>
                    )}
                  </div>

                  <ShiftSection title="🌅 Ca sáng" accent="amber" rows={filteredSchedule.morning} />
                  <ShiftSection title="🌆 Ca chiều" accent="blue" rows={filteredSchedule.afternoon} />

                  {filteredSchedule.morning.length === 0 && filteredSchedule.afternoon.length === 0 && (
                    <p className="text-center text-sm text-gray-400 py-6">
                      {scheduleSearch ? "Không tìm thấy kết quả." : "Chưa có lịch."}
                    </p>
                  )}
                </>
              )}
            </>
          )}

        </div>
      </div>
    </div>
  );
}
