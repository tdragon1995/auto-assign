import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { misaMonths, syncWait, getMisaSyncStatus, inLabcenterShare } from '../src/lib/misa-sync';
import { morningSyncDue, maybeMorningSync, morningResumeDue, shouldResume, morningRunFailure, MAX_SELF_CALLS } from '../src/lib/morning-sync-trigger';
import { POST } from '../src/app/api/misa-sync/continue/route';
import { GET } from '../src/app/api/morning-sync/route';
assert.deepEqual(misaMonths(null,new Date('2026-12-31T18:00:00Z')),['2026-11','2026-12','2027-01','2027-02']);
assert.deepEqual(misaMonths('2026-10'),['2026-10']);
assert.throws(()=>misaMonths('2026-13'));assert.throws(()=>misaMonths('2026-10&host=evil'));
const time=Date.parse('2026-10-07T00:00:00Z');
const run={id:1,status:'in_progress' as const,conclusion:null,created_at:new Date(time).toISOString(),updated_at:new Date(time).toISOString(),daily:true,
phase:'misa' as const,cursor:'',months:['2026-10'],monthIndex:0,processed:0,issues:0,shiftRows:0};
assert.equal(syncWait(run,time+300000).running,true);assert.equal(syncWait(run,time+335001).running,false);
assert.equal(syncWait({...run,status:'completed',conclusion:'success'},time+60000).wait,14);
assert.equal(syncWait({...run,status:'completed',conclusion:'failure'},time+60000).wait,0);
assert.equal(morningSyncDue(new Date('2026-10-06T21:59:00Z')),false);
assert.equal(morningSyncDue(new Date('2026-10-06T22:00:00Z')),true);
assert.equal(morningSyncDue(new Date('2026-10-06T23:00:00Z')),false);
// Every code falls in exactly one day of any 7 in a row.
for(const code of ['1','6','7','10234','999999999','123456789012']) {
  const days=Array.from({length:7},(_,i)=>new Date(Date.UTC(2026,9,26+i)).toISOString().slice(0,10)).filter(d=>inLabcenterShare(code,d));
  assert.equal(days.length,1,code);
}
// Hop cap: Vercel let 4 self-calls through on 2026-10-19 and refused the 5th.
assert.ok(MAX_SELF_CALLS<4);
assert.equal(morningResumeDue(new Date('2026-10-06T21:59:00Z')),false);
assert.equal(morningResumeDue(new Date('2026-10-07T00:59:00Z')),true);
assert.equal(morningResumeDue(new Date('2026-10-07T01:00:00Z')),false);
const today=new Date(time);
assert.equal(shouldResume({...run,id:time},false,today),true);
assert.equal(shouldResume({...run,id:time},true,today),false,'a step is running');
assert.equal(shouldResume({...run,id:time,daily:false},false,today),false,'manual runs never resume from cron');
assert.equal(shouldResume({...run,id:time,status:'completed'},false,today),false);
assert.equal(shouldResume({...run,id:time-86400000},false,today),false,'yesterday');
assert.equal(morningRunFailure({...run,id:time},time+60000),null);
assert.equal(morningRunFailure({...run,id:time},time+335000)?.error,'Sync interrupted');
const failed=morningRunFailure({...run,id:time,status:'completed',conclusion:'failure',phase:'metadata',error:'Sync continuation HTTP 508'},time);
assert.equal(failed?.error,'Sync continuation HTTP 508');assert.equal(failed?.misaDone,false);
assert.equal(morningRunFailure({...run,id:time,status:'completed',conclusion:'failure',monthIndex:1},time)?.misaDone,true);
assert.equal(morningRunFailure({...run,id:time,status:'completed',conclusion:'success'},time+999999),null);
const old=process.env.CRON_SECRET;delete process.env.CRON_SECRET;
try {
assert.equal((await GET(new NextRequest('https://dashboard.invalid/api/morning-sync'))).status,401);
assert.equal((await POST(new NextRequest('https://dashboard.invalid/api/misa-sync/continue?run=1',{method:'POST'}))).status,401);
await maybeMorningSync(new Date('2026-10-06T22:00:00Z'));
assert.equal((await (await getMisaSyncStatus()).json()).status,'disabled');
process.env.CRON_SECRET='test';
assert.equal((await POST(new NextRequest('https://dashboard.invalid/api/misa-sync/continue?run=1',{method:'POST',headers:{Authorization:'Bearer wrong'}}))).status,401);
assert.equal((await POST(new NextRequest('https://dashboard.invalid/api/misa-sync/continue?run=NaN',{method:'POST',headers:{Authorization:'Bearer test'}}))).status,400);
}finally{if(old===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=old;}
console.log('Native MISA timing, cooldown, stale-run handling and fail-closed authorization passed');
