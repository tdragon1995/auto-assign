"use client";

/**
 * The four-step progress bar and status chip shared by the three request pages
 * (/qr, /psc-tinh, /ao). They all describe the same journey — a request is made, a
 * driver collects, the sample travels, someone signs for it — so they should not
 * each invent their own vocabulary for it.
 *
 * State: 0 waiting for dispatch · 1 driver heading to pickup · 2 collected and in
 * transit · 3 handed over.
 */

/** 4 = rejected by a driver: a closed outcome, not a stage of the journey.
 *  5 = parked on a proxy account until its appointed pickup time. Also waiting, but
 *  for the clock rather than for a dispatcher, which is a different answer to "when?" */
export type TripState = 0 | 1 | 2 | 3 | 4 | 5;

export const TRIP_STEPS = ["Yêu cầu", "Lấy mẫu", "Đang giao", "Đã giao"] as const;

export const TRIP_STATE_STYLE: Record<TripState, string> = {
  0: "bg-amber-100 text-amber-700",
  1: "bg-blue-100 text-blue-700",
  2: "bg-blue-100 text-blue-700",
  3: "bg-green-100 text-green-700",
  4: "bg-red-100 text-red-700",
  5: "bg-amber-100 text-amber-700",
};

/** True while a trip is still waiting to start — either state of waiting. */
export function isTripWaiting(state: TripState): boolean {
  return state === 0 || state === 5;
}

/** Names the destination rather than assuming it — only D001 is the central lab. */
export function tripStateText(state: TripState, dest?: string): string {
  const to = dest ? ` đến ${dest}` : "";
  if (state === 0) return "Chờ điều phối";
  if (state === 5) return "Chờ tới giờ hẹn";
  if (state === 1) return "Tài xế đang đến lấy";
  if (state === 2) return `Đang giao${to}`;
  if (state === 4) return "Đã từ chối";
  return "Đã giao";
}

/** Cartrack stop_status_id: 1 chờ · 2 đang đến · 3 đã đến · 4 xong · 5 từ chối.
 *  jobStatusId 3 (rejected) and 2 (unassigned) override the stop-derived reading;
 *  `parked` (job sitting on a proxy account) outranks both readings of "assigned". */
export function tripStateFromStops(
  pickupStatusId?: number | null,
  dropoffStatusId?: number | null,
  hasDriver = true,
  jobStatusId?: number | null,
  parked = false,
): TripState {
  if (jobStatusId === 3) return 4;
  if (dropoffStatusId === 4) return 3;
  if (pickupStatusId === 4) return 2;
  if (parked) return 5;
  if (jobStatusId === 2) return 0;
  return hasDriver ? 1 : 0;
}

export function TripSteps({ times, state }: { times: (string | null)[]; state: TripState }) {
  // Steps completed so far; the "current" step pulses.
  const doneUpto = state === 2 ? 1 : state === 3 ? 3 : 0;
  const nowIdx = state === 3 ? -1 : isTripWaiting(state) ? 0 : state === 1 ? 1 : 2;

  return (
    <div className="flex items-start mt-1 mb-1">
      {TRIP_STEPS.map((label, i) => {
        const done = state === 3 || i <= doneUpto;
        const current = i === nowIdx;
        return (
          <div key={label} className="flex-1 flex flex-col items-center relative">
            {i > 0 && (
              <span
                aria-hidden
                className={`absolute top-[5px] -left-1/2 w-full h-[3px] ${done || current ? "bg-green-600" : "bg-slate-200"}`}
              />
            )}
            <span
              aria-hidden
              className={`relative z-10 w-3.5 h-3.5 rounded-full border-[3px] ${
                done ? "bg-green-600 border-green-600"
                  : current ? "bg-white border-blue-600 animate-pulse"
                  : "bg-slate-200 border-slate-200"
              }`}
            />
            <span className={`mt-1.5 text-[10px] font-semibold leading-tight text-center ${
              done ? "text-green-700" : current ? "text-blue-700" : "text-slate-500"
            }`}>
              {label}
            </span>
            {times[i] && <span className="text-[10px] font-bold tabular-nums text-slate-500">{times[i]}</span>}
          </div>
        );
      })}
    </div>
  );
}
