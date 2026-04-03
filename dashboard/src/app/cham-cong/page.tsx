"use client";

import { useEffect, useState } from "react";

interface Driver {
  customer_id: string;
  driver_id: string;
  driver_name: string;
}

interface Location {
  customer_id: string;
  name: string;
}

type ActionType = "check-in" | "check-out";
type Status = "idle" | "loading" | "success" | "error";

export default function ChamCongPage() {
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [driverId, setDriverId] = useState("");
  const [driverName, setDriverName] = useState("");
  const [locationId, setLocationId] = useState("");
  const [locationName, setLocationName] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    Promise.all([
      fetch("/api/drivers").then((r) => r.json()),
      fetch("/api/cham-cong").then((r) => r.json()),
    ]).then(([driversData, chamCongData]) => {
      const sorted = (driversData.data ?? [])
        .map((d: { delivery_driver_id: string; first_name: string; last_name: string }) => ({
          customer_id: "",
          driver_id: d.delivery_driver_id,
          driver_name: `${d.first_name ?? ""} ${d.last_name ?? ""}`.trim(),
        }))
        .sort((a: Driver, b: Driver) =>
          a.driver_name.localeCompare(b.driver_name, "vi")
        );
      setDrivers(sorted);
      setLocations(chamCongData.pscs ?? []);
    });
  }, []);

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

        {/* Driver select */}
        <div className="space-y-1">
          <label className="text-sm font-medium text-gray-700">Tài xế</label>
          <select
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={driverId}
            onChange={(e) => {
              const d = drivers.find((d) => d.driver_id === e.target.value);
              setDriverId(e.target.value);
              setDriverName(d?.driver_name ?? "");
            }}
          >
            <option value="">-- Chọn tài xế --</option>
            {drivers.map((d) => (
              <option key={d.driver_id} value={d.driver_id}>
                {d.driver_name}
              </option>
            ))}
          </select>
        </div>

        {/* Location select */}
        <div className="space-y-1">
          <label className="text-sm font-medium text-gray-700">Địa điểm</label>
          <select
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={locationId}
            onChange={(e) => {
              const l = locations.find((l) => l.customer_id === e.target.value);
              setLocationId(e.target.value);
              setLocationName(l?.name ?? "");
            }}
          >
            <option value="">-- Chọn địa điểm --</option>
            {locations.map((l) => (
              <option key={l.customer_id} value={l.customer_id}>
                {l.name}
              </option>
            ))}
          </select>
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
