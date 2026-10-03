import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Exercise the real callback without importing the dashboard's browser-only panels.
const source = ts.createSourceFile("dashboard.tsx", readFileSync(new URL("../src/components/dashboard.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback: ts.Expression | undefined;
let reportPanel: ts.JsxElement | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleRefresh" && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "details" && node.getText(source).includes("metadataReport")) reportPanel = node;
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
  let call=0, report: {state:string;processed:number;issues:unknown[];error?:string} | null = null;
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
  if (expected.includes("error") && responses.length === 3) assert.equal((report as unknown as {error:string}).error,"Failed");
}
assert.ok(reportPanel);
const panelCode = ts.transpile(`const render = () => (${ts.createPrinter().printNode(ts.EmitHint.Expression, reportPanel, source)});`, {target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React});
const renderReport = (report:object) => renderToStaticMarkup(new Function("React","metadataReport",`${panelCode}; return render();`)(React,report));
const initial = {matched:0,owners:0,errors:0,totalCodes:0,processed:0,nextCursor:null,issues:[],state:"running"};
const starting = renderReport(initial);
assert.match(starting,/Đang lấy danh sách khách hàng và điểm giao/);
assert.doesNotMatch(starting,/0\/|0 địa điểm|0 vấn đề/);
assert.match(renderReport({...initial,totalCodes:1556,processed:100,matched:120,owners:110}),/100\/1556 mã khách hàng/);
const completed = renderReport({...initial,state:"complete",processed:1556,matched:2040,owners:1970});
assert.match(completed,/2040 địa điểm khớp liên kết/);
assert.match(completed,/1970 địa điểm có thông tin sales/);
assert.match(completed,/Không có vấn đề cần kiểm tra/);
const failed = renderReport({...initial,state:"failed",error:"Labcenter returned 401"});
assert.match(failed,/Labcenter returned 401/);
assert.match(failed,/Nhấn Đồng bộ dữ liệu để thử lại/);
console.log("Manual paged Labcenter sync, issue warnings, retained partial reports and lightweight save refresh checks passed");
