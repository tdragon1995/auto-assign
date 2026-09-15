"use client";

import { useMemo, useState } from "react";
import { NDTP_DROPOFFS } from "@/lib/ndtp";
import { foldName } from "@/lib/driver-cell";

const shortName = (name: string) => name.replace(/^NDTP - /, "");

export default function NdtpPage() {
  const [dropoffId, setDropoffId] = useState("");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  const matches = useMemo(() => {
    const q = foldName(search.trim());
    return q ? NDTP_DROPOFFS.filter((d) => foldName(d.name).includes(q)) : NDTP_DROPOFFS;
  }, [search]);

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
      setMessage(`Đã gửi yêu cầu (Job #${data.job_id ?? "?"}).`);
      setDropoffId("");
      setSearch("");
      setNote("");
    } catch {
      setStatus("error");
      setMessage("Không thể kết nối. Vui lòng thử lại.");
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 w-full max-w-md p-6 space-y-5">
        <header className="border-b-4 border-[#1f5fc4] pb-3">
          <p className="text-sm font-bold text-[#1f4fa8] leading-tight">BỆNH VIỆN</p>
          <p className="text-xl font-extrabold text-[#1f4fa8] leading-tight">NHI ĐỒNG THÀNH PHỐ</p>
        </header>

        <h1 className="text-xl font-bold text-gray-900">Gửi mẫu</h1>

        <div className="space-y-1 relative">
          <label htmlFor="dropoff" className="text-sm font-medium text-gray-700">Nơi giao</label>
          <div className="relative">
            <input
              id="dropoff"
              type="text"
              role="combobox"
              aria-expanded={open && !dropoffId}
              aria-controls="dropoff-list"
              autoComplete="off"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Tìm nơi giao..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setDropoffId(""); setOpen(true); }}
              onFocus={() => setOpen(true)}
              onBlur={() => setTimeout(() => setOpen(false), 150)}
            />
            {search && (
              <button
                aria-label="Xoá nơi giao"
                className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-gray-400 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                onMouseDown={(e) => { e.preventDefault(); setSearch(""); setDropoffId(""); }}
              >
                ×
              </button>
            )}
          </div>
          {open && !dropoffId && (
            <ul id="dropoff-list" role="listbox" className="absolute z-10 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-y-auto mt-1">
              {matches.length === 0 && <li className="px-3 py-2 text-sm text-gray-400">Không tìm thấy</li>}
              {matches.map((d) => (
                <li
                  key={d.customer_id}
                  role="option"
                  aria-selected={false}
                  className="px-3 py-2 text-sm hover:bg-blue-50 cursor-pointer"
                  onMouseDown={() => { setDropoffId(d.customer_id); setSearch(shortName(d.name)); setOpen(false); }}
                >
                  {shortName(d.name)}
                </li>
              ))}
            </ul>
          )}
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
