import { NextRequest, NextResponse } from "next/server";
import { editClient, editDriver } from "@/lib/master-profile";
import { deleteMasterRule, masterClient, masterClients, masterDrivers, masterRules, saveMasterRule, type RuleInput } from "@/lib/master-store";
import { invalidateConfigCache, invalidateDriversCache } from "@/lib/config";
import { syncLabcenterMetadata } from "@/lib/master-sync";

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
