"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { BatchLookupResult, LookupJobRow, LookupStep } from "@/lib/batch-lookup";
import { parseVnTimestamp } from "@/lib/time";

const lookupTimestamp = (value?: string | null) => value ? parseVnTimestamp(value).getTime() : null;

const mins = (m: number | null) => m === null ? "—" : `${m < 0 ? "−" : ""}${Math.abs(m) >= 60 ? `${Math.floor(Math.abs(m) / 60)}h ` : ""}${Math.round(Math.abs(m) % 60 * 10) / 10}m`;
const card = "rounded-lg border border-slate-200 bg-white p-4 space-y-2";
const muted = "text-xs text-slate-500";
const kinds: Record<string, string> = { batch: "Batch run", home: "Home collection", other: "Other run", clock_in: "Clock in", clock_out: "Clock out" };

function JobsTable({ jobs }: { jobs: LookupJobRow[] }) {
  return <div className="overflow-x-auto"><table className="w-full text-xs text-left">
    <thead className="text-slate-500"><tr><th className="py-2 pr-3">Time (VN)</th><th className="pr-3">Job / route</th><th>Status</th></tr></thead>
    <tbody>{jobs.map(j => <tr key={j.job_id} className={`border-t ${j.ours ? "bg-indigo-50" : ""}`}>
      <td className="py-2 pr-3 whitespace-nowrap font-mono">{j.start.slice(11, 16)}–{j.end.slice(11, 16)}</td>
      <td className="py-2 pr-3"><div className="font-medium">{j.reference} <span className={muted}>· {kinds[j.kind]} · #{j.job_id}</span></div>
        <div>{j.stops.map(s => s.place).join(" → ")}</div>
        {j.ours && <div className="font-semibold text-indigo-700">This visit&apos;s delivery{j.match === "route+time" ? " · route + time only (lower confidence)" : " · confirmed batch code"}</div>}
        {j.batches.map(b => <div key={b.code} className={b.ours ? "text-indigo-700 font-mono" : "text-slate-500 font-mono"}>{b.code} · {b.branch} · {b.created?.slice(11, 16)}</div>)}
      </td><td className="py-2 whitespace-nowrap">{j.status}</td>
    </tr>)}</tbody>
  </table></div>;
}

