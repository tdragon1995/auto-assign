"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { foldName } from "@/lib/driver-cell";
import { displayDriverCell } from "@/lib/driver-label";
import { BranchEditor } from "./config-todo-panel";
import type { ConfigRowView } from "@/app/api/config/rows/route";
import type { BranchRule, ConfigDriver } from "@/lib/types";

/**
 * The config table, readable and searchable from the dashboard.
 *
 * Until now the only way to answer "who covers this branch, and when?" was to
 * open the workbook — which is also the only way to answer it WRONGLY, because
 * the sheet shows every row while the engine reads one tab and applies its own
 * rules to it. This shows the tab in force today, parsed the way the engine
 * parses it.
 *
 * Loaded ON DEMAND. The table is ~1,700 rows; fetching it on the dashboard's
 * 90-second poll would be paying for it continuously to answer a question asked
 * a few times a day. It loads when the panel is first opened and can be
 * refreshed by hand.
 *
 * It reads the SHEET rather than the engine's parsed config, and that is what
 * makes it useful for admin work rather than only for inspection: the parse
 * drops every row that names a branch but no driver, which is exactly the set
 * someone comes here to fix. It also keeps the sheet row, which every write path
 * addresses rows by.
 *
 * Editing opens the SAME BranchEditor the "Cần xử lý" rows use — so a branch
 * reached by searching for it is edited through the same four guarded routes,
 * the same clash check and the same re-read-before-write as one reached by the
 * engine complaining about it. The difference between the two entry points is
 * only which branches they can reach.
 */

/** How many matches to draw. A blank search matches all 1,700 rows, and drawing
 *  them costs a visibly janky scroll for a list nobody reads to the end — the
 *  count below the box always states the true total, so the cap never hides that
 *  there is more. */
const RENDER_CAP = 150;

/**
 * Rows matching every whitespace-separated term, accent-insensitively.
 *
 * Every term must match SOMEWHERE in the row rather than all in one field, so
 * "d014 hùng" finds the branch-and-driver combination without the typist having
 * to know which column each word lives in. Accent folding is the same one the
 * driver pickers use: "quynh" has to find "Quỳnh", or the search reads as broken
 * rather than picky.
 */
