"use client";

import { useState } from "react";
import { NDTP_DROPOFFS, NDTP_PICKUP } from "@/lib/ndtp";

export default function NdtpPage() {
  const [dropoffId, setDropoffId] = useState("");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  async function submit() {
    if (!dropoffId) {
      setStatus("error");
      setMessage("Vui lòng chọn nơi giao");
      return;
    }
    setStatus("loading");
    setMessage("");
    try {
      const res = await fetch("/api/ndtp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dropoff_id: dropoffId, note }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus("error");
        setMessage(data.error ?? "Có lỗi xảy ra. Vui lòng thử lại.");
        return;
      }
      setStatus("success");
      setMessage(`Đã gửi yêu cầu lấy mẫu (Job #${data.job_id ?? "?"}).`);
      setDropoffId("");
      setNote("");
    } catch {
      setStatus("error");
      setMessage("Không thể kết nối. Vui lòng thử lại.");
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 w-full max-w-md p-6 space-y-5">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Yêu cầu lấy mẫu</h1>
          <p className="text-sm text-gray-500 mt-1">Nơi lấy: {NDTP_PICKUP.name}</p>
        </div>

        <div className="space-y-1">
          <label htmlFor="dropoff" className="text-sm font-medium text-gray-700">Nơi giao</label>
          <select
            id="dropoff"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={dropoffId}
            onChange={(e) => setDropoffId(e.target.value)}
          >
            <option value="">Chọn nơi giao...</option>
            {NDTP_DROPOFFS.map((d) => (
              <option key={d.customer_id} value={d.customer_id}>
                {d.name.replace(/^NDTP - /, "")}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label htmlFor="note" className="text-sm font-medium text-gray-700">Ghi chú (không bắt buộc)</label>
          <textarea
            id="note"
            rows={2}
            maxLength={500}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Người yêu cầu, số lượng mẫu..."
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

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
    </div>
  );
}
