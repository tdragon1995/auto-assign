"use client";

import type { SheetAlarm } from "@/lib/types";

/**
 * Two different kinds of trouble with the spreadsheet, which need opposite words.
 *
 * REFUSED — a column the reader cannot work without went missing, or the response
 * was not a sheet at all. Nothing has stopped: the last good copy of that tab is
 * still in use, so assignment carries on exactly as before. What has changed is
 * that the engine and the spreadsheet no longer agree, and every edit made since
 * is being ignored. Urgent, and red, because the longer it stands the further the
 * two drift apart.
 *
 * DATA — the tab read perfectly and some of its ROWS are wrong: two rules live at
 * the same minute, a name that no longer resolves, one branch name meaning two
 * places. Nothing is stale and edits take effect normally.
 *
 * They were previously rendered with the same words, which said the engine was
 * running on an old copy and that changes to the tab had no effect — both false
 * for a data warning, and alarming in exactly the wrong direction. Whoever read
 * it would go hunting for a broken column that was never broken.
 */
export function SheetAlarmBanner({ alarms }: { alarms: SheetAlarm[] }) {
  // Absent kind means an older snapshot, which only ever carried refusals.
  const refused = alarms.filter((a) => (a.kind ?? "refused") === "refused");
  const data = alarms.filter((a) => a.kind === "data");
  if (refused.length === 0 && data.length === 0) return null;

  return (
    <div className="shrink-0 flex flex-col gap-2">
      {refused.length > 0 && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2">
          <div className="flex items-baseline gap-2">
            <span className="text-xs font-semibold text-red-800">
              Sheet sai cấu trúc — engine đang chạy bằng bản cũ
            </span>
            <span className="text-[11px] text-red-600">{refused.length} tab</span>
          </div>
          <ul className="mt-1.5 flex flex-col gap-1">
            {refused.map((a) => (
              <li key={a.label} className="text-[11px] leading-snug text-red-900">
                <span className="font-medium">{a.label}</span>
                <span className="text-red-700 whitespace-pre-line"> — {a.reason}</span>
                <span className="text-red-500"> · {a.ts}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] leading-snug text-red-700">
            Sửa lại cột trên sheet rồi bấm Refresh. Trong lúc chờ, mọi thay đổi
            trên tab đó không có tác dụng.
          </p>
        </div>
      )}

      {data.length > 0 && (
        <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2">
          <div className="flex items-baseline gap-2">
            <span className="text-xs font-semibold text-amber-800">
              Dữ liệu trong sheet cần xem lại
            </span>
            <span className="text-[11px] text-amber-600">{data.length} mục</span>
          </div>
          <ul className="mt-1.5 flex flex-col gap-1">
            {data.map((a) => (
              <li key={a.label} className="text-[11px] leading-snug text-amber-900">
                <span className="font-medium">{a.label}</span>
                <span className="text-amber-700 whitespace-pre-line"> — {a.reason}</span>
                <span className="text-amber-500"> · {a.ts}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] leading-snug text-amber-700">
            Sheet vẫn đọc được bình thường và thay đổi vẫn có tác dụng — đây là
            các DÒNG cần sửa, không phải cấu trúc. Sửa xong bấm Refresh.
          </p>
        </div>
      )}
    </div>
  );
}
