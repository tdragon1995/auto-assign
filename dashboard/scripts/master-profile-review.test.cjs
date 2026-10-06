// Run: node scripts/master-profile-review.test.cjs (no network or live writes).
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
function load(file,deps,extra={}){
 const exports={};const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(code,{exports,JSON,Date,console,require:name=>{assert.ok(name in deps,`Unexpected dependency ${name}`);return deps[name];},...extra});return exports;
}
const names=load('src/lib/display-names.ts',{});
const editor=load('src/components/master-profile-editor.tsx',{'react':React,'react/jsx-runtime':require('react/jsx-runtime'),'@/lib/display-names':names,'@/lib/location-status':{isInactiveLocation:()=>false},'@/components/ui/button':{Button:({children})=>React.createElement('button',null,children)},'./filter-multi-select':{FilterMultiSelect:()=>null}});
const html=renderToStaticMarkup(React.createElement(editor.MasterProfileEditor,{kind:'driver',id:'driver',initial:{first_name:'P - C - PTBU',last_name:'Lê Minh Triết',employee_code:'',code_name:'legacy'},clients:[],onCancel(){},async onSaved(){}}));
assert.match(html,/readOnly=""[^>]*value="PTBU"/);assert.ok(!html.includes('Mã / tên nội bộ'));
assert.equal(names.staffCode('F - P - DC100320'),'DC100320');assert.equal(names.staffCode('P - C - PTBU'),'PTBU');
assert.equal(JSON.stringify(editor.profilePatch('driver',{employee_code:'DC100320',code_name:'legacy'},{employee_code:'PTBU',code_name:'changed'},true)),'{}','display codes never overwrite MISA mapping or legacy aliases');
let status=404,sourceBody={},refs={},rpcWrites=0,sunday=[];const id='11111111-1111-4111-8111-111111111111';
const removed=load('src/lib/master-removed-clients.ts',{'./cartrack':{BASE_URL:'https://cartrack.invalid',getHeaders:()=>({})},'./supabase-rest':{sbSelectAll:async()=>[],sbRpc:async(name)=>{if(name==='master_client_references')return {...refs};assert.equal(name,'master_drop_removed_client');rpcWrites++;}},'./sheets':{SHEET_GID:{sunday:'sunday',tpl:'tpl'},SHEET_CONTRACT:{sunday:{},tpl:{}},fetchSheetRows:async(gid)=>gid==='sunday'?sunday:[]},'./psc-routes-data':{PSC_ROUTES:[]},'./master-reconcile':{UUID:/^[0-9a-f-]{36}$/}}, {fetch:async()=>({status,ok:status===200,json:async()=>sourceBody})});
(async()=>{
 for(const code of [200,401,422,429,500]){status=code;await assert.rejects(removed.dropRemovedCartrackClient(id,'2026-10-06T00:00:00Z'));}assert.equal(rpcWrites,0);
 status=404;refs={tat_legs:1};await assert.rejects(removed.dropRemovedCartrackClient(id,'2026-10-06T00:00:00Z'),/tat_legs/);assert.equal(rpcWrites,0);
 refs={};sunday=[{customer_id:id}];await assert.rejects(removed.dropRemovedCartrackClient(id,'2026-10-06T00:00:00Z'),/Sunday/);assert.equal(rpcWrites,0);
 sunday=[];await removed.dropRemovedCartrackClient(id,'2026-10-06T00:00:00Z');assert.equal(rpcWrites,1);
 await assert.rejects(removed.dropRemovedCartrackClient('bad','2026-10-06T00:00:00Z'));assert.equal(rpcWrites,1);
 status=422;sourceBody={error:{code:422,data:{customer_id:['The selected customer_id is invalid.']}}};await removed.dropRemovedCartrackClient(id,'2026-10-06T00:00:00Z');assert.equal(rpcWrites,2);
 console.log('Profile code display, hidden aliases, source checks and deletion guards passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
