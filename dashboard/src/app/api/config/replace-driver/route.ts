import { resolveConfigDay } from "@/lib/config-day";
import { NextRequest, NextResponse } from "next/server";
import { replaceConfigDriver } from "@/lib/sheets-writer";
import { loadDriversFromSheet, invalidateConfigCache } from "@/lib/config";
import { parseConfigTargets } from "@/lib/config-targets";
import { getDrivers } from "@/lib/cartrack";
import { masterDriver, masterEnabled } from "@/lib/master-store";
import { syncMissingProfiles } from "@/lib/master-sync";
import { sbSelectAll } from "@/lib/supabase-rest";

/**
 * Replace one driver with another across the config — "Hùng nghỉ, từ nay Nam
 * chạy các điểm của Hùng" in one action instead of a branch at a time.
 *
 * The rows come from the dashboard (what the person ticked in the preview), and
 * each is re-checked against the live sheet before it is written — see
 * replaceConfigDriver. Only the Driver cell is touched: hours, destination and
 * the other names on a smart row all stay as they are.
 *
 * `to` must be on the roster tab, the same check complete-row makes: a name that
 * is not there writes perfectly well and resolves to a blank id. `from` is NOT
 * checked — the commonest reason to replace someone is that they have left, and
 * a driver already taken off the roster is exactly the one whose rows need
 * moving.
 *
 * The cache is bumped ONCE for the whole set.
 */

export async function POST(req: NextRequest) {
  const bad = (msg: string, code = 400) => NextResponse.json({ ok: false, error: msg }, { status: code });
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return bad("Body không hợp lệ");
    const configDay = resolveConfigDay(body.config_day);
    const { from, to, rows } = body as {
      from?: string; to?: string; rows?: unknown;
    };
    const fromName = (from ?? "").trim(), toName = (to ?? "").trim();
    if (!fromName) return bad("Chưa chọn tài xế cần thay");
    if (!toName) return bad("Chưa chọn tài xế thay thế");
    if (fromName === toName) return bad("Hai tài xế trùng nhau");
    // A name is one cell entry; a comma would be read as a second driver.
    if (fromName.includes(",") || toName.includes(",")) return bad("Mỗi bên chỉ một tài xế");
    const parsed = parseConfigTargets(rows);
    if ("error" in parsed) return bad(parsed.error);

    if (masterEnabled() && configDay === "weekday") {
      const drivers = await getDrivers();
      if (drivers.length < 100) return bad("Chưa đọc đủ tài xế Cartrack — thử lại sau", 503);
      const matches = drivers.filter((d) => d.is_active && `${d.first_name} ${d.last_name}`.trim() === toName);
      if (matches.length !== 1) return bad(`"${toName}" không xác định duy nhất trong Cartrack`);
      const id = matches[0].delivery_driver_id;
      if (!(await masterDriver(id))) {
        const clients = await sbSelectAll<{ customer_id: string }>("master_clients", "select=customer_id", "customer_id.asc");
        await syncMissingProfiles([{ source_row: 0, row_data: { driver_id: id } }],
          new Set(clients.map((c) => c.customer_id)), new Set());
      }
    } else {
      const drivers = await loadDriversFromSheet();
      if (drivers.length === 0) return bad("Chưa đọc được danh sách tài xế — thử lại sau", 503);
      if (!drivers.some((d) => d.name === toName)) return bad(`"${toName}" không có trong tab Driver — chọn từ danh sách`);
    }

    const result = await replaceConfigDriver({ config_day: configDay, from: fromName, to: toName, targets: parsed.targets });
    if (result.replaced.length > 0) await invalidateConfigCache();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // A Sunday attempt or a renamed column is the caller's to resolve.
    return bad(e instanceof Error ? e.message : String(e), 409);
  }
}
