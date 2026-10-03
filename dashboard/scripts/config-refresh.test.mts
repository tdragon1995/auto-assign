import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Exercise the real callback without importing the dashboard's browser-only panels.
const source = ts.createSourceFile("dashboard.tsx", readFileSync(new URL("../src/components/dashboard.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleRefresh" && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(callback);
const code = ts.transpile(`const handler = ${ts.createPrinter().printNode(ts.EmitHint.Expression, callback, source)};`, {target: ts.ScriptTarget.ES2022});
const batch = (nextCursor:string|null, issues:unknown[] = []) => ({ok:true,labcenter:{matched:1,owners:1,errors:0,totalCodes:2,processed:1,nextCursor,issues}});
for (const [syncProfiles, responses, expected] of [
  [false, [], ["busy:true", "settings", "success", "busy:false"]],
  [true, [{ok:true},batch("1"),batch(null)], ["busy:true", "profiles", "metadata", "metadata", "rows", "settings", "success", "busy:false"]],
  [true, [{ok:true},batch(null,[{customer_id:"id",kind:"missing_owner"}])], ["busy:true", "profiles", "metadata", "rows", "settings", "warning", "busy:false"]],
  [true, [{ok:false,error:"Failed"}], ["busy:true", "profiles", "error", "busy:false"]],
  [true, [{ok:true},batch("1"),{ok:false,error:"Failed"}], ["busy:true", "profiles", "metadata", "metadata", "rows", "error", "busy:false"]],
] as const) {
  const events: string[] = [];
  let call=0, report: {state:string;processed:number;issues:unknown[]} | null = null;
  const handler = new Function("fetch", "setSyncingSettings", "setConfigRefreshKey", "setMetadataReport", "syncSettings", "toast", `${code}; return handler;`)(
    async (url: string, options: RequestInit) => {
      assert.equal(options.method,"POST");
      assert.equal(url, call === 0 ? "/api/master-client-info/sync" : `/api/master-client-info/sync?phase=metadata&limit=100&after=${call === 1 ? "" : "1"}`);
      events.push(call === 0 ? "profiles" : "metadata");
      return Response.json(responses[call++]);
    },
    (busy: boolean) => events.push(`busy:${busy}`),
    (update: (key: number) => number) => {assert.equal(update(2),3);events.push("rows");},
    (value: typeof report) => {report=value;},
    async () => {events.push("settings");},
    {success: () => events.push("success"),warning: () => events.push("warning"),error: () => events.push("error")},
  );
  await handler(syncProfiles);
  assert.deepEqual(events,expected);
  if (responses.length === 3) assert.equal((report as unknown as {processed:number}).processed, expected.includes("success") ? 2 : 1);
}
console.log("Manual paged Labcenter sync, issue warnings, retained partial reports and lightweight save refresh checks passed");
