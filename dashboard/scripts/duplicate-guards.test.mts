/**
 * The three duplicate-trip defences that can be checked without a network or a Redis.
 *
 * 1. An RPC create that was SENT and never answered must not fall back to REST. This is
 *    the only remaining path that can turn one branch request into two real jobs, and it
 *    is invisible in normal operation: it needs a timeout, which is exactly when nobody
 *    is watching. A thrown fetch used to look identical to an answered refusal, and the
 *    fallback after a refusal is licensed by a probe that only ever tested refusals.
 *
 * 2. The pair overlay's compare-and-delete pattern. The Lua runs in Redis, but the
 *    PATTERN it matches on is the part that can be wrong on its own — "job_id":1 must
 *    not match job 12 — so that is checked here against the real stored shape.
 *
 * 3. retirePending: one booking must render as one card whatever type its id arrived as.
 *
 * Fully offline — global fetch is stubbed, no Redis is configured, no day is read.
 *
 *   npx tsx scripts/duplicate-guards.test.mts
 */

// No Redis: the cookie cache and the pair overlay both degrade to their local paths.
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
// atob() decodes this to "TEST:pw", which is all performLogin reads out of it.
process.env.CARTRACK_AUTH = `Basic ${Buffer.from("TEST:pw").toString("base64")}`;
process.env.CARTRACK_WEB_PASS = "pw";

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "  ok  " : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!pass) failures++;
}

// ── 1. A sent-but-unanswered RPC create must not be retried over REST ──────────

const calls: string[] = [];
/** How the stubbed RPC answers the create call. */
let createBehaviour: "throw" | "refuse" = "throw";

const realFetch = globalThis.fetch;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  const body = typeof init?.body === "string" ? init.body : "";
  const method = /"method":"(\w+)"/.exec(body)?.[1] ?? "";

  if (url.includes("jsonrpc")) {
    calls.push(`rpc:${method}`);
    if (method === "ct_login") {
      // A successful handshake: verdict in the body, session in Set-Cookie.
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: { status: "SUCCEEDED" } }),
        headers: { getSetCookie: () => ["CTSID=test; Path=/"] },
      };
    }
    if (method === "delivery_create_job") {
      if (createBehaviour === "throw") {
        // The shape of a timeout: the request left, nothing came back.
        throw new Error("fetch failed: socket hang up");
      }
      // An ANSWERED refusal — Cartrack looked at it and said no, so nothing was created.
      return { ok: false, status: 400, json: async () => ({ error: { message: "bad payload" } }), headers: { getSetCookie: () => [] } };
    }
  }
  if (url.includes("/jobs")) {
    calls.push("rest:create");
    return { ok: true, status: 200, json: async () => ({ data: { job_id: 777 } }), headers: { getSetCookie: () => [] } };
  }
  throw new Error(`unexpected fetch: ${url}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

const { createJob } = await import("../src/lib/cartrack");

const payload = {
  job_type_id: 1,
  schedule_type_id: 1,
  reference_number: "TEST→D001_09:00",
  labels: ["🛵 Vận chuyển mẫu PSC"],
  delivery_driver_id: "11111111-2222-3333-4444-555555555555",
  stops: [
    { stop_type_id: 1, customer_id: "cust-psc", duration: 5, todos: [{ todo_type_id: 3, stop_type_id: 1, is_required: true, description: "Quét" }] },
    { stop_type_id: 2, customer_id: "cust-lab", duration: 10, todos: [{ todo_type_id: 2, description: "Chụp" }] },
  ],
  items: [{ description: "Mẫu", weight: 0, item_type_id: 1, quantity: 1, tracking_number: "", todos: [] }],
};

// "ok" skips the driver-status gate, as the booking path does with a live roster in hand.
const timedOut = await createJob(payload, "prod", "ok");
check("a timed-out RPC create is reported as failed", !timedOut.ok, `status ${timedOut.status}`);
check("…with a 5xx, so the caller holds its locks", timedOut.status >= 500, `status ${timedOut.status}`);
check("…and NO second create is posted over REST",
  !calls.includes("rest:create"), calls.join(", "));
check("…the RPC was genuinely attempted", calls.includes("rpc:delivery_create_job"), calls.join(", "));

// The fallback must still work where it is licensed: an answered refusal creates nothing,
// so REST may retry. Losing this would make every RPC hiccup a failed booking.
calls.length = 0;
createBehaviour = "refuse";
const refused = await createJob(payload, "prod", "ok");
check("an ANSWERED refusal still falls back to REST", refused.ok && calls.includes("rest:create"), calls.join(", "));

globalThis.fetch = realFetch;

// ── 2. The pair overlay's compare-and-delete matches whole job ids ─────────────

// The exact string markPscPair stores.
const stored = (jobId: number) => JSON.stringify({ job_id: jobId, reference_number: "D007→D001_10:00", at: Date.now() });
/** The Lua pattern, in JS. Kept in step with PAIR_CAS_DEL_SCRIPT by hand — the point of
 *  this check is that the pattern anchors on a whole number, which is a property of the
 *  pattern itself, not of Redis. */
const matches = (raw: string, id: number) => new RegExp(`"job_id":${id}(?![0-9])`).test(raw);

check("CAS deletes the pair it names", matches(stored(900003), 900003));
check("CAS leaves another job's pair alone", !matches(stored(900003), 900004));
check("CAS does not match a PREFIX of the id", !matches(stored(12), 1));
check("CAS does not match a longer id", !matches(stored(1), 12));

// ── 3. One booking, one card ──────────────────────────────────────────────────

const { retirePending } = await import("../src/lib/pending-cards");
const card = (job_id: number) => ({ job_id, reference: "r", created_ts: "09:00", date: "2026-09-20" });

check("a pending card retires when the feed carries its job",
  retirePending([card(34342828)], [34342828]).length === 0);
check("…even when the booking response gave a STRING id",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  retirePending([{ ...card(0), job_id: "34342828" as any }], [34342828]).length === 0);
check("…and a different job does not retire it",
  retirePending([card(34342828)], [34342832]).length === 1);
check("an empty feed retires nothing", retirePending([card(1)], []).length === 1);
check("a null id in the feed retires nothing",
  retirePending([card(1)], [null, undefined]).length === 1);

console.log(failures ? `\n${failures} FAILED\n` : "\nall good\n");
process.exitCode = failures ? 1 : 0;
