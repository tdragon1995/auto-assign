import { NextRequest, NextResponse } from "next/server";
import { editClient, editDriver } from "@/lib/master-profile";
import { deleteMasterRule, masterClient, masterClients, masterDrivers, masterRules, saveMasterRule, type RuleInput } from "@/lib/master-store";
import { invalidateConfigCache, invalidateDriversCache } from "@/lib/config";
import { syncLabcenterMetadata } from "@/lib/master-sync";
import { publicClient, publicDriver, publicRule } from "@/lib/master-public";
import { masterEnabled, alternateDropoffChanges, writeMasterRules } from "@/lib/master-store";

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
    if (view === "clients") return NextResponse.json({ rows: (await masterClients()).map(publicClient) });
    if (view === "drivers") return NextResponse.json({ rows: (await masterDrivers()).map(publicDriver) });
    if (view === "rules") return NextResponse.json({ rows: (await masterRules("weekday")).map(publicRule), readOnly:!masterEnabled() });
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
  try {
    const body = await req.json();
    if (!body || typeof body !== "object") throw new Error("Invalid body");
    if (!["client", "driver", "alternate_dropoffs"].includes(body.kind) && !authorized(req)) return deny();
    if (body.kind === "alternate_dropoffs") {
      if (typeof body.id !== "string") throw new Error("Invalid client ID");
      const changes = alternateDropoffChanges(body.id, body.rows, await masterRules("weekday"));
      const result = await writeMasterRules(changes);
      await invalidateConfigCache();
      return NextResponse.json({ ok: true, result });
    }
    if (body.kind === "client" || body.kind === "driver") {
      if (typeof body.id !== "string" || !body.patch || typeof body.patch !== "object" || Array.isArray(body.patch)) throw new Error("Invalid profile patch");
      if ("bot_token" in body.patch && !authorized(req)) return deny();
    }
    if (body.kind === "client") {
      const result = await editClient(body.id, body.patch);
      await invalidateConfigCache();
      return NextResponse.json({ ok: true, result });
    }
    if (body.kind === "driver") {
      const result = await editDriver(body.id, body.patch);
      invalidateDriversCache();
      await invalidateConfigCache();
      return NextResponse.json({ ok: true, result });
    }
    if (body.kind === "rule") {
      if (!Number.isSafeInteger(body.rule_id) || !Number.isSafeInteger(body.revision)) throw new Error("Invalid rule ID/revision");
      const row = await saveMasterRule(body.input as RuleInput, body.rule_id, body.revision);
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
    if (body?.kind !== "rule" || !Number.isSafeInteger(body.rule_id) || !Number.isSafeInteger(body.revision)) throw new Error("Invalid rule ID/revision");
    await deleteMasterRule(body.rule_id, body.revision);
    await invalidateConfigCache();
    return NextResponse.json({ ok: true });
  } catch (e) { return error(e); }
}
