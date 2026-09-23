"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Timer } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { Drift, EtaProposal } from "@/lib/pickup-setup";

type Report = { proposals: EtaProposal[]; drift: Drift[]; adopted: number; places: number };

/**
 * ETA shown on the customer portal vs what pickups actually take, and places
 * where Labcenter was changed behind our master copy. Nothing reaches Labcenter
 * until someone clicks.
 *
 * Collapsed by default and fetched the first time it is opened, not when the
 * Config tab opens: the comparison reads Supabase and Labcenter, and most visits
 * to the tab are to edit a rule, not to review ETAs.
 */
export function PickupSetupPanel() {
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch("/api/pickup-setup", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // First open only; "Tải lại" is the way to ask again.
  const requested = useRef(false);
  useEffect(() => {
    if (!open || requested.current) return;
    requested.current = true;
    void load();
  }, [open, load]);

  async function act(id: number, body: Record<string, unknown>, done: string) {
    setBusy(id);
    try {
      const r = await fetch("/api/pickup-setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lc_location_id: id, ...body }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      toast.success(done);
      setData((d) => d && {
        ...d,
        proposals: d.proposals.filter((p) => p.lc_location_id !== id),
        drift: d.drift.filter((x) => x.lc_location_id !== id),
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const pct = (d: number) => (Number.isFinite(d) ? `${d > 0 ? "+" : ""}${Math.round(d * 100)}%` : "—");

  return (
    // py-2 / gap-0 overrides the Card defaults (py-6, gap-6), which stacked on
    // top of the content's own padding and made the COLLAPSED card ~100px of
    // white space around one line — twice the height of the panel below it.
    <Card className="gap-0 py-2 shrink-0 border-slate-200">
      <CardContent className="px-3 space-y-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
            aria-expanded={open}
          >
            <ChevronRight
              aria-hidden
              className={`size-4 shrink-0 text-slate-500 transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
            />
            <Timer className="size-4 shrink-0 text-indigo-600" strokeWidth={2} />
            <span className="text-sm font-semibold text-slate-800">ETA lấy mẫu trên cổng khách hàng</span>
            {data && (
              <span className="text-[11px] text-slate-500">
                {data.places} địa điểm · {data.proposals.length} lệch · {data.drift.length} Labcenter đổi
              </span>
            )}
          </button>
          {open && (
            <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => { setData(null); void load(); }}>
              Tải lại
            </Button>
          )}
        </div>

        {open && error && <p role="alert" className="text-xs text-rose-700">Không tải được: {error}</p>}
        {open && !data && !error && <p className="text-xs text-slate-500">Đang so sánh với Labcenter…</p>}

        {open && data && (
          <>
            <section>
              {/* Title and method split: the method is a paragraph, and set
                  as one bold heading it buried the count at the end of it. */}
              <h3 className="text-xs font-semibold text-slate-700">
                ETA lệch thực tế <span className="font-normal tabular-nums text-slate-500">{data.proposals.length}</span>
              </h3>
              <p className="mb-1 max-w-[75ch] text-[11px] text-slate-500">
                Tính từ giờ hẹn lấy mẫu tới lúc tài xế đến · đề xuất theo mốc 80% chuyến · 30 ngày, trên 5 chuyến,
                bỏ chuyến có khung giờ, chuyến hẹn trước 06:00 và chuyến giao khác ngày.
              </p>
              {data.proposals.length === 0 ? (
                <p className="text-xs text-slate-500">Không có địa điểm nào lệch quá 10%.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-slate-500 text-left">
                      <tr>
                        <th className="py-1 pr-2 font-medium">Địa điểm</th>
                        <th className="py-1 px-2 font-medium text-right">Số chuyến</th>
                        <th className="py-1 px-2 font-medium text-right">Trung vị</th>
                        <th className="py-1 px-2 font-medium text-right" title="8/10 chuyến tới trước mốc này">80% chuyến</th>
                        <th className="py-1 px-2 font-medium text-right">Đang cài</th>
                        <th className="py-1 px-2 font-medium text-right">Lệch</th>
                        <th className="py-1 px-2 font-medium text-right">Đề xuất</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {data.proposals.map((p) => (
                        <tr key={p.lc_location_id} className="border-t border-slate-100">
                          <td className="py-1 pr-2">
                            <div className="text-slate-800">{p.pick_name}</div>
                            <div className="text-[11px] text-slate-500">→ {p.drop_name}</div>
                          </td>
                          <td className="py-1 px-2 text-right tabular-nums">{p.n}</td>
                          <td className="py-1 px-2 text-right tabular-nums">{Math.round(p.median_mins)}′</td>
                          <td className="py-1 px-2 text-right tabular-nums">{Math.round(p.p80_mins)}′</td>
                          <td className="py-1 px-2 text-right tabular-nums">{p.current_mins}′</td>
                          <td className={`py-1 px-2 text-right tabular-nums ${p.deviation > 0 ? "text-rose-700" : "text-emerald-700"}`}>
                            {pct(p.deviation)}
                          </td>
                          <td className="py-1 px-2 text-right tabular-nums font-semibold">{p.proposed_mins}′</td>
                          <td className="py-1 pl-2 text-right">
                            <Button
                              size="sm" className="h-7" disabled={busy === p.lc_location_id}
                              onClick={() => {
                                if (!confirm(`Đổi ETA "${p.pick_name}" từ ${p.current_mins} thành ${p.proposed_mins} phút trên Labcenter?`)) return;
                                void act(p.lc_location_id, { action: "approve_eta", mins: p.proposed_mins, basis_mins: p.p80_mins, n: p.n }, "Đã cập nhật ETA");
                              }}
                            >
                              Duyệt
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {data.drift.length > 0 && (
              <section>
                <h3 className="text-xs font-semibold text-slate-700 mb-1">
                  Labcenter khác bản gốc — có người sửa trực tiếp trên Labcenter ({data.drift.length})
                </h3>
                <ul className="space-y-1">
                  {data.drift.map((d) => (
                    <li key={d.lc_location_id} className="flex flex-wrap items-center gap-2 text-xs border-t border-slate-100 pt-1">
                      <span className="text-slate-800 min-w-0 flex-1">{d.pick_name}</span>
                      <span className="text-slate-600">
                        Bản gốc: {d.master.drop_name} · {d.master.eta_mins}′ — Labcenter: {d.labcenter.drop_name} · {d.labcenter.eta_mins}′
                      </span>
                      <Button size="sm" variant="outline" className="h-7" disabled={busy === d.lc_location_id}
                        onClick={() => void act(d.lc_location_id, { action: "repush" }, "Đã đẩy lại bản gốc")}>
                        Đẩy lại
                      </Button>
                      <Button size="sm" variant="outline" className="h-7" disabled={busy === d.lc_location_id}
                        onClick={() => void act(d.lc_location_id, { action: "accept_lc" }, "Đã nhận theo Labcenter")}>
                        Nhận theo Labcenter
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
