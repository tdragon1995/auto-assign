"use client";

import { useState } from "react";
import { Loader2, Download, AlertCircle } from "lucide-react";

interface VidRow {
  vid: string;
  branch_code?: string | null;
  client_id?: string | null;
  client_name?: string | null;
  patient_name?: string | null;
  remark?: string | null;
  dest?: string | null;
  dest_from_remark?: boolean;
  error?: string;
}

interface Group {
  dest: string;
  count: number;
  clients: { name: string; rows: VidRow[] }[];
}

const MAX_VIDS = 100;
const HUB = "D001";

function groupRows(rows: VidRow[]): Group[] {
  const sorted = [...rows].sort((a, b) =>
    (a.dest ?? "").localeCompare(b.dest ?? "")
    || (a.client_name ?? "").localeCompare(b.client_name ?? "", "vi")
    || a.vid.localeCompare(b.vid));
  const byDest = new Map<string, Map<string, VidRow[]>>();
  for (const r of sorted) {
    const dest = r.dest ?? "—";
    const client = r.client_name ?? `Client ${r.client_id ?? "?"}`;
    const clients = byDest.get(dest) ?? byDest.set(dest, new Map()).get(dest)!;
    clients.set(client, [...(clients.get(client) ?? []), r]);
  }
  return [...byDest].map(([dest, clients]) => ({
    dest,
    count: [...clients.values()].reduce((n, rs) => n + rs.length, 0),
    clients: [...clients].map(([name, rows]) => ({ name, rows })),
  }));
}

/** Why a row's destination is the order's branch rather than the remark — null when the remark decided. */
const fallbackReason = (r: VidRow) =>
  r.dest_from_remark ? null : r.remark ? `Ghi chú không rõ nơi gửi: “${r.remark}”` : "Không có ghi chú bản cứng";

async function downloadList(title: string, groups: Group[]) {
  const XLSX = await import("xlsx");
  const day = new Date().toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
  const aoa: (string | number)[][] = [
    [`BÀN GIAO KẾT QUẢ BẢN CỨNG — ${title} — ${day}`],
    [],
    ["STT", "Gửi về", "Khách hàng", "VID", "Bệnh nhân", "Ghi chú", "Đã nhận"],
  ];
  let n = 0;
  for (const g of groups) for (const c of g.clients) for (const r of c.rows) {
    const reason = fallbackReason(r);
    aoa.push([++n, g.dest, c.name, r.vid, r.patient_name ?? "", reason ? `Theo chi nhánh ${r.branch_code ?? "?"} — ${reason}` : "", "☐"]);
  }
  aoa.push([], [`Tổng: ${n} hồ sơ`], [], ["Người giao:", "", "", "Người nhận:", "", "Thời gian:"]);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [{ wch: 5 }, { wch: 8 }, { wch: 36 }, { wch: 14 }, { wch: 26 }, { wch: 30 }, { wch: 8 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Bàn giao");
  const stamp = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" });
  XLSX.writeFile(wb, `ban-giao-ban-cung_${title.replace(/\s+/g, "-")}_${stamp}.xlsx`);
}

function HandoverList({ title, groups }: { title: string; groups: Group[] }) {
  const total = groups.reduce((n, g) => n + g.count, 0);
  return (
    <section className="bg-white rounded-2xl shadow-sm p-4 space-y-3 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-bold text-slate-800">
          {title} <span className="text-slate-500">({total})</span>
        </h2>
        <button
          onClick={() => downloadList(title, groups)}
          disabled={!total}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold text-blue-700 border border-blue-200 active:bg-blue-50 disabled:opacity-40"
        >
          <Download aria-hidden className="w-4 h-4" />Tải về
        </button>
      </div>
      {!total && <p className="text-sm text-slate-500 text-center py-4">Không có hồ sơ.</p>}
      {groups.map((g) => (
        <div key={g.dest}>
          <p className="text-sm font-extrabold text-slate-900 bg-slate-100 rounded-lg px-2.5 py-1.5">
            Gửi về {g.dest} · {g.count}
          </p>
          {g.clients.map((c) => (
            <div key={c.name} className="mt-2 px-1">
              <p className="text-xs font-bold text-slate-700">{c.name} · {c.rows.length}</p>
              <ul className="mt-1 divide-y divide-slate-100">
                {c.rows.map((r) => {
                  const reason = fallbackReason(r);
                  return (
                    <li key={r.vid} className="py-1.5 text-xs flex gap-2">
                      <span className="font-mono text-slate-700 shrink-0">{r.vid}</span>
                      <span className="flex-1 min-w-0 text-slate-800">
                        {r.patient_name ?? "—"}
                        {reason && (
                          <span className="flex items-start gap-1 text-amber-700 mt-0.5">
                            <AlertCircle aria-hidden className="w-3.5 h-3.5 shrink-0" />
                            <span>{reason} — tạm theo chi nhánh {r.branch_code ?? "?"}</span>
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

export function HardCopyHandover() {
  const [text, setText] = useState("");
  const [rows, setRows] = useState<VidRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const vids = [...new Set(text.split(/\D+/).filter(Boolean))];
  const tooMany = vids.length > MAX_VIDS;

  const lookup = async () => {
    if (!vids.length || tooMany || loading) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/labcenter/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vids }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? "Tra cứu thất bại"); setRows([]); }
      else setRows(data.results ?? []);
    } catch {
      setError("Không thể kết nối. Vui lòng thử lại.");
    } finally {
      setLoading(false);
    }
  };

  const found = rows.filter((r) => !r.error);
  const failed = rows.filter((r) => r.error);

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl shadow-sm p-4 space-y-3 max-w-[430px] mx-auto">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Dán danh sách VID, mỗi dòng một số"
          rows={5}
          aria-label="Danh sách VID"
          className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-700 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400"
        />
        <p className={`text-xs ${tooMany ? "text-red-600 font-semibold" : "text-slate-500"}`}>
          {vids.length} VID{tooMany ? ` — tối đa ${MAX_VIDS} mỗi lần` : ""}
        </p>
        <button
          onClick={lookup}
          disabled={loading || !vids.length || tooMany}
          className="w-full rounded-xl py-3 text-white text-sm font-bold flex items-center justify-center gap-2 bg-blue-700 active:scale-[.97] transition disabled:opacity-40"
        >
          {loading ? <><Loader2 aria-hidden className="w-4 h-4 animate-spin" />Đang tra cứu {vids.length} VID…</> : "Tra cứu"}
        </button>
        {error && <p role="alert" className="text-xs text-red-600 font-medium">{error}</p>}
      </div>

      {failed.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-xs text-red-800 space-y-1">
          <p className="font-bold">Không tra được ({failed.length})</p>
          {[...new Set(failed.map((r) => r.error))].map((err) => (
            <p key={err}>
              {err}: <span className="font-mono break-words">{failed.filter((r) => r.error === err).map((r) => r.vid).join(", ")}</span>
            </p>
          ))}
        </div>
      )}

      {rows.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 items-start">
          <HandoverList title={HUB} groups={groupRows(found.filter((r) => r.dest === HUB))} />
          <HandoverList title={`Ngoài ${HUB}`} groups={groupRows(found.filter((r) => r.dest !== HUB))} />
        </div>
      )}
    </div>
  );
}
