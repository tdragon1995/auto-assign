"use client";

import {
  splitDriverName, employmentOf, EMPLOYMENT_LABEL, EMPLOYMENT_TITLE,
} from "@/lib/driver-label";

/**
 * How a driver is shown ANYWHERE on the dashboard: the person, what kind of
 * account it is, and the staff code. One component so those three never drift
 * apart between panels.
 *
 * What is deliberately NOT shown is the label's leading "F - C - " / "P - P - ".
 * That is routing metadata on the Cartrack record; it tells the reader nothing,
 * it is the widest thing on the row, and on a phone it pushed the actual content
 * off the edge. The staff code survives because it identifies the ACCOUNT —
 * about a dozen people hold two under one personal name, and without it those
 * rows are indistinguishable.
 *
 * The FT/PT chip is what replaces the dropped prefix as the readable answer to
 * "which of this person's two accounts is this?". Part-time carries the colour;
 * full-time stays grey, because it is the common case and colouring every row
 * would spend attention on something almost always the same. A label with no
 * staff code at all ("Admin Lý Thị Thùy Linh") gets no chip rather than a
 * guessed one — neither answer is true for it.
 */
export function DriverName({
  full,
  className = "text-sm font-semibold text-slate-900",
  showCode = true,
}: {
  full: string;
  /** Styling for the name itself; the chip and code are fixed and small. */
  className?: string;
  /** Drop the staff code where the surrounding row already identifies the
   *  account, or is too narrow to carry it. The FT/PT chip stays either way. */
  showCode?: boolean;
}) {
  const { code, name } = splitDriverName(full);
  const employment = employmentOf(full);
  return (
    <>
      <span className={className}>{name}</span>
      {employment && (
        <span
          className={
            "shrink-0 rounded-full border px-1.5 py-0 text-[10px] font-semibold leading-relaxed " +
            (employment === "part-time"
              ? "border-indigo-200 bg-indigo-100 text-indigo-700"
              : "border-slate-200 bg-slate-100 text-slate-600")
          }
          title={EMPLOYMENT_TITLE[employment]}
        >
          {EMPLOYMENT_LABEL[employment]}
        </span>
      )}
      {showCode && code && (
        <span className="font-mono text-[11px] text-slate-500">{code}</span>
      )}
    </>
  );
}
