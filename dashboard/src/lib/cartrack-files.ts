/**
 * Files → permanent public links, using a Cartrack Fleetweb APPOINTMENT as the
 * carrier (the technique from the file2CT_url proof of concept, 2026-10-08):
 *
 *   1. set the appointment's files to the upload   (delivery_update_appointment)
 *   2. read it back to get each file's link        (delivery_get_appointment)
 *   3. set its files back to []                    — the links keep working
 *
 * Runs SERVER-SIDE, logged in as the account that owns the carrier appointment
 * (CNGT00003 — the dashboard's own CNGT00002 is refused on it), so no Cartrack
 * credential or token ever reaches a driver's phone.
 *
 * CONFIG, all environment variables — never in code (the POC hard-coded them):
 *   CARTRACK_PROOF_ACCOUNT         the Fleetweb account id (CNGT00003)
 *   CARTRACK_PROOF_PASSWORD        its password
 *   CARTRACK_PROOF_APPOINTMENT_ID  the carrier appointment (13285)
 * The API key is the dashboard's own CARTRACK_AUTH — verified identical to the
 * POC's. Its capability id is read off the appointment itself. Until all three are
 * set, upload() refuses with a clear message rather than guessing.
 *
 * SHARED CARRIER: the POC site at cartrack-file-poc.vercel.app uses the same
 * appointment. An upload there at the same second as one here can wipe ours
 * between steps 1 and 2 — caught by the count check below, never stored wrong.
 *
 * THE LINKS ARE PUBLIC: anyone holding one can open the file. Fine for a
 * screenshot of an app error; the form says not to upload anything personal.
 *
 * ONE AT A TIME. Two uploads on one appointment overwrite each other's step 1
 * before step 2 reads it back, so a Redis lock serialises them.
 */
import { JSONRPC_URL } from "./cartrack";
import { getRedis } from "./tat-archive";
import { vnDate, addDays } from "./time";

const PUBLIC_BASE = "https://fleetweb-vn.cartrack.com/jsonrpc/todoImage/image?img=";
const LOCK_KEY = "cartrack:proof-upload:lock";

export interface UploadFile { name: string; dataUrl: string }

export function proofUploadConfigured(): boolean {
  return Number(process.env.CARTRACK_PROOF_APPOINTMENT_ID) > 0
    && !!process.env.CARTRACK_PROOF_ACCOUNT && !!process.env.CARTRACK_PROOF_PASSWORD && !!process.env.CARTRACK_AUTH;
}

type Rpc = <T = unknown>(method: string, params: unknown) => Promise<{ ok: true; result: T } | { ok: false; error: string }>;

/**
 * Logs in as the proof account and returns a caller for its session — the same
 * login the POC does: ct_login answers with an access token in the body and
 * session cookies (fs, SERVERID, refresh_token), and Fleetweb wants BOTH on every
 * call after. One login per upload: uploads are rare, and a cached session is one
 * more thing to go stale.
 *
 * A refused login says WRONG_CREDENTIALS in a 200 body (verified for the main
 * account 2026-08-10); it is surfaced, never retried — Cartrack counts failures
 * and locks the account.
 */
async function proofSession(): Promise<Rpc> {
  const res = await fetch(JSONRPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: process.env.CARTRACK_AUTH! },
    body: JSON.stringify({
      version: "2.0", method: "ct_login", id: 1,
      params: {
        x: "x", account: process.env.CARTRACK_PROOF_ACCOUNT, username: "", password: process.env.CARTRACK_PROOF_PASSWORD,
        locale: "en-ZA", otp: "", browserName: "", version: "3.9.1", environment: "live", thirdParty: false,
      },
    }),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => null)) as { result?: { access_token?: string; status?: string } } | null;
  const token = body?.result?.access_token;
  if (!res.ok || !token) throw new Error(`proof account login refused (${body?.result?.status ?? `HTTP ${res.status}`})`);
  const set = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") ?? ""];
  const cookie = set
    .map((line) => /^\s*(fs|SERVERID|refresh_token)=([^;]+)/.exec(line))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => `${m[1]}=${m[2]}`)
    .join("; ");

  return async <T,>(method: string, params: unknown) => {
    const r = await fetch(JSONRPC_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Authorization: `Bearer ${token}`, Cookie: cookie },
      body: JSON.stringify({ version: "2.0", method, id: 10, params }),
      cache: "no-store",
    });
    const j = (await r.json().catch(() => null)) as { result?: T; error?: unknown } | null;
    if (!r.ok || !j || j.error) return { ok: false as const, error: j?.error ? JSON.stringify(j.error).slice(0, 300) : `HTTP ${r.status}` };
    return { ok: true as const, result: j.result as T };
  };
}

