"use client";

import { useState } from "react";
import { Loader2, Download, AlertCircle, Printer, Check, X } from "lucide-react";
import { parsePaste, billingFound, type PasteLine } from "@/lib/handover";

/** One order as the lookup route returns it. */
interface Order {
  vid: string;
  branch_code?: string | null;
  client_id?: string | null;
  client_name?: string | null;
  patient_name?: string | null;
  test_names?: string[]; // billing_name, test_name and test_name_vi of every test
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
}

interface Group {
  dest: string;
  count: number;
  clients: { name: string; rows: Row[] }[];
}

// The route takes at most 100 per request (it has 60s to answer); longer lists go in chunks.
const CHUNK = 100;
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
    clients: [...clients].map(([name, rows]) => ({ name, rows })),
  }));
}

/** Only a remark that exists but names no clear branch is worth flagging; no remark just means "use the branch". */
const unreadRemark = (r: Row) => (!r.dest_from_remark && r.remark ? `Ghi chú không rõ nơi gửi: “${r.remark}”` : null);

const billingText = (r: Row) => (r.billing ? `${r.billing} ${r.billing_ok ? "✓" : "✗ Không có trong đơn"}` : "");

const today = (locale: string) => new Date().toLocaleDateString(locale, { timeZone: "Asia/Ho_Chi_Minh" });
const fileStem = (title: string) => `ban-giao-ban-cung_${title.replace(/\s+/g, "-")}_${today("sv-SE")}`;

const HEAD = ["STT", "Gửi về", "Khách hàng", "VID", "Bệnh nhân", "Xét nghiệm", "Ghi chú"];
const OPTIONAL = [5, 6]; // Xét nghiệm, Ghi chú — dropped when every row leaves them blank

