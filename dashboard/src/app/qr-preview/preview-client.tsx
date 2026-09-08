"use client";

/**
 * PREVIEW ONLY — a decision aid, not a shipping screen.
 *
 * The branch asks two questions and nothing else: WHAT is moving, and WHEN. So the
 * page answers them in that order, at a glance, with no tap required. The courier's
 * name is a detail on the third line, not the headline — an earlier draft led with it
 * and buried the answer behind an expander.
 */

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Check } from "lucide-react";
import { placeLabel } from "@/lib/place-label";
import { ms } from "@/lib/branch-visits";
import type { BranchDay, CourierCard } from "@/lib/branch-visits";

interface BranchRow { code: string; name: string; jobs: number; couriers: number }

const hm = (t?: string | null) => (t ? t.slice(11, 16) : null);
const clock = (msVal: number) => new Date(msVal).toTimeString().slice(0, 5);

/** The one answer the page leads with. */
interface Lead {
  kind: "eta" | "recent" | "idle";
  time: string | null;
  payload: string | null;
  courier: string | null;
  footnote: string | null;
}

function buildLead(couriers: CourierCard[]): Lead {
  // Best estimate = the soonest (last arrival + this courier's own rhythm). Only
  // couriers who have actually been here today have a rhythm to project from.
  // Only a FUTURE projection may lead. A rhythm-based estimate goes stale the moment
  // it passes, and "Chuyến kế tiếp ~13:12" shown at 14:30 is worse than no estimate at
  // all — it reads as a promise already broken.
  const now = Date.now();
  let best: { at: number; c: CourierCard } | null = null;
  for (const c of couriers) {
    const pending = c.visits.filter((v) => v.pending);
    if (!pending.length || c.cadenceMins == null) continue;
    const last = ms(c.lastArrival);
    if (last == null) continue;
    const at = last + c.cadenceMins * 60_000;
    if (at <= now) continue;
    if (!best || at < best.at) best = { at, c };
  }

  if (best) {
    const next = best.c.visits.find((v) => v.pending);
    const take = next?.jobs.filter((j) => j.stop_type_id === 1).length ?? 0;
    const give = next?.jobs.filter((j) => j.stop_type_id !== 1).length ?? 0;
    const bits: string[] = [];
    if (give) bits.push(`giao ${give} mẫu cho bạn`);
    if (take) bits.push(`lấy ${take} mẫu đi`);
    return {
      kind: "eta",
      time: clock(best.at),
      payload: bits.join(" · ") || null,
      courier: best.c.name,
      footnote: best.c.lastArrival ? `Vừa ghé lúc ${hm(best.c.lastArrival)}` : null,
    };
  }

  // No rhythm to project from — the most recent real timestamp is the honest lead.
  const stamps = couriers
    .flatMap((c) => c.visits.map((v) => v.arrived ?? v.departed))
    .filter(Boolean)
    .sort() as string[];
  const coming = couriers.filter((c) => c.visits.some((v) => v.pending)).length;
  if (stamps.length) {
    return {
      kind: coming ? "recent" : "idle",
      time: hm(stamps[stamps.length - 1]),
      payload: coming ? `${coming} chuyến đang tới` : "Đã xong hôm nay",
      courier: null,
      footnote: coming ? "Chưa đủ dữ liệu để ước tính giờ" : null,
    };
  }
  return { kind: "idle", time: null, payload: coming ? `${coming} chuyến đang tới` : "Chưa có chuyến nào", courier: null, footnote: null };
}

/** `when` is the departure stamp, so only an outgoing row carries one. */
interface Flow { count: number; place: string; when?: string }

/** Two lists, both answering "what": arriving here, and left here but not yet landed. */
function buildFlows(couriers: CourierCard[]) {
  const incoming = new Map<string, Flow>();
  const outgoing = new Map<string, Flow>();
  for (const c of couriers) {
    for (const v of c.visits) {
      for (const j of v.jobs) {
        const place = placeLabel(j.counterpart ?? "—");
        if (v.pending) {
          // Still ahead of the courier. A delivery here is a sample coming TO us.
          if (j.stop_type_id !== 1) {
            const e = incoming.get(place) ?? { count: 0, place };
            e.count++; incoming.set(place, e);
          }
        } else if (j.stop_type_id === 1 && !j.settled) {
          // Collected here, far end not done — riding away with our samples.
          const e = outgoing.get(place) ?? { count: 0, place };
          e.count++;
          const t = v.departed ?? v.arrived;
          if (t && (!e.when || t > e.when)) e.when = t;
          outgoing.set(place, e);
        }
      }
    }
  }
  const done = couriers.reduce(
    (a, c) => {
      for (const v of c.visits) {
        if (v.pending) continue;
        a.visits++;
        a.samples += v.jobs.length;
      }
      return a;
    },
    { visits: 0, samples: 0 }
  );
  return {
    incoming: [...incoming.values()].sort((a, b) => b.count - a.count),
    outgoing: [...outgoing.values()].sort((a, b) => b.count - a.count),
    done,
  };
}