/** "07:00:00+07" + date → the full window timestamp the RPC wants. Same as the POC. */
function slotToWindow(date: string, slot: string): string {
  const m = /^(\d{2}:\d{2}:\d{2})([+-]\d{2})(?::?(\d{2}))?$/.exec(slot.trim());
  return m ? `${date}T${m[1]}${m[2]}:${m[3] || "00"}` : `${date}T${slot}`;
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const redis = getRedis();
  if (!redis) return fn();   // ponytail: no Redis (local dev) → no lock; prod always has it.
  for (let i = 0; i < 20; i++) {
    if (await redis.set(LOCK_KEY, "1", { nx: true, ex: 60 })) {
      try { return await fn(); } finally { await redis.del(LOCK_KEY); }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("Hệ thống đang tải ảnh khác, thử lại sau ít phút.");
}

/** Uploads the files and returns one public link each, in order. */
export async function uploadToCartrack(files: UploadFile[]): Promise<string[]> {
  const appointmentId = Number(process.env.CARTRACK_PROOF_APPOINTMENT_ID);
  if (!proofUploadConfigured()) throw new Error("Chưa cấu hình nơi lưu ảnh minh chứng.");
  if (files.length === 0) return [];

  return withLock(async () => {
    const jsonRpc = await proofSession();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const got = await jsonRpc<any>("delivery_get_appointment", { data: { appointmentId } });
    if (!got.ok) throw new Error(`delivery_get_appointment: ${got.error}`);
    const appt = got.result?.data ?? {};
    const capabilityId = appt.capabilityId;

    // The update wants a bookable window, as the POC found; today's or
    // tomorrow's first free slot, else the appointment's own.
    let win: string | null = null;
    for (const d of [vnDate(), addDays(vnDate(), 1)]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s = await jsonRpc<any>("delivery_get_available_appointment_slots", { data: { capabilityId, selectedDate: d, appointmentId: null } });
      const slots: string[] = (s.ok && s.result?.data) || [];
      if (slots.length) { win = slotToWindow(d, slots[0]); break; }
    }
    win ??= appt.windowStartTime ? String(appt.windowStartTime).replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00") : null;
    if (!win) throw new Error("Không tìm được khung giờ để tải ảnh.");

    const update = (list: { file_name: string; base64_data: string }[]) => jsonRpc("delivery_update_appointment", {
      data: {
        windowStartTime: win, windowEndTime: win, durationInMinutes: appt.durationInMinutes ?? 45,
        properties: appt.properties, files: list, capabilityId, appointmentId,
      },
    });

    const put = await update(files.map((f) => ({ file_name: f.name, base64_data: f.dataUrl })));
    if (!put.ok) throw new Error(`delivery_update_appointment: ${put.error}`);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const back = await jsonRpc<any>("delivery_get_appointment", { data: { appointmentId } });
      if (!back.ok) throw new Error(`delivery_get_appointment: ${back.error}`);
      const stored: { file_url?: string }[] = back.result?.data?.files ?? [];
      const links = stored.filter((f) => f.file_url).map((f) => PUBLIC_BASE + encodeURIComponent(new URL(f.file_url!).pathname));
      if (links.length !== files.length) throw new Error(`Cartrack giữ ${links.length}/${files.length} tệp.`);
      return links;
    } finally {
      // Leave the carrier empty whatever happened; the links survive it.
      await update([]);
    }
  });
}
