import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FilterMultiSelect } from "../src/components/filter-multi-select";

const source = ts.createSourceFile("picker.tsx",readFileSync(new URL("../src/components/filter-multi-select.tsx",import.meta.url),"utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let add: ts.Expression | undefined;
let onKeyDown: ts.Expression | undefined;
let place: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "add") add=node.initializer;
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "onKeyDown") onKeyDown=node.initializer;
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "place" && node.initializer && ts.isCallExpression(node.initializer)) place=node.initializer.arguments[0];
  ts.forEachChild(node,visit);
}
visit(source);assert.ok(add);assert.ok(onKeyDown);assert.ok(place);
const placeCode=ts.transpile(`const position=${ts.createPrinter().printNode(ts.EmitHint.Expression,place,source)};`,{target:ts.ScriptTarget.ES2022});
for (const [top,bottom,above,expectedTop] of [[530,564,true,528],[20,52,false,54]] as const) {
  let rect: {top:number;above:boolean} | undefined;
  new Function("boxRef","window","setRect",`${placeCode};position();`)(
    {current:{getBoundingClientRect:()=>({top,bottom,left:20,width:300})}}, {innerWidth:1280,innerHeight:720}, (value:typeof rect)=>rect=value,
  );
  assert.deepEqual([rect?.top,rect?.above],[expectedTop,above],"suggestions must anchor immediately above or below the field");
}
const code=ts.transpile(`const add=${ts.createPrinter().printNode(ts.EmitHint.Expression,add,source)};`,{target:ts.ScriptTarget.ES2022});
for(const multiple of [true,false]) {
  let selection: string[]=[];let opened=true;
  const pick=new Function("multiple","values","onChange","setQuery","setActive","inputRef","setOpen","requestAnimationFrame","place",`${code};return add;`)(
    multiple,["old"],(values:string[])=>selection=values,()=>{},()=>{}, {current:{focus(){}}},(open:boolean)=>opened=open,(fn:()=>void)=>fn(),()=>{},
  );
  pick("new");
  assert.deepEqual(selection,multiple ? ["old","new"] : ["new"]);
  assert.equal(opened,multiple,"single choice must close the suggestions");
}
const keyboardCode=ts.transpile(`const handler=${ts.createPrinter().printNode(ts.EmitHint.Expression,onKeyDown,source)};`,{target:ts.ScriptTarget.ES2022});
for (const allowClear of [true,false]) {
  let removed=false;let opened=true;let stopped=false;
  const key=new Function("allowClear","open","query","values","remove","setOpen",`${keyboardCode};return handler;`)(
    allowClear,true,"",["old"],()=>removed=true,(open:boolean)=>opened=open,
  );
  key({key:"Backspace"});assert.equal(removed,allowClear,"required dropoffs must not be cleared by Backspace");
  key({key:"Escape",stopPropagation(){stopped=true;}});
  assert.ok(stopped && !opened,"Escape closes suggestions without closing the profile editor");
}
const html=renderToStaticMarkup(createElement(FilterMultiSelect,{label:"Điểm giao thay thế",values:["old"],options:[{value:"old",label:"BRA - D001"}],onChange(){},placeholder:"Tìm điểm giao…",multiple:false,disabled:true}));
assert.ok(html.includes("BRA - D001") && html.includes('role="combobox"') && html.includes("disabled"));
const required=renderToStaticMarkup(createElement(FilterMultiSelect,{label:"Điểm giao mặc định",values:["old"],options:[{value:"old",label:"BRA - D015"}],onChange(){},placeholder:"Tìm điểm giao…",multiple:false,allowClear:false,portal:false}));
assert.ok(required.includes("BRA - D015") && !required.includes('aria-label="Bỏ BRA - D015"'));
console.log("Single dropoff replacement, existing multi-filter selection and disabled picker checks passed");
