import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createMasterDriver} from '../src/lib/master-driver-create';
import {editClient} from '../src/lib/master-profile';
import {MasterProfileEditor,profilePatch,gpsDeltaKm} from '../src/components/master-profile-editor';
const driver='44444444-4444-4444-8444-444444444444',pickup='11111111-1111-4111-8111-111111111111';
const draft={first_name:'P - C - PTBU',last_name:'Test driver',phone_code:'84',phone_number:'903123456'};
const html=renderToStaticMarkup(createElement(MasterProfileEditor,{kind:'client',id:pickup,gpsOnly:true,initial:{latitude:10.5,longitude:106.5},clients:[],onCancel(){},async onSaved(){}}));
assert.ok(html.includes('Vĩ độ')&&html.includes('Kinh độ')&&html.includes('Lưu GPS')&&!html.includes('Tên khách hàng'));
assert.equal(gpsDeltaKm({latitude:10.5,longitude:106.5},{latitude:"10.5",longitude:"106.5"}),0);
assert.equal(gpsDeltaKm({latitude:10.5,longitude:106.5},{latitude:"",longitude:"106.5"}),null);
assert.equal(gpsDeltaKm({latitude:null,longitude:106.5},{latitude:"10.5",longitude:"106.5"}),null);
assert.equal(gpsDeltaKm({latitude:10.5,longitude:106.5},{latitude:"91",longitude:"106.5"}),null);
assert.ok(Math.abs(gpsDeltaKm({latitude:0,longitude:0},{latitude:"1",longitude:"0"})!-111.195)<0.01);
assert.ok(html.includes("Haversine")&&html.includes("GPS hiện tại")&&html.includes("0 m"));
assert.throws(()=>profilePatch('client',{}, {latitude:'91',longitude:'106'},false));
assert.deepEqual(profilePatch('client',{latitude:10.5,longitude:106.5},{latitude:'11',longitude:'107'},false),{latitude:11,longitude:107});
const env={SUPABASE_URL:'https://supabase.invalid',SUPABASE_SERVICE_ROLE_KEY:'test',CARTRACK_AUTH:'test',KV_REST_API_URL:'https://redis.invalid',KV_REST_API_TOKEN:'test',LABCENTER_EMAIL:'test',LABCENTER_PASSWORD:'test',MASTER_CLIENT_INFO_SOURCE:'supabase'};
const before=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]])),previousFetch=globalThis.fetch;
Object.assign(process.env,env);
const saved=new Map<string,string>();let creates=0,dbFails=false,uncertain=false,lcAccepts=true,linked=false;
let customer={customer_id:pickup,customer_name:'Location',address_line_1:'Address',latitude:10.5,longitude:106.5,contact_number:'123'};
let lc={address:'Address',latitude:10.5,longitude:106.5};
const writes:{url:string,body:unknown}[]=[];
globalThis.fetch=async(input,init)=>{
 const url=String(input),method=init?.method??'GET';
 if(url.startsWith('https://redis.invalid')){
   const body=JSON.parse(String(init?.body));const pipeline=Array.isArray(body[0]);
   const execute=(command:unknown[])=>{const [op,k,v,...options]=command.map(String);if(op.toUpperCase()==='GET')return {result:saved.get(k)??null};if(op.toUpperCase()==='DEL'){saved.delete(k);return {result:1};}assert.equal(op.toUpperCase(),'SET');if(options.some(x=>x.toUpperCase()==='NX')&&saved.has(k))return {result:null};saved.set(k,v);return {result:'OK'};};
   return Response.json(pipeline?body.map(execute):execute(body));
 }
 if(url.endsWith('/delivery/drivers')&&method==='POST') {creates++;if(uncertain)throw new Error('Network interrupted');return Response.json({data:{...draft,delivery_driver_id:driver,is_active:true}});}
 if(url.endsWith('/delivery/drivers/'+driver))return Response.json({data:{...draft,delivery_driver_id:driver,is_active:true}});
 if(url.startsWith('https://supabase.invalid/rest/v1/master_drivers')&&method==='POST') {writes.push({url,body:JSON.parse(String(init?.body))});return dbFails?new Response('temporarily unavailable',{status:500}):Response.json([]);}
 if(url.includes('/rest/v1/master_clients')) {
   if(method==='POST'){writes.push({url,body:JSON.parse(String(init?.body))});return Response.json([]);}
   return Response.json([{customer_id:pickup,cartrack:customer,labcenter_location_id:linked?10:null}]);
 }
 if(url.endsWith('/delivery/customers/'+pickup)){
   if(method==='PUT'){Object.assign(customer,JSON.parse(String(init?.body)));return Response.json({});}
   return Response.json({data:customer});
 }
 if(url.endsWith('/api/v1/auth/login'))return Response.json({token:'test'});
 if(url.endsWith('/api/locations/10')){
   if(method==='PUT'){if(lcAccepts)Object.assign(lc,JSON.parse(String(init?.body)));return Response.json({});}
   return Response.json({data:lc});
 }
 throw new Error('Unexpected '+method+' '+url);
};
try {
 await assert.rejects(createMasterDriver(pickup,{...draft,bot_token:'secret'}));assert.equal(creates,0);
 await assert.rejects(createMasterDriver(pickup,{...draft,start_location_customer_id:'invalid'}));assert.equal(creates,0);
 dbFails=true;await assert.rejects(createMasterDriver(pickup,draft));assert.equal(creates,1);
 dbFails=false;assert.equal((await createMasterDriver(pickup,draft)).driver_id,driver);assert.equal(creates,1,'retry after DB failure must not create another driver');
 assert.equal((await createMasterDriver(pickup,draft)).driver_id,driver);assert.equal(creates,1);
 const row=(writes[1].body as Record<string,unknown>[])[0];assert.deepEqual(row.roster,{Driver:'P - C - PTBU Test driver',employee_code:'PTBU',employee_full_name:'Test driver'});
 uncertain=true;await assert.rejects(createMasterDriver(driver,draft),/Chưa xác định/);await assert.rejects(createMasterDriver(driver,draft),/Chưa xác định/);assert.equal(creates,2);
 await editClient(pickup,{latitude:11,longitude:107});assert.equal(customer.address_line_1,'Address');
 let update=(writes.at(-1)!.body as Record<string,unknown>[])[0];assert.ok(update.geo_calculated_at&&update.geo_dataset_version);assert.equal(customer.latitude,11);
 const coords=[customer.latitude,customer.longitude];await editClient(pickup,{address_line_1:'New address'});assert.deepEqual([customer.latitude,customer.longitude],coords);
 linked=true;await editClient(pickup,{latitude:10.6,longitude:106.6});assert.equal(lc.latitude,10.6);assert.equal(lc.longitude,106.6);
 lcAccepts=false;await assert.rejects(editClient(pickup,{latitude:10.7,longitude:106.7}),/GPS không khớp/);
 assert.equal(customer.latitude,10.7,'partial save remains explicit and retryable');
 await assert.rejects(editClient(pickup,{latitude:91}),/GPS/);
 console.log('GPS save/read-back/address preservation and driver validation, partial-save retry, duplicate-submit safety passed; no live writes');
}finally{globalThis.fetch=previousFetch;for(const [k,v]of Object.entries(before))if(v===undefined)delete process.env[k];else process.env[k]=v;}
