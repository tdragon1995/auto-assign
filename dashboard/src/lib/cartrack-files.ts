/**
 * Files → permanent public links, using a Cartrack Fleetweb APPOINTMENT as the
 * carrier (the technique from the file2CT_url proof of concept, 2026-10-08):
 *
 *   1. set the appointment's files to the upload   (delivery_update_appointment)
 *   2. read it back to get each file's link        (delivery_get_appointment)
 *   3. set its files back to []                    — the links keep working
 *
 * Runs SERVER-SIDE on the dashboard's own Fleetweb session (jsonRpc), so no
 * Cartrack credential or token ever reaches a driver's phone. The POC's own
 * hard-coded account is NOT used.
 *
 * CONFIG. CARTRACK_PROOF_APPOINTMENT_ID — one appointment created in Fleetweb under
 * the dashboard's account (CNGT00002), used only for this and kept empty. Its
 * capability id is read off the appointment itself. Until it is set, upload()
 * refuses with a clear message rather than guessing.
 *
 * THE LINKS ARE PUBLIC: anyone holding one can open the file. Fine for a
 * screenshot of an app error; the form says not to upload anything personal.
 *
 * ONE AT A TIME. Two uploads on one appointment overwrite each other's step 1
 * before step 2 reads it back, so a Redis lock serialises them.
 */
import { jsonRpc } from "./cartrack";
import { getRedis } from "./tat-archive";
import { vnDate, addDays } from "./time";

const PUBLIC_BASE = "https://fleetweb-vn.cartrack.com/jsonrpc/todoImage/image?img=";
const LOCK_KEY = "cartrack:proof-upload:lock";

export interface UploadFile { name: string; dataUrl: string }

export function proofUploadConfigured(): boolean {
  return Number(process.env.CARTRACK_PROOF_APPOINTMENT_ID) > 0;
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
  if (!(appointmentId > 0)) throw new Error("Chưa cấu hình nơi lưu ảnh minh chứng.");
  if (files.length === 0) return [];

  return withLock(async () => {
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
