import assert from "node:assert/strict";
import {
  buildLeaveSplit,
  encodeLeaveSplitNote,
  leaveSplitOperationKey,
  parseLeaveSplitNote,
  replaceSplitOriginalNote,
  unwrapLeaveSplitNote,
} from "../src/lib/leave-split";

const block = (name: string, from: string, to: string) => ({ name, from, to });

assert.deepEqual(
  buildLeaveSplit("07:00", "17:00", [block("A", "07:00", "12:00"), block("B", "12:00", "17:00")]),
  [
    { from: "07:00", to: "12:00", sub: block("A", "07:00", "12:00") },
    { from: "12:00", to: "17:00", sub: block("B", "12:00", "17:00") },
  ],
  "adjacent substitute shifts become two rows",
);

assert.deepEqual(
  buildLeaveSplit("07:00", "17:00", [block("B", "13:00", "16:00"), block("A", "08:00", "12:00")]),
  [
    { from: "08:00", to: "12:00", sub: block("A", "08:00", "12:00") },
    { from: "13:00", to: "16:00", sub: block("B", "13:00", "16:00") },
  ],
  "only entered shifts become rows",
);

const fullDay = buildLeaveSplit(null, null, [block("A", "07:00", "12:00"), block("B", "12:00", "17:00")]);
assert.deepEqual(
  fullDay.map((part) => [part.from, part.to, part.sub?.name ?? null]),
  [["07:00", "12:00", "A"], ["12:00", "17:00", "B"]],
  "full-day leave creates no inferred edge rows",
);

assert.throws(
  () => buildLeaveSplit("07:00", "17:00", [block("A", "07:00", "12:30"), block("B", "12:00", "17:00")]),
  /bị chồng/,
);
assert.deepEqual(
  buildLeaveSplit("07:00", "17:00", [block("A", "06:30", "12:00"), block("B", "12:00", "18:00")])
    .map((part) => [part.from, part.to, part.sub?.name]),
  [["06:30", "12:00", "A"], ["12:00", "18:00", "B"]],
  "substitute shifts may extend before and after the leave window",
);
assert.throws(
  () => buildLeaveSplit("07:00", "17:00", [block("A", "07:00", "12:00"), block("", "12:00", "17:00")]),
  /Hoàn tất/,
);

const parts = buildLeaveSplit("07:00", "17:00", [block("A", "07:00", "12:00"), block("B", "12:00", "17:00")]);
assert.equal(
  leaveSplitOperationKey("driver", "2026-09-14", "07:00", "17:00", parts),
  leaveSplitOperationKey("driver", "2026-09-14", "07:00", "17:00", parts),
  "retry operation key is stable",
);

const wrapped = encodeLeaveSplitNote({
  operationKey: "split-1", sourceKey: "source-1", partKey: "07:00-12:00", originalNote: "THAY_CA_V1:{\"recordKey\":\"x\"}",
});
assert.equal(unwrapLeaveSplitNote(wrapped), "THAY_CA_V1:{\"recordKey\":\"x\"}");
const updated = replaceSplitOriginalNote(wrapped, "new operational note");
assert.equal(unwrapLeaveSplitNote(updated), "new operational note");
assert.equal(parseLeaveSplitNote(updated)?.operationKey, "split-1", "reconciliation preserves retry metadata");

console.log("Leave split: entered rows only, boundaries, API validation and retry metadata passed.");
