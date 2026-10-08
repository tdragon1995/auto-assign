"use client";

/**
 * "Cập nhật công" — the driver's form in Thu Nhập. Two reasons from a dropdown:
 *
 *   Quên / chưa biết chấm công — proof optional; the day's completed stops are
 *                                the evidence the supervisor checks against.
 *   Lỗi hệ thống               — a screenshot of the error is REQUIRED.
 *
 * Photos are shrunk HERE (longest side 1600 px, JPEG) before sending: a phone
 * photo is 3–6 MB, the request limit is 4.5 MB, and a screenshot of an error
 * stays perfectly readable at a few hundred KB. The same rules are checked again
 * on the server (lib/pay-corrections.ts).
 */
import { useState } from "react";
import { Loader2, Paperclip, X } from "lucide-react";
import { openRange, checkTimes, checkProof, MAX_PROOF_FILES, type DriverReason } from "@/lib/pay-corrections";

const shrink = (file: File): Promise<{ name: string; dataUrl: string }> =>
  new Promise((resolve, reject) => {
    const read = () => {
      const r = new FileReader();
      r.onload = () => resolve({ name: file.name, dataUrl: String(r.result) });
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    };
    if (!file.type.startsWith("image/")) return read();   // PDF: as is
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const k = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
      resolve({ name: file.name.replace(/\.\w+$/, "") + ".jpg", dataUrl: c.toDataURL("image/jpeg", 0.8) });
    };
    // A format the browser cannot draw (some HEIC) goes as it is; the server decides.
    img.onerror = () => { URL.revokeObjectURL(url); read(); };
    img.src = url;
  });

export function CorrectionForm({
  today, date: presetDate, defaultIn, defaultOut, onDone, onCancel,
}: {
  today: string;
  date?: string;
  defaultIn?: string | null;
  defaultOut?: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const range = openRange(today);
  const [date, setDate] = useState(presetDate ?? range.to);
  const [reason, setReason] = useState<DriverReason | "">("");
  const [inTime, setInTime] = useState(defaultIn ?? "");
  const [outTime, setOutTime] = useState(defaultOut ?? "");
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    const fail = checkTimes({ date, in_time: inTime, out_time: outTime, note }, today)
      ?? checkProof(reason, files.map((f) => ({ name: f.name, dataUrl: "data:image/jpeg;base64,AA==" })));
    if (fail) { setError(fail); return; }
    setBusy(true);
    try {
      const proof = await Promise.all(files.map(shrink));
      const bad = checkProof(reason, proof);
      if (bad) { setError(bad); return; }
      const res = await fetch("/api/pay/me/correction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, reason, in_time: inTime, out_time: outTime, note, files: proof }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setError(j.error ?? "Không gửi được yêu cầu."); return; }
      onDone();
    } catch {
      setError("Không kết nối được máy chủ.");
    } finally {
      setBusy(false);
    }
  }

  const field = "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm min-h-[44px] bg-white";
  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-3 space-y-3">
      <p className="text-sm font-semibold text-gray-800">Cập nhật công</p>

      {!presetDate && (
        <label className="block space-y-1">
          <span className="text-xs text-gray-600">Ngày</span>
          <input type="date" className={field} min={range.from} max={range.to} value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      )}

      <label className="block space-y-1">
        <span className="text-xs text-gray-600">Lý do</span>
        <select className={field} value={reason} onChange={(e) => setReason(e.target.value as DriverReason | "")}>
          <option value="">— Chọn lý do —</option>
          <option value="forgot_tap">Quên / chưa biết chấm công</option>
          <option value="system_error">Lỗi hệ thống</option>
        </select>
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1">
          <span className="text-xs text-gray-600">Giờ vào</span>
          <input type="time" className={field} value={inTime} onChange={(e) => setInTime(e.target.value)} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-gray-600">Giờ ra</span>
          <input type="time" className={field} value={outTime} onChange={(e) => setOutTime(e.target.value)} />
        </label>
      </div>

      <label className="block space-y-1">
        <span className="text-xs text-gray-600">Ghi chú</span>
        <textarea className={`${field} min-h-[64px]`} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)}
          placeholder={reason === "system_error" ? "Lỗi xảy ra khi nào, ở màn hình nào" : "Đã làm ở đâu, từ mấy giờ"} />
      </label>

      <div className="space-y-1.5">
        <span className="text-xs text-gray-600">
          Ảnh minh chứng {reason === "system_error" ? <b className="text-gray-800">(bắt buộc — ảnh chụp màn hình lỗi)</b> : "(không bắt buộc)"}
        </span>
        {files.map((f, i) => (
          <div key={i} className="flex items-center gap-2 text-xs text-gray-700 bg-white border border-gray-200 rounded-lg px-2 py-1.5">
            <Paperclip size={12} className="shrink-0 text-gray-400" />
            <span className="truncate flex-1">{f.name}</span>
            <button aria-label="Bỏ ảnh" className="p-2 -m-1 text-gray-500" onClick={() => setFiles(files.filter((_, k) => k !== i))}>
              <X size={14} />
            </button>
          </div>
        ))}
        {files.length < MAX_PROOF_FILES && (
          <label className="flex items-center justify-center gap-1.5 min-h-[44px] text-xs font-semibold text-blue-700 border border-dashed border-blue-300 rounded-lg cursor-pointer bg-white">
            <Paperclip size={14} /> Thêm ảnh
            <input type="file" accept="image/*,application/pdf" multiple className="sr-only"
              onChange={(e) => { setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, MAX_PROOF_FILES)); e.target.value = ""; }} />
          </label>
        )}
        <p className="text-[11px] text-gray-500">Ảnh được lưu bằng đường dẫn công khai — không gửi ảnh giấy tờ cá nhân.</p>
      </div>

      {error && <p role="alert" className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

      <div className="flex gap-2">
        <button onClick={onCancel} disabled={busy} className="flex-1 min-h-[44px] text-sm font-semibold text-gray-700 border border-gray-300 rounded-lg bg-white">
          Huỷ
        </button>
        <button onClick={submit} disabled={busy} className="flex-1 min-h-[44px] text-sm font-semibold text-white bg-blue-600 rounded-lg inline-flex items-center justify-center gap-1.5 disabled:opacity-60">
          {busy && <Loader2 size={14} className="animate-spin" />} Gửi duyệt
        </button>
      </div>
    </div>
  );
}

const STATUS: Record<string, { text: string; cls: string }> = {
  pending: { text: "Chờ duyệt", cls: "bg-amber-50 text-amber-800 border-amber-200" },
  approved: { text: "Đã duyệt", cls: "bg-green-50 text-green-800 border-green-200" },
  rejected: { text: "Từ chối", cls: "bg-red-50 text-red-800 border-red-200" },
};

/** The day's latest request, as a chip on its row. */
export function CorrectionChip({ status }: { status: string }) {
  const s = STATUS[status];
  return s ? <span className={`ml-1.5 inline-block text-[11px] font-semibold border rounded px-1.5 py-px ${s.cls}`}>{s.text}</span> : null;
}
