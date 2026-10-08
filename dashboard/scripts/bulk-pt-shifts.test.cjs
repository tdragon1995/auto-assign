// Run from dashboard: node scripts/bulk-pt-shifts.test.cjs (no network or writes).
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const jsx=require('react/jsx-runtime');
const labels={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/driver-label.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{module:labels,exports:labels.exports,require:()=>({})});
let state=[],cursor=0,posts=[],busy=[],saved=0;
const deps={
 'react':{useState(initial){const i=cursor++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return [state[i],v=>state[i]=typeof v==='function'?v(state[i]):v];}},
 'react/jsx-runtime':jsx,'./ui/button':{Button:'button'},'./driver-name':{DriverName:'driver-name'},
 '@/lib/driver-label':labels.exports,
 '@/lib/driver-cell':{foldName:n=>n.toLowerCase()},'@/lib/time':{vnDate:()=> '2026-10-08'}
};
const moduleShim={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/components/bulk-pt-shift-panel.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{
 module:moduleShim,exports:moduleShim.exports,require:n=>deps[n]??(()=>{throw Error(n);})(),Set,Array,
 fetch:async(url,options)=>{assert.equal(url,'/api/driver-shifts');const body=JSON.parse(options.body);posts.push(body);const ok=body.data.driver_id!=='retry';return {ok,json:async()=>ok?{ok:true}:{error:'revision changed'}};}
});
const {missingPtCycles,BulkPtShiftPanel}=moduleShim.exports;
const driver=(id,name='P - C - PTBU '+id,active=true)=>({driver_id:id,name,active,employee_code:'driver:'+id});
const pattern=(id,extra={})=>({id:1,driver_id:id,employee_code:'driver:'+id,label:id,active:true,active_from:null,active_to:null,review_issues:[],days:[null,{start:'18:00',end:'21:00'},null,null,null,null,null],...extra});
const drivers=[driver('new'),driver('retry'),driver('covered'),driver('unconfigured'),driver('inactive',undefined,false),driver('ft','F - C - DC1001 FT'),driver('blank'),driver('expired'),driver('future')];
let patterns=[pattern('covered'),pattern('blank',{days:Array(7).fill(null)}),pattern('expired',{active_to:'2026-10-07'}),pattern('future',{active_from:'2026-11-01'}),pattern(null,{employee_code:'PTBU'})];
const configuredIds=drivers.filter(d=>d.driver_id!=='unconfigured').map(d=>d.driver_id);
assert.deepEqual([...missingPtCycles(drivers,patterns,configuredIds,'2026-10-08')].map(d=>d.driver_id),['new','retry','blank','expired','future']);
assert.ok(!missingPtCycles(drivers,patterns,configuredIds,'2026-11-02').some(d=>d.driver_id==='future'),'Future cycles apply only from their start date');
const props={drivers,patterns,configuredIds,onBusy:v=>busy.push(v),onSaved:async()=>{saved++;patterns=[...patterns,pattern('new')];props.patterns=patterns;}};
const render=()=>{cursor=0;return BulkPtShiftPanel(props);};
const walk=(node)=>Array.isArray(node)?node.flatMap(walk):node&&typeof node==='object'&&node.props?[node,...walk(node.props.children)]:[];
const input=type=>walk(render()).find(n=>n.type==='input'&&n.props.type===type);
const select=id=>{const row=walk(render()).find(n=>n.type==='label'&&walk(n).some(x=>x.type==='driver-name'&&x.props.full===drivers.find(d=>d.driver_id===id).name));walk(row).find(x=>x.type==='input').props.onChange({target:{checked:true}});};
(async()=>{
 input('date').props.onChange({target:{value:'2026-10-12'}});
 input('time').props.onChange({target:{value:'22:00'}});
 walk(render()).filter(n=>n.type==='input'&&n.props.type==='time')[1].props.onChange({target:{value:'02:00'}});
 const tuesday=walk(render()).find(n=>n.type==='label'&&n.props.children?.[1]==='T3');walk(tuesday).find(n=>n.type==='input').props.onChange({target:{checked:false}});
 select('new');select('retry');
 render().props.onSubmit({preventDefault(){}});
 for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(posts.length,2);assert.equal(saved,1);assert.deepEqual(busy,[true,false]);
 const cycle=posts[0].data;assert.equal(posts[0].mode,'patterns');assert.equal(cycle.active_from,'2026-10-12');assert.equal(cycle.active_to,null);assert.equal(cycle.days.length,7);
 assert.deepEqual(cycle.days[1],{start:'22:00',end:'02:00'});assert.equal(cycle.days[0],null);assert.equal(cycle.days[2],null);
 assert.ok(walk(render()).find(n=>n.props.role==='status').props.children.includes('revision changed'));
 assert.deepEqual([...state[4]],['retry'],'Only failed drivers stay selected; successful cycles are not resubmitted');
 const {expandPtPatterns}=await import('../../misa-fetcher/lib/sheet-read.mjs');
 const daily=expandPtPatterns([cycle],{monthStart:'2026-10-11',monthEnd:'2026-10-20'});
 assert.equal(daily[0].shift_date,'2026-10-12');assert.equal(daily[0].start_time,'22:00');assert.equal(daily[1].day_type,'off');assert.equal(daily[7].start_time,'22:00','Next week repeats');
 console.log('PASS: configured PT only, UUID separation, effective dates, bulk payload, partial failures and weekly expansion');
})().catch(e=>{console.error(e);process.exitCode=1;});
