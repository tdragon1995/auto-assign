// Run: npx tsx scripts/standby.test.mts — no network.
// A STANDBY deployment stays idle only while ANOTHER deployment's beat is fresh;
// its own beat never counts, and a stale or unreadable hash means "take over".
import assert from "node:assert/strict";
import { anyOtherFresh } from "../src/lib/smart-log-kv";

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

assert.equal(anyOtherFresh({ A: ago(1), B: ago(0) }, "B"), true, "primary fresh → idle");
assert.equal(anyOtherFresh({ A: ago(9), B: ago(0) }, "B"), false, "primary stale → take over");
assert.equal(anyOtherFresh({ B: ago(0) }, "B"), false, "own beat never counts");
assert.equal(anyOtherFresh(null, "B"), false, "unreadable → take over");
assert.equal(anyOtherFresh({ A: "garbage", B: ago(0) }, "B"), false, "unparseable beat ignored");
console.log("standby: ok");
