"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Download, AlertCircle, Printer, Check, X, RefreshCw } from "lucide-react";
import { parsePaste, billingFound, stripPatient, pendingFor, statusLabel, displayClientName, printRowKey, statusLookupVids, type PasteLine, type PrintDraftRow, type PrintHistory, type PrintHistorySummary, type TestEntry, type PendingTest } from "@/lib/handover";
import { vnDate } from "@/lib/time";

/** One order as the lookup route returns it. */
interface Order {
  vid: string;
  branch_code?: string | null;
  client_id?: string | null;
  client_name?: string | null;
  patient_name?: string | null;
  test_entries?: TestEntry[]; // every name a test (or a package part) goes by, with its LIS codes
  pending?: PendingTest[] | null; // tests without an approved result; null = status unreadable
  remark?: string | null;
  dest?: string | null;
  dest_from_remark?: boolean;
  error?: string;
}

/** One pasted line joined to its order. `billing_ok` is null when nothing was pasted for it. */
interface Row extends Order {
  key: string;
  billing: string;
  billing_ok: boolean | null;
  print_note?: string;
  /** Pending results this row stands for; null = the status could not be checked. */
  row_pending: PendingTest[] | null;
  status_checking?: boolean;
}

interface Group {
  dest: string;
  count: number;
  clients: { name: string; sourceName: string; rows: Row[] }[];
}

// Smaller chunks keep a 200-VID lookup below the route timeout and show progress sooner.
const CHUNK = 50;
const HUB = "D001";

function groupRows(rows: Row[]): Group[] {
  const sorted = [...rows].sort((a, b) =>
    (a.dest ?? "").localeCompare(b.dest ?? "")
    || (a.client_name ?? "").localeCompare(b.client_name ?? "", "vi")
    || a.vid.localeCompare(b.vid)
    || a.billing.localeCompare(b.billing, "vi"));
  const byDest = new Map<string, Map<string, Row[]>>();
  for (const r of sorted) {
    const dest = r.dest ?? "—";
    const client = r.client_name ?? `Client ${r.client_id ?? "?"}`;
    const clients = byDest.get(dest) ?? byDest.set(dest, new Map()).get(dest)!;
    clients.set(client, [...(clients.get(client) ?? []), r]);
  }
  return [...byDest].map(([dest, clients]) => ({
    dest,
    count: [...clients.values()].reduce((n, rs) => n + rs.length, 0),
    clients: [...clients].map(([sourceName, rows]) => ({ name: displayClientName(sourceName), sourceName, rows })),
  }));
}

/** Only a remark that exists but names no clear branch is worth flagging; no remark just means "use the branch". */
const unreadRemark = (r: Row) => (!r.dest_from_remark && r.remark ? `Ghi chú không rõ nơi gửi: “${r.remark}”` : null);

// Print and Excel carry the name only; the ✓/✗ check is for the screen.
const billingText = (r: Row) => r.billing;

const today = (locale: string) => new Date().toLocaleDateString(locale, { timeZone: "Asia/Ho_Chi_Minh" });
const fileStem = (title: string, printedAt?: string) => `ban-giao-ban-cung_${title.replace(/\s+/g, "-")}_${new Date(printedAt ?? Date.now()).toLocaleDateString("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" })}`;
const printDate = (printedAt?: string) => new Date(printedAt ?? Date.now()).toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });

const HEAD = ["STT", "Gửi về", "Khách hàng", "VID", "Bệnh nhân", "Xét nghiệm", "Ghi chú"];
const OPTIONAL = [5, 6]; // Xét nghiệm, Ghi chú — dropped when every row leaves them blank

/** The checklist table shared by print and Excel, minus optional columns nobody filled. */
function printRows(groups: Group[]): PrintDraftRow[] {
  return groups.flatMap((g) => g.clients.flatMap((c) => c.rows.map((r) => {
    const note = unreadRemark(r);
    return { dest: g.dest, client: c.name, vid: r.vid, patient: r.patient_name ?? "", billing: billingText(r), note: r.print_note ?? (note ? `Theo chi nhánh ${r.branch_code ?? "?"} — ${note}` : "") };
  })));
}

