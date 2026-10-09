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
const {missingPtShifts,BulkPtShiftPanel}=moduleShim.exports;
const driver=(id,name='P - C - PTBU '+id,active=true)=>({driver_id:id,name,active,employee_code:'driver:'+id});
const pattern=(id,extra={})=>({id:1,driver_id:id,employee_code:'driver:'+id,label:id,active:true,active_from:null,active_to:null,review_issues:[],days:[null,{start:'18:00',end:'21:00'},null,null,null,null,null],...extra});
const drivers=[driver('new'),driver('retry'),driver('covered'),driver('unconfigured'),driver('inactive',undefined,false),driver('ft','F - C - DC1001 FT'),driver('blank'),driver('expired'),driver('future'),driver('off'),driver('holiday'),driver('legacy'),{...driver('shared1'),employee_code:'PTBU'},{...driver('shared2'),employee_code:'PTBU'},driver('foreign')];
let patterns=[pattern('covered'),pattern('blank',{days:Array(7).fill(null)}),pattern('expired',{active_to:'2026-10-07'}),pattern('future',{active_from:'2026-11-01'}),pattern(null,{employee_code:'PTBU'})];
const configuredIds=drivers.filter(d=>d.driver_id!=='unconfigured').map(d=>d.driver_id);
const row=(id,day_type='working',extra={})=>({driver_id:id,employee_code:'driver:'+id,shift_date:'2026-10-08',day_type,...extra});
const shifts=[row('covered'),row('off','off'),row('holiday','holiday'),row(null,'off',{employee_code:'driver:legacy'}),row(null,'working',{employee_code:'PTBU'}),row('another','working',{employee_code:'driver:foreign'}),row('future','working',{shift_date:'2026-11-01'})];
assert.deepEqual([...missingPtShifts(drivers,shifts,configuredIds,'2026-10-08')].map(d=>d.driver_id),['new','retry','blank','expired','future','shared1','shared2','foreign']);
assert.ok(!missingPtShifts(drivers,shifts,configuredIds,'2026-11-01').some(d=>d.driver_id==='future'),'Only shifts on the selected date count');
assert.ok(missingPtShifts(drivers,[],configuredIds,'2026-10-08').some(d=>d.driver_id==='covered'),'A weekly pattern is not a dated shift');
const shiftsModule={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/driver-shifts.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:shiftsModule,exports:shiftsModule.exports,require:()=>({}),Set});
const rule=(id,start,end,extra={})=>({driver_ids:[id],pickup_customer_id:'clinic',row_data:{'Điểm Pick-up':'Clinic'},review_issues:[],shift_start:start,shift_end:end,...extra});
const suggestions=shiftsModule.exports.configShiftSuggestions([
 [rule('new','22:00:00','02:00:00'),rule('new','22:00','02:00'),rule('new','18:00','20:00'),rule('retry',null,null),rule('retry','07:00','08:00',{review_issues:['invalid']}),rule('retry','08:00','08:00'),rule('retry','25:00','26:00'),rule('retry','07:00','08:00',{pickup_customer_id:null})],
 [rule('new','22:00','02:00'),rule('sunday','19:00','21:00')]
]);
assert.equal(suggestions.new.length,2,'Duplicate windows collapse; different windows stay separate');
assert.deepEqual(JSON.parse(JSON.stringify(suggestions.new[0])),{start:'22:00',end:'02:00',days:[1,2,3,4,5,6,0],sources:['Clinic']});
assert.equal(suggestions.retry,undefined,'Incomplete, invalid and unusable rules do not suggest hours');
assert.deepEqual([...suggestions.sunday[0].days],[0],'Sunday rules do not imply weekday work');
const props={drivers,patterns,shifts,suggestions,configuredIds,date:'2026-10-08',cutoff:'2026-08-15',loading:false,onDateChange:date=>{props.date=date;},onBusy:v=>busy.push(v),onSaved:async()=>{saved++;patterns=[...patterns,pattern('new')];props.patterns=patterns;}};
const render=()=>{cursor=0;return BulkPtShiftPanel(props);};
const walk=(node)=>Array.isArray(node)?node.flatMap(walk):node&&typeof node==='object'&&node.props?[node,...walk(node.props.children)]:[];
const input=type=>walk(render()).find(n=>n.type==='input'&&n.props.type===type);
const select=id=>{const row=walk(render()).find(n=>n.type==='label'&&walk(n).some(x=>x.type==='driver-name'&&x.props.full===drivers.find(d=>d.driver_id===id).name));walk(row).find(x=>x.type==='input').props.onChange({target:{checked:true}});};
(async()=>{
 input('date').props.onChange({target:{value:'2026-10-12'}});
 const copy=walk(render()).find(n=>n.type==='button'&&n.props.title==='Config: Clinic');copy.props.onClick();
 assert.deepEqual(walk(render()).filter(n=>n.type==='input'&&n.props.type==='time').map(n=>n.props.value),['22:00','02:00']);
 const sunday=walk(render()).find(n=>n.type==='label'&&n.props.children?.[1]==='CN');walk(sunday).find(n=>n.type==='input').props.onChange({target:{checked:false}});
 const tuesday=walk(render()).find(n=>n.type==='label'&&n.props.children?.[1]==='T3');walk(tuesday).find(n=>n.type==='input').props.onChange({target:{checked:false}});
 select('new');select('retry');
 render().props.onSubmit({preventDefault(){}});
 for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(posts.length,2);assert.equal(saved,1);assert.deepEqual(busy,[true,false]);
 const cycle=posts[0].data;assert.equal(posts[0].mode,'patterns');assert.equal(cycle.active_from,'2026-10-12');assert.equal(cycle.active_to,null);assert.equal(cycle.days.length,7);
 assert.deepEqual(cycle.days[1],{start:'22:00',end:'02:00'});assert.equal(cycle.days[0],null);assert.equal(cycle.days[2],null);
 assert.ok(walk(render()).find(n=>n.props.role==='status').props.children.includes('revision changed'));
 assert.deepEqual([...state[3]],['retry'],'Only failed drivers stay selected; successful cycles are not resubmitted');
 const {expandPtPatterns}=await import('../../misa-fetcher/lib/sheet-read.mjs');
 const daily=expandPtPatterns([cycle],{monthStart:'2026-10-11',monthEnd:'2026-10-20'});
 assert.equal(daily[0].shift_date,'2026-10-12');assert.equal(daily[0].start_time,'22:00');assert.equal(daily[1].day_type,'off');assert.equal(daily[7].start_time,'22:00','Next week repeats');
 const versioned=expandPtPatterns([pattern('new'),cycle],{monthStart:'2026-10-12',monthEnd:'2026-10-12'});
 assert.equal(versioned[0].start_time,'22:00','A new dated cycle supersedes the existing version');
 assert.equal(expandPtPatterns([cycle],{monthStart:'2026-10-12',monthEnd:'2026-10-12'},new Set([cycle.employee_code])).length,0,'MISA schedules take priority');
 const route={exports:{}},routeDeps={'next/server':{NextResponse:{json:(body,options)=>({body,status:options?.status??200})}},'@/lib/driver-shifts':{...shiftsModule.exports,shiftPatterns:async()=>patterns,shiftDrivers:async()=>drivers,visiblePtPatterns:p=>p,dailyDriverShifts:async date=>shifts.filter(s=>s.shift_date===date)},'@/lib/time':{vnDate:()=>props.date,cartrackHistoryCutoff:()=>props.cutoff},'@/lib/shift-window':{},'@/lib/config':{},'@/lib/master-store':{masterRules:async()=>[rule('new','22:00','02:00')]} };
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/api/driver-shifts/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:route,exports:route.exports,require:n=>routeDeps[n],Set});
 const response=await route.exports.GET({nextUrl:new URL('https://example.test/api/driver-shifts?mode=missing&date=2026-10-08')});
 assert.equal(response.status,200);assert.equal(response.body.shifts.length,shifts.length-1);assert.deepEqual([...response.body.configuredDriverIds],['new']);assert.equal(response.body.suggestions.new[0].start,'22:00');
 posts=[];select('new');select('covered');
 walk(render()).find(n=>n.type==='input'&&n.props.type==='time').props.onChange({target:{value:''}});
 const apply=walk(render()).find(n=>n.type==='button'&&n.props.children?.[0]==='Áp dụng chu kỳ cho ');
 assert.equal(apply.props.disabled,false,'Saved PT plans can be applied without filling the new-plan form');
 apply.props.onClick();for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(posts.map(p=>p.mode),['apply-pt','apply-pt']);assert.deepEqual(posts.map(p=>p.data.driver_id),['new','covered']);assert.equal(posts[0].data.date,'2026-10-12');assert.deepEqual([...state[3]],['retry']);
 props.loading=true;assert.equal(walk(render()).filter(n=>n.type==='driver-name').length,0,'Do not show stale missing rows while changing dates');
 console.log('PASS: configured PT with no dated shift, off/holiday, unique legacy codes, separate config windows, copy-to-weekly setup, partial failures and weekly expansion');
})().catch(e=>{console.error(e);process.exitCode=1;});
