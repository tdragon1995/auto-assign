"use client";

import { useEffect, useState, useMemo } from "react";

interface Driver {
  driver_id: string;
  driver_first_name: string;
  driver_last_name: string;
  driver_full_name: string;
}

interface Location {
  customer_id: string;
  name: string;
  address: string;
}

type Status = "idle" | "loading" | "success" | "error" | "warning";

const LS_DRIVER_ID         = "audit_driver_id";
const LS_DRIVER_FIRST_NAME = "audit_driver_first_name";
const LS_DRIVER_LAST_NAME  = "audit_driver_last_name";
const LS_DRIVER_FULL_NAME  = "audit_driver_full_name";

export default function AuditPage() {
  const [drivers,   setDrivers]   = useState<Driver[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);

  const [driverId,       setDriverId]       = useState(() => typeof window !== "undefined" ? localStorage.getItem(LS_DRIVER_ID) ?? "" : "");
  const [driverFirstName, setDriverFirstName] = useState(() => typeof window !== "undefined" ? localStorage.getItem(LS_DRIVER_FIRST_NAME) ?? "" : "");
  const [driverLastName,  setDriverLastName]  = useState(() => typeof window !== "undefined" ? localStorage.getItem(LS_DRIVER_LAST_NAME) ?? "" : "");
  const [driverFullName,  setDriverFullName]  = useState(() => typeof window !== "undefined" ? localStorage.getItem(LS_DRIVER_FULL_NAME) ?? "" : "");
  const [driverSearch,   setDriverSearch]   = useState(() => typeof window !== "undefined" ? localStorage.getItem(LS_DRIVER_FULL_NAME) ?? "" : "");
  const [showDriverList, setShowDriverList] = useState(false);

  const [locationId,       setLocationId]       = useState("");
  const [locationName,     setLocationName]     = useState("");
  const [locationSearch,   setLocationSearch]   = useState("");
  const [showLocationList, setShowLocationList] = useState(false);

  const [status,  setStatus]  = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [jobId,   setJobId]   = useState<number | null>(null);
  const [refNumber, setRefNumber] = useState("");

  const [initialLoading, setInitialLoading] = useState(true);

  // Load dropdowns on mount
  useEffect(() => {
    Promise.all([
      fetch("/api/drivers").then((r) => r.json()),
      fetch("/api/audit").then((r) => r.json()),
    ])
      .then(([driversData, auditData]) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sorted = (driversData.data ?? [])
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((d: any) => d.is_active !== false)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((d: any): Driver => ({
            driver_id: d.delivery_driver_id,
            driver_first_name: d.first_name ?? "",
            driver_last_name: d.last_name ?? "",
            driver_full_name: `${d.first_name ?? ""} ${d.last_name ?? ""}`.trim(),
          }))
          .filter((d: Driver) => d.driver_id && d.driver_full_name)
          .sort((a: Driver, b: Driver) =>
            a.driver_full_name.localeCompare(b.driver_full_name, "vi")
          );
        setDrivers(sorted);
        setLocations(auditData.pscs ?? []);
      })
      .finally(() => setInitialLoading(false));
  }, []);

  const filteredDrivers = useMemo(() =>
    driverSearch.trim() && !driverId
      ? drivers.filter((d) =>
          d.driver_full_name.toLowerCase().includes(driverSearch.toLowerCase())
        )
      : drivers,
    [drivers, driverSearch, driverId]
  );

  const filteredLocations = useMemo(() =>
    locationSearch.trim() && !locationId
      ? locations.filter((l) =>
          l.name.toLowerCase().includes(locationSearch.toLowerCase()) ||
          l.address.toLowerCase().includes(locationSearch.toLowerCase())
        )
      : locations,
    [locations, locationSearch, locationId]
  );

  function selectDriver(d: Driver) {
    setDriverId(d.driver_id);
    setDriverFirstName(d.driver_first_name);
    setDriverLastName(d.driver_last_name);
    setDriverFullName(d.driver_full_name);
    setDriverSearch(d.driver_full_name);
    setShowDriverList(false);
    localStorage.setItem(LS_DRIVER_ID,         d.driver_id);
    localStorage.setItem(LS_DRIVER_FIRST_NAME, d.driver_first_name);
    localStorage.setItem(LS_DRIVER_LAST_NAME,  d.driver_last_name);
    localStorage.setItem(LS_DRIVER_FULL_NAME,  d.driver_full_name);
  }

  function clearDriver() {
    setDriverId(""); setDriverFirstName(""); setDriverLastName(""); setDriverFullName(""); setDriverSearch("");
    localStorage.removeItem(LS_DRIVER_ID);
    localStorage.removeItem(LS_DRIVER_FIRST_NAME);
    localStorage.removeItem(LS_DRIVER_LAST_NAME);
    localStorage.removeItem(LS_DRIVER_FULL_NAME);
  }

  function selectLocation(l: Location) {
    setLocationId(l.customer_id);
    setLocationName(l.name);
    setLocationSearch(l.name);
    setShowLocationList(false);
  }

  function clearLocation() {
    setLocationId(""); setLocationName(""); setLocationSearch("");
  }

  async function submit() {
    if (!driverId || !locationId) {
      setStatus("error");
      setMessage("Vui lòng chọn tài xế và địa điểm.");
      return;
    }

    setStatus("loading");
    setMessage("");
    setJobId(null);
    setRefNumber("");

    try {
      const res = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          driver_id: driverId,
          driver_first_name: driverFirstName,
          driver_last_name: driverLastName,
          driver_full_name: driverFullName,
          location_customer_id: locationId,
          location_name: locationName,
        }),
      });

      const data = await res.json();

      if (res.status === 409) {
        setStatus("error");
        setMessage(data.error ?? "Đã tạo audit hôm nay rồi.");
        return;
      }

      if (res.status === 207) {
        setStatus("warning");
        setJobId(data.job_id ?? null);
        setRefNumber(data.reference_number ?? "");
        setMessage(data.warning ?? "Job tạo thành công nhưng không gán được tài xế.");
        return;
      }

      if (!res.ok) {
        setStatus("error");
        setMessage(data.error ?? "Có lỗi xảy ra. Vui lòng thử lại.");
        return;
      }

      setStatus("success");
      setJobId(data.job_id ?? null);
      setRefNumber(data.reference_number ?? "");
      setMessage(`Đã tạo audit thành công! Vui lòng mở app Cartrack và hoàn thành 8 ảnh kiểm tra.`);
    } catch {
      setStatus("error");
      setMessage("Không thể kết nối. Vui lòng thử lại.");
    }
  }

  if (initialLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-3">
        <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-gray-400">Đang tải...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 w-full max-w-md p-6 space-y-5">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Audit Tuần</h1>
          <p className="text-sm text-gray-500 mt-1">Tạo task kiểm tra tác phong nhân viên giao nhận.</p>
        </div>

        {/* Driver searchable dropdown */}
        <div className="space-y-1 relative">
          <label className="text-sm font-medium text-gray-700">Tài xế</label>
          <div className="relative">
            <input
              type="text"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder={drivers.length ? "Tìm tài xế..." : "Đang tải..."}
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
                  {d.driver_full_name}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Location searchable dropdown */}
        <div className="space-y-1 relative">
          <label className="text-sm font-medium text-gray-700">Địa điểm (PSC hiện tại)</label>
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

        {/* Submit button */}
        <button
          disabled={status === "loading"}
          onClick={submit}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold rounded-xl py-3 text-sm transition-colors"
        >
          {status === "loading" ? "Đang tạo task..." : "Tạo Audit"}
        </button>

        {/* Status message */}
        {message && (
          <div
            className={`rounded-lg px-4 py-3 text-sm font-medium ${
              status === "success"
                ? "bg-green-50 text-green-700 border border-green-200"
                : status === "warning"
                ? "bg-yellow-50 text-yellow-800 border border-yellow-300"
                : status === "error"
                ? "bg-red-50 text-red-700 border border-red-200"
                : ""
            }`}
          >
            {status === "warning" && <span className="mr-1">⚠️</span>}
            {message}
            {(status === "success" || status === "warning") && jobId && (
              <p className="mt-1 font-normal text-xs opacity-75">
                Job #{jobId} · {refNumber}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
