"use client";

import type { SheetAlarm } from "@/lib/types";

/**
 * A spreadsheet tab the engine has REFUSED to read, because a column it cannot
 * work without went missing or the response was not a sheet at all.
 *
 * This is not a job failure and deliberately does not look like one. Nothing has
 * stopped: the last good copy of that tab is still being used, so assignment
 * carries on exactly as it did before the edit. What has changed is that the
 * engine and the spreadsheet no longer agree, and every edit made since is being
 * ignored — which is invisible unless something says so.
 *
 * Red rather than amber, and above the job list, because the longer it stands the
 * further the two drift apart.
 */
export function SheetAlarmBanner({ alarms }: { alarms: SheetAlarm[] }) {
  if (alarms.length === 0) return null;

  return (
    <div className="shrink-0 rounded border border-red-300 bg-red-50 px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-semibold text-red-800">
          Sheet sai cấu trúc — engine đang chạy bằng bản cũ
        </span>
        <span className="text-[11px] text-red-600">
          {alarms.length} tab
        </span>
      </div>

      <ul className="mt-1.5 flex flex-col gap-1">
        {alarms.map((a) => (
          <li key={a.label} className="text-[11px] leading-snug text-red-900">
            <span className="font-medium">{a.label}</span>
            <span className="text-red-700"> — {a.reason}</span>
            <span className="text-red-500"> · {a.ts}</span>
          </li>
        ))}
      </ul>

      <p className="mt-1.5 text-[11px] leading-snug text-red-700">
        Sửa lại cột trên sheet rồi bấm Refresh. Trong lúc chờ, mọi thay đổi trên
        tab đó không có tác dụng.
      </p>
    </div>
  );
}