function checklist(groups: Group[]) {
  const rows = printRows(groups).map((r, i) => [i + 1, r.dest, r.client, r.vid, r.patient, r.billing, r.note]);
  const cols = HEAD.map((_, i) => i).filter((i) => !OPTIONAL.includes(i) || rows.some((r) => r[i]));
  return { cols, head: cols.map((i) => HEAD[i]), rows: rows.map((r) => cols.map((i) => r[i])) };
}

async function downloadExcel(title: string, groups: Group[]) {
  const XLSX = await import("xlsx");
  const { cols, head, rows } = checklist(groups);
  const aoa: (string | number)[][] = [
    [`BÀN GIAO KẾT QUẢ BẢN CỨNG — ${title}`], [`Ngày in: ${today("vi-VN")}`], [], [...head, "Đã nhận"],
    ...rows.map((r) => [...r, "☐"]),
    [], [`Tổng: ${rows.length} hồ sơ`], [], ["Người giao:", "", "", "Người nhận:", "", "Thời gian:"],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const widths = [5, 8, 36, 14, 26, 30, 30];
  ws["!cols"] = [...cols.map((i) => ({ wch: widths[i] })), { wch: 8 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Bàn giao");
  XLSX.writeFile(wb, `${fileStem(title)}.xlsx`);
}

const esc = (v: unknown) => String(v).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

/** A4 portrait checklist in a new window; the print dialog also offers "Save as PDF". */
function printA4(title: string, groups: Group[], autoPrint = true, printedAt?: string, target?: Window): boolean {
  const { cols, head, rows } = checklist(groups);
  let offset = 0;
  const body = groups.map((g) => {
    const groupRows = rows.slice(offset, offset + g.count);
    offset += g.count;
    return `<tbody class="psc">${groupRows.map((r, i) => `<tr>${r.map((v, j) => `<td class="c${cols[j]}">${esc(j === 0 ? i + 1 : v)}</td>`).join("")}<td class="box">☐</td></tr>`).join("")}</tbody>`;
  }).join("");
  const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>${esc(fileStem(title, printedAt))}</title><style>
@page { size: A4 portrait; margin: 12mm 10mm; }
* { box-sizing: border-box; }
body { font: 10.5pt/1.35 Arial, sans-serif; color: #000; margin: 0; }
h1 { font-size: 14pt; margin: 0 0 2mm; }
.meta { font-size: 10pt; margin-bottom: 4mm; }
table { width: 100%; border-collapse: collapse; border-left: 2pt solid #000; border-right: 2pt solid #000; }
thead { display: table-header-group; }
tbody.psc { page-break-inside: auto; }
tr { page-break-inside: avoid; }
th, td { border: 0.6pt solid #000; padding: 1.5mm 1.8mm; text-align: left; vertical-align: top; }
tbody.psc td { border-style: dotted; }
tbody.psc td:first-child { border-left: 2pt solid #000; }
tbody.psc td:last-child { border-right: 2pt solid #000; }
tbody.psc tr:first-child td { border-top: 2pt solid #000; }
tbody.psc tr:last-child td { border-bottom: 2pt solid #000; }
th { background: #eee; font-size: 9.5pt; }
thead th { border-top: 2pt solid #000; border-bottom: 2pt solid #000; font-weight: 700; }
.c0, .box { text-align: center; width: 9mm; }
.c1 { width: 14mm; font-weight: bold; }
.c3 { width: 26mm; font-family: Consolas, monospace; }
.c5, .c6 { font-size: 8.5pt; }
.box { font-size: 13pt; width: 15mm; }
.sign { display: flex; justify-content: space-between; margin-top: 10mm; page-break-inside: avoid; }
.sign div { width: 30%; text-align: center; }
.sign p { margin: 0 0 18mm; font-weight: bold; }
</style></head><body>
<h1>BÀN GIAO KẾT QUẢ BẢN CỨNG — ${esc(title)}</h1>
<div class="meta">Ngày in: ${esc(printDate(printedAt))} · Tổng: ${rows.length} hồ sơ</div>
<table><thead><tr>${[...head, "Đã nhận"].map((h) => `<th>${h}</th>`).join("")}</tr></thead>${body}</table>
<div class="sign"><div><p>Người giao</p>(Ký, ghi rõ họ tên)</div><div><p>Người nhận</p>(Ký, ghi rõ họ tên)</div><div><p>Thời gian</p>____:____ ngày ____/____</div></div>
</body></html>`;
  const w = target ?? window.open("", "_blank");
  if (!w) { alert("Trình duyệt đã chặn cửa sổ in — hãy cho phép cửa sổ bật lên."); return false; }
  w.document.open();
  w.document.write(html);
  w.document.close();
  if (autoPrint) w.onload = () => w.print();
  return true;
}

function HandoverList({ title, groups, busy, onPrint }: { title: string; groups: Group[]; busy: boolean; onPrint: (title: string, groups: Group[]) => void }) {
  const total = groups.reduce((n, g) => n + g.count, 0);
  return (
    <section className="bg-white rounded-2xl shadow-sm p-4 space-y-3 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-bold text-slate-800">
          {title} <span className="text-slate-500">· {total} hồ sơ</span>
        </h2>
        <div className="flex gap-2">
          <button
            onClick={() => onPrint(title, groups)}
            disabled={!total || busy}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold text-white bg-blue-700 active:scale-[.97] disabled:opacity-40"
          >
            <Printer aria-hidden className="w-4 h-4" />In A4
          </button>
          <button
            onClick={() => downloadExcel(title, groups)}
            disabled={!total || busy}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold text-blue-700 border border-blue-200 active:bg-blue-50 disabled:opacity-40"
          >
            <Download aria-hidden className="w-4 h-4" />Excel
          </button>
        </div>
      </div>
      {!total && <p className="text-sm text-slate-500 text-center py-4">Không có hồ sơ.</p>}
      {groups.map((g) => (
        <div key={g.dest}>
          <p className="text-sm font-extrabold text-slate-900 bg-slate-100 rounded-lg px-2.5 py-1.5">
            Gửi về {g.dest} · {g.count} hồ sơ
          </p>
          {g.clients.map((c) => (
            <div key={c.sourceName} className="mt-2 px-1">
              <p className="text-xs font-bold text-slate-700">{c.name} · {c.rows.length} hồ sơ</p>
              <ul className="mt-1 divide-y divide-slate-100">
                {c.rows.map((r) => {
                  const note = r.print_note || unreadRemark(r);
                  return (
                    <li key={r.key} className="py-1.5 text-xs flex gap-2">
                      <span className="font-mono text-slate-700 shrink-0">{r.vid}</span>
                      <span className="flex-1 min-w-0 text-slate-800">
                        {r.patient_name ?? "—"}
                        {r.billing && (
                          <span className={`flex items-start gap-1 mt-0.5 ${r.billing_ok === null ? "text-slate-700" : r.billing_ok ? "text-green-700" : "text-red-600"}`}>
                            {r.billing_ok === null ? null : r.billing_ok
                              ? <Check aria-label="Có trong đơn" className="w-3.5 h-3.5 shrink-0" />
                              : <X aria-label="Không có trong đơn" className="w-3.5 h-3.5 shrink-0" />}
                            <span>{r.billing}{r.billing_ok === false && " — không có trong đơn"}</span>
                          </span>
                        )}
                        {r.status_checking ? (
                          <span className="block text-slate-500 mt-0.5">Đang kiểm tra kết quả…</span>
                        ) : r.row_pending === null ? (
                          <span className="flex items-start gap-1 text-slate-500 mt-0.5">
                            <AlertCircle aria-hidden className="w-3.5 h-3.5 shrink-0" />
                            <span>Không kiểm tra được trạng thái kết quả</span>
                          </span>
                        ) : r.row_pending.length > 0 && (
                          <details className="text-amber-700 mt-0.5">
                            <summary className="cursor-pointer marker:text-amber-700">
                              Chưa có kết quả · {r.row_pending.length} xét nghiệm
                            </summary>
                            <ul className="list-disc pl-5 mt-1 space-y-0.5">
                              {r.row_pending.map((p, i) => <li key={`${p.code}-${i}`}>{p.name} ({statusLabel(p.status)})</li>)}
                            </ul>
                          </details>
                        )}
                        {note && (
                          <span className="flex items-start gap-1 text-amber-700 mt-0.5">
                            <AlertCircle aria-hidden className="w-3.5 h-3.5 shrink-0" />
                            <span>{note}{r.print_note ? "" : ` — tạm theo chi nhánh ${r.branch_code ?? "?"}`}</span>
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

function joinedRows(lines: PasteLine[], orders: Record<string, Order>): Row[] {
  return lines.flatMap((l, i) => {
    const o = orders[l.vid];
    if (!o || o.error) return [];
    const billing = stripPatient(l.billing, o.patient_name);
    const entries = o.test_entries ?? [];
    const billing_ok = billing ? billingFound(billing, entries.flatMap((e) => e.names)) : null;
    // A name that isn't on the order already shows ✗; its status would say nothing more.
    const row_pending = billing_ok === false ? [] : pendingFor(billing, entries, o.pending ?? null);
    return [{ ...o, key: `${i}`, billing, billing_ok, row_pending }];
  });
}

async function fetchOrders(vids: string[], onChunk?: (got: Record<string, Order>, done: number) => void, statusOnly = false): Promise<Record<string, Order>> {
  const found: Record<string, Order> = {};
  // Chunks run one after another so long lists never have more than 10 Labcenter calls in flight.
  for (let i = 0; i < vids.length; i += CHUNK) {
    const chunk = vids.slice(i, i + CHUNK);
    let got: Order[];
    try {
      const res = await fetch("/api/labcenter/orders", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vids: chunk, statusOnly }),
      });
      const data = await res.json().catch(() => ({}));
      got = res.ok ? data.results ?? [] : chunk.map((vid) => ({ vid, error: data.error ?? "Tra cứu thất bại" }));
    } catch {
      got = chunk.map((vid) => ({ vid, error: "Không thể kết nối" }));
    }
    const batch = Object.fromEntries(got.map((o) => [o.vid, o]));
    for (const vid of chunk) if (!batch[vid]) batch[vid] = { vid, error: "Không có phản hồi từ Labcenter" };
    Object.assign(found, batch);
    onChunk?.(batch, i + chunk.length);
  }
  return found;
}

function restoredRow(r: PrintDraftRow, order?: Order, checking = false): Row {
  const entries = order?.test_entries ?? [];
  const billing_ok = !r.billing || !order || order.error ? null : billingFound(r.billing, entries.flatMap((e) => e.names));
  return {
    vid: r.vid, dest: r.dest, client_name: r.client, patient_name: r.patient,
    billing: r.billing, print_note: r.note, key: printRowKey(r), billing_ok,
    row_pending: !order || order.error ? null : billing_ok === false ? [] : pendingFor(r.billing, entries, order.pending ?? null),
    status_checking: checking && !order,
  };
}

export function HardCopyHandover() {
  const [text, setText] = useState("");
  const [lines, setLines] = useState<PasteLine[]>([]); // what was pasted when "Tra cứu" was pressed
  const [orders, setOrders] = useState<Record<string, Order>>({});
  const [savedRows, setSavedRows] = useState<PrintDraftRow[]>([]);
  const [savedOrders, setSavedOrders] = useState<Record<string, Order>>({});
  const [history, setHistory] = useState<PrintHistorySummary[]>([]);
  const [historyDate, setHistoryDate] = useState(vnDate);
  const [historyError, setHistoryError] = useState("");
  const [draftError, setDraftError] = useState("");
  const [draftLoading, setDraftLoading] = useState(true);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusDone, setStatusDone] = useState(0);
  const [statusTotal, setStatusTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(0);

  const refreshDraft = useCallback(async () => {
    setDraftLoading(true);
    try {
      const res = await fetch("/api/ao/draft", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Không tải được bản nháp chung");
      const draftRows: PrintDraftRow[] = data.rows ?? [];
      setSavedRows(draftRows);
      setDraftError("");
      setDraftLoading(false);
      const { statusOnly: statusOnlyVids, full: fullVids } = statusLookupVids(draftRows);
      const savedCount = statusOnlyVids.length + fullVids.length;
      setSavedOrders({});
      setStatusDone(0);
      setStatusTotal(savedCount);
      setStatusLoading(savedCount > 0);
      const update = (got: Record<string, Order>, count: number) => {
        setSavedOrders((prev) => ({ ...prev, ...got }));
        setStatusDone(count);
      };
      await fetchOrders(statusOnlyVids, update, true);
      await fetchOrders(fullVids, (got, count) => update(got, statusOnlyVids.length + count));
    } catch (error) {
      setDraftError(String(error));
    } finally {
      setDraftLoading(false);
      setStatusLoading(false);
    }
  }, []);
  useEffect(() => { void refreshDraft(); }, [refreshDraft]);
  useEffect(() => {
    const day = vnDate();
    const timer = window.setInterval(() => { if (vnDate() !== day) window.location.reload(); }, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    void fetch("/api/ao/prints", { cache: "no-store" })
      .then(async (res) => { const data = await res.json(); if (!res.ok) throw new Error(data.error); setHistory(data.prints ?? []); })
      .catch((error) => setHistoryError(String(error)));
  }, []);

  const pasted = parsePaste(text);
  const vids = [...new Set(pasted.map((l) => l.vid))];

  const lookup = async () => {
    if (!vids.length || loading) return;
    setLoading(true);
    setLines(pasted);
    setOrders({});
    setDone(0);
    // One lookup per distinct VID, however many billing lines it has.
    const found = await fetchOrders(vids, (got, count) => {
      setOrders((prev) => ({ ...prev, ...got }));
      setDone(count);
    });
    const incoming = printRows(groupRows(joinedRows(pasted, found)));
    for (let i = 0; i < incoming.length; i += 200) {
      try {
        const res = await fetch("/api/ao/draft", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows: incoming.slice(i, i + 200) }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Không lưu được bản nháp chung");
        setSavedRows(data.rows ?? []);
        setDraftError("");
      } catch (error) {
        setDraftError(String(error));
        break;
      }
    }
    setLoading(false);
  };

  const rows = joinedRows(lines, orders);
  const merged = new Map<string, Row>(savedRows.map((r) => [printRowKey(r), restoredRow(r, savedOrders[r.vid], statusLoading)]));
  for (const row of rows) merged.set(printRowKey(row), row);
  const allRows = [...merged.values()];
  const hubGroups = groupRows(allRows.filter((r) => r.dest === HUB));
  const outsideGroups = groupRows(allRows.filter((r) => r.dest !== HUB));
  const failed = Object.values(orders).filter((o) => o.error);
  const datedHistory = history.filter((item) => !historyDate || vnDate(new Date(item.printedAt)) === historyDate);
  const historyGroups = ["D001", "Ngoài D001"].map((title) => ({
    title, prints: datedHistory.filter((item) => item.title === title),
  }));

  const handlePrint = (title: string, groups: Group[]) => {
    if (!printA4(title, groups)) return;
    void fetch("/api/ao/prints", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, rows: printRows(groups) }),
    }).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Không lưu được lịch sử in");
      setHistory((prev) => [data.print, ...prev]);
      setHistoryError("");
    }).catch((error) => setHistoryError(String(error)));
  };

  const openHistory = async (item: PrintHistorySummary) => {
    const w = window.open("", "_blank");
    if (!w) { alert("Trình duyệt đã chặn cửa sổ in — hãy cho phép cửa sổ bật lên."); return; }
    w.document.body.textContent = "Đang tải bản in…";
    try {
      const res = await fetch(`/api/ao/prints?id=${encodeURIComponent(item.id)}`, { cache: "no-store" });
      const data: { print?: PrintHistory; error?: string } = await res.json();
      if (!res.ok || !data.print) throw new Error(data.error ?? "Không tải được bản in");
      printA4(data.print.title, groupRows(data.print.rows.map((r) => restoredRow(r))), false, data.print.printedAt, w);
      setHistoryError("");
    } catch (error) {
      w.document.body.textContent = "Không tải được bản in. Hãy thử lại.";
      setHistoryError(String(error));
    }
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold text-slate-900">Bàn giao kết quả bản cứng</h1>
          <p className="mt-1 text-sm text-slate-600">Ngày {today("vi-VN")} · Bản nháp chung hôm nay: {savedRows.length} dòng</p>
        </div>
        <button onClick={refreshDraft} disabled={draftLoading || statusLoading || loading}
          className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:opacity-40">
          <RefreshCw aria-hidden className="w-4 h-4" />{draftLoading ? "Đang tải bản nháp…" : "Làm mới bản nháp"}
        </button>
      </header>
      {draftError && <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl p-3">{draftError} · Dòng mới chưa chắc đã được lưu trên máy khác.</p>}
      {statusLoading && <p role="status" className="text-xs text-slate-600">Đang kiểm tra kết quả {statusDone}/{statusTotal} VID…</p>}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,1fr)] lg:items-start">
        <section className="bg-white rounded-2xl shadow-sm p-5 space-y-3 min-w-0">
        <h2 className="text-base font-bold text-slate-900">Dán danh sách VID</h2>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"Dán VID, mỗi dòng một hồ sơ.\nCó thể dán kèm tên xét nghiệm (billing name) sau VID."}
          rows={5}
          aria-label="Danh sách VID"
          className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-700 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400"
        />
        <p className="text-xs text-slate-500">
          {pasted.length} dòng · {vids.length} VID
        </p>
        <button
          onClick={lookup}
          disabled={loading || !vids.length}
          className="w-full rounded-xl py-3 text-white text-sm font-bold flex items-center justify-center gap-2 bg-blue-700 active:scale-[.97] transition disabled:opacity-40"
        >
          {loading ? <><Loader2 aria-hidden className="w-4 h-4 animate-spin" />Đang tra cứu {done}/{vids.length} VID…</> : "Tra cứu"}
        </button>
        </section>

        <section className="bg-white rounded-2xl shadow-sm p-5 space-y-3 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-base font-bold text-slate-900">Lịch sử in</h2>
          <span className="text-xs text-slate-500">Lưu 7 ngày</span>
        </div>
        <div className="flex items-end gap-2">
          <label htmlFor="ao-history-date" className="flex-1 text-xs font-semibold text-slate-600">
            Ngày in
            <input id="ao-history-date" type="date" value={historyDate} onChange={(e) => setHistoryDate(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400" />
          </label>
          <button onClick={() => setHistoryDate("")} className="rounded-lg px-2 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-blue-700">Tất cả</button>
        </div>
        {historyError && <p role="alert" className="text-xs text-red-700">{historyError}</p>}
        <div className="space-y-3">
          {historyGroups.map((group) => (
            <div key={group.title}>
              <h3 className="border-b border-slate-200 pb-1 text-xs font-bold text-slate-800">{group.title} · {group.prints.length} bản</h3>
              {group.prints.length ? (
                <ul className="max-h-24 divide-y divide-slate-100 overflow-y-auto pr-1">
                  {group.prints.map((print) => (
                    <li key={print.id} className="flex items-center justify-between gap-2 py-2 text-xs">
                      <span className="min-w-0 text-slate-600">{new Date(print.printedAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })} · {print.count} hồ sơ</span>
                      <button className="shrink-0 font-semibold text-blue-700 hover:underline focus-visible:outline-2 focus-visible:outline-blue-700" onClick={() => void openHistory(print)}>Xem bản in</button>
                    </li>
                  ))}
                </ul>
              ) : <p className="py-2 text-xs text-slate-500">Chưa có bản in.</p>}
            </div>
          ))}
        </div>
        </section>
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

      {allRows.length > 0 && (
        <div className={`grid gap-4 items-start ${hubGroups.length && outsideGroups.length ? "md:grid-cols-2" : "grid-cols-1"}`}>
          {hubGroups.length > 0 && <HandoverList title={HUB} groups={hubGroups} busy={loading || draftLoading} onPrint={handlePrint} />}
          {outsideGroups.length > 0 && <HandoverList title={`Ngoài ${HUB}`} groups={outsideGroups} busy={loading || draftLoading} onPrint={handlePrint} />}
        </div>
      )}
    </div>
  );
}
