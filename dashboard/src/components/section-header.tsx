/**
 * Small labelled count header used across the "Cần xử lý" tab panels
 * (failed-jobs sections + leave-status day columns). Shared so a styling tweak
 * stays consistent between them.
 */
export function SectionHeader({
  label,
  count,
  tone = "slate",
  className = "pt-1",
  note,
}: {
  label: string;
  count: number;
  tone?: "slate" | "amber" | "red";
  className?: string;
  /** Quiet trailing text — used for "as of HH:mm" on sections whose rows are a
   *  snapshot rather than live. Rendered after the count so it never competes
   *  with the number people read off the header — but at slate-500, not 400, for
   *  the contrast reason the count below is: this text dates the rows, so a
   *  reader who cannot make it out is worse off than one who never saw it. */
  note?: string;
}) {
  const color =
    tone === "amber" ? "text-amber-700" : tone === "red" ? "text-red-700" : "text-slate-700";
  return (
    <div className={`flex items-baseline gap-1.5 ${className}`}>
      <span className={`text-xs font-semibold ${color}`}>{label}</span>
      {/* slate-500, not 400: the count is the number people actually read off
          these headers, and at 400 it sat at 2.63:1 on white — below AA — in all
          three panels that use this. */}
      <span className="text-xs tabular-nums text-slate-500">{count}</span>
      {note && <span className="text-[11px] font-normal text-slate-500">{note}</span>}
    </div>
  );
}
