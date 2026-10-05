"use client";

import { useEffect, useId, useRef, useState } from "react";
import { HoverCard } from "radix-ui";
import { ArrowRight, ChevronDown, Search, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BatchLookupResult, LookupEvent, LookupJobRow, LookupStep } from "@/lib/batch-lookup";
import { parseVnTimestamp } from "@/lib/time";

const timestamp = (value?: string | null) => value ? parseVnTimestamp(value).getTime() : null;
const time = (value?: string | null) => value?.slice(11, 19) || "—";
const date = (value?: string | null) => value ? value.slice(0, 10).split("-").reverse().join("/") : "—";
const mins = (value: number | null) => {
  if (value === null) return "—";
  const n = Math.round(Math.abs(value) * 10) / 10;
  return `${value < 0 ? "−" : ""}${n >= 60 ? `${Math.floor(n / 60)}h ` : ""}${Math.round(n % 60 * 10) / 10}m`;
};
const muted = "text-xs text-slate-600";
const focus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2";

export const isKeyLookupEvent = (event: LookupEvent) => event.kind === "due" || /^(Visit|Sample collected|Sample arrived|Sample received|Pickup completed|Delivery completed)|^Batch .* created|cancelled/i.test(event.label);

/** Context covers only the delivery leg carrying this visit, including overlapping work. */
export function driverWindowJobs(job: LookupJobRow, jobs: LookupJobRow[]) {
  const start = timestamp(job.start), end = timestamp(job.end);
  if (start === null || end === null || !Number.isFinite(start) || !Number.isFinite(end)) return [job];
  return jobs.filter(row => row.driver === job.driver && (timestamp(row.start) ?? Infinity) <= end && (timestamp(row.end) ?? -Infinity) >= start);
}

