/** Đà Nẵng bookings must be made at least this far ahead. */
export const DANANG_LEAD_MINS = 12 * 60;

export const validDanangPhone = (phone: string) => /^0[35789]\d{8}$/.test(phone.trim());

export function danangPickupNote(note: string, recipient: string, phone: string): string {
  return [note.trim(), `Tên nhân viên: ${recipient.trim()}`, `Số Điện Thoại Nhân Viên: ${phone.trim()}`]
    .filter(Boolean)
    .join("\n");
}
