// Run: npx tsx scripts/config-todo-hover.test.mts. No network or profile writes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import React, { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { foldName, splitDriverNames, DRIVER_SEP } from "../src/lib/driver-cell";
import { displayDriverCell } from "../src/lib/driver-label";
import { overlapKey } from "../src/lib/config-shift";

const read = (name: string) => ts.createSourceFile(name, readFileSync(new URL(`../src/components/${name}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const browser = read("config-browser-panel.tsx"), todo = read("config-todo-panel.tsx");
const printer = ts.createPrinter();
let renderer: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(browser) === "renderProfile") renderer = node.initializer;
  ts.forEachChild(node, visit);
}
visit(browser); assert.ok(renderer);
const transpile = (code: string) => ts.transpile(code, {target:ts.ScriptTarget.ES2022, jsx:ts.JsxEmit.React});
const client = {customer_id:"pickup"}, destination = {customer_id:"dropoff"};
const drivers = [{driver_id:"driver",roster:{Driver:"F - P - DC101 Driver Name"},cartrack:{first_name:"Driver",last_name:"Name"}}];
const opened: unknown[][] = [];
let left = 0;
const renderProfile = new Function("React", "foldName", "driverMetadata", "clientMetaById", "clientMetaByName", "driverMetaById", "profileHover", "openProfile", "leaveProfile",
  `${transpile(`const renderProfile=${printer.printNode(ts.EmitHint.Expression, renderer, browser)};`)}return renderProfile;`)(
  React, foldName, drivers, new Map([["pickup",client]]), new Map([["bra - d006",destination],["duplicate",null]]), new Map([["driver",drivers[0]]]), null,
  (...args: unknown[]) => opened.push(args), () => left++,
);
const pickup = renderProfile("client", "pickup", "Renamed pickup");
assert.equal(pickup.type, "button");
pickup.props.onPointerEnter({pointerType:"touch"}); assert.equal(opened.length, 0);
const anchor = {};
pickup.props.onPointerEnter({pointerType:"mouse",currentTarget:anchor});
assert.deepEqual(opened.pop(), ["client","pickup",anchor]);
pickup.props.onClick({currentTarget:anchor});
assert.deepEqual(opened.pop(), ["client","pickup",anchor,true], "click/keyboard opens the same pinned Master card");
pickup.props.onPointerLeave({pointerType:"mouse"}); assert.equal(left, 1);
assert.equal(renderProfile("client", undefined, " BRA - D006 ").type, "button");
assert.equal(renderProfile("client", "wrong-id", "BRA - D006"), "BRA - D006", "do not replace a known ID with a name guess");
assert.equal(renderProfile("client", undefined, "duplicate"), "duplicate");
assert.equal(renderProfile("driver", undefined, drivers[0].roster.Driver).type, "button");
drivers.push({...drivers[0],driver_id:"duplicate-driver"});
assert.equal(renderProfile("driver", undefined, "Driver Name"), "Driver Name", "ambiguous names must not open the wrong driver");
drivers.pop();

const declarations = ["driverProfiles", "OverlapRow", "GapRow", "UnfinishedRow"].map(name => {
  const node = todo.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name); assert.ok(node);
  return printer.printNode(ts.EmitHint.Unspecified, node, todo);
}).join("\n");
const rows = new Function("React", "Fragment", "useState", "splitDriverNames", "DRIVER_SEP", "displayDriverCell", "overlapKey", "Button",
  `${transpile(declarations)};return {OverlapRow,GapRow,UnfinishedRow};`)(React, React.Fragment, useState, splitDriverNames, DRIVER_SEP, displayDriverCell, overlapKey,
  ({children}: {children: React.ReactNode}) => React.createElement("button", null, children));
const common = {rules:[],drivers:[],onSaved(){},renderProfile};
drivers.push({driver_id:"second",roster:{Driver:"Second Name"},cartrack:{first_name:"Second",last_name:"Name"}});
for (const [component, props] of [
  [rows.GapRow, {g:{customer_id:"pickup",pickup_name:"Pickup",dropoff_name:"BRA - D006",at:"06:54",before:null,after:null}}],
  [rows.UnfinishedRow, {rows:[{row:2,customer_id:"pickup",pickup_name:"Pickup",dropoff_name:"BRA - D006",window:null}]}],
  [rows.OverlapRow, {o:{customer_id:"pickup",pickup_name:"Pickup",window:"09:00–10:00",drivers:["Driver Name, Second Name","Driver Name"],kind:"smart"}}],
]) {
  const html = renderToStaticMarkup(React.createElement(component, {...common,...props}));
  assert.equal((html.match(/aria-haspopup="dialog"/g) ?? []).length, component === rows.OverlapRow ? 4 : 2);
  assert.ok(html.includes("Sửa config"), "hover links must preserve the config action");
}
console.log("Config to-do hover: exact profiles, smart driver aliases, pointer/click controls and all row types passed");