export function BatchLookupPanel() {
  const [vid, setVid] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [steps, setSteps] = useState<LookupStep[]>([]);
  const [result, setResult] = useState<BatchLookupResult | null>(null);
  const [error, setError] = useState("");
  const source = useRef<EventSource | null>(null);
  useEffect(() => () => { source.current?.close(); }, []);

  function lookup(e: React.FormEvent) {
    e.preventDefault();
    const q = vid.trim();
    if (!/^\d{8,20}$/.test(q)) { setError("VID phải gồm 8–20 chữ số."); return; }
    source.current?.close();
    setBusy(true); setProgress("Starting lookup…"); setSteps([]); setResult(null); setError("");
    const events = new EventSource(`/api/admin/batch-lookup?vid=${encodeURIComponent(q)}`);
    source.current = events;
    const end = () => { events.close(); source.current = null; setBusy(false); setProgress(""); };
    events.addEventListener("doing", e => setProgress(JSON.parse(e.data).msg));
    events.addEventListener("step", e => setSteps(prev => [...prev, JSON.parse(e.data)]));
    events.addEventListener("done", e => {
      const data: BatchLookupResult = JSON.parse(e.data);
      setResult(data); setSteps(data.steps); setError(data.error ?? ""); end();
    });
    events.onerror = () => { setError("Lookup connection interrupted. Please retry."); end(); };
  }
  const s = result?.summary;
  const collected = lookupTimestamp(result?.timeline.find(e => e.label === "Sample collected")?.time);
  const previousBatch = collected === null ? null : result?.branch_batches.filter(b => !b.ours && b.created && lookupTimestamp(b.created)! < collected).sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""))[0]?.code;

  return <div className="h-full overflow-y-auto space-y-4 rounded-lg bg-slate-50 p-3 sm:p-4 text-slate-800">
    <div>
      <h2 className="text-base font-semibold">Tra cứu VID / Batch</h2>
      <p className="text-xs text-slate-500 mt-1">Order → samples → batch → delivery → lab receipt. All times are Vietnam time (UTC+7).</p>
    </div>
    <form onSubmit={lookup} className="flex flex-wrap items-end gap-2">
      <div className="space-y-1"><label htmlFor="batch-lookup-vid" className="text-xs font-medium">VID</label>
        <input id="batch-lookup-vid" inputMode="numeric" autoComplete="off" placeholder="26020720305" value={vid} onChange={e => setVid(e.target.value)} maxLength={20} pattern="[0-9]{8,20}" required disabled={busy} className="h-9 w-56 rounded-md border border-slate-300 bg-white px-3 text-sm focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-60" />
      </div>
      <Button type="submit" disabled={busy}>{busy ? "Đang tra cứu…" : "Tra cứu"}</Button>
      {busy && <Button type="button" variant="outline" onClick={() => { source.current?.close(); source.current = null; setBusy(false); setProgress(""); }}>Dừng</Button>}
    </form>
    {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}{s ? " — Showing the data retrieved so far." : ""}</p>}
    {busy && <div role="status" aria-live="polite" className={card}><p className="text-sm font-medium">{progress}</p><p className={muted}>{steps.length} steps completed</p></div>}
    {result && s && <>
      {s.client && <section className={card} aria-label="Client">
        <h3 className="text-xs font-semibold text-slate-500">Client</h3>
        <div className="font-semibold">{s.client.code === "51222087" ? "WALKIN" : s.client.name ?? s.client.code}</div>
        {s.client.code !== "51222087" && <p className={muted}>{[s.client.code, s.client.segment, s.client.type, s.client.owner && `owner ${s.client.owner}`, s.client.supervisor_email && `supervisor ${s.client.supervisor_email}`].filter(Boolean).join(" · ")}</p>}
      </section>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <section className={card}><h3 className="text-sm font-semibold">Visit</h3><div className="font-mono text-lg">{s.order.vid}</div>
          <p className={muted}>{s.order.branch} · {s.order.status} · {s.order.tests} tests</p><p className={muted}>Created {s.order.created}</p>
          {s.order.route && <p className={muted}>{s.order.route} · expected {s.order.expected_transport ?? "—"}</p>}
        </section>
        <section className={card}><h3 className="text-sm font-semibold">Samples ({s.samples.length})</h3>
          {!s.samples.length && <p className={muted}>No samples yet.</p>}
          {s.samples.map(x => <div key={x.sample_id}><div className="font-mono text-sm">{x.sample_id}{x.stat && <span className="ml-2 font-semibold text-red-600">STAT</span>}</div><p className={muted}>{[x.status, x.name, x.container].filter(Boolean).join(" · ")}</p></div>)}
        </section>
        <section className={card}><h3 className="text-sm font-semibold">Confirmed batches ({s.batches.length})</h3>
          {s.batches.map(b => <div key={b.code}><div className="font-mono text-sm font-semibold break-all">{b.code}</div><p className={muted}>{b.status} · {b.total_samples ?? "?"} samples · {b.orders_in_batch} visits</p>
            <p className={muted}>{b.created}{b.created_by && ` · ${b.created_by}`}</p><p className={muted}>{b.destination && `To ${b.destination} · `}samples: {b.our_samples.join(", ")}</p>
            {b.transferred && <p className={muted}>Transferred {b.transferred}</p>}{b.completed && <p className={muted}>Completed {b.completed}</p>}
          </div>)}
          {!!s.unbatched_samples.length && <p className="text-xs text-amber-700">Batch not confirmed for: {s.unbatched_samples.join(", ")}. The search is limited to 10 candidates.</p>}
        </section>
        <section className={card}><h3 className="text-sm font-semibold">Delivery ({s.jobs.length})</h3>
          {!s.jobs.length && <p className={muted}>No delivery job found in the scanned days.</p>}
          {s.jobs.map(j => <div key={j.job_id}><div className="text-sm font-semibold break-words">{j.reference}</div><p className={muted}>#{j.job_id} · {j.status} · {j.driver || "Unassigned"}</p><p className={muted}>{j.stops.map(st => st.place).join(" → ")}</p>
            {j.match === "route+time" && <p className="text-xs font-medium text-amber-700">Route + time only — lower confidence</p>}
          </div>)}
        </section>
      </div>
      {!!result.phases.length && <section className={card}><h3 className="text-sm font-semibold">Durations</h3>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-xs max-w-xl">{result.phases.map(p => <div key={p.label} className="contents"><dt className={p.breach ? "text-red-700" : ""}>{p.label}</dt><dd className={`font-mono font-semibold ${p.breach ? "text-red-700" : ""}`}>{mins(p.minutes)}</dd></div>)}</dl>
      </section>}
      {!!result.driver_days.length && <section className={card}><h3 className="text-sm font-semibold">Drivers&apos; day</h3><p className={muted}>Highlighted rows carried this visit. Clock-in/out and other work provide context around the delivery.</p>
        {result.driver_days.map(d => <details key={`${d.driver}-${d.jobs[0]?.job_id}`} open><summary className="cursor-pointer py-2 text-sm font-medium">{d.driver || "Driver"} · {d.days.join(", ")} · {d.jobs.length} jobs</summary><JobsTable jobs={d.jobs} /></details>)}
      </section>}
      {!!result.branch_batches.length && <details className={card}><summary className="cursor-pointer text-sm font-semibold">Branch batches ({result.branch_batches.length})</summary><p className={muted}>Shows batches around collection time, including the last batch created before collection.</p>
        <div className="overflow-x-auto"><table className="w-full text-xs text-left"><thead className="text-slate-500"><tr><th className="py-2 pr-3">Created (VN)</th><th className="pr-3">Batch</th><th className="pr-3">Samples / status</th><th>Delivery</th></tr></thead><tbody>
          {result.branch_batches.map(b => <tr key={b.code} className={`border-t ${b.ours ? "bg-indigo-50 text-indigo-800" : ""}`}><td className="py-2 pr-3 whitespace-nowrap font-mono">{b.created}</td><td className="py-2 pr-3 font-mono">{b.code}<div className={muted}>{b.branch}{b.ours ? " · This visit" : b.code === previousBatch ? " · Created just before collection" : ""}</div></td><td className="py-2 pr-3">{b.total_samples ?? "?"} · {b.status}</td><td>{b.cartrack_job ?? "No job found"}</td></tr>)}
        </tbody></table></div>
      </details>}
      <section className={card}><h3 className="text-sm font-semibold">Timeline ({result.timeline.length} events)</h3>
        <div className="overflow-x-auto"><table className="w-full text-xs text-left"><thead className="text-slate-500"><tr><th className="py-2 pr-3">Time (VN)</th><th className="pr-3">Since previous</th><th className="pr-3">Since collected</th><th>Event</th></tr></thead><tbody>
          {result.timeline.map((e, i) => <tr key={i} className={`border-t align-top ${e.kind === "due" ? "bg-amber-50" : ""}`}>
            <td className="py-2 pr-3 whitespace-nowrap font-mono">{e.time.slice(11)}<div className={muted}>{e.time.slice(0, 10)}</div></td>
            <td className={`py-2 pr-3 whitespace-nowrap font-mono ${e.kind === "done" && (e.since_prev_min ?? 0) >= 15 ? "text-amber-700 font-semibold" : ""}`}>{mins(e.since_prev_min)}</td>
            <td className="py-2 pr-3 whitespace-nowrap font-mono">{collected === null ? "—" : mins(Math.round((lookupTimestamp(e.time)! - collected) / 6000) / 10)}</td>
            <td className="py-2"><span className="mr-2 rounded bg-slate-100 px-1.5 py-0.5 font-semibold">{e.source}</span>{e.label}
              {e.who && <div className={muted}>{e.who}</div>}{e.detail && <div className={muted}>{e.detail}</div>}{!!e.samples.length && <div className="font-mono text-indigo-700">{e.samples.join(", ")}</div>}
            </td>
          </tr>)}
        </tbody></table></div>
      </section>
    </>}
    {!!steps.length && <details className={card}><summary className="cursor-pointer text-xs font-semibold">Lookup steps ({steps.length})</summary><ol className="space-y-1 text-xs">{steps.map((s, i) => <li key={i} className={s.step === "error" ? "text-red-700" : s.step === "warning" ? "text-amber-700" : "text-slate-500"}>{s.msg}</li>)}</ol></details>}
  </div>;
}
