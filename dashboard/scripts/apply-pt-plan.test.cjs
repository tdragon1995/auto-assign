// Run from dashboard: node scripts/apply-pt-plan.test.cjs (no network or writes).
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const load=(file,deps)=>{const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:n=>{if(n in deps)return deps[n];throw Error(n);},Date,Set,Map});return module.exports;};
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const time=load('src/lib/time.ts',{}),labels=load('src/lib/driver-label.ts',{'./display-names':{},'./driver-cell':{}});
(async()=>{
 const {expandPtPatterns}=await import('../../misa-fetcher/lib/sheet-read.mjs');
 let drivers=[{driver_id:id,first_name:'P - C - PTBU',last_name:'No MISA account',roster:{},is_active:true}];
 let patterns=[{id:1,driver_id:id,employee_code:'stale-code',label:'Old name',active:true,active_from:'2026-10-09',active_to:null,review_issues:[],days:[null,...Array(6).fill({start:'17:00',end:'21:00'})]},
  {id:2,driver_id:id,employee_code:'stale-code',label:'Old name',active:true,active_from:'2026-10-20',active_to:null,review_issues:[],days:[null,...Array(6).fill({start:'22:00',end:'02:00'})]}];
 let daily=[{shift_date:'2026-10-10',source:'MISA',slot:1},{shift_date:'2026-10-11',source:'manual',slot:2},{shift_date:'2026-10-12',source:'manual',day_type:'off',driver_id:null},{shift_date:'2026-10-13',source:'PT',slot:1}];
 let proposed=[],calls=0;
 const api=load('src/lib/driver-shifts.ts',{'./driver-label':labels,'./time':time,'./master-reconcile':{UUID:/^[0-9a-f-]{36}$/},'./master-store':{assertMasterWritable(){}},'../../../misa-fetcher/lib/sheet-read.mjs':{expandPtPatterns},'./supabase-rest':{
  sbSelectAll:async(table,query)=>{if(table==='master_drivers')return drivers;if(table==='driver_shift_patterns')return patterns;assert.equal(table,'driver_shifts');assert.ok(query.includes('driver_id.eq.'+id));assert.ok(query.includes('shift_date=gte.2026-10-09'));return daily;},
  sbUpsert:async(table,rows,key,batch,ignore)=>{assert.equal(table,'driver_shifts');assert.equal(key,'employee_code,shift_date,slot');assert.equal(ignore,true,'Concurrent daily edits must win');calls++;proposed=rows;daily=[...daily,...rows];}
 }});
 assert.deepEqual(JSON.parse(JSON.stringify(await api.applyPtPlan(id,'2026-10-09'))),{from:'2026-10-09',to:'2026-10-31'});
 assert.equal(proposed.length,19,'Fill 23 dates minus four existing daily schedules');
 assert.ok(proposed.every(r=>r.source==='PT'&&r.driver_id===id&&r.employee_code==='driver:'+id));
 assert.equal(proposed.find(r=>r.shift_date==='2026-10-09').start_time,'17:00');
 assert.equal(proposed.find(r=>r.shift_date==='2026-10-18').day_type,'off');
 assert.equal(proposed.find(r=>r.shift_date==='2026-10-20').end_time,'02:00','Effective-dated overnight plan applies');
 await api.applyPtPlan(id,'2026-10-09');assert.equal(proposed.length,0,'Repeated apply does not duplicate daily shifts');
 const before=calls;drivers[0].first_name='F - C - DC1001';await assert.rejects(()=>api.applyPtPlan(id,'2026-10-09'),/PT đang hoạt động/);
 drivers[0].first_name='P - C - PTBU';drivers[0].is_active=false;await assert.rejects(()=>api.applyPtPlan(id,'2026-10-09'),/PT đang hoạt động/);drivers[0].is_active=true;
 await assert.rejects(()=>api.applyPtPlan('not-a-uuid','2026-10-09'));await assert.rejects(()=>api.applyPtPlan(id,'2026-02-31'));await assert.rejects(()=>api.applyPtPlan(id,'2000-01-01'));
 drivers[0].roster={employee_code:'PTBU'};drivers.push({...drivers[0],driver_id:other});await assert.rejects(()=>api.applyPtPlan(id,'2026-10-09'),/Mã nhân viên trùng/);drivers.pop();drivers[0].roster={};
 patterns=patterns.map(p=>({...p,active_from:'2026-11-01'}));await assert.rejects(()=>api.applyPtPlan(id,'2026-10-09'),/Chưa có chu kỳ/);
 patterns=patterns.map(p=>({...p,active_from:null,review_issues:['unlinked']}));await assert.rejects(()=>api.applyPtPlan(id,'2026-10-09'),/Chưa có chu kỳ/);assert.equal(calls,before);
 console.log('PASS: PT plan without MISA, month boundary, future versions, overnight/off days, existing schedules preserved, idempotence and identity guards');
})().catch(e=>{console.error(e);process.exitCode=1;});
