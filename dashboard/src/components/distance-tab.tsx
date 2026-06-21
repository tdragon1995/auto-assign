"use client";

import { useState } from "react";
import type { Env } from "@/lib/cartrack";
import { DistanceCheckingPanel } from "./distance-checking-panel";
import { CompletedExportPanel } from "./completed-export-panel";

// The dashboard "Distance checking" tab hosts two tools, switched by an inner
// sub-tab: the lat/long pair checker and the completed-jobs export.
type Sub = "coords" | "completed";

export function DistanceTab({ env }: { env: Env }) {
  const [sub, setSub] = useState<Sub>("coords");

  const subBtn = (active: boolean) =>
    `px-2.5 py-1 text-[11px] font-semibold rounded-full transition-colors ${
      active ? "bg-slate-200 text-slate-800" : "text-slate-400 hover:text-slate-700"
    }`;

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex items-center gap-1 px-3 sm:px-4 pt-3">
        <button onClick={() => setSub("coords")} className={subBtn(sub === "coords")}>
          Kiểm tra toạ độ
        </button>
        <button onClick={() => setSub("completed")} className={subBtn(sub === "completed")}>
          Chuyến hoàn thành
        </button>
      </div>

      {sub === "coords" ? <DistanceCheckingPanel /> : <CompletedExportPanel env={env} />}
    </div>
  );
}
