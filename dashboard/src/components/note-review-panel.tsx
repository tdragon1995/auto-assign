"use client";

import { useCallback, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export interface HeldJob {
  job_id: number;
  customer: string;
  note: string;
}

const NOTE_PREVIEW_LIMIT = 100;

/** Note content with a blue "Xem thêm / Thu gọn" toggle when it's long. The
 *  collapsed view stays on a single line so the toggle never drops to its own row. */
function HeldNote({ note }: { note: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = note.length > NOTE_PREVIEW_LIMIT;
  return (
    <div className="mt-1 rounded border border-amber-300 bg-amber-100/70 px-2 py-1">
      <span className="text-[10px] font-bold uppercase tracking-wide text-amber-700">Ghi chú</span>
      {!isLong || expanded ? (
        <p className="mt-0.5 break-words font-medium text-amber-950">
          {note}
          {isLong && (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="ml-1 font-semibold text-blue-600 hover:text-blue-800"
            >
              Thu gọn
            </button>
          )}
        </p>
      ) : (
        <div className="mt-0.5 flex items-baseline gap-1 font-medium text-amber-950">
          <span className="min-w-0 truncate">{note}</span>
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="shrink-0 font-semibold text-blue-600 hover:text-blue-800"
          >
            Xem thêm
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Lists unassigned jobs the engine held back because a stop has a note, and lets
 * the admin assign one anyway. `held` is fed by the dashboard's status poll (no
 * polling of its own); `onRefresh` re-pulls after an assign. Renders nothing
 * when there are no held jobs.
 */
export function NoteReviewPanel({
  held,
  env,
  onRefresh,
}: {
  held: HeldJob[];
  env: "prod" | "uat";
  onRefresh: () => void;
}) {
  const [busyId, setBusyId] = useState<number | null>(null);

  const assignAnyway = useCallback(
    async (job: HeldJob) => {
      if (!window.confirm(`Giao Job ${job.job_id} dù có ghi chú?\n\n"${job.note}"`)) return;
      setBusyId(job.job_id);
      try {
        const res = await fetch(`/api/assign/held?env=${env}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId: job.job_id }),
        });
        const data = await res.json();
        if (data.ok || data.assigned) {
          toast.success(`Đã giao Job ${job.job_id}`);
        } else {
          toast.error(data.error ?? `Không giao được Job ${job.job_id}`);
        }
      } catch {
        toast.error(`Không giao được Job ${job.job_id}`);
      } finally {
        setBusyId(null);
        onRefresh();
      }
    },
    [env, onRefresh],
  );

  if (held.length === 0) return null;

  return (
    <Card className="py-4 border-orange-300">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          📝 Chờ duyệt ghi chú
          <span className="text-orange-600 font-semibold">{held.length}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {held.map((job) => (
          <div key={job.job_id} className="text-xs border rounded p-2 bg-orange-50 border-orange-200">
            <div className="font-medium">
              Job {job.job_id} · {job.customer}
            </div>
            <HeldNote note={job.note} />
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-xs px-2 mt-1.5"
              disabled={busyId === job.job_id}
              onClick={() => assignAnyway(job)}
            >
              {busyId === job.job_id ? "Đang giao…" : "Giao dù có ghi chú"}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
