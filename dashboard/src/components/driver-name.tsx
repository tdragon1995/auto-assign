"use client";

import {
  splitDriverName, employmentOf, EMPLOYMENT_LABEL, EMPLOYMENT_TITLE,
} from "@/lib/driver-label";

/**
 * How a driver is shown ANYWHERE on the dashboard: the person, what kind of
 * account it is, and the staff code. One component so those three never drift
 * apart between panels.
 *
 * NEITHER the "F - C - " routing prefix NOR the staff code is shown. Both are
 * identifiers for the Cartrack record rather than anything a person reads, and
 * between them they were most of the width of a row on a phone.
 *
 * The code was the harder call, because it was carrying a real job: about a
 * dozen people hold two accounts under one personal name, and two rows for the
 * same person differ ONLY by which account they name. The FT/PT chip now answers
 * exactly that question, in two characters instead of eight, and it answers it
 * in words rather than in payroll codes — the pairs are always one full-time and
 * one part-time, never two of a kind, so the chip separates them completely.
 * The full label stays reachable as the name's tooltip for the rare moment
 * someone needs the code itself.
 *
 * Part-time carries the colour; full-time stays grey, because it is the common
 * case and colouring every row would spend attention on something almost always
 * the same. A label with no staff code at all ("Admin Lý Thị Thùy Linh") gets no
 * chip rather than a guessed one — neither answer is true for it.
 */
export function DriverName({
  full,
  className = "text-sm font-semibold text-slate-900",
}: {
  full: string;
  /** Styling for the name itself; the chip is fixed and small. */
  className?: string;
}) {
  const { name } = splitDriverName(full);
  const employment = employmentOf(full);
  return (
    <>
      {/* The whole label, code and all, one hover away — so dropping it from the
          row costs nothing on the rare occasion the code is what is wanted. */}
      <span className={className} title={full}>{name}</span>
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
    </>
  );
}
