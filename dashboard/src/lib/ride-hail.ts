// Shared by the "Gửi xe công nghệ" form and /api/admin/ride-hail. The provider
// list is also a CHECK constraint on ride_hail_trips — change both together.
export const RIDE_HAIL_PROVIDERS = ["Grab", "Be", "Xanh SM", "Ahamove", "Khác"] as const;

export const RIDE_HAIL_ADMINS = [
  "Lý Thị Thùy Linh",
  "Lê Thị Thùy Dương",
  "Trần Thanh Vân",
  "Nguyễn Huy Thịnh",
  "Nguyễn Thành Long",
] as const;

export interface RideHailTrip {
  job_id: number;
  provider: string;
  amount_vnd: number;
  waybill: string;
  admin_name: string;
  completed_at: string | null;
}

export const formatVnd = (n: number) => `${n.toLocaleString("vi-VN")}đ`;

/** "85.000", "85,000đ", "85000" → 85000. Dots and commas count only as
 *  thousands separators, so "12.5" is refused rather than read as 125. */
export function parseVnd(raw: string): number | null {
  const s = raw.trim().replace(/\s*đ$/i, "");
  if (!/^\d+$|^\d{1,3}([.,\s]\d{3})+$/.test(s)) return null;
  const n = Number(s.replace(/[.,\s]/g, ""));
  return Number.isSafeInteger(n) && n > 0 && n <= 100_000_000 ? n : null;
}
