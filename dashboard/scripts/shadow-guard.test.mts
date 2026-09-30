import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { autoAssignCycle } from "../src/lib/assign";
import { proxy } from "../src/proxy";

process.env.VERCEL_ENV = "preview";
process.env.VERCEL_GIT_COMMIT_REF = "codex/shadow-assignment";
await assert.rejects(autoAssignCycle({} as Parameters<typeof autoAssignCycle>[0]), /read-only/);
const request = (path: string, method = "GET") => new NextRequest(`https://shadow.example${path}`, { method });
assert.equal(proxy(request("/api/assign", "POST")).status, 403);
assert.equal(proxy(request("/api/sales/create-trip", "POST")).status, 403);
assert.equal(proxy(request("/api/shadow")).status, 200);
assert.equal(proxy(request("/")).status, 307);
process.env.VERCEL_ENV = "production";
assert.equal(proxy(request("/api/assign", "POST")).status, 200);
console.log("shadow assignment guard: OK");
