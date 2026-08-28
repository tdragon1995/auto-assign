"use client";

import { useCallback, useEffect, useState } from "react";
import { Lightbulb } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface NoteSuggestion {
  ok: number;
  sched: number;
  sample: string;
  last: string;
}

/**
 * Sentences the engine has watched you approve and is offering for the safe list.
 *
 * A sentence reaches here after three "Giao ngay" approvals in a row with no
 * "Hẹn giờ" in between. Accepting it means jobs carrying exactly that sentence
 * go straight to a driver from then on — during working hours only — instead of
 * waiting here. The engine never adds one by itself: this row is the last moment
 * anyone reads the sentence, because once it is on the list its jobs stop
 * arriving in this queue.
 *
 * Fetches on mount and whenever the queue below it changes — the only moments a
 * new suggestion can appear — rather than on the dashboard's 90-second poll,
 * which would spend a Redis command every time for an answer that changes once
 * or twice a month.
 */
export function NoteSuggestionPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const [items, setItems] = useState<NoteSuggestion[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/assign/note-list");
      const data = await res.json();
      setItems(Array.isArray(data.suggestions) ? data.suggestions : []);
    } catch {
      /* a missing suggestion is not worth a error toast on the landing tab */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const decide = async (s: NoteSuggestion, action: "accept" | "dismiss") => {
    if (
      action === "accept" &&
      !window.confirm(
        `Luôn tự giao việc có đúng ghi chú này?\n\n"${s.sample}"\n\n` +
          `Từ nay việc mang đúng câu này sẽ được giao thẳng cho tài xế trong giờ làm việc, ` +
          `không chờ duyệt nữa. Ghi chú vẫn hiện nguyên văn cho tài xế đọc.`,
      )
    ) {
      return;
    }
    setBusy(s.sample);
    try {
      const res = await fetch("/api/assign/note-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sentence: s.sample, action }),
      });
      const data = await res.json();
      if (data.ok) {
        setItems((prev) => prev.filter((x) => x.sample !== s.sample));
        toast.success(action === "accept" ? "Đã thêm vào danh sách tự giao" : "Đã bỏ qua ghi chú này");
      } else {
        toast.error(data.error ?? "Không lưu được, vui lòng thử lại");
      }
    } catch {
      toast.error("Lỗi kết nối, vui lòng thử lại");
    } finally {
      setBusy(null);
    }
  };

  if (items.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 pt-1">
        <Lightbulb className="size-3.5 text-sky-600" strokeWidth={2} />
        <span className="text-xs font-semibold text-sky-700">Ghi chú nên tự giao</span>
        <span className="text-xs tabular-nums text-slate-400">{items.length}</span>
      </div>

      {items.map((s) => (
        <div
          key={s.sample}
          className="space-y-1.5 rounded-md border border-sky-200 bg-sky-50/60 px-2.5 py-2"
        >
          <p className="break-words text-[13px] font-medium leading-snug text-slate-900">
            &ldquo;{s.sample}&rdquo;
          </p>
          <p className="text-[11px] text-slate-600">
            Đã duyệt giao <span className="font-semibold text-slate-900">{s.ok} lần liên tiếp</span>
            {s.sched > 0 && <> · từng hẹn giờ {s.sched} lần trước đó</>}
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <Button
              size="sm"
              className="bg-sky-600 text-xs hover:bg-sky-700"
              disabled={busy === s.sample}
              onClick={() => decide(s, "accept")}
            >
              {busy === s.sample ? "Đang lưu…" : "Luôn tự giao"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-xs"
              disabled={busy === s.sample}
              onClick={() => decide(s, "dismiss")}
            >
              Bỏ qua
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
