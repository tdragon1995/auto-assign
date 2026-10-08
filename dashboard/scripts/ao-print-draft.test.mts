import assert from "node:assert/strict";
import type { Redis } from "@upstash/redis";
import { printRowOf, readPrintDraft, savePrintDraft, readPrintHistory, savePrintHistory } from "../src/lib/ao-print-draft";
import type { PrintDraftRow } from "../src/lib/handover";

const saved = new Map<string, unknown>();
const ttls: number[] = [];
const db = {
  scan: async (_cursor: string, options: { match: string }) => ["0", [...saved.keys()].filter((key) => key.startsWith(options.match.slice(0, -1)))],
  mget: async (...keys: string[]) => keys.map((key) => saved.get(key) ?? null),
  async set(key: string, value: unknown, options: { ex: number }) { saved.set(key, value); ttls.push(options.ex); },
  pipeline: () => {
    const pending: [string, PrintDraftRow][] = [];
    return {
      set(key: string, row: PrintDraftRow, options: { ex: number }) {
        pending.push([key, row]);
        ttls.push(options.ex);
        return this;
      },
      async exec() { for (const [key, row] of pending) saved.set(key, row); },
    };
  },
} as unknown as Redis;

const row = (billing: string): PrintDraftRow => ({
  dest: "D021", client: "Phòng khám An", vid: "12345678", patient: "Bệnh nhân A", billing, note: "",
});
assert.deepEqual(printRowOf({ ...row("Xét nghiệm A"), secret: "discard" }), row("Xét nghiệm A"));
assert.equal(printRowOf({ ...row("Xét nghiệm A"), vid: "bad" }), null);
await savePrintDraft(db, [row("Xét nghiệm A"), row("xet nghiem  a"), row("Xét nghiệm B")]);
assert.equal((await readPrintDraft(db)).length, 2); // one VID may still carry two distinct tests
assert.deepEqual(ttls, [604800, 604800]);
assert.deepEqual(Object.keys((await readPrintDraft(db))[0]).sort(), ["billing", "client", "dest", "note", "patient", "vid"]);
const print = await savePrintHistory(db, "Ngoài D001", [row("Xét nghiệm A"), row("xet nghiem  a"), row("Xét nghiệm B")]);
assert.equal(print.rows.length, 2);
assert.deepEqual((await readPrintHistory(db)).map((p) => p.id), [print.id]);
assert.deepEqual(ttls, [604800, 604800, 604800]);
console.log("ok — draft and print history dedupe rows and expire after seven days");
