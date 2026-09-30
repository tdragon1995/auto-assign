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
for (const [syncProfiles, status, body, expected] of [
  [false, 200, {ok:true}, ["busy:true", "settings", "success", "busy:false"]],
  [true, 200, {ok:true}, ["busy:true", "profiles", "rows", "settings", "success", "busy:false"]],
  [true, 502, {ok:false,error:"Failed"}, ["busy:true", "profiles", "error", "busy:false"]],
  [true, 200, {ok:false}, ["busy:true", "profiles", "error", "busy:false"]],
] as const) {
  const events: string[] = [];
  const handler = new Function("fetch", "setSyncingSettings", "setConfigRefreshKey", "syncSettings", "toast", `${code}; return handler;`)(
    async (url: string, options: RequestInit) => {assert.equal(url,"/api/master-client-info/sync");assert.equal(options.method,"POST");events.push("profiles");return Response.json(body,{status});},
    (busy: boolean) => events.push(`busy:${busy}`),
    (update: (key: number) => number) => {assert.equal(update(2),3);events.push("rows");},
    async () => {events.push("settings");},
    {success: () => events.push("success"),error: () => events.push("error")},
  );
  await handler(syncProfiles);
  assert.deepEqual(events,expected);
}
console.log("Manual data sync, lightweight save refresh and failed-sync checks passed");