/** The checklist table shared by print and Excel, minus optional columns nobody filled. */
function checklist(groups: Group[]) {
  let n = 0;
  const rows = groups.flatMap((g) => g.clients.flatMap((c) => c.rows.map((r) => {
    const note = unreadRemark(r);
    return [++n, g.dest, c.name, r.vid, r.patient_name ?? "", billingText(r), note ? `Theo chi nhánh ${r.branch_code ?? "?"} — ${note}` : ""];
  })));
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
function printA4(title: string, groups: Group[]) {
  const { cols, head, rows } = checklist(groups);
  const body = rows.map((r) => `<tr>${r.map((v, j) => `<td class="c${cols[j]}">${esc(v)}</td>`).join("")}<td class="box">☐</td></tr>`).join("");
  const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>${esc(fileStem(title))}</title><style>
@page { size: A4 portrait; margin: 12mm 10mm; }
* { box-sizing: border-box; }
body { font: 10.5pt/1.35 Arial, sans-serif; color: #000; margin: 0; }
h1 { font-size: 14pt; margin: 0 0 2mm; }
.meta { font-size: 10pt; margin-bottom: 4mm; }
table { width: 100%; border-collapse: collapse; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; }
th, td { border: 0.6pt solid #000; padding: 1.5mm 1.8mm; text-align: left; vertical-align: top; }
th { background: #eee; font-size: 9.5pt; }
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
<div class="meta">Ngày in: ${esc(today("vi-VN"))} · Tổng: ${rows.length} hồ sơ</div>
<table><thead><tr>${[...head, "Đã nhận"].map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>
<div class="sign"><div><p>Người giao</p>(Ký, ghi rõ họ tên)</div><div><p>Người nhận</p>(Ký, ghi rõ họ tên)</div><div><p>Thời gian</p>____:____ ngày ____/____</div></div>
</body></html>`;
  const w = window.open("", "_blank");
  if (!w) return alert("Trình duyệt đã chặn cửa sổ in — hãy cho phép cửa sổ bật lên.");
  w.document.write(html);
  w.document.close();
  w.onload = () => w.print();
}

function HandoverList({ title, groups }: { title: string; groups: Group[] }) {
  const total = groups.reduce((n, g) => n + g.count, 0);
  return (
    <section className="bg-white rounded-2xl shadow-sm p-4 space-y-3 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-bold text-slate-800">
          {title} <span className="text-slate-500">· {total} hồ sơ</span>
        </h2>
        <div className="flex gap-2">
          <button
            onClick={() => printA4(title, groups)}
            disabled={!total}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold text-white bg-blue-700 active:scale-[.97] disabled:opacity-40"
          >
            <Printer aria-hidden className="w-4 h-4" />In A4
          </button>
          <button
            onClick={() => downloadExcel(title, groups)}
            disabled={!total}
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
            <div key={c.name} className="mt-2 px-1">
              <p className="text-xs font-bold text-slate-700">{c.name} · {c.rows.length} hồ sơ</p>
              <ul className="mt-1 divide-y divide-slate-100">
                {c.rows.map((r) => {
                  const note = unreadRemark(r);
                  return (
                    <li key={r.key} className="py-1.5 text-xs flex gap-2">
                      <span className="font-mono text-slate-700 shrink-0">{r.vid}</span>
                      <span className="flex-1 min-w-0 text-slate-800">
                        {r.patient_name ?? "—"}
                        {r.billing && (
                          <span className={`flex items-start gap-1 mt-0.5 ${r.billing_ok ? "text-green-700" : "text-red-600"}`}>
                            {r.billing_ok
                              ? <Check aria-label="Có trong đơn" className="w-3.5 h-3.5 shrink-0" />
                              : <X aria-label="Không có trong đơn" className="w-3.5 h-3.5 shrink-0" />}
                            <span>{r.billing}{!r.billing_ok && " — không có trong đơn"}</span>
                          </span>
                        )}
                        {note && (
                          <span className="flex items-start gap-1 text-amber-700 mt-0.5">
                            <AlertCircle aria-hidden className="w-3.5 h-3.5 shrink-0" />
                            <span>{note} — tạm theo chi nhánh {r.branch_code ?? "?"}</span>
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
  const [lines, setLines] = useState<PasteLine[]>([]); // what was pasted when "Tra cứu" was pressed
  const [orders, setOrders] = useState<Record<string, Order>>({});
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(0);

  const pasted = parsePaste(text);
  const vids = [...new Set(pasted.map((l) => l.vid))];

  const lookup = async () => {
    if (!vids.length || loading) return;
    setLoading(true);
    setLines(pasted);
    setOrders({});
    setDone(0);
    // One lookup per distinct VID, however many billing lines it has. Chunks run one after another so a
    // long paste never has more than 10 Labcenter calls in flight; a failed chunk marks only its own VIDs.
    for (let i = 0; i < vids.length; i += CHUNK) {
      const chunk = vids.slice(i, i + CHUNK);
      let got: Order[];
      try {
        const res = await fetch("/api/labcenter/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vids: chunk }),
        });
        const data = await res.json().catch(() => ({}));
        got = res.ok ? data.results ?? [] : chunk.map((vid) => ({ vid, error: data.error ?? "Tra cứu thất bại" }));
      } catch {
        got = chunk.map((vid) => ({ vid, error: "Không thể kết nối" }));
      }
      setOrders((prev) => ({ ...prev, ...Object.fromEntries(got.map((o) => [o.vid, o])) }));
      setDone(i + chunk.length);
    }
    setLoading(false);
  };

  const rows: Row[] = lines.flatMap((l, i) => {
    const o = orders[l.vid];
    if (!o || o.error) return [];
    return [{ ...o, key: `${i}`, billing: l.billing, billing_ok: l.billing ? billingFound(l.billing, o.test_names ?? []) : null }];
  });
  const failed = Object.values(orders).filter((o) => o.error);

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl shadow-sm p-4 space-y-3 max-w-[430px] mx-auto">
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

      {lines.length > 0 && Object.keys(orders).length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 items-start">
          <HandoverList title={HUB} groups={groupRows(rows.filter((r) => r.dest === HUB))} />
          <HandoverList title={`Ngoài ${HUB}`} groups={groupRows(rows.filter((r) => r.dest !== HUB))} />
        </div>
      )}
    </div>
  );
}
