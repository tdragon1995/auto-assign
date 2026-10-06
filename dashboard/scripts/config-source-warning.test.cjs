// Run: node scripts/config-source-warning.test.cjs (no network or live writes).
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const load=(file,deps={},extra={})=>{const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:n=>{assert.ok(n in deps,`Unexpected dependency ${n}`);return deps[n];},console,process:{env:{}},Date,...extra});return exports;};
const audit=load('src/lib/config-audit.ts'),time=load('src/lib/time.ts');
const row={customer_id:'11111111-1111-4111-8111-111111111111',driver_id:'22222222-2222-4222-8222-222222222222',smart_driver_id:'',Driver:'Driver','Điểm Pick-up':'BRA - D053',shift_start:'00:00',shift_end:'23:59'};
async function check(source,stamp){
 const warnings=new Map([['Location Table — tên trùng','old alarm']]),reads=[];
 class Clock extends Date {constructor(...args){super(...(args.length?args:[stamp]));}static now(){return new Date(stamp).getTime();}}
 const sheets={SHEET_GID:{mapping:'mapping',sunday:'sunday',locations:'locations'},SHEET_CONTRACT:{mapping:{label:'config (mapping)'},sunday:{label:'CONFIG SUNDAY'},locations:{label:'Location Table'}},noteSheetLoad(){},isSheetShapeError:()=>false,noteSheetWarning:(label,text)=>text?warnings.set(label,text):warnings.delete(label),fetchSheetRows:async gid=>{reads.push(gid);return gid==='locations'?[{customer_name:'BRA - D053',customer_id:'old'},{customer_name:'BRA - D053',customer_id:row.customer_id}]:[row];}};
 const config=load('src/lib/config.ts',{'./day-config':{invalidateDayConfigCache(){}},'@upstash/redis':{},'./sheets':sheets,'./config-audit':audit,'./time':time,'./unmapped-row':{},'./config-gen':{readConfigGen:async()=>null},'./master-store':{masterEnabled:()=>source==='supabase',masterRuleRows:async()=>[row],inactiveMasterClientIds:async()=>[]},'./location-status':{activeLocationRules:r=>r},'./supabase-rest':{},'./smart-log-kv':{readCoverageGaps:async()=>[]}}, {Date:Clock});
 assert.equal((await config.loadConfigFromSheets()).mappings[0].customer_id,row.customer_id);
 const sheetLookup=source==='sheet'||stamp.includes('10-04');
 assert.equal(reads.includes('locations'),sheetLookup,'Only a Sheet-backed config audits the name lookup');
 assert.equal(warnings.has('Location Table — tên trùng'),sheetLookup);
 if(!sheetLookup){warnings.set('Location Table — tên trùng','stale alarm');await config.loadConfigFromSheets();assert.equal(warnings.has('Location Table — tên trùng'),false,'Warm cache also retracts the obsolete alarm');}
}
(async()=>{await check('supabase','2026-10-06T05:00:00Z');await check('supabase','2026-10-04T05:00:00Z');await check('sheet','2026-10-06T05:00:00Z');console.log('PASS: Supabase weekday warnings cleared; Sunday and Sheet audits retained');})().catch(e=>{console.error(e);process.exitCode=1;});
