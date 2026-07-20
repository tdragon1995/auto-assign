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
    tone === "amber" ? "text-amber-700" : tone === "red" ? "text-red-700" : "text-slate-700";
  return (
    <div className={`flex items-baseline gap-1.5 ${className}`}>
      <span className={`text-xs font-semibold ${color}`}>{label}</span>
      <span className="text-xs tabular-nums text-slate-400">{count}</span>
    </div>
  );
}