export function searchConfigRows(rows: readonly ConfigRowView[], query: string): ConfigRowView[] {
  const terms = foldName(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return rows as ConfigRowView[];
  return rows.filter((r) => {
    const hay = foldName([r.pickup, r.customer_id, r.driver, r.dropoff, r.start, r.end].join(" "));
    return terms.every((t) => hay.includes(t));
  });
}

/** One branch's rows, in the shape the editor takes. Only rows that carry a
 *  sheet row can be edited — every writer addresses them by number. */
function rulesOf(rows: readonly ConfigRowView[]): BranchRule[] {
  return rows.map((r) => ({ row: r.row, driver: r.driver, start: r.start, end: r.end }));
}

export function ConfigBrowserPanel({ drivers }: { drivers: ConfigDriver[] }) {
  const [rows, setRows] = useState<ConfigRowView[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ tab: string; fetchedAt: string } | null>(null);
  const loadedRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/config/rows", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && !Array.isArray(data.rows)) throw new Error(data.error || `Lỗi ${res.status}`);
      setRows(Array.isArray(data.rows) ? data.rows : []);
      setMeta({ tab: data.tab ?? "", fetchedAt: data.fetchedAt ?? "" });
      if (data.error) setErr(String(data.error));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Once, when the tab is first shown — not on every mount of a hidden panel.
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void load();
  }, [load]);

  const matches = useMemo(() => searchConfigRows(rows, q), [rows, q]);
  const shown = matches.slice(0, RENDER_CAP);

  /** The branch currently open in the editor, by customer id. One at a time:
   *  the editor writes, and two open on the same branch would each hold a
   *  baseline taken before the other's writes landed. */
  const [editing, setEditing] = useState<string | null>(null);
  const editingRows = useMemo(
    () => (editing ? rows.filter((r) => (r.customer_id || r.pickup) === editing) : []),
    [rows, editing],
  );

  return (
    <Card className="py-2 h-full flex flex-col border-slate-200">
      <CardContent className="px-3 flex flex-col min-h-0 gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Tìm điểm, mã, tài xế…"
              aria-label="Tìm trong config"
              className="w-full rounded border border-slate-300 bg-white py-1 pl-7 pr-2 text-xs outline-none focus:ring-2 focus:ring-indigo-400/50"
            />
          </div>
          <Button
            size="sm" variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={load}
            disabled={loading}
          >
            {loading ? "Đang tải…" : "Tải lại"}
          </Button>
        </div>

        <div className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-slate-500">
          <span>
            {matches.length}/{rows.length} dòng
            {matches.length > shown.length && ` · hiện ${shown.length} đầu tiên`}
          </span>
          {meta?.tab && <span className="text-slate-400">{meta.tab}</span>}
          {meta?.fetchedAt && <span className="text-slate-400">đọc {meta.fetchedAt.slice(11, 16)}</span>}
        </div>

        {err && <div role="alert" className="text-[11px] text-red-600">{err}</div>}

        {/* The branch's whole day, in the editor the to-do rows already use.
            Above the table rather than inline in it: a row expanding inside a
            scrolling list of 150 pushes everything the reader was looking at
            off the screen. */}
        {editing && editingRows.length > 0 && (
          <div className="rounded-md border border-indigo-200 bg-indigo-50/40 p-1.5">
            <div className="mb-1 flex flex-wrap items-baseline gap-x-1.5">
              <span className="text-xs font-semibold text-slate-800">{editingRows[0].pickup || editing}</span>
              {editingRows[0].customer_id && (
                <span className="font-mono text-[10px] text-slate-500">{editingRows[0].customer_id}</span>
              )}
            </div>
            <BranchEditor
              pickupName={editingRows[0].pickup}
              dropoffName={editingRows[0].dropoff}
              rules={rulesOf(editingRows)}
              drivers={drivers}
              onCancel={() => setEditing(null)}
              onDone={() => { setEditing(null); void load(); }}
            />
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-slate-200">
          {shown.length === 0 ? (
            <p className="px-2 py-3 text-xs text-slate-500">
              {loading ? "Đang tải config…" : rows.length === 0 ? "Chưa đọc được config." : "Không tìm thấy dòng nào."}
            </p>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-50 text-[11px] text-slate-600">
                <tr>
                  <th className="px-2 py-1 text-left font-medium sr-only">Sửa</th>
                  <th className="px-2 py-1 text-left font-medium">Điểm lấy</th>
                  <th className="px-2 py-1 text-left font-medium">Tài xế</th>
                  <th className="px-2 py-1 text-left font-medium">Ca</th>
                  <th className="px-2 py-1 text-left font-medium">Điểm giao</th>
                  <th className="px-2 py-1 text-right font-medium">Dòng</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map((r) => (
                  <tr key={r.row} className="align-top hover:bg-slate-50">
                    <td className="px-2 py-1">
                      <Button
                        size="sm" variant="outline"
                        className="h-6 px-2 text-[11px] font-normal"
                        onClick={() => setEditing(r.customer_id || r.pickup)}
                        disabled={!r.customer_id && !r.pickup}
                      >
                        Sửa
                      </Button>
                    </td>
                    <td className="px-2 py-1">
                      <span className="text-slate-800">{r.pickup || <span className="text-slate-400">—</span>}</span>
                      {r.customer_id && (
                        <span className="ml-1.5 font-mono text-[10px] text-slate-400">{r.customer_id}</span>
                      )}
                    </td>
                    <td className="px-2 py-1 text-slate-700">
                      {r.driver ? displayDriverCell(r.driver) : <span className="text-amber-700">chưa có tài xế</span>}
                      {r.smart && (
                        <span className="ml-1.5 rounded-full border border-sky-200 bg-sky-50 px-1 py-0 text-[10px] font-semibold text-sky-700">
                          smart
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1 tabular-nums text-slate-600">
                      {r.start && r.end ? `${r.start}–${r.end}` : <span className="text-slate-400">cả ngày</span>}
                    </td>
                    <td className="px-2 py-1 text-slate-500">
                      {r.dropoff || <span className="text-slate-400">mọi điểm</span>}
                    </td>
                    <td className="px-2 py-1 text-right font-mono text-[10px] text-slate-400">{r.row}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
