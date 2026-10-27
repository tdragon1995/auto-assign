"use client";

/**
 * "Giao Kết Quả / Vật Tư": the PSC picks clients, says per client whether it is
 * results or supplies, adds a note and photos/files, and gets one trip each, PSC →
 * client, waiting for the dispatcher (/api/psc-delivery). Photos are shrunk here
 * exactly as in "Cập nhật công". Below it, what this PSC booked on the page's day and
 * where each is now (Booked).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, Package, Paperclip, Plus, RefreshCw, Search, Send, X } from "lucide-react";
import { shrink } from "@/components/correction-form";
import { MAX_PROOF_BYTES, MAX_PROOF_FILES } from "@/lib/pay-corrections";
import { placeLabel } from "@/lib/place-label";

/** How long a booking with photos may take before it is sent again without them. */
const PHOTO_WAIT_MS = 15_000;

const bytesOf = (dataUrl: string) => Math.floor((dataUrl.length - dataUrl.indexOf(",") - 1) * 3 / 4);

/**
 * A photo redrawn smaller and smaller until it fits `budget` bytes. Decoded with
 * createImageBitmap first — it reads camera shots the plain <img> path sometimes
 * cannot, which then went up full size — and with `shrink` (the <img> path) after.
 * A PDF, or a photo neither can draw, comes back as it is.
 */
async function fit(file: File, budget: number): Promise<{ name: string; dataUrl: string }> {
  if (!file.type.startsWith("image/") || typeof createImageBitmap !== "function") return shrink(file);
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(file); } catch { return shrink(file); }
  const name = file.name.replace(/\.\w+$/, "") + ".jpg";
  let dataUrl = "";
  for (const [side, q] of [[1600, 0.8], [1280, 0.7], [1024, 0.6], [800, 0.5], [640, 0.45]] as const) {
    const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    dataUrl = c.toDataURL("image/jpeg", q);
    if (bytesOf(dataUrl) <= budget) break;
  }
  bmp.close();
  return { name, dataUrl };
}

interface Customer { customer_id: string; customer_name: string; address_line_1?: string | null }
const KINDS = [["KQ", "Kết quả"], ["VT", "Vật tư"], ["KV", "Kết quả + Vật tư"]] as const;
interface Row { c: Customer; kind: (typeof KINDS)[number][0]; note: string; files: File[] }

interface Booking { bid: string; ts: string; client: string; text: string; note: string; links?: string[]; status: string; tone: "wait" | "move" | "done" | "off"; job: number | null; cancellable: boolean }

/** One booked photo, opening full size; a file that is not a picture (a PDF) shows as a link. */
function Thumb({ url, n }: { url: string; n: number }) {
  const [broken, setBroken] = useState(false);
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`Mở ảnh ${n}`}
      className="block w-14 h-14 shrink-0 rounded-lg overflow-hidden border border-slate-200 bg-slate-50">
      {broken
        ? <span className="flex w-full h-full items-center justify-center text-[11px] font-semibold text-blue-700">Tệp {n}</span>
        // eslint-disable-next-line @next/next/no-img-element
        : <img src={url} alt={`Ảnh ${n}`} loading="lazy" onError={() => setBroken(true)} className="w-full h-full object-cover" />}
    </a>
  );
}
const TONE = { wait: "text-amber-700", move: "text-blue-700", done: "text-green-700", off: "text-slate-500" } as const;

/** This PSC's KQ/VT bookings for `date`. Read when the page opens or the day changes,
 *  after a booking, and on the refresh button — no polling, like the rest of /qr. */