function FlowList({
  title, rows, dir,
}: { title: string; rows: Flow[]; dir: "in" | "out" }) {
  if (!rows.length) return null;
  const Icon = dir === "in" ? ArrowDown : ArrowUp;
  const tone = dir === "in" ? "text-violet-700" : "text-sky-800";
  const total = rows.reduce((a, r) => a + r.count, 0);
  // D001 draws from 27 places. Past a handful the list stops being read at all, so the
  // tail collapses into one line rather than turning the answer into a scroll.
  const CAP = 6;
  const shown = rows.slice(0, CAP);
  const rest = rows.slice(CAP);
  const restCount = rest.reduce((a, r) => a + r.count, 0);
  return (
    <section className="rounded-2xl bg-white border border-slate-200 overflow-hidden">
      <h2 className="px-4 pt-3 pb-1 text-xs font-bold uppercase tracking-wide text-slate-500">
        {title} · {total} mẫu
      </h2>
      <ul>
        {shown.map((r) => (
          <li key={r.place} className="px-4 py-2.5 border-t border-slate-100 flex items-center gap-2.5">
            <Icon aria-hidden className={`w-4 h-4 shrink-0 ${tone}`} />
            <span className="font-semibold text-slate-900 tabular-nums">{r.count}</span>
            <span className="flex-1 min-w-0 truncate text-sm text-slate-700">{r.place}</span>
            {r.when && <span className="text-xs tabular-nums text-slate-500 shrink-0">{hm(r.when)}</span>}
          </li>
        ))}
        {rest.length > 0 && (
          <li className="px-4 py-2.5 border-t border-slate-100 text-sm text-slate-500">
            và {rest.length} nơi khác · {restCount} mẫu
          </li>
        )}
      </ul>
    </section>
  );
}

/** The layout being replaced, rebuilt from the same data so the comparison is fair. */
function JobCardsView({ day }: { day: BranchDay }) {
  const rows = day.couriers
    .flatMap((c) =>
      c.visits.flatMap((v) =>
        v.jobs.map((j) => ({
          key: `${j.job_id}-${j.stop_type_id}`,
          who: c.name,
          time: v.pending ? null : hm(v.arrived) ?? hm(v.departed),
          j,
        }))
      )
    )
    .sort((a, b) => (a.time ?? "zz").localeCompare(b.time ?? "zz"));
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.key} className="rounded-xl bg-white border border-slate-200 px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-slate-800 truncate">
              {r.j.stop_type_id === 1 ? "Gửi đi" : "Nhận về"} · {placeLabel(r.j.counterpart ?? "—")}
            </span>
            <span className="text-xs tabular-nums text-slate-500">{r.time ?? "chưa tới"}</span>
          </div>
          <p className="text-xs text-slate-500 truncate">{r.who}</p>
        </div>
      ))}
    </div>
  );
}

export default function PreviewClient() {
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [code, setCode] = useState("");
  const [day, setDay] = useState<BranchDay | null>(null);
  const [mode, setMode] = useState<"answer" | "job">("answer");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/qr-preview")
      .then((r) => r.json())
      .then((d) => {
        setBranches(d.branches ?? []);
        if (d.branches?.length) setCode(d.branches[0].code);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!code) return;
    setLoading(true);
    fetch(`/api/qr-preview?code=${code}`)
      .then((r) => r.json())
      .then(setDay)
      .catch(() => setDay(null))
      .finally(() => setLoading(false));
  }, [code]);

  const lead = useMemo(() => (day ? buildLead(day.couriers) : null), [day]);
  const flows = useMemo(() => (day ? buildFlows(day.couriers) : null), [day]);

  return (
    <div className="min-h-screen bg-slate-100">
      <div className="mx-auto max-w-lg p-3 space-y-3">
        <header className="rounded-2xl bg-white border border-slate-200 p-3 space-y-2.5">
          <div className="flex items-center justify-between">
            <h1 className="text-sm font-bold text-slate-900">Bản thử</h1>
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-violet-100 text-violet-700">PREVIEW</span>
          </div>
          <select
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="w-full text-sm rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
          >
            {branches.map((b) => (
              <option key={b.code} value={b.code}>
                {placeLabel(b.name)} — {b.jobs} việc / {b.couriers} người
              </option>
            ))}
          </select>
          <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-lg">
            {(["answer", "job"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`text-xs font-semibold py-1.5 rounded-md ${
                  mode === m ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                }`}
              >
                {m === "answer" ? "Đề xuất" : "Hiện tại"}
              </button>
            ))}
          </div>
        </header>

        {loading && <p className="text-center text-sm text-slate-500 py-10">Đang tải…</p>}

        {!loading && day && mode === "job" && <JobCardsView day={day} />}

        {!loading && day && lead && flows && mode === "answer" && (
          <>
            {/* THE ANSWER — biggest thing on the page, no interaction to reach it. */}
            <section className="rounded-2xl bg-slate-900 text-white px-5 py-5">
              <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400">
                {lead.kind === "eta" ? "Chuyến kế tiếp" : lead.kind === "recent" ? "Lần gần nhất" : "Hôm nay"}
              </p>
              <p className="mt-1 text-5xl font-bold tabular-nums leading-none">
                {lead.kind === "eta" && <span className="text-2xl align-top text-slate-400 mr-0.5">~</span>}
                {lead.time ?? "—"}
              </p>
              {lead.payload && <p className="mt-2.5 text-base font-semibold text-slate-100">{lead.payload}</p>}
              {lead.courier && <p className="mt-0.5 text-sm text-slate-400">{lead.courier}</p>}
              {lead.footnote && <p className="mt-2 text-xs text-slate-500">{lead.footnote}</p>}
            </section>

            <FlowList title="Đang tới đây" rows={flows.incoming} dir="in" />
            <FlowList title="Mẫu đã rời đi, chưa tới nơi" rows={flows.outgoing} dir="out" />

            {flows.done.visits > 0 && (
              <p className="flex items-center justify-center gap-2 text-sm text-slate-500 py-1">
                <Check aria-hidden className="w-4 h-4 text-green-600" />
                Đã xong hôm nay · {flows.done.visits} lượt · {flows.done.samples} mẫu
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
