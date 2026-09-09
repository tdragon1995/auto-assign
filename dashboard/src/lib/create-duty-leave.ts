import type { SubDutyConflict } from "./sub-duty";

/** Creation is acknowledged before cover is saved, so a retry cannot re-append. */
export async function createDutyLeave(
  duty: SubDutyConflict,
  request: typeof fetch,
): Promise<void> {
  const windowed = !!(duty.from && duty.to);
  const response = await request("/api/nghi-phep", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      driver_id: duty.driver_id,
      driver_name: duty.name,
      loai_nghi: windowed ? "nua_buoi" : "nguyen_buoi",
      ngay_bat_dau: duty.date,
      ngay_ket_thuc: windowed ? undefined : duty.date,
      gio_bat_dau: windowed ? duty.from : undefined,
      gio_ket_thuc: windowed ? duty.to : undefined,
      note: "Nhập từ dashboard — bố trí người thay cho tài xế đang đi thay",
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.success) {
    throw new Error(result.error || `Không tạo được dòng nghỉ (HTTP ${response.status})`);
  }
}
