"use client";

import { useState } from "react";
import { CORP_CLINICS, normalizeVnPhone } from "@/lib/corp";
import { PickupTripFeed, justSentTrip } from "@/components/pickup-trip-feed";
import type { PickupTrip } from "@/lib/pickup-trips";

export default function CorpPage() {
  const [clinicId, setClinicId] = useState("");
  const [phone, setPhone] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState<PickupTrip[]>([]);

  function pick(id: string) {
    setClinicId(id);
    // Every request starts from the clinic's default; an edit applies to this request only.
    setPhone(CORP_CLINICS.find((c) => c.customer_id === id)?.phone ?? "");
  }

  async function submit() {
    if (!clinicId) {
      setStatus("error");
      setMessage("Vui lòng chọn phòng khám");
      return;
    }
    if (!normalizeVnPhone(phone)) {
      setStatus("error");
      setMessage("Số điện thoại không hợp lệ");
      return;
    }
    setStatus("loading");
    setMessage("");
    try {
      const res = await fetch("/api/corp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clinic_id: clinicId, phone }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus("error");
        setMessage(data.error ?? "Có lỗi xảy ra. Vui lòng thử lại.");
        return;
      }
      setStatus("success");
      setMessage(`Đã gửi yêu cầu lấy mẫu (Job #${data.job_id ?? "?"}).`);
      const clinic = CORP_CLINICS.find((c) => c.customer_id === clinicId);
      if (data.job_id && clinic) setSent((prev) => [justSentTrip(data.job_id, clinic.name, "BRA - D001"), ...prev]);
      setClinicId("");
      setPhone("");
    } catch {
      setStatus("error");
      setMessage("Không thể kết nối. Vui lòng thử lại.");
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center gap-5 p-4 pt-8 pb-12">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 w-full max-w-md p-6 space-y-5">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Yêu cầu lấy mẫu</h1>
          <p className="text-sm text-gray-500 mt-1">Giao về Diag D001</p>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-gray-700 mb-1">Nơi lấy mẫu</legend>
          {CORP_CLINICS.map((c) => (
            <button
              key={c.customer_id}
              type="button"
              aria-pressed={clinicId === c.customer_id}
              onClick={() => pick(c.customer_id)}
              className={`w-full text-left rounded-lg border px-4 py-3 text-sm font-semibold transition-colors ${
                clinicId === c.customer_id ? "border-blue-500 bg-blue-50 text-blue-700 ring-2 ring-blue-200" : "border-gray-300 text-gray-800 hover:bg-gray-50"
              }`}
            >
              {c.short}
            </button>
          ))}
        </fieldset>

        {clinicId && (
          <div className="space-y-1">
            <label htmlFor="phone" className="text-sm font-medium text-gray-700">Số điện thoại liên hệ</label>
            <input
              id="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            <p className="text-xs text-gray-500">Có thể sửa cho lần gửi này.</p>
          </div>
        )}

        <button
          disabled={status === "loading"}
          onClick={submit}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold rounded-xl py-3 text-sm transition-colors"
        >
          {status === "loading" ? "Đang gửi..." : "Gửi yêu cầu"}
        </button>

        {message && (
          <div
            role="status"
            className={`rounded-lg px-4 py-3 text-sm font-medium border ${
              status === "success" ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-700 border-red-200"
            }`}
          >
            {message}
          </div>
        )}
      </div>

      <PickupTripFeed url="/api/corp" sent={sent} showPickup />
    </div>
  );
}
