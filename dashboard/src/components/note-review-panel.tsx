"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface HeldJob {
  job_id: number;
  customer: string;
  note: string;
}

/**
 * Lists unassigned jobs the engine held back because a stop has a note, and lets
 * the admin assign one anyway. Renders nothing when there are no held jobs.
 */
export function NoteReviewPanel({ env }: { env: "prod" | "uat" }) {
  const [held, setHeld] = useState<HeldJob[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/assign/held?env=${env}`);
      const data = await res.json();
      if (Array.isArray(data.held)) setHeld(data.held);
    } catch {
      /* transient — keep last known list */
    }
  }, [env]);

  useEffect(() => {
    load();
    const id = setInterval(load, 20_000);
    return () => clearInterval(id);
  }, [load]);

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
        load();
      }
    },
    [env, load],
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
            <div className="text-muted-foreground italic mt-0.5 break-words">“{job.note}”</div>
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
