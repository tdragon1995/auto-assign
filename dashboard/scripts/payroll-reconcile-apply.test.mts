import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import { diffPayRows } from "../src/lib/payroll-reconcile";
import type { PayJob, PayPunch } from "../src/lib/pay";
import { generateKeyPairSync } from "node:crypto";
import { decryptAudit } from "./payroll-audit-crypto";

const job = (id: number): PayJob => ({
  trip_date: "2026-08-15", job_id: id, driver_id: "pt-account", driver_name: "P - PT100001 Nguyễn Văn A",
  reference_number: `test-${id}`, pickup_customer_id: "D018", pickup_name: "D018",
  pickup_lat: null, pickup_lng: null, pickup_completed_ts: "2026-08-15T09:00:00+07:00",
  dropoff_customer_id: "D001", dropoff_name: "D001", dropoff_lat: null, dropoff_lng: null,
  dropoff_completed_ts: "2026-08-15T10:00:00+07:00", distance_km: 3.9,
});
const punch = (id: number, kind: "in" | "out"): PayPunch => ({
  trip_date: "2026-08-15", job_id: id, driver_id: "pt-account", driver_name: "P - PT100001 Nguyễn Văn A",
  kind, customer_id: "D001", location_name: "D001", started_ts: null, arrived_ts: null,
  completed_ts: `2026-08-15T${kind === "in" ? "09" : "10"}:00:00+07:00`, job_status_id: 5,
});
type Row = (PayJob | PayPunch) & { archived_at?: string };
const baseline = {
  jobs: [{ ...job(1), dropoff_name: "old name", archived_at: "2026-09-01T00:00:00Z" },
    { ...job(77), driver_id: "ft-account", driver_name: "P - DC100001 Nguyễn Văn A", archived_at: "2026-09-01T00:00:00Z" }],
  punches: [] as Row[],
};
const tables: Record<string, Row[]> = { pay_jobs: structuredClone(baseline.jobs), pay_punches: [] };
let failPunchWrite = true;
let payrollWrites = 0;
const kv = new Map<string, string>();
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://127.0.0.1");
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
  res.setHeader("content-type", "application/json");
  if (!url.pathname.startsWith("/rest/v1/")) {
    const one = (cmd: string[]) => {
      let value: string | null;
      if (cmd[0].toLowerCase() === "set") { kv.set(cmd[1], cmd[2]); value = "OK"; }
      else value = kv.get(cmd[1]) ?? null;
      return { result: value && req.headers["upstash-encoding"] === "base64" ? Buffer.from(value).toString("base64") : value };
    };
    res.end(JSON.stringify(Array.isArray(body[0]) ? body.map(one) : one(body)));
    return;
  }
  const table = url.pathname.split("/").at(-1)!;
  const matches = (row: Row) => [...url.searchParams].every(([field, value]) => {
    if (!["trip_date", "job_id", "archived_at"].includes(field)) return true;
    const actual = String((row as unknown as Record<string, unknown>)[field]);
    const [op, ...parts] = value.split(".");
    const wanted = parts.join(".");
    return op === "eq" ? actual === wanted : op === "gte" ? actual >= wanted : actual <= wanted;
  });
  if (req.method === "GET") {
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 1000);
    res.end(JSON.stringify(tables[table].filter(matches).sort((a, b) => a.trip_date.localeCompare(b.trip_date) || a.job_id - b.job_id).slice(offset, offset + limit)));
  } else if (req.method === "POST") {
    payrollWrites++;
    if (table === "pay_punches" && failPunchWrite) { res.statusCode = 500; res.end('{"error":"injected write failure"}'); return; }
    for (const row of body as Row[]) {
      const index = tables[table].findIndex((old) => old.trip_date === row.trip_date && old.job_id === row.job_id);
      if (index < 0) tables[table].push(row); else tables[table][index] = row;
    }
    res.end("{}");
  } else {
    tables[table] = tables[table].filter((row) => !matches(row));
    res.end("{}");
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("No test port");
const auditsRoot = resolve("payroll-audits");
mkdirSync(auditsRoot, { recursive: true });
const runDir = mkdtempSync(resolve(auditsRoot, "test-apply-"));
const proposalPath = resolve(runDir, "proposal.json");
const proposal = {
  version: 1, mode: "dry-run", report_id: "local-test", month: "2026-09", from: "2026-08-15", to: "2026-09-14",
  failed_days: [], source_exceptions: [], attendance_exceptions: 0,
  jobs: [job(1), job(2)], punches: [punch(21, "in"), punch(22, "out")], deletions: { jobs: [], punches: [] },
};
writeFileSync(proposalPath, JSON.stringify(proposal));
writeFileSync(resolve(runDir, "baseline.json"), JSON.stringify(baseline));
const run = async (...args: string[]) => {
  const child = spawn(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), "scripts/payroll-reconcile.mts", ...args], {
    env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${address.port}`, SUPABASE_SERVICE_ROLE_KEY: "test-only",
      KV_REST_API_URL: `http://127.0.0.1:${address.port}`, KV_REST_API_TOKEN: "test-only" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const [code] = await once(child, "exit");
  return { code, output };
};
try {
  const applyArgs = [`--apply=${proposalPath}`, "--confirm=APPLY-2026-09"];
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  writeFileSync(resolve(runDir, "recipient.pem"), keys.publicKey);
  const captured = await run("--month=2026-09", `--capture-baseline=${resolve(runDir, "encrypted.json")}`, `--recipient=${resolve(runDir, "recipient.pem")}`);
  assert.equal(captured.code, 0, captured.output);
  const envelope = JSON.parse(readFileSync(resolve(runDir, "encrypted.json"), "utf8"));
  const snapshot = JSON.parse(decryptAudit(envelope, keys.privateKey));
  assert.equal(snapshot.jobs.length, 2, "baseline captures PT and FT records");
  assert.equal(snapshot.drivers.length, 1, "baseline totals keep accounts separate");
  assert.equal(payrollWrites, 0, "capture is read-only");
  writeFileSync(proposalPath, JSON.stringify({ ...proposal, jobs: [{ ...job(1), trip_date: "2026-08-14" }] }));
  const outsidePeriod = await run(...applyArgs);
  assert.notEqual(outsidePeriod.code, 0);
  assert.match(outsidePeriod.output, /invalid payroll row/);
  assert.equal(payrollWrites, 0);
  writeFileSync(proposalPath, JSON.stringify(proposal));
  tables.pay_jobs[0] = { ...tables.pay_jobs[0], dropoff_name: "changed after dry-run" } as Row;
  const changedBaseline = await run(...applyArgs);
  assert.notEqual(changedBaseline.code, 0);
  assert.match(changedBaseline.output, /changed after the dry run/);
  assert.equal(payrollWrites, 0);
  tables.pay_jobs[0] = structuredClone(baseline.jobs[0]);
  const failed = await run(...applyArgs);
  assert.notEqual(failed.code, 0);
  assert.match(failed.output, /injected write failure/);
  assert.equal(JSON.parse(readFileSync(resolve(runDir, "apply-state.json"), "utf8")).completed_days.length, 0);
  assert.equal(tables.pay_jobs.length, 3, "first half of interrupted day was written");
  failPunchWrite = false;
  const resumed = await run(...applyArgs);
  assert.equal(resumed.code, 0, resumed.output);
  const applied = JSON.parse(readFileSync(resolve(runDir, "apply-audit.json"), "utf8"));
  assert.equal(applied.coverage.days_reconciled, 31);
  assert.equal(applied.coverage.ready_for_approval, true);
  assert.equal(applied.after.drivers.length, 1, "FT account excluded from payroll totals");
  assert.equal(applied.after.drivers[0].total_pay, 45600);
  assert.equal(tables.pay_jobs.filter((row) => row.job_id === 77)[0].driver_id, "ft-account");
  const writes = payrollWrites;
  assert.equal((await run(...applyArgs)).code, 0);
  assert.equal(payrollWrites, writes, "repeat apply does not rewrite completed days");
  tables.pay_jobs[0] = { ...tables.pay_jobs[0], dropoff_name: "later edit" } as Row;
  const protectedRollback = await run(`--rollback=${runDir}`, "--confirm=ROLLBACK-2026-09");
  assert.notEqual(protectedRollback.code, 0);
  assert.match(protectedRollback.output, /changed after this run/);
  assert.equal(payrollWrites, writes, "rollback refuses later edits before any writes");
  tables.pay_jobs[0] = { ...tables.pay_jobs[0], dropoff_name: "D001" } as Row;
  const rolledBack = await run(`--rollback=${runDir}`, "--confirm=ROLLBACK-2026-09");
  assert.equal(rolledBack.code, 0, rolledBack.output);
  const diff = diffPayRows(baseline.jobs, tables.pay_jobs as PayJob[]);
  assert.equal(diff.missing.length + diff.stale.length + diff.changed.length, 0);
  assert.equal(tables.pay_punches.length, 0);
  assert.equal(JSON.parse(readFileSync(resolve(runDir, "apply-state.json"), "utf8")).completed_days.length, 0);
  console.log("Payroll CLI: interrupted write, resume, repeated apply, account separation, pay totals and rollback passed.");
} finally {
  server.close();
  if (!runDir.startsWith(`${auditsRoot}${sep}`)) throw new Error("Test cleanup escaped audit directory");
  rmSync(runDir, { recursive: true, force: true });
}