function Booked({ list, loading, onRefresh, onCancel, cancelling, error }: {
  list: Booking[]; loading: boolean; onRefresh: () => void; onCancel: (b: Booking) => void; cancelling: string; error: string;
}) {
  if (list.length === 0) return null;
  return (
    <div className="bg-white rounded-2xl shadow-sm p-4 mb-5">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-[15px] font-bold text-slate-800">KQ / VT đã gửi ({list.length})</h2>
        <button aria-label="Tải lại" onClick={onRefresh} disabled={loading} className="p-2 -m-2 text-slate-500 disabled:opacity-50">
          <RefreshCw aria-hidden className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>
      {error && <p role="alert" className="text-sm font-medium text-red-700 bg-red-50 border border-red-200 rounded-xl p-3 my-2">{error}</p>}
      <ul className="divide-y divide-slate-100">
        {list.map((b) => (
          <li key={b.bid} className="py-2.5 flex gap-3">
            <span className="w-10 shrink-0 text-xs tabular-nums text-slate-500 pt-0.5">{b.ts}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-slate-800 break-words">{b.client}</p>
              <p className="text-xs text-slate-600 break-words">{b.text}{b.note ? ` — ${b.note}` : ""}</p>
              <p className={`text-xs font-semibold ${TONE[b.tone]}`}>{b.status}{b.job ? ` · Job ${b.job}` : ""}</p>
              {!!b.links?.length && (
                <div className="flex gap-1.5 mt-1.5 flex-wrap">{b.links.map((u, i) => <Thumb key={u} url={u} n={i + 1} />)}</div>
              )}
            </div>
            {b.cancellable && (
              <button onClick={() => onCancel(b)} disabled={!!cancelling}
                className="self-center shrink-0 min-h-[40px] px-3 rounded-lg border border-red-200 text-sm font-semibold text-red-700 active:bg-red-50 disabled:opacity-50 inline-flex items-center gap-1">
                {cancelling === b.bid && <Loader2 aria-hidden className="w-3.5 h-3.5 animate-spin" />}Huỷ
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DeliveryBooking({ pickup, date }: { pickup: string; date: string }) {
  const [booked, setBooked] = useState<Booking[]>([]);
  const [bookedLoading, setBookedLoading] = useState(false);
  const loadBooked = useCallback(async () => {
    setBookedLoading(true);
    try {
      const r = await fetch(`/api/psc-delivery?booked=${encodeURIComponent(pickup)}&date=${date}`);
      const j = await r.json();
      if (r.ok) setBooked(j.bookings ?? []);
    } catch { /* offline: keep what is shown */ }
    finally { setBookedLoading(false); }
  }, [pickup, date]);
  useEffect(() => { setBooked([]); void loadBooked(); }, [loadBooked]);
  const [cancelling, setCancelling] = useState("");
  const [cancelError, setCancelError] = useState("");
  const cancel = async (b: Booking) => {
    if (!window.confirm(`Huỷ ${b.text} cho ${b.client}?`)) return;
    setCancelling(b.bid); setCancelError("");
    try {
      const r = await fetch(`/api/psc-delivery?booked=${encodeURIComponent(pickup)}&date=${date}&bid=${b.bid}`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setCancelError(j.error ?? "Huỷ thất bại, vui lòng thử lại.");
    } catch {
      setCancelError("Huỷ thất bại. Kiểm tra mạng rồi thử lại.");
    } finally {
      setCancelling("");
      // Refused or not, the list is re-read: a refusal usually means the item moved on.
      void loadBooked();
    }
  };

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Customer[]>([]);
  const [searching, setSearching] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
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

  /**
   * "Đã gửi" at once; everything after runs in the background (supervisor, 2026-10-25:
   * the PSC should neither wait nor hear about photos). Photos are best effort: shrunk,
   * dropped if they cannot be made small, and dropped altogether when sending them is
   * slow. Only a booking that could not be sent at all brings the form back.
   */
  const submit = () => {
    const snapshot = rows;
    setError("");
    setSent(rows.map((r) => placeLabel(r.c.customer_name)));
    setRows([]);
    void (async () => {
      let why = "Không gửi được yêu cầu. Kiểm tra mạng rồi thử lại.";
      try {
        const count = snapshot.reduce((n, r) => n + r.files.length, 0);
        // ~300 KB a photo at most: readable, and small enough to go in time. Past
        // ~4.5 MB a request is dropped with no answer at all.
        const budget = Math.min(300_000, Math.floor(MAX_PROOF_BYTES * 0.9 / Math.max(1, count)));
        const deliveries = await Promise.all(snapshot.map(async (r) => ({
          customer_id: r.c.customer_id, kind: r.kind, note: r.note,
          // A file that stays too big (a PDF, a photo the phone cannot read) is left off.
          files: (await Promise.all(r.files.map((f) => fit(f, budget).catch(() => null))))
            .filter((f): f is { name: string; dataUrl: string } => !!f && bytesOf(f.dataUrl) <= budget),
        })));
        const post = (body: unknown, signal?: AbortSignal) => fetch("/api/psc-delivery", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
        });
        // The upload link can be very slow (2026-10-25: 160 KB took 17 s to 8 min).
        // Past PHOTO_WAIT_MS the booking goes again WITHOUT photos. If the first got
        // through after all, the double-booking lock answers 409: already booked.
        const photos = deliveries.some((d) => d.files.length);
        let res: Response | null = null;
        if (photos) {
          const ac = new AbortController();
          const t = setTimeout(() => ac.abort(), PHOTO_WAIT_MS);
          res = await post({ pickup, deliveries }, ac.signal).catch(() => null);
          clearTimeout(t);
        }
        if (!res) {
          res = await post({ pickup, deliveries: deliveries.map((d) => ({ ...d, files: [] })) });
          if (photos && res.status === 409) res = new Response("{}", { status: 202 });
        }
        if (!res.ok) {
          why = (await res.json().catch(() => ({}))).error ?? "Không gửi được yêu cầu.";
          throw new Error(why);
        }
        // The trips are made in the background; give them a moment before reading back.
        setTimeout(() => void loadBooked(), 5000);
      } catch {
        // The booking itself did not go: put it back so nothing is lost without a word.
        setRows((cur) => [...snapshot, ...cur]);
        setSent([]);
        setOpen(true);
        setError(why);
      }
    })();
  };

  const list = <Booked list={booked} loading={bookedLoading} onRefresh={() => void loadBooked()} onCancel={cancel} cancelling={cancelling} error={cancelError} />;

  if (!open) {
    return (<>
      <button onClick={() => setOpen(true)}
        className="w-full rounded-2xl py-3.5 mb-5 bg-white shadow-sm text-blue-700 text-base font-bold flex items-center justify-center gap-2 active:scale-[.97] transition">
        <Package aria-hidden className="w-5 h-5" />Đề nghị Giao kết quả / vật tư
      </button>
      {list}
    </>);
  }

  return (<>
    <div className="bg-white rounded-2xl shadow-sm p-4 mb-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-bold text-slate-800">Đề nghị Giao kết quả / vật tư</h2>
        <button aria-label="Đóng" onClick={() => { setOpen(false); setSent([]); }} className="p-2 -m-2 text-slate-500"><X className="w-5 h-5" /></button>
      </div>

      {sent.length > 0 ? (<>
        <div role="status" className="text-sm text-green-800 bg-green-50 border border-green-200 rounded-xl p-3 space-y-1">
          <p className="font-bold flex items-center gap-1.5"><Check aria-hidden className="w-4 h-4" />Đã gửi {sent.length} yêu cầu</p>
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
        <button onClick={submit}
          className="w-full min-h-[48px] rounded-xl bg-blue-700 text-white font-bold inline-flex items-center justify-center gap-2 disabled:opacity-60">
          <Send aria-hidden className="w-4 h-4" />
          Gửi {rows.length} chuyến
        </button>
      )}
      </>)}
    </div>
    {list}
  </>);
}
