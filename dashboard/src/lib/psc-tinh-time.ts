import { addDays, vnDate, vnMinutesSinceMidnight } from "./time";

export function pscTinhDayLabel(date: string, today = vnDate()): string {
  const day = date === today ? "Hôm nay" : date === addDays(today, 1) ? "Ngày mai" : "";
  return `${day ? `${day} · ` : ""}${date.slice(8, 10)}/${date.slice(5, 7)}`;
}

/** Absolute dates keep a selected tomorrow slot on the same day across midnight. */
export function buildPscTinhTimeSlots(now = new Date()) {
  const today = vnDate(now);
  const currentMins = vnMinutesSinceMidnight(now) % 1440;
  return [today, addDays(today, 1)].map((date, day) => ({
    date,
    label: pscTinhDayLabel(date, today),
    slots: Array.from({ length: 288 }, (_, i) => i * 5)
      .filter((mins) => day === 1 || mins > currentMins)
      .map((mins) => {
        const eta = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
        return { value: `${date}T${eta}`, label: `${eta} — ${pscTinhDayLabel(date, today)}` };
      }),
  }));
}

/** Old clients may omit the date; they still book today. */
export function pscTinhSchedule(eta: unknown, date: unknown, now = new Date()) {
  const today = vnDate(now);
  const deliveryDate = date === undefined ? today : date;
  if (typeof deliveryDate !== "string" || ![today, addDays(today, 1)].includes(deliveryDate)) {
    throw new Error("Vui lòng chọn hôm nay hoặc ngày mai.");
  }
  if (typeof eta !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(eta)) {
    throw new Error("Giờ tới nhà xe không hợp lệ.");
  }
  if (new Date(`${deliveryDate}T${eta}:00+07:00`).getTime() <= now.getTime()) {
    throw new Error("Giờ đã qua. Vui lòng chọn lại thời gian tới nhà xe.");
  }
  return {
    deliveryDate,
    // Day-start makes tomorrow's job visible from midnight; ETA stays in the stop window.
    fields: deliveryDate === today
      ? { schedule_type_id: 1 }
      : { schedule_type_id: 2, scheduled_delivery_ts: `${deliveryDate} 00:00:00` },
  };
}
