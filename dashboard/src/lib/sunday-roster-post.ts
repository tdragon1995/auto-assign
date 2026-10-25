/**
 * The Sunday roster as the drivers' Zalo group sees it: which lines are still
 * OPEN, and the words the bot posts about them. Pure — shared by the Lịch CN
 * tab's API, the claim endpoint, the roster picture and the cron post, so the
 * text, the picture and the "Nhận ca" button can never disagree about which
 * slots are open. `scripts/sunday-roster-post.test.mts`.
 */

/** One line of a Sunday, with the rostered person already resolved. */
export type PostLine = {
  id: number;
  area: string;
  shift: string;
  note: string;
  driver_id: string | null;
  /** Display name, staff code stripped; "" = nobody on the line. */
  name: string;
  /** Set when the rostered driver will not drive these hours (leave with no
   *  substitute, or resigned) — the line is open again. */
  away?: string | null;
};

/** The one leave fact a line needs: when, and whether someone already covers it. */
export type AwayFact = { resigned: boolean; window: string | null; covered: boolean; label: string };

export const SUNDAY_TAB_URL = "https://diag-logistics.vercel.app/cham-cong";

/** Internal roles are not part of the published driver schedule (same rule as the tab). */
export const isPublished = (area: string) => !area.includes("BO Runner") && !area.includes("Logistics General");

export const isOpen = (l: Pick<PostLine, "name" | "away">) => !l.name || !!l.away;

/** "06:00 - 15:00" (or "8:00 - 12:00") → minutes since midnight; null = blank or unreadable. */
export function shiftRange(shift: string): [number, number] | null {
  const m = shift.match(/(\d{1,2})[:.h](\d{2})\s*[-–]\s*(\d{1,2})[:.h](\d{2})/);
  if (!m) return null;
  return [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])];
}

/** Two hour ranges meet. A blank side is the whole day; a shared boundary does
 *  not count, the same half-open rule the leave coverage uses. */
export function hoursMeet(a: string | null, b: string | null): boolean {
  const ra = a ? shiftRange(a) : null, rb = b ? shiftRange(b) : null;
  if (!ra || !rb) return true;
  return ra[0] < rb[1] && rb[0] < ra[1];
}

/** Why a rostered driver will not drive this line, or null when they will. */
export function awayFor(shift: string, facts: AwayFact[]): string | null {
  for (const f of facts) {
    if (f.resigned) return f.label;
    if (!f.covered && hoursMeet(shift, f.window)) return f.label;
  }
  return null;
}

/** Morning = starts before 15:00, as the Lịch CN tab splits it. */
export const isMorning = (shift: string) => (shiftRange(shift)?.[0] ?? 0) < 15 * 60;

export const openLines = (lines: PostLine[]) => lines.filter((l) => isPublished(l.area) && isOpen(l));

const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const pad2 = (n: number) => String(n).padStart(2, "0");

function slotList(open: PostLine[]): string {
  return open.map((l) => `${l.area}\t${l.shift}${l.away ? " (cần người thay)" : ""}`).join("\n");
}

/** Friday's post, in the wording admins already use — the sign-up step now
 *  points at the "Nhận ca" button rather than replies in the group. */
export function weeklyPostText(date: string, lines: PostLine[]): string {
  const open = openLines(lines);
  const head = [
    "@All",
    `Team gửi lịch làm việc chủ nhật dự kiến ngày ${dmy(date)}`,
    `Kiểm tra ca làm việc chủ nhật tương ứng trên link chấm công => Mục/Tab "Lịch CN" (Xem hình đính kèm)*`,
  ];
  const slots = open.length
    ? [
        `Hiện đang trống ${pad2(open.length)} vị trí, ai có thể làm thì bấm "Nhận ca" trong Tab "Lịch CN" (ai nhận trước sẽ được xếp ca):`,
        slotList(open),
      ]
    : ["Lịch chủ nhật đã đủ người, cảm ơn cả nhà!"];
  const tail = [
    "Nếu có thay đổi sau mốc thời gian trên, mọi người vui lòng chủ động: Xin nghỉ theo quy định",
    `B1: Điền đơn ${SUNDAY_TAB_URL}`,
    `B2: Nhắn tin lên nhóm Zalo chung bằng cách sao chép dòng "Thông báo nghỉ..." khi nộp đơn thành công`,
    "B3: Thường xuyên kiểm tra phản hồi từ Đội điều phối & Liên hệ với anh em GNM khác để hỗ trợ làm thay.",
    "Cảm ơn cả nhà",
    SUNDAY_TAB_URL,
  ];
  return [...head, ...slots, ...tail].join("\n");
}

/** The group line after a driver takes a slot. `lines` is the roster AFTER the claim. */
export function claimText(date: string, name: string, line: Pick<PostLine, "area" | "shift">, lines: PostLine[]): string {
  const open = openLines(lines);
  const took = `✅ ${name} đã nhận ca ${line.area} ${line.shift} — Chủ nhật ${dmy(date).slice(0, 5)}.`;
  return open.length
    ? `${took}\nCòn ${pad2(open.length)} vị trí trống:\n${slotList(open)}\nBấm "Nhận ca" trong Tab "Lịch CN": ${SUNDAY_TAB_URL}`
    : `${took}\nLịch chủ nhật đã đủ người 🎉`;
}

/** Saturday evening, to the admin group, only when something is still open. */
export function adminAlertText(date: string, lines: PostLine[]): string | null {
  const open = openLines(lines);
  if (!open.length) return null;
  return `⚠️ Lịch CN ${dmy(date).slice(0, 5)} còn ${pad2(open.length)} vị trí chưa có người:\n${slotList(open)}\nCần điều phối xếp người trong Lịch Chủ nhật.`;
}
