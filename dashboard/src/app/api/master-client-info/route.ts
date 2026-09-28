import { NextRequest, NextResponse } from "next/server";
import { editClient, editDriver } from "@/lib/master-profile";
import { deleteMasterRule, masterClient, masterClients, masterDrivers, masterRules, saveMasterRule, type MasterClient, type RuleInput } from "@/lib/master-store";
import { invalidateConfigCache, invalidateDriversCache } from "@/lib/config";
import { cartrackList, syncLabcenterMetadata } from "@/lib/master-sync";
import { sbSelectAll } from "@/lib/supabase-rest";
import { fetchSheetRows, SHEET_CONTRACT, SHEET_GID } from "@/lib/sheets";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

function authorized(req: NextRequest) {
  const key = process.env.MASTER_CLIENT_INFO_EDIT_KEY;
  return !!key && req.headers.get("x-master-edit-key") === key;
}
const deny = () => NextResponse.json({ error: "Master Client Info access denied" }, { status: 401 });
const error = (e: unknown) => NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });

export async function GET(req: NextRequest) {
  if (!authorized(req)) return deny();
  try {
    const view = req.nextUrl.searchParams.get("view");
    if (view === "summary") {
      const [clients, sheet, live] = await Promise.all([
        sbSelectAll<Pick<MasterClient, "customer_id" | "client_code"> & { customer_name: string | null }>(
          "master_clients",
          "select=customer_id,customer_name:cartrack->>customer_name,client_code,new_ward,nearest_psc_name,nearest_psc_km,default_dropoff_name,eta_minutes,sales_name,sales_email,supervisor_name,supervisor_email",
          "customer_id.asc",
        ),
        fetchSheetRows(SHEET_GID.mapping, SHEET_CONTRACT.mapping),
        cartrackList("customers").catch((e) => { console.error("Cartrack client list unavailable; using stored profiles", e); return []; }),
      ]);
      if (clients.length < 100 || sheet.length < 100) throw new Error("Danh sách khách hàng hoặc Google Sheet chưa tải đủ — thử lại");
      const ids = new Set(sheet.map((r) => r.customer_id?.trim()).filter(Boolean));
      const names = new Set(sheet.filter((r) => !r.customer_id?.trim()).map((r) => r["Điểm Pick-up"]?.trim().toLocaleLowerCase("vi")).filter(Boolean));
      const stored = new Map(clients.map((c) => [c.customer_id, c]));
      const current = live.length > 100 ? live.map((c) => ({
        customer_id: String(c.customer_id ?? ""), customer_name: String(c.customer_name ?? ""),
      })).filter((c) => c.customer_id) : clients;
      return NextResponse.json({ rows: current.map((c) => {
        const name = c.customer_name?.trim() ?? "";
        const code = name.split(/\s*-\s*/, 1)[0].trim();
        return { ...stored.get(c.customer_id), ...c,
          client_code: stored.get(c.customer_id)?.client_code ?? (/^\d+$/.test(code) ? code : null),
          mapped: ids.has(c.customer_id) || names.has(name.toLocaleLowerCase("vi")),
        };
      }) });
    }
    if (view === "clients") return NextResponse.json({ rows: await masterClients() });
    if (view === "drivers") return NextResponse.json({ rows: await masterDrivers() });
    if (view === "rules") return NextResponse.json({ rows: await masterRules("weekday") });
    return NextResponse.json({ error: "Unknown view" }, { status: 400 });
  } catch (e) { return error(e); }
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return deny();
  try {
    const body = await req.json();
    if (body?.kind === "refresh_client") {
      const client = typeof body.id === "string" ? await masterClient(body.id) : null;
      if (!client || !client.client_code || !/^\d+$/.test(client.client_code)) throw new Error("Khách hàng không có mã số Sapoche hợp lệ");
      return NextResponse.json({ ok: true, result: await syncLabcenterMetadata(0, 200, [client.client_code]) });
    }
    if (!body || body.kind !== "rule" || !body.input) return NextResponse.json({ error: "Invalid rule" }, { status: 400 });
    const row = await saveMasterRule(body.input as RuleInput);
    await invalidateConfigCache();
    return NextResponse.json({ ok: true, row });
  } catch (e) { return error(e); }
}

export async function PATCH(req: NextRequest) {
  if (!authorized(req)) return deny();
  try {
    const body = await req.json();
    if (!body || typeof body !== "object") throw new Error("Invalid body");
    if (body.kind === "client") return NextResponse.json({ ok: true, result: await editClient(body.id, body.patch) });
    if (body.kind === "driver") {
      const result = await editDriver(body.id, body.patch);
      invalidateDriversCache();
      return NextResponse.json({ ok: true, result });
    }
    if (body.kind === "rule") {
      if (!Number.isInteger(body.row) || typeof body.version !== "string") throw new Error("Invalid rule version");
      const row = await saveMasterRule(body.input as RuleInput, body.row, body.version);
      await invalidateConfigCache();
      return NextResponse.json({ ok: true, row });
    }
    throw new Error("Unknown kind");
  } catch (e) { return error(e); }
}

export async function DELETE(req: NextRequest) {
  if (!authorized(req)) return deny();
  try {
    const body = await req.json();
    if (body?.kind !== "rule" || !Number.isInteger(body.row) || typeof body.version !== "string") throw new Error("Invalid rule");
    await deleteMasterRule(body.row, body.version);
    await invalidateConfigCache();
    return NextResponse.json({ ok: true });
  } catch (e) { return error(e); }
}
