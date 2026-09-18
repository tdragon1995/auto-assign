// /corp — corporate clinics that send samples to D001. Shared by the page and the API
// (whitelist: the client never picks a customer_id the server has not listed).

/** Marks a trip as booked from /corp; the page lists only trips carrying it. */
export const CORP_LABEL = "Mẫu Corp";

export const CORP_DROPOFF_ID = "3927b076-3af9-11ed-b939-506b8dbc8dfb"; // BRA - D001

export const CORP_CLINICS: { customer_id: string; name: string; short: string; phone: string }[] = [
  { customer_id: "afe6f722-4daf-11f1-9378-fa163ee8d8ac", name: "22303 - D3 - DBPhu - Vietmedi Điện Biên Phủ", short: "Vietmedi Điện Biên Phủ", phone: "02862720399" },
  { customer_id: "8109495e-580f-11f1-9378-fa163ee8d8ac", name: "49787862 - D1 - NTMKhai - Phòng Khám Đa Khoa DHA Healthcare", short: "DHA Healthcare", phone: "0937192725" },
  { customer_id: "6c9c33de-8745-11ee-98f4-506b8d9879b5", name: "18564 - D1 - NTrai - PHÒNG KHÁM ĐA KHOA IVY HEALTH", short: "IVY Health", phone: "0908710710" },
];

/** "0937 192 725" / "+84937192725" → "937192725", the national form Cartrack stores
 *  beside contact_code 84. null when it is not a Vietnamese mobile or landline. */
export function normalizeVnPhone(raw: string): string | null {
  const digits = raw.replace(/[\s.\-()]/g, "").replace(/^\+?84/, "").replace(/^0/, "");
  return /^\d{9,10}$/.test(digits) ? digits : null;
}
