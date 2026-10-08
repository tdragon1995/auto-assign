import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { misaMonths, syncWait, getMisaSyncStatus } from '../src/lib/misa-sync';
import { morningSyncDue, maybeMorningSync } from '../src/lib/morning-sync-trigger';
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
