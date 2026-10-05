// Run: node scripts/master-source-sync.test.mjs (no network or credentials).
import assert from "node:assert/strict";
import {runMasterSync} from "./sync-master.mjs";
const calls = [];
let batches = 0, stall = false, fail = false;
const request = async (url, options) => {
  calls.push([new URL(url).pathname + new URL(url).search, options.method]);
  if (fail) return Response.json({error:"Source unavailable"}, {status:502});
  if (url.includes("phase=profiles")) return Response.json({ok:true});
  if (url.includes("phase=metadata")) return Response.json({ok:true,labcenter:{processed:100,issues:[],nextCursor:++batches === 1 || stall ? "100" : null}});
  return Response.json({status:"ok"});
};
assert.deepEqual(await runMasterSync("https://example.test", request),{processed:200,issues:0});
assert.ok(calls[2][0].endsWith("after=100"));
assert.deepEqual(calls.at(-1),["/api/config","GET"],"Reload cached configuration after sources finish");
stall = true; batches = 0; calls.length = 0;
await assert.rejects(runMasterSync("https://example.test",request),/did not advance/);
assert.ok(!calls.some(([path])=>path === "/api/config"),"Never claim a failed full refresh completed");
fail = true; calls.length = 0;
await assert.rejects(runMasterSync("https://example.test",request),/Source unavailable/);
assert.equal(calls.length,1);
console.log("Morning source sync: pagination, cache reload and failure guards passed");