function Detail({ label, children, className = "", name }: { label: React.ReactNode; children: React.ReactNode; className?: string; name: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <HoverCard.Root open={open} onOpenChange={setOpen} openDelay={180} closeDelay={150}>
    <HoverCard.Trigger asChild><button type="button" aria-label={name} aria-expanded={open} aria-describedby={open ? id : undefined} onClick={() => setOpen(!open)} className={`inline-flex max-w-full items-center gap-1.5 rounded text-left underline decoration-slate-300 decoration-dotted underline-offset-4 hover:text-indigo-700 hover:decoration-indigo-500 ${focus} ${className}`}>
      {label}<ChevronDown aria-hidden="true" className="size-3 shrink-0" />
    </button></HoverCard.Trigger>
    <HoverCard.Portal><HoverCard.Content id={id} role="tooltip" sideOffset={8} collisionPadding={16} className="z-50 w-96 max-w-[calc(100vw-2rem)] max-h-[min(32rem,75dvh)] overflow-y-auto rounded-xl bg-white p-4 text-sm text-slate-800 shadow-lg shadow-slate-900/15 outline outline-1 outline-slate-200">
      {children}
    </HoverCard.Content></HoverCard.Portal>
  </HoverCard.Root>;
}

function DriverRoute({ job, jobs }: { job: LookupJobRow; jobs: LookupJobRow[] }) {
  const overlapping = driverWindowJobs(job, jobs).filter(row => row.job_id !== job.job_id);
  return <Detail name={`Lộ trình liên quan của ${job.driver || "tài xế chưa được phân công"}`} label={<span className="truncate">{job.driver || "Chưa phân công"}</span>} className="min-h-8 text-xs font-medium">
    <h4 className="font-semibold">{job.driver || "Chưa phân công"}</h4><p className={`${muted} mt-1`}>{date(job.start)} · {time(job.start)}–{time(job.end)}</p>
    <p className="mt-3 text-xs font-medium">Chặng vận chuyển của VID này · #{job.job_id}</p><p className={`${muted} mt-1`}>{job.reference}</p>
    <ol className="mt-2 space-y-3">{job.stops.map((stop, index) => <li key={index} className="grid grid-cols-[5rem_1fr] gap-3">
      <div className="font-mono text-xs tabular-nums text-slate-600">{time(stop.arrived)}<br />{time(stop.completed)}</div>
      <div><p className="text-sm font-medium">{stop.place}</p><p className={muted}>{stop.type} · đến / hoàn tất</p></div>
    </li>)}</ol>
    {!!overlapping.length && <div className="mt-4 border-t pt-3"><h4 className="text-xs font-semibold">Công việc trùng khoảng thời gian này</h4><ul className="mt-2 space-y-2">{overlapping.map(row => <li key={row.job_id} className="text-xs">
      <p className="font-medium break-words">{row.reference}</p><p className={muted}>{time(row.start < job.start ? job.start : row.start)}–{time(row.end > job.end ? job.end : row.end)} · {row.stops.map(stop => stop.place).join(" → ")}</p>
    </li>)}</ul></div>}
  </Detail>;
}

export function BatchLookupPanel() {
  const [vid, setVid] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [steps, setSteps] = useState<LookupStep[]>([]);
  const [result, setResult] = useState<BatchLookupResult | null>(null);
  const [error, setError] = useState("");
  const [allEvents, setAllEvents] = useState(false);
  const [mobileContext, setMobileContext] = useState(false);
  const source = useRef<EventSource | null>(null);
  useEffect(() => () => { source.current?.close(); }, []);

  function lookup(event: React.FormEvent) {
    event.preventDefault();
    const query = vid.trim();
    if (!/^\d{8,20}$/.test(query)) { setError("VID phải gồm 8–20 chữ số."); return; }
    source.current?.close();
    setBusy(true); setProgress("Đang tìm đơn và mẫu…"); setSteps([]); setResult(null); setError(""); setAllEvents(false); setMobileContext(false);
    const events = new EventSource(`/api/admin/batch-lookup?vid=${encodeURIComponent(query)}`);
    source.current = events;
    const end = () => { events.close(); source.current = null; setBusy(false); setProgress(""); };
    events.addEventListener("doing", event => setProgress(JSON.parse(event.data).msg));
    events.addEventListener("step", event => setSteps(previous => [...previous, JSON.parse(event.data)]));
    events.addEventListener("done", event => {
      const data: BatchLookupResult = JSON.parse(event.data);
      setResult(data); setSteps(data.steps); setError(data.error ?? ""); end();
    });
    events.onerror = () => { setError("Kết nối bị gián đoạn. Hãy tra cứu lại."); end(); };
  }

  const summary = result?.summary;
  const collected = timestamp(result?.timeline.find(event => event.label === "Sample collected")?.time);
  const timeline = result?.timeline.filter(event => allEvents || isKeyLookupEvent(event)) ?? [];
  const total = result?.phases.find(phase => phase.label === "Collected → last sample received");
  const tat = result?.phases.find(phase => phase.label.startsWith("TAT"));
  const driverJobs = result?.driver_days.flatMap(day => day.jobs) ?? [];
  const warnings = steps.filter(step => step.step === "warning" || step.step === "error");

  return <div className="flex h-full flex-col gap-3 overflow-y-auto bg-white p-3 text-slate-800 selection:bg-indigo-100 sm:p-4 lg:overflow-hidden">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-base font-semibold">Tra cứu VID / Batch</h2><p className={`${muted} mt-0.5`}>Hành trình mẫu từ điểm lấy đến phòng xét nghiệm.</p></div>
      <form onSubmit={lookup} className="flex w-full items-center gap-2 sm:w-auto"><label htmlFor="batch-lookup-vid" className="sr-only">VID</label>
        <div className="relative min-w-0 flex-1 sm:w-56"><Search aria-hidden="true" className="absolute left-3 top-3 size-4 text-slate-500" /><input id="batch-lookup-vid" inputMode="numeric" autoComplete="off" placeholder="Nhập VID…" value={vid} onChange={event => setVid(event.target.value)} maxLength={20} pattern="[0-9]{8,20}" required disabled={busy} aria-invalid={!!error && !result} className={`h-10 w-full rounded-md border border-slate-300 bg-white pl-9 pr-3 text-sm tabular-nums caret-indigo-600 placeholder:text-slate-500 disabled:opacity-60 ${focus}`} /></div>
        <Button type="submit" disabled={busy} className="h-10">{busy ? "Đang tra…" : "Tra cứu"}</Button>
        {busy && <Button type="button" variant="outline" className="h-10" onClick={() => { source.current?.close(); source.current = null; setBusy(false); setProgress("Đã dừng tra cứu. Nhấn Tra cứu để bắt đầu lại."); }}>Dừng</Button>}
      </form>
    </header>
    {error && <p role="alert" className="shrink-0 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{error}{summary ? " Dữ liệu đã tìm được vẫn hiển thị bên dưới." : ""}</p>}
    {!!warnings.length && !busy && <p role="status" className="shrink-0 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">{warnings.map(step => step.msg).join(" · ")}</p>}
    {busy && <div role="status" aria-live="polite" className="space-y-3 border-t pt-4"><p className="text-sm font-medium">{progress}</p><p className={muted}>{steps.length} bước đã hoàn tất</p><div aria-hidden="true" className="space-y-3 motion-safe:animate-pulse"><div className="h-12 rounded bg-slate-100" /><div className="h-64 rounded bg-slate-50" /></div></div>}
    {!busy && progress && <p role="status" className="text-sm text-slate-600">{progress}</p>}
    {!result && !busy && !error && !progress && <div className="my-auto mx-auto max-w-md py-12 text-center"><Search aria-hidden="true" className="mx-auto mb-4 size-7 text-slate-400" /><h3 className="text-base font-medium">Mẫu đang ở đâu, chậm ở bước nào?</h3><p className="mt-2 text-sm leading-6 text-slate-600">Nhập VID để xem thời gian lấy mẫu, batch vận chuyển và tiếp nhận tại lab.</p><p className="mt-4 text-xs text-slate-600">POS <ArrowRight aria-hidden="true" className="mx-2 inline size-3" /> LIS <ArrowRight aria-hidden="true" className="mx-2 inline size-3" /> Cartrack · Giờ Việt Nam (UTC+7)</p></div>}

    {result && summary && <>
      <section aria-label="Thông tin lượt khám" className="flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-y border-slate-200 py-3">
        <div><div className="flex flex-wrap items-center gap-x-3 gap-y-1"><h3 className="font-mono text-lg font-semibold tabular-nums">{summary.order.vid}</h3><span className="text-sm font-medium">{summary.order.branch || "—"}</span><span className={muted}>{summary.order.status} · {summary.order.tests} tests</span></div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600"><span>{date(summary.order.created)} · {time(summary.order.created)}</span>
            {summary.client && <Detail name="Thông tin khách hàng" label={summary.client.code === "51222087" ? "WALKIN" : summary.client.name || summary.client.code}><h4 className="font-semibold">{summary.client.name || summary.client.code}</h4><p className="mt-2 break-words text-xs leading-6 text-slate-600">{[summary.client.code, summary.client.segment, summary.client.type, summary.client.owner && `Owner: ${summary.client.owner}`, summary.client.supervisor_email && `Supervisor: ${summary.client.supervisor_email}`].filter(Boolean).join(" · ")}</p></Detail>}
            {summary.order.route && <span>{summary.order.route} · dự kiến {summary.order.expected_transport || "—"}</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">{total && <span>Lấy mẫu → nhận: <strong className="tabular-nums">{mins(total.minutes)}</strong></span>}{tat && <span className={tat.breach ? "font-medium text-red-700" : "text-emerald-700"}>{tat.breach ? "Quá TAT" : "Còn trước TAT"}: <strong className="tabular-nums">{mins(tat.minutes)}</strong></span>}
          {!!result.phases.length && <Detail name="Chi tiết thời gian từng bước" label="Thời gian từng bước"><h4 className="font-semibold">Thời gian từng bước</h4><dl className="mt-3 space-y-2 text-xs">{result.phases.map(phase => <div key={phase.label} className={`flex justify-between gap-4 ${phase.breach ? "text-red-700" : ""}`}><dt>{phase.label}</dt><dd className="shrink-0 font-semibold tabular-nums">{mins(phase.minutes)}</dd></div>)}</dl></Detail>}
        </div>
      </section>
      <div role="group" aria-label="Nội dung tra cứu" className="flex shrink-0 gap-1 rounded-md bg-slate-100 p-1 lg:hidden">
        {[false, true].map(context => <button key={String(context)} type="button" aria-pressed={mobileContext === context} onClick={() => setMobileContext(context)} className={`min-h-9 flex-1 rounded px-3 text-xs font-medium ${focus} ${mobileContext === context ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:bg-slate-200"}`}>{context ? `Mẫu & chuyến (${summary.jobs.length})` : "Timeline"}</button>)}
      </div>
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-label="Timeline" className={`${mobileContext ? "hidden lg:flex" : "flex"} min-h-0 flex-col`}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Timeline <span className="ml-1 font-normal text-slate-600">{timeline.length}/{result.timeline.length} sự kiện</span></h3><div role="group" aria-label="Sự kiện hiển thị" className="flex rounded-md bg-slate-100 p-0.5">{[false, true].map(all => <button key={String(all)} type="button" aria-pressed={allEvents === all} onClick={() => setAllEvents(all)} className={`min-h-8 rounded px-3 text-xs font-medium ${focus} ${allEvents === all ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:bg-slate-200"}`}>{all ? "Tất cả" : "Mốc chính"}</button>)}</div></div>
          <div tabIndex={0} aria-label="Danh sách sự kiện theo thời gian" className={`min-h-0 max-h-[32rem] overflow-y-auto rounded-lg border border-slate-200 lg:max-h-none lg:flex-1 ${focus}`}>
            <table className="w-full table-fixed text-left text-xs"><colgroup><col className="w-20 sm:w-24" /><col /><col className="w-20 sm:w-24" /></colgroup><thead className="sticky top-0 z-10 bg-slate-50 text-slate-600"><tr><th scope="col" className="px-3 py-2 font-medium">Giờ VN</th><th scope="col" className="px-2 py-2 font-medium">Sự kiện</th><th scope="col" className="px-3 py-2 text-right font-medium">Từ lấy mẫu</th></tr></thead>
              <tbody>{timeline.map((event, index) => <tr key={`${event.time}-${event.label}-${index}`} className={`border-t border-slate-100 align-top hover:bg-slate-50 ${event.kind === "due" ? "bg-amber-50 text-amber-900" : ""}`}>
                <td className="px-3 py-1.5 font-mono tabular-nums"><span>{time(event.time)}</span>{(index === 0 || timeline[index - 1].time.slice(0, 10) !== event.time.slice(0, 10)) && <div className="mt-0.5 text-[11px] text-slate-600">{date(event.time)}</div>}</td>
                <td className="px-2 py-1"><span className={`mr-2 inline-block whitespace-nowrap rounded px-1.5 py-0.5 align-middle text-[11px] font-semibold ${event.source === "LIS" ? "bg-blue-600 text-white" : event.source === "Cartrack" ? "bg-orange-700 text-white" : "bg-slate-100 text-slate-600"}`}>{event.source}</span><Detail name={`Chi tiết: ${event.label}`} className="min-h-6 text-xs font-medium leading-5" label={event.label}><h4 className="font-semibold">{event.label}</h4><p className={`${muted} mt-1`}>{date(event.time)} · {time(event.time)} · {event.source}</p>{event.who && <p className="mt-3 break-words text-xs">{event.who}</p>}{event.detail && <p className="mt-2 text-xs text-slate-600">{event.detail}</p>}{!!event.samples.length && <p className="mt-2 break-all font-mono text-xs">{event.samples.join(", ")}</p>}<p className={`${muted} mt-3`}>Từ sự kiện trước trong timeline đầy đủ: {mins(event.since_prev_min)}</p></Detail></td>
                <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">{collected === null ? "—" : mins(Math.round((timestamp(event.time)! - collected) / 6000) / 10)}</td>
              </tr>)}</tbody>
            </table>{!timeline.length && <p className="p-4 text-sm text-slate-600">Chưa có sự kiện trong dữ liệu đã tìm được.</p>}
          </div>
          <div className="mt-2 flex shrink-0 flex-wrap justify-between gap-2 text-[11px] text-slate-600"><span>Rê chuột hoặc nhấn vào sự kiện để xem chi tiết.</span>{!!steps.length && <Detail name="Các bước tra cứu" label={`${steps.length} bước tra cứu`}><h4 className="font-semibold">Các bước tra cứu</h4><ol className="mt-3 space-y-2 text-xs">{steps.map((step, index) => <li key={index} className={step.step === "error" ? "text-red-700" : step.step === "warning" ? "text-amber-800" : "text-slate-600"}>{step.msg}</li>)}</ol></Detail>}</div>
        </section>
        <aside aria-label="Mẫu và vận chuyển" className={`${mobileContext ? "block" : "hidden lg:block"} min-h-0 space-y-3 overflow-y-auto lg:border-l lg:border-slate-200 lg:pl-4`}>
          <section><h3 className="mb-2 text-sm font-semibold">Mẫu <span className="font-normal text-slate-600">({summary.samples.length})</span></h3>{!summary.samples.length && <p className={muted}>Chưa có mẫu.</p>}<ul className="space-y-2">{summary.samples.map(sample => <li key={sample.sample_id} className="text-xs"><div className="flex flex-wrap items-center gap-2"><Detail name={`Chi tiết mẫu ${sample.sample_id}`} label={<span className="font-mono">{sample.sample_id}</span>}><h4 className="font-mono font-semibold">{sample.sample_id}</h4><p className="mt-2 text-xs text-slate-600">{[sample.name, sample.container, sample.status].filter(Boolean).join(" · ")}</p></Detail><span className="text-slate-600">{sample.status}</span>{sample.stat && <span className="font-semibold text-red-700">STAT</span>}</div><p className={`${muted} mt-1`}>{sample.name}</p></li>)}</ul></section>
          <section className="border-t border-slate-200 pt-3"><h3 className="mb-2 text-sm font-semibold">Batch xác nhận <span className="font-normal text-slate-600">({summary.batches.length})</span></h3><ul className="space-y-2">{summary.batches.map(batch => <li key={batch.code} className="text-xs"><Detail name={`Chi tiết batch ${batch.code}`} label={<span className="break-all font-mono font-medium">{batch.code}</span>}><h4 className="break-all font-mono font-semibold">{batch.code}</h4><p className={`${muted} mt-2`}>{batch.status} · {batch.total_samples ?? "?"} samples · {batch.orders_in_batch} visits</p><dl className="mt-3 space-y-2 text-xs"><div><dt className="text-slate-600">Tạo batch</dt><dd>{batch.created || "—"}</dd><dd className="break-words text-slate-600">{batch.created_by}</dd></div><div><dt className="text-slate-600">Chuyển / hoàn tất</dt><dd>{batch.transferred || "—"}<br />{batch.completed || "—"}</dd></div><div><dt className="text-slate-600">Mẫu của VID này</dt><dd className="break-all font-mono">{batch.our_samples.join(", ")}</dd></div></dl></Detail><p className={`${muted} mt-1`}>{batch.status} · {time(batch.created)} {batch.destination && `→ ${batch.destination}`}</p></li>)}</ul>{!!summary.unbatched_samples.length && <p className="mt-2 text-xs text-amber-800">Chưa xác nhận batch: {summary.unbatched_samples.join(", ")}. Đã giới hạn tìm trong 10 batch ứng viên.</p>}{!summary.batches.length && !summary.unbatched_samples.length && <p className={muted}>Chưa có batch xác nhận.</p>}</section>
          <section className="border-t border-slate-200 pt-3"><h3 className="mb-1 text-sm font-semibold">Chặng vận chuyển <span className="font-normal text-slate-600">({summary.jobs.length})</span></h3><p className="mb-2 text-[11px] text-slate-600">Rê chuột / nhấn tên tài xế để xem khoảng liên quan.</p>{!summary.jobs.length && <p className={muted}>Chưa tìm được chuyến trong các ngày đã tra cứu.</p>}<ul className="divide-y divide-slate-100">{summary.jobs.map(job => <li key={job.job_id} className="py-2 text-xs"><div className="flex items-start gap-2"><Truck aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-slate-500" /><div className="min-w-0"><p className="font-medium leading-5">{job.stops.map(stop => stop.place).join(" → ")}</p><p className={`${muted} mt-0.5`}>{job.status} · {time(job.start)}–{time(job.end)}</p><DriverRoute job={job} jobs={driverJobs} /></div></div>{job.match === "route+time" && <p className="mt-1 text-xs font-medium text-amber-800">Khớp tuyến + thời gian · độ tin cậy thấp hơn</p>}</li>)}</ul></section>
          {!!result.branch_batches.length && <section className="border-t border-slate-200 pt-3"><Detail name="Các batch tại điểm lấy mẫu" label={`Batch cùng điểm lấy (${result.branch_batches.length})`} className="text-xs"><h4 className="font-semibold">Batch cùng điểm lấy</h4><p className={`${muted} mt-1`}>Các batch quanh thời gian lấy mẫu.</p><ul className="mt-3 divide-y divide-slate-100">{result.branch_batches.map(batch => <li key={batch.code} className="py-2 text-xs"><p className={`break-all font-mono ${batch.ours ? "font-semibold text-indigo-700" : ""}`}>{batch.code}{batch.ours && " · VID này"}</p><p className={`${muted} mt-1`}>{date(batch.created)} · {time(batch.created)} · {batch.total_samples ?? "?"} mẫu · {batch.status}</p><p className={`${muted} mt-1`}>{batch.cartrack_job || "Chưa tìm được chuyến"}</p></li>)}</ul></Detail></section>}
        </aside>
      </div>
    </>}
  </div>;
}
