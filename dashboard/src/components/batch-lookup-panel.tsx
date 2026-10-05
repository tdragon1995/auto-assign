"use client";

import { Fragment, useEffect, useId, useRef, useState } from "react";
import { HoverCard } from "radix-ui";
import { ArrowRight, ChevronDown, Search, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BatchLookupResult, LookupEvent, LookupJobRow, LookupStep } from "@/lib/batch-lookup";
import { driverDisplayName, placeName, staffCode } from "@/lib/display-names";
import { parseVnTimestamp } from "@/lib/time";

const timestamp = (value?: string | null) => {
  const ms = value ? parseVnTimestamp(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
};
const time = (value?: string | null) => value?.slice(11, 19) || "—";
const date = (value?: string | null) => value ? value.slice(0, 10).split("-").reverse().join("/") : "—";
const mins = (value: number | null) => {
  if (value === null) return "—";
  const n = Math.round(Math.abs(value) * 10) / 10;
  return `${value < 0 ? "−" : ""}${n >= 60 ? `${Math.floor(n / 60)}h ` : ""}${Math.round(n % 60 * 10) / 10}m`;
};
const muted = "text-xs text-slate-600";
const focus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2";

export const isKeyLookupEvent = (event: LookupEvent) => event.kind === "due" || /^(Visit|Job assigned|Sample collected|Sample arrived|Sample received|Pickup completed|Delivery completed)|^Batch .* created|cancelled/i.test(event.label);


function Detail({ label, children, className = "", name }: { label: React.ReactNode; children: React.ReactNode; className?: string; name: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <HoverCard.Root open={open} onOpenChange={setOpen} openDelay={180} closeDelay={150}>
    <HoverCard.Trigger asChild><button type="button" aria-label={name} aria-expanded={open} aria-describedby={open ? id : undefined} onClick={() => setOpen(!open)} className={`inline-flex max-w-full items-center gap-1.5 rounded text-left underline-offset-4 hover:text-indigo-700 hover:underline ${focus} ${className}`}>
      {label}<ChevronDown aria-hidden="true" className="size-3 shrink-0" />
    </button></HoverCard.Trigger>
    <HoverCard.Portal><HoverCard.Content id={id} role="tooltip" sideOffset={8} collisionPadding={16} className="z-50 w-[30rem] max-w-[calc(100vw-2rem)] max-h-[min(32rem,75dvh,var(--radix-hover-card-content-available-height))] overflow-y-auto rounded-xl bg-white p-4 text-sm text-slate-800 shadow-lg shadow-slate-900/15 outline outline-1 outline-slate-200">
      {children}
    </HoverCard.Content></HoverCard.Portal>
  </HoverCard.Root>;
}

export function driverArrivalContext(job: LookupJobRow, jobs: LookupJobRow[], stopIndex = 0) {
  const target = job.stops[stopIndex];
  const arrival = target?.arrived || target?.completed;
  const assigned = timestamp(job.assigned);
  const until = timestamp(arrival);
  const sameDriver = jobs.filter(row => job.driver_id ? row.driver_id === job.driver_id : !!job.driver && row.driver === job.driver);
  const recorded = sameDriver.flatMap(row => row.stops.flatMap((stop, index) => {
    const at = stop.arrived || stop.completed;
    return at && timestamp(at) !== null ? [{ ...stop, at, job_id: row.job_id, index, reference: row.reference }] : [];
  })).sort((a, b) => a.at.localeCompare(b.at));
  const previous = assigned === null ? undefined : recorded.flatMap(stop => {
    const at = stop.completed && timestamp(stop.completed)! <= assigned ? stop.completed : stop.at;
    return timestamp(at)! <= assigned ? [{ ...stop, recorded_at: at }] : [];
  }).sort((a, b) => a.recorded_at.localeCompare(b.recorded_at)).at(-1);
  const route = assigned === null || until === null || until < assigned ? [] : recorded.filter(stop =>
    !(stop.job_id === job.job_id && stop.index === stopIndex) && timestamp(stop.at)! >= assigned && timestamp(stop.at)! < until);
  // Multiple jobs can record the same visit; count a shared place/time only once.
  const unique = [...new Map(route.map(stop => [`${stop.place}|${stop.at}`, stop])).values()];
  const active = assigned === null ? [] : sameDriver.filter(row => {
    const at = timestamp(row.assigned), completed = timestamp(row.stops.at(-1)?.completed);
    return row.job_id !== job.job_id && at !== null && at <= assigned && (completed === null || completed > assigned) && row.status !== "Đã huỷ" && row.kind !== "clock_in" && row.kind !== "clock_out";
  });
  return { target, arrival, previous, route: unique, active, known: assigned !== null && until !== null && until >= assigned };
}

function DriverContext({ job, jobs, stopIndex = 0 }: { job: LookupJobRow; jobs: LookupJobRow[]; stopIndex?: number }) {
  const context = driverArrivalContext(job, jobs, stopIndex);
  const leg = driverArrivalContext(job, jobs, Math.max(0, job.stops.length - 1));
  const ownStops = job.stops.map((stop, index) => ({ ...stop, at: stop.arrived || stop.completed || "", job_id: job.job_id, index, reference: job.reference }));
  // A shared visit can appear on several jobs; keep this VID's own stop in the route.
  const route = [...new Map([...leg.route, ...ownStops].map(stop => [`${stop.place}|${stop.at || stop.index}`, stop])).values()].sort((a, b) => (a.at || "9999").localeCompare(b.at || "9999"));
  const nodeTime = (at?: string | null) => <span className="tabular-nums">{time(at)}{at && job.assigned && at.slice(0, 10) !== job.assigned.slice(0, 10) && <span className="block text-[10px] text-slate-500">{date(at)}</span>}</span>;
  return <>
    <div className="flex items-baseline justify-between gap-3"><h4 className="text-base font-semibold">{driverDisplayName(job.driver) || "Chưa phân công"}</h4><span className="shrink-0 text-xs text-slate-500">{staffCode(job.driver)}</span></div>
    <p className={`${muted} mt-1`}>{job.stops.map(stop => placeName(stop.place)).join(" → ")} · {date(job.assigned || job.start)}</p>
    <p className="mt-2 text-xs text-slate-600">{context.known ? <><strong className="text-slate-800">{context.route.length} điểm dừng</strong> trước khi đến {placeName(context.target?.place)} · {mins((timestamp(context.arrival)! - timestamp(job.assigned)!) / 60000)} từ phân công</> : "Chưa đủ giờ phân công / giờ đến để đếm điểm dừng."}</p>
    <ol aria-label="Lộ trình tài xế trong chặng liên quan" className="relative mt-3 space-y-2 before:absolute before:bottom-3 before:left-[5.5rem] before:top-3 before:w-px before:bg-slate-200">
      {context.previous && <li className="relative grid grid-cols-[4.5rem_1rem_1fr] gap-2 text-xs text-slate-600">{nodeTime(context.previous.recorded_at)}<span aria-hidden="true" className="z-10 mt-1.5 mx-auto size-2 rounded-full bg-slate-400" /><div><p title={context.previous.place} className="font-medium">{placeName(context.previous.place)}</p><p className="text-[11px]">Điểm cuối ghi nhận trước phân công</p></div></li>}
      <li className="relative grid grid-cols-[4.5rem_1rem_1fr] gap-2 text-xs">{nodeTime(job.assigned)}<Truck aria-hidden="true" className="z-10 mt-0.5 size-4 bg-white text-slate-600" /><p className="font-medium">{job.assigned ? "Được phân công chuyến này" : "Chưa có giờ phân công"}</p></li>
      {route.map(stop => {
        const ours = stop.job_id === job.job_id;
        const selected = ours && stop.index === stopIndex;
        return <li key={`${stop.job_id}-${stop.index}`} className={`relative grid grid-cols-[4.5rem_1rem_1fr] gap-2 text-xs ${selected ? "font-semibold" : ""}`}>
          {nodeTime(stop.at)}<span aria-hidden="true" className={`z-10 mx-auto mt-1.5 size-2 rounded-full ${ours ? "bg-[#F47735]" : "bg-slate-400"}`} />
          <div><p title={stop.place} className="font-medium leading-5">{placeName(stop.place)}{selected && <span className="ml-2 whitespace-nowrap rounded bg-orange-50 px-1.5 py-0.5 text-[10px] font-semibold text-orange-800">Đang xem</span>}</p><p className="text-[11px] font-normal text-slate-600">{stop.type === "Pickup" ? "Điểm lấy" : ["Delivery", "Dropoff"].includes(stop.type) ? "Điểm giao" : "Điểm dừng"}{ours ? " · VID này" : " · chuyến khác"}{stop.completed && ` · xong ${time(stop.completed)}`}{!stop.arrived && stop.completed && " · chỉ có giờ hoàn tất"}{!stop.at && " · chưa có giờ đến"}</p></div>
        </li>;
      })}
    </ol>
    <div className="mt-3 border-t border-slate-200 pt-2 text-xs text-slate-600">
      {job.assigned ? context.active.length ? <details><summary className={`cursor-pointer font-medium ${focus}`}>{context.active.length} chuyến khác chưa xong lúc phân công</summary><ul className="mt-2 space-y-2">{context.active.map(row => <li key={row.job_id}>{row.stops.map(stop => placeName(stop.place)).join(" → ")}<span className="block text-[11px]">#{row.job_id} · phân công {time(row.assigned)}</span></li>)}</ul></details> : <p>Không ghi nhận chuyến khác còn mở lúc {time(job.assigned)}.</p> : <p>Thiếu giờ phân công để xác định các chuyến khác.</p>}
      <details className="mt-2 text-[11px]"><summary className={`cursor-pointer ${focus}`}>Dữ liệu Cartrack · #{job.job_id}</summary><p className="mt-1 leading-4">{job.reference} · {job.driver}. Điểm dừng trong các ngày đã tra cứu; phân công theo bản ghi hiện tại. Lịch sử đổi tài xế không có trong dữ liệu này.</p></details>
    </div>
  </>;
}

function DriverRoute({ job, jobs }: { job: LookupJobRow; jobs: LookupJobRow[] }) {
  return <Detail name={`Lộ trình liên quan của ${job.driver || "tài xế chưa được phân công"}`} label={<span className="truncate">{driverDisplayName(job.driver) || "Chưa phân công"}</span>} className="min-h-8 text-xs font-medium"><DriverContext job={job} jobs={jobs} /></Detail>;
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
  const idle = !result && !busy;
  const singleDay = new Set(timeline.map(event => event.time.slice(0, 10))).size <= 1;
  const warnings = steps.filter(step => step.step === "warning" || step.step === "error");

  return <div className={`flex min-h-full flex-col gap-2 overflow-visible bg-white p-3 text-slate-800 selection:bg-indigo-100 sm:p-4 lg:overflow-hidden ${idle || busy ? "h-full justify-center" : "h-auto"} lg:h-full lg:min-h-0`}>
    <header className={`grid shrink-0 items-center gap-3 ${idle ? "mx-auto w-full max-w-lg text-center" : "lg:grid-cols-[1fr_auto_1fr]"}`}>
      <div><h2 className="text-base font-semibold">Tra cứu VID / Batch</h2><p className={`${muted} mt-0.5`}>Hành trình mẫu từ điểm lấy đến phòng xét nghiệm.</p></div>
      <form onSubmit={lookup} className="mx-auto flex w-full max-w-md items-center gap-2"><label htmlFor="batch-lookup-vid" className="sr-only">VID</label>
        <div className="relative min-w-0 flex-1 sm:min-w-64"><Search aria-hidden="true" className="absolute left-3 top-3 size-4 text-slate-500" /><input id="batch-lookup-vid" inputMode="numeric" autoComplete="off" placeholder="Nhập VID…" value={vid} onChange={event => setVid(event.target.value)} maxLength={20} pattern="[0-9]{8,20}" required disabled={busy} aria-invalid={!!error && !result} className={`h-10 w-full rounded-md border border-slate-300 bg-white pl-9 pr-3 text-sm tabular-nums caret-indigo-600 placeholder:text-slate-500 disabled:opacity-60 ${focus}`} /></div>
        <Button type="submit" disabled={busy} className="h-10">{busy ? "Đang tra…" : "Tra cứu"}</Button>
        {busy && <Button type="button" variant="outline" className="h-10" onClick={() => { source.current?.close(); source.current = null; setBusy(false); setProgress("Đã dừng tra cứu. Nhấn Tra cứu để bắt đầu lại."); }}>Dừng</Button>}
      </form>{!idle && <div aria-hidden="true" className="hidden lg:block" />}
    </header>
    {error && <p role="alert" className="shrink-0 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{error}{summary ? " Dữ liệu đã tìm được vẫn hiển thị bên dưới." : ""}</p>}
    {!!warnings.length && !busy && <p role="status" className="shrink-0 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">{warnings.map(step => step.msg).join(" · ")}</p>}
    {busy && <div role="status" aria-live="polite" className="space-y-3 border-t pt-4"><p className="text-sm font-medium">{progress}</p><p className={muted}>{steps.length} bước đã hoàn tất</p><div aria-hidden="true" className="space-y-3 motion-safe:animate-pulse"><div className="h-12 rounded bg-slate-100" /><div className="h-64 rounded bg-slate-50" /></div></div>}
    {!busy && progress && <p role="status" className="text-sm text-slate-600">{progress}</p>}
    {!result && !busy && !error && !progress && <p className="text-center text-xs text-slate-600">POS <ArrowRight aria-hidden="true" className="mx-2 inline size-3" /> LIS <ArrowRight aria-hidden="true" className="mx-2 inline size-3" /> Cartrack · Giờ Việt Nam (UTC+7)</p>}

    {result && summary && <>
      <section aria-label="Thông tin lượt khám" className="flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-y border-slate-200 py-2">
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
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Hành trình <span className="ml-1 font-normal text-slate-600">{timeline.length}/{result.timeline.length} sự kiện{singleDay && timeline[0] && ` · ${date(timeline[0].time)}`}</span></h3><div role="group" aria-label="Sự kiện hiển thị" className="flex rounded-md bg-slate-100 p-0.5">{[false, true].map(all => <button key={String(all)} type="button" aria-pressed={allEvents === all} onClick={() => setAllEvents(all)} className={`min-h-8 rounded px-3 text-xs font-medium ${focus} ${allEvents === all ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:bg-slate-200"}`}>{all ? "Tất cả" : "Mốc chính"}</button>)}</div></div>
          <div tabIndex={0} aria-label="Danh sách sự kiện theo thời gian" className={`min-h-0 overflow-visible rounded-lg border border-slate-200 lg:overflow-y-auto lg:flex-1 ${focus}`}>
            <table className="w-full table-fixed text-left text-xs"><colgroup><col className="w-20 sm:w-24" /><col /><col className="w-20 sm:w-24" /></colgroup><thead className="sticky top-0 z-10 bg-slate-50 text-slate-600"><tr><th scope="col" className="px-3 py-2 font-medium">Giờ VN</th><th scope="col" className="px-2 py-2 font-medium">Sự kiện</th><th scope="col" className="px-3 py-2 text-right font-medium">Từ lấy mẫu</th></tr></thead>
              <tbody>{timeline.map((event, index) => {
                const job = event.source === "Cartrack" ? summary.jobs.find(job => job.job_id === event.job_id) : undefined;
                const tag = <span className={`inline-block shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold ${event.source === "LIS" ? "bg-blue-600 text-white" : event.source === "Cartrack" ? "bg-[#F47735] text-white" : "bg-slate-100 text-slate-600"}`}>{event.source}</span>;
                return <Fragment key={`${event.time}-${event.job_id}-${event.label}-${index}`}>
                  {!singleDay && (index === 0 || timeline[index - 1].time.slice(0, 10) !== event.time.slice(0, 10)) && <tr className="bg-slate-50"><th scope="rowgroup" colSpan={3} className="px-3 py-2 text-xs font-medium text-slate-600">{date(event.time)} · Giờ Việt Nam</th></tr>}
                  <tr className={`border-t border-slate-100 align-top hover:bg-slate-50 ${event.kind === "due" ? "bg-amber-50 text-amber-900" : ""}`}>
                    <td className="whitespace-nowrap px-3 py-1 tabular-nums">{time(event.time)}</td>
                    <td className="px-2 py-0.5"><Detail name={job ? `Lộ trình tài xế: ${event.label}` : `Chi tiết: ${event.label}`} className="min-h-8 w-full text-xs font-medium sm:min-h-6 leading-5" label={<>{tag}<span className="min-w-0 [overflow-wrap:anywhere]">{event.label === "Job assigned to driver" && job ? `Phân công · ${driverDisplayName(job.driver)}` : event.label}</span></>}>
                      {job ? <DriverContext job={job} jobs={driverJobs} stopIndex={event.stop_index ?? 0} /> : <><h4 className="font-semibold">{event.label}</h4>{event.who && <p className="mt-3 break-words text-xs">{event.who}</p>}{event.detail && <p className="mt-2 text-xs text-slate-600">{event.detail}</p>}{!!event.samples.length && <p className="mt-2 break-all font-mono text-xs">{event.samples.join(", ")}</p>}</>}
                      {!job && <><p className={`${muted} mt-3`}>{date(event.time)} · {time(event.time)} · {event.source}</p><p className={`${muted} mt-1`}>Từ sự kiện trước trong timeline đầy đủ: {mins(event.since_prev_min)}</p></>}
                    </Detail></td>
                    <td className="px-3 py-1 text-right tabular-nums text-slate-600">{collected === null ? "—" : mins(Math.round((timestamp(event.time)! - collected) / 6000) / 10)}</td>
                  </tr>
                </Fragment>;
              })}</tbody>
            </table>{!timeline.length && <p className="p-4 text-sm text-slate-600">Chưa có sự kiện trong dữ liệu đã tìm được.</p>}
          </div>
          <div className="mt-2 flex shrink-0 flex-wrap justify-between gap-2 text-[11px] text-slate-600"><span>Cartrack: rê chuột hoặc nhấn để xem tài xế và lộ trình trước giờ đến.</span>{!!steps.length && <Detail name="Các bước tra cứu" label={`${steps.length} bước tra cứu`}><h4 className="font-semibold">Các bước tra cứu</h4><ol className="mt-3 space-y-2 text-xs">{steps.map((step, index) => <li key={index} className={step.step === "error" ? "text-red-700" : step.step === "warning" ? "text-amber-800" : "text-slate-600"}>{step.msg}</li>)}</ol></Detail>}</div>
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
