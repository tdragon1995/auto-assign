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
}: {
  label: string;
  count: number;
  tone?: "slate" | "amber" | "red";
  className?: string;
}) {
  const color =
    tone === "amber" ? "text-amber-700" : tone === "red" ? "text-red-700" : "text-slate-500";
  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <span className={`text-[11px] font-bold uppercase tracking-wide ${color}`}>{label}</span>
      <span className="rounded-full bg-slate-100 border border-slate-200 px-1.5 leading-none py-0.5 text-[10px] text-slate-600">
        {count}
      </span>
    </div>
  );
}
