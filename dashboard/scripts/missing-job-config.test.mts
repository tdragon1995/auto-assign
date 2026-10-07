// Run: npx tsx scripts/missing-job-config.test.mts. No live reads or writes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { servesDropoff, applyCopiedLines } from "../src/lib/config-shift";
import { isInactiveLocation } from "../src/lib/location-status";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FailedJobsPanel } from "../src/components/failed-jobs-panel";
import { BranchEditor } from "../src/components/config-todo-panel";

const source = ts.createSourceFile("panel.tsx", readFileSync(new URL("../src/components/failed-jobs-panel.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const loader = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "loadMissingJobConfig");
assert.ok(loader);
const code = ts.transpile(ts.createPrinter().printNode(ts.EmitHint.Unspecified, loader, source), {target:ts.ScriptTarget.ES2022});
const pickupId = "pickup", dropoffId = "dropoff";
const calls: string[] = [];
let stale = false, badStatus = false, missingStop = false, day = "weekday";
let rows: object[] = [];
let clients = [
  {customer_id:pickupId, cartrack:{customer_name:"Correct pickup"}},
  {customer_id:dropoffId, cartrack:{customer_name:"BRA - D006"}},
  {customer_id:"other", cartrack:{customer_name:"Correct pickup"}},
  {customer_id:"inactive", cartrack:{customer_name:"{inactive} Old location"}},
];
const load = new Function("fetch", "servesDropoff", "isInactiveLocation", `${code};return loadMissingJobConfig;`)(
  async (url: string, init: RequestInit) => {
    calls.push(url);
    assert.ok(!init.method || init.method === "GET", "opening the editor must not write anything");
    const body = url.includes("/admin/job") ? {
      pickup:{customer_id:pickupId, customer_name:"stale pickup name"},
      dropoff:missingStop ? null : {customer_id:dropoffId, customer_name:"stale destination name"},
    } : url.includes("metadata") ? {clients} : {day, tab:"Supabase", rows, stale};
    return new Response(JSON.stringify(body), {status:badStatus ? 502 : 200});
  }, servesDropoff, isInactiveLocation,
);
const config = await load(34479357, "uat");
assert.ok(calls.includes("/api/admin/job?job_id=34479357&env=uat"));
assert.ok(calls.includes("/api/config/rows?fresh=1"));
assert.equal(config.pickupId, pickupId);
assert.equal(config.pickupName, "Correct pickup");
assert.equal(config.dropoffName, "BRA - D006");
assert.equal(config.configDay, "weekday");
assert.deepEqual(config.extraLines, [{driver:"",start:"",end:"",dropoff:"BRA - D006",assignment_mode:"fixed"}]);
assert.ok(!config.locations.some((c: {id:string}) => c.id === "inactive"));
const noop = () => {};
const props = {held:[],env:"prod" as const,onNoteRefresh:noop,onNoteAssigned:noop,onNoteManualAssign:noop,warnings:[],warningsAt:null,
  scheduleErrors:[],drivers:[],onAssign:noop,onScheduleFailed:noop,onRetrySchedule:noop,retryingSchedule:false,
  leaveToday:[],leaveTomorrow:[],onLeaveRefresh:noop,onConfigSaved:noop};
for (const reason of ["NO_MAPPING", "NO_DROPOFF_RULE", "NO_DRIVER", "INVALID_DRIVER"] as const) {
  const html = renderToStaticMarkup(createElement(FailedJobsPanel, {...props,failed:[{job_id:34479357,customer:"Pickup → BRA - D006",reason,detail:"",level:"ERROR",ts:""}]}));
  assert.equal(html.includes("Thiết lập config"), reason !== "INVALID_DRIVER");
  if (reason === "NO_DRIVER") assert.ok(html.includes("Hẹn giờ") && html.includes("Gán thủ công"));
}
const editor = renderToStaticMarkup(createElement(BranchEditor, {...config,drivers:[],onCancel:noop,onDone:noop,onStale:noop}));
assert.ok(editor.includes("Copy ca từ điểm khác") && editor.includes("Lưu"));

const copied = applyCopiedLines([{...config.extraLines[0], key:"new"}], [
  {driver:"Driver A",start:"08:00",end:"12:00",sourceRow:10,sourceRuleId:80,assignment_mode:"smart",alt_drop_off_id:"alternate"},
  {driver:"Driver B",start:"12:00",end:"19:00",sourceRow:11,sourceRuleId:81,assignment_mode:"fixed"},
], config.dropoffName);
assert.equal(copied.lines.length, 2);
assert.ok(copied.lines.every(l => l.dropoff === "BRA - D006" && !l.row && !l.rule_id));
assert.equal(copied.lines[0].copyFromRuleId, 80);
assert.equal(copied.lines[0].assignment_mode, "smart");
assert.equal(copied.lines[0].alt_drop_off_id, "alternate");

rows = [
  {customer_id:pickupId,row:2,driver:"A",start:"08:00",end:"12:00",dropoff:""},
  {customer_id:pickupId,row:3,driver:"B",start:"12:00",end:"19:00",dropoff:"BRA - D006"},
  {customer_id:pickupId,row:4,driver:"C",dropoff:"BRA - D001"},
  {customer_id:"other",row:5,driver:"D",dropoff:"BRA - D006"},
];
const existing = await load(34479357, "prod");
assert.deepEqual(existing.rules.map((r: {row:number}) => r.row), [2,3]);
assert.deepEqual(existing.extraLines, [], "reopening after save must not append another empty rule");
stale = true; await assert.rejects(load(1, "prod"), /cấu hình mới/); stale = false;
badStatus = true; await assert.rejects(load(1, "prod")); badStatus = false;
missingStop = true; await assert.rejects(load(1, "prod"), /thiếu điểm/); missingStop = false;
day = "sunday"; await assert.rejects(load(1, "prod"), /Chủ nhật/); day = "weekday";
clients = clients.filter(c => c.customer_id !== pickupId);
await assert.rejects(load(1, "prod"), /Master Client Info/, "never guess a pickup by its display name");
console.log("Missing-job config: exact route, copy scope, existing rules and read failures passed");
