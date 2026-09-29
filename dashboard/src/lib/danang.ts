export const validDanangPhone = (phone: string) => /^0[35789]\d{8}$/.test(phone.trim());

export function danangPickupNote(note: string, recipient: string, phone: string): string {
  return [note.trim(), `Người nhận: ${recipient.trim()}`, `Số điện thoại: ${phone.trim()}`]
    .filter(Boolean)
    .join("\n");
}
