"use client";

import { useEffect, useState, useMemo } from "react";

interface Driver {
  driver_id: string;
  driver_name: string;
}

interface Location {
  customer_id: string;
  name: string;
  address: string;
}

type ActionType = "check-in" | "check-out";
type Status = "idle" | "loading" | "success" | "error";

const LS_DRIVER_ID   = "cc_driver_id";
const LS_DRIVER_NAME = "cc_driver_name";

export default function ChamCongPage() {
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);

  const [driverId,      setDriverId]      = useState(() => typeof window !== "undefined" ? localStorage.getItem(LS_DRIVER_ID)   ?? "" : "");
  const [driverName,    setDriverName]    = useState(() => typeof window !== "undefined" ? localStorage.getItem(LS_DRIVER_NAME) ?? "" : "");
  const [driverSearch,  setDriverSearch]  = useState(() => typeof window !== "undefined" ? localStorage.getItem(LS_DRIVER_NAME) ?? "" : "");
  const [showDriverList, setShowDriverList] = useState(false);

  const [locationId,    setLocationId]    = useState("");
  const [locationName,  setLocationName]  = useState("");
  const [locationSearch, setLocationSearch] = useState("");
  const [showLocationList, setShowLocationList] = useState(false);

  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");

  // Load dropdown data
  useEffect(() => {
    Promise.all([
      fetch("/api/drivers").then((r) => r.json()),
      fetch("/api/cham-cong").then((r) => r.json()),
    ]).then(([driversData, chamCongData]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sorted = (driversData.data ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((d: any) => d.is_active !== false)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((d: any): Driver => ({
          driver_id: d.delivery_driver_id,
          driver_name: `${d.first_name ?? ""} ${d.last_name ?? ""}`.trim(),
        }))
        .filter((d: Driver) => d.driver_id && d.driver_name)
        .sort((a: Driver, b: Driver) =>
          a.driver_name.localeCompare(b.driver_name, "vi")
        );
      setDrivers(sorted);
      setLocations(chamCongData.pscs ?? []);
    });
  }, []);

  const filteredDrivers = useMemo(() =>
    driverSearch.trim() && !driverId
      ? drivers.filter((d) =>
          d.driver_name.toLowerCase().includes(driverSearch.toLowerCase())
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
    setDriverName(d.driver_name);
    setDriverSearch(d.driver_name);
    setShowDriverList(false);
    localStorage.setItem(LS_DRIVER_ID, d.driver_id);
    localStorage.setItem(LS_DRIVER_NAME, d.driver_name);
  }

  function clearDriver() {
    setDriverId("");
    setDriverName("");
    setDriverSearch("");
    localStorage.removeItem(LS_DRIVER_ID);
    localStorage.removeItem(LS_DRIVER_NAME);
  }

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

  async function submit(type: ActionType) {
    if (!driverId || !locationId) {
      setStatus("error");
      setMessage("Vui lòng chọn tài xế và địa điểm.");
      return;
    }

    setStatus("loading");
    setMessage("");

    try {
      const res = await fetch("/api/cham-cong", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          driver_id: driverId,
          driver_name: driverName,
          psc_customer_id: locationId,
          psc_name: locationName,
          type,
        }),
      });

      const data = await res.json();

      if (!res.ok && res.status !== 207) {
        setStatus("error");
        setMessage(data.error ?? "Có lỗi xảy ra.");
        return;
      }

      setStatus("success");
      setMessage(
        type === "check-in"
          ? `Chấm công vào thành công! Job #${data.job_id}`
          : `Chấm công ra thành công! Job #${data.job_id}`
      );
    } catch {
      setStatus("error");
      setMessage("Không thể kết nối. Vui lòng thử lại.");
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 w-full max-w-md p-6 space-y-5">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Chấm Công</h1>
          <p className="text-sm text-gray-500 mt-1">Chọn tài xế và địa điểm để chấm công vào / ra.</p>
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
              onChange={(e) => {
                setDriverSearch(e.target.value);
                setDriverId("");
                setShowDriverList(true);
              }}
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

        {/* Location searchable dropdown */}
        <div className="space-y-1 relative">
          <label className="text-sm font-medium text-gray-700">Địa điểm</label>
          <div className="relative">
            <input
              type="text"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder={locations.length ? "Tìm địa điểm..." : "Đang tải..."}
              value={locationSearch}
              onChange={(e) => {
                setLocationSearch(e.target.value);
                setLocationId("");
                setShowLocationList(true);
              }}
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

        {/* Buttons */}
        <div className="grid grid-cols-2 gap-3 pt-1">
          <button
            disabled={status === "loading"}
            onClick={() => submit("check-in")}
            className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold rounded-xl py-3 text-sm transition-colors"
          >
            {status === "loading" ? "Đang xử lý..." : "Vào Ca"}
          </button>
          <button
            disabled={status === "loading"}
            onClick={() => submit("check-out")}
            className="bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white font-semibold rounded-xl py-3 text-sm transition-colors"
          >
            {status === "loading" ? "Đang xử lý..." : "Ra Ca"}
          </button>
        </div>

        {/* Status message */}
        {message && (
          <div
            className={`rounded-lg px-4 py-3 text-sm font-medium ${
              status === "success"
                ? "bg-green-50 text-green-700 border border-green-200"
                : status === "error"
                ? "bg-red-50 text-red-700 border border-red-200"
                : ""
            }`}
          >
            {message}
          </div>
        )}
      </div>
    </div>
  );
}
