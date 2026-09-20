/**
 * /picture: what the verdict is ABOUT, and who it is attributed to.
 *
 * Two things here are worth pinning offline.
 *
 * The DECK. A job's images are not all photos: the e-Sign todo carries one too. If a
 * signature slipped into the deck, every job would gain a picture nobody is auditing
 * and — worse — one more unit for the "seen everything" gate to demand, so the gate
 * would train reviewers to click through an image that never tells them anything.
 *
 * The ATTRIBUTION. The reviewer's email is the whole audit trail. It comes from a
 * signed cookie precisely so a browser cannot claim to be someone else, and a
 * signature check that silently accepts a forged or expired token would leave a table
 * full of verdicts attributed to people who never filed them.
 *
 *   npx tsx scripts/photo-review.test.mts
 */

process.env.DRIVER_SESSION_SECRET = "test-secret-for-photo-review";

import crypto from "crypto";

const { pickPhotos, pickNotes, FAIL_REASON_CODES } = await import("../src/lib/photo-review");
const { signReviewSession, reviewerEmail } = await import("../src/lib/review-session");

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

// A trimmed copy of job 34448099 as Cartrack returns it: a photo + a note + an e-Sign
// at pickup, and the same three at dropoff — where the e-Sign one HAS an image.
const JOB = {
  stops: [
    {
      customer_name: "46511528 - D1 - TVCan",
      todos: [
        { todo_type_id: 5, description: "Note @ pickup", note: "2tui", images: [] },
        {
          todo_type_id: 2, description: "Take a photo @ pickup", note: null,
          images: [{ image_id: 23237014, image_url: "https://x/pickup.jpeg", is_deleted: false }],
        },
        { todo_type_id: 1, description: "e-Sign @ pickup", note: null, images: [] },
      ],
    },
    {
      customer_name: "BRA - D026",
      todos: [
        { todo_type_id: 5, description: "Note @ dropoff", note: "2tui", images: [] },
        {
          todo_type_id: 2, description: "Take a photo @ dropoff", note: null,
          images: [
            { image_id: 23237033, image_url: "https://x/dropoff.jpeg", is_deleted: false },
            { image_id: 99999999, image_url: "https://x/retaken.jpeg", is_deleted: true },
          ],
        },
        {
          todo_type_id: 1, description: "e-Sign @ dropoff", note: null,
          images: [{ image_id: 23237036, image_url: "https://x/signature.jpeg", is_deleted: false }],
        },
      ],
    },
  ],
};

console.log("the deck");
const shots = pickPhotos(JOB);
check("photo todos only — the signature is not in the deck", shots.length === 2, `got ${shots.length}`);
check("a deleted (retaken) image is skipped", !shots.some((s) => s.url.includes("retaken")));
check("no signature url anywhere", !shots.some((s) => s.url.includes("signature")));
check("pickup first, then dropoff", shots[0]?.url.includes("pickup") && shots[1]?.url.includes("dropoff"));
check("each shot says which stop it is from", shots[0]?.where.includes("TVCan") && shots[1]?.where === "BRA - D026");

const notes = pickNotes(JOB);
check("both typed notes are surfaced", notes.length === 2 && notes.every((n) => n.note === "2tui"),
  JSON.stringify(notes));

check("an empty job yields an empty deck, not a throw", pickPhotos(null).length === 0 && pickNotes(undefined).length === 0);

// The DB's CHECK constraint lists these three codes. A code added to one side only is
// either a reason the UI offers and Postgres rejects, or a dead option.
console.log("fail reasons");
check("codes match the migration's CHECK list",
  FAIL_REASON_CODES.join(",") === "blurry,qty_mismatch,qty_unclear", FAIL_REASON_CODES.join(","));

console.log("attribution");
const good = signReviewSession("long.nguyenthanh@diag-center.com.vn");
check("a signed session reads back its email", reviewerEmail(good) === "long.nguyenthanh@diag-center.com.vn");
check("no cookie is not a session", reviewerEmail(undefined) === null && reviewerEmail("") === null);
check("a token with no signature is refused", reviewerEmail(good.split(".")[0]) === null);

// Swap the payload for a different email, keep the original signature.
const forged = `${Buffer.from(JSON.stringify({ email: "someone.else@diag-center.com.vn", exp: Date.now() + 60_000 })).toString("base64url")}.${good.split(".")[1]}`;
check("a rewritten payload is refused", reviewerEmail(forged) === null);

// Correctly signed, but expired — the signature alone must not be enough.
const staleBody = Buffer.from(JSON.stringify({ email: "a@b.c", exp: Date.now() - 1000 })).toString("base64url");
const stale = `${staleBody}.${crypto.createHmac("sha256", process.env.DRIVER_SESSION_SECRET!).update(staleBody).digest("base64url")}`;
check("an expired session is refused", reviewerEmail(stale) === null);

// A token signed with a different secret (another deployment, or a guess).
const otherBody = Buffer.from(JSON.stringify({ email: "a@b.c", exp: Date.now() + 60_000 })).toString("base64url");
const other = `${otherBody}.${crypto.createHmac("sha256", "not-the-secret").update(otherBody).digest("base64url")}`;
check("a session signed with another secret is refused", reviewerEmail(other) === null);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
