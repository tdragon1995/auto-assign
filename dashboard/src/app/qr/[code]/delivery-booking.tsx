"use client";

/**
 * "Giao Kết Quả / Vật Tư": the PSC picks clients, says per client whether it is
 * results or supplies, adds a note and photos/files, and gets one trip each, PSC →
 * client, waiting for the dispatcher (/api/psc-delivery). Photos are shrunk here
 * exactly as in "Cập nhật công".
 */
import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Package, Paperclip, Plus, Search, Send, X } from "lucide-react";
import { shrink } from "@/components/correction-form";
import { MAX_PROOF_FILES } from "@/lib/pay-corrections";
import { placeLabel } from "@/lib/place-label";

interface Customer { customer_id: string; customer_name: string; address_line_1?: string | null }
const KINDS = [["KQ", "Kết quả"], ["VT", "Vật tư"], ["KV", "Kết quả + Vật tư"]] as const;
interface Row { c: Customer; kind: (typeof KINDS)[number][0]; note: string; files: File[] }

export function DeliveryBooking({ pickup }: { pickup: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Customer[]>([]);
  const [searching, setSearching] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Names of the clients just sent. The server answers before the trips exist (they
  // are created in the background), so this is the whole confirmation.
  const [sent, setSent] = useState<string[]>([]);

  // Searches already answered on this page, so going back to one costs nothing.
  const seen = useRef(new Map<string, Customer[]>());

  // 3 letters and a 600 ms pause before asking: each ask is a server call, and the
  // first one on a cold server loads the whole client list from Cartrack (~6s).
  useEffect(() => {
    const key = q.trim().toLowerCase();
    if (key.length < 3) { setHits([]); setSearching(false); return; }
    const known = seen.current.get(key);
    if (known) { setHits(known); setSearching(false); return; }
    // Spinner from the first keystroke, so "not found" never flashes during the pause.
    setSearching(true);
    const ac = new AbortController();
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/psc-delivery?q=${encodeURIComponent(key)}`, { signal: ac.signal });
        const j = await r.json();
        if (r.ok) seen.current.set(key, j.customers ?? []);
        setHits(j.customers ?? []);
      } catch { /* aborted or offline: keep the last hits */ }
      finally { if (!ac.signal.aborted) setSearching(false); }
    }, 600);
    return () => { clearTimeout(t); ac.abort(); };
  }, [q]);

  const set = (i: number, patch: Partial<Row>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const add = (c: Customer) => {
    if (!rows.some((r) => r.c.customer_id === c.customer_id)) setRows([...rows, { c, kind: "KQ", note: "", files: [] }]);
    setQ(""); setHits([]);
  };

  const submit = async () => {
    setBusy(true); setError("");
    try {
      const deliveries = await Promise.all(rows.map(async (r) => ({
        customer_id: r.c.customer_id, kind: r.kind, note: r.note, files: await Promise.all(r.files.map(shrink)),
      })));
      const res = await fetch("/api/psc-delivery", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pickup, deliveries }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j.error ?? "Không gửi được yêu cầu."); return; }
      setSent(rows.map((r) => placeLabel(r.c.customer_name)));
      setRows([]);
    } catch {
      setError("Không gửi được yêu cầu. Kiểm tra mạng rồi thử lại.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="w-full rounded-2xl py-3.5 mb-5 bg-white shadow-sm text-blue-700 text-base font-bold flex items-center justify-center gap-2 active:scale-[.97] transition">
        <Package aria-hidden className="w-5 h-5" />Đề nghị Giao kết quả / vật tư
      </button>
    );
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm p-4 mb-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-bold text-slate-800">Đề nghị Giao kết quả / vật tư</h2>
        <button aria-label="Đóng" onClick={() => { setOpen(false); setSent([]); }} className="p-2 -m-2 text-slate-500"><X className="w-5 h-5" /></button>
      </div>

      {sent.length > 0 ? (<>
        <div role="status" className="text-sm text-green-800 bg-green-50 border border-green-200 rounded-xl p-3 space-y-1">
          <p className="font-bold flex items-center gap-1.5"><Check aria-hidden className="w-4 h-4" />Đã gửi {sent.length} chuyến — chờ điều phối</p>
          {sent.map((n, i) => <p key={i} className="pl-5.5">{n}</p>)}
        </div>
        <button onClick={() => setSent([])}
          className="w-full min-h-[48px] rounded-xl bg-blue-700 text-white font-bold inline-flex items-center justify-center gap-2">
          <Plus aria-hidden className="w-4 h-4" />Đề nghị chuyến khác
        </button>
      </>) : (<>

      <div className="relative">
        <Search aria-hidden className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm khách hàng (tên hoặc địa chỉ)"
          className="w-full rounded-xl border border-slate-300 pl-9 pr-9 py-2.5 text-sm" />
        {searching && <Loader2 aria-hidden className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-slate-400" />}
      </div>
      {hits.length > 0 && (
        <ul className="border border-slate-200 rounded-xl divide-y divide-slate-100 max-h-64 overflow-y-auto">
          {hits.map((c) => (
            <li key={c.customer_id}>
              <button onClick={() => add(c)} className="w-full text-left px-3 py-2.5 active:bg-slate-50">
                <div className="text-sm font-semibold text-slate-800">{c.customer_name}</div>
                {c.address_line_1 && <div className="text-xs text-slate-500 break-words">{c.address_line_1}</div>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {q.trim().length >= 3 && !searching && hits.length === 0 && <p className="text-xs text-slate-500">Không tìm thấy khách hàng.</p>}

      {rows.map((r, i) => (
        <div key={r.c.customer_id} className="border border-slate-200 rounded-xl p-3 space-y-2">
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold text-slate-800">{r.c.customer_name}</div>
              {r.c.address_line_1 && <div className="text-xs text-slate-500 break-words">{r.c.address_line_1}</div>}
            </div>
            <button aria-label="Bỏ khách hàng" onClick={() => setRows(rows.filter((_, k) => k !== i))} className="p-2 -m-1 text-slate-500"><X className="w-4 h-4" /></button>
          </div>
          <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 rounded-lg" role="radiogroup">
            {KINDS.map(([k, label]) => (
              <button key={k} role="radio" aria-checked={r.kind === k} onClick={() => set(i, { kind: k })}
                className={`min-h-[40px] px-1 rounded-md text-sm leading-tight font-semibold ${r.kind === k ? "bg-white shadow-sm text-blue-700" : "text-slate-600"}`}>
                {label}
              </button>
            ))}
          </div>
          <textarea value={r.note} maxLength={300} onChange={(e) => set(i, { note: e.target.value })} placeholder="Ghi chú cho tài xế"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm min-h-[56px]" />
          {r.files.map((f, k) => (
            <div key={k} className="flex items-center gap-2 text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5">
              <Paperclip aria-hidden className="w-3 h-3 shrink-0 text-slate-400" />
              <span className="truncate flex-1">{f.name}</span>
              <button aria-label="Bỏ ảnh" className="p-2 -m-1 text-slate-500" onClick={() => set(i, { files: r.files.filter((_, n) => n !== k) })}><X className="w-3.5 h-3.5" /></button>
            </div>
          ))}
          {r.files.length < MAX_PROOF_FILES && (
            <label className="flex items-center justify-center gap-1.5 min-h-[44px] text-xs font-semibold text-blue-700 border border-dashed border-blue-300 rounded-lg cursor-pointer">
              <Paperclip aria-hidden className="w-3.5 h-3.5" /> Chụp / chọn ảnh hoặc tệp
              <input type="file" accept="image/*,application/pdf" multiple className="sr-only"
                onChange={(e) => { set(i, { files: [...r.files, ...Array.from(e.target.files ?? [])].slice(0, MAX_PROOF_FILES) }); e.target.value = ""; }} />
            </label>
          )}
        </div>
      ))}
      {rows.some((r) => r.files.length) && <p className="text-[11px] text-slate-500">Ảnh được gửi cho tài xế bằng đường dẫn công khai — không gửi giấy tờ cá nhân.</p>}

      {error && <p role="alert" className="text-sm font-medium text-red-700 bg-red-50 border border-red-200 rounded-xl p-3">{error}</p>}
      {rows.length > 0 && (
        <button onClick={submit} disabled={busy}
          className="w-full min-h-[48px] rounded-xl bg-blue-700 text-white font-bold inline-flex items-center justify-center gap-2 disabled:opacity-60">
          {busy ? <Loader2 aria-hidden className="w-4 h-4 animate-spin" /> : <Send aria-hidden className="w-4 h-4" />}
          Gửi {rows.length} chuyến
        </button>
      )}
      </>)}
    </div>
  );
}
