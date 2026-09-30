import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FilterMultiSelect } from "../src/components/filter-multi-select";

const source = ts.createSourceFile("picker.tsx",readFileSync(new URL("../src/components/filter-multi-select.tsx",import.meta.url),"utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let add: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "add") add=node.initializer;
  ts.forEachChild(node,visit);
}
visit(source);assert.ok(add);
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
const html=renderToStaticMarkup(createElement(FilterMultiSelect,{label:"Điểm giao thay thế",values:["old"],options:[{value:"old",label:"BRA - D001"}],onChange(){},placeholder:"Tìm điểm giao…",multiple:false,disabled:true}));
assert.ok(html.includes("BRA - D001") && html.includes('role="combobox"') && html.includes("disabled"));
console.log("Single dropoff replacement, existing multi-filter selection and disabled picker checks passed");
