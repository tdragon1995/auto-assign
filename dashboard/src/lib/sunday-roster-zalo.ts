/**
 * The Sunday roster's Zalo side: Wednesday 13:00 (draft) and Friday 13:00
 * (final) the drivers' groups get the roster picture, an open-slots picture and
 * the text; every "Nhận ca" claim is announced there; Monday 13:00 the coming
 * Sunday is saved as a copy of the last one if nobody saved it; on Tuesday and Thursday
 * 13:00, the day before each post, the admin group gets the open-slots picture
 * and list.
 *
 * Rides the assign cron like the pickup-ETA update — no schedule of its own.
 * Sent by the admin bot (ZALO_ADMIN_BOT_TOKEN), which must be a member of the
 * drivers' group ZALO_DRIVER_CHAT_ID. Unset chat id = nothing is posted.
 */
import crypto from "crypto";
import { sbRpc, sbSelect, sbSelectAll } from "./supabase-rest";
import { masterEnabled } from "./master-store";
import { invalidateConfigCache } from "./config";
import { loadLeaveEntries, leaveEntriesOnDate, resignationOn, type LeaveEntry } from "./leave-config";
import { notifyAdminGroup, sendZaloMessage } from "./zalo";
import { getRedis } from "./tat-archive";
import { vnDate, vnMinutesSinceMidnight } from "./time";
import { rosterSunday } from "./sunday-roster";
import { adminAlertText, awayFor, isPublished, openLines, POST_DAY, STAGE_LABEL, weeklyPostText, type AwayFact, type PostLine, type Stage } from "./sunday-roster-post";
import { renderOpenSlotsImage, renderRosterImage } from "./sunday-roster-image";

// The deployment that signs the picture URL must be the one serving it: the two
// Vercel accounts need not share the secret, and "Đăng Zalo" runs on account B.
const BASE_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : "https://diag-logistics.vercel.app";

type Row = {
  id: number; area: string; driver_id: string | null; raw_name: string | null; shift: string | null; note: string | null;
  master_drivers: { last_name: string | null; roster: Record<string, string> | null; phone_number_update: string | null } | null;
};

const dm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
export const cleanName = (name: string) => name.replace(/^(PT|DC)\d+\s+/i, "").trim();

/** Leave that stops a rostered driver driving on `date`, by driver id. */
function awayFacts(date: string, entries: LeaveEntry[]): Map<string, AwayFact[]> {
  const out = new Map<string, AwayFact[]>();
  const add = (id: string, f: AwayFact) => out.set(id, [...(out.get(id) ?? []), f]);
  // A resignation can end (leave_to) — the driver came back — so ask the shared rule.
  for (const id of new Set(entries.filter((e) => e.loai_nghi === "Nghỉ việc").map((e) => e.driver_id))) {
    const r = resignationOn(id, date, entries);
    if (r) add(id, { resigned: true, window: null, covered: false, label: `Nghỉ việc từ ${dm(r.leave_from)}` });
  }
  for (const e of leaveEntriesOnDate(date, entries)) {
    if (e.loai_nghi === "Nghỉ việc") continue;
    add(e.driver_id, { resigned: false, window: e.timeLabel, covered: e.subs.length > 0, label: e.loai_nghi || "Nghỉ" });
  }
  return out;
}

export type SundayLine = PostLine & { phone: string };

/** One Sunday's lines with names and leave resolved, plus a way to ask the same
 *  question of a driver who is not on a line yet (a claimer). An unreadable leave
 *  list reads as nobody away: a line with a driver then counts as filled, which
 *  is what it was before this feature. */
export async function loadSunday(date: string): Promise<{ lines: SundayLine[]; awayOf: (driverId: string, shift: string) => string | null }> {
  const [rows, entries] = await Promise.all([
    sbSelectAll<Row>("master_sunday_roster",
      `select=id,area,driver_id,raw_name,shift,note,master_drivers(last_name,roster,phone_number_update)&work_date=eq.${date}`, "sort.asc,id.asc"),
    loadLeaveEntries().catch(() => [] as LeaveEntry[]),
  ]);
  const away = awayFacts(date, entries);
  const awayOf = (driverId: string, shift: string) => awayFor(shift, away.get(driverId) ?? []);
  const lines = rows.map((r) => {
    const d = r.master_drivers;
    const phone = d?.phone_number_update?.replace(/\D/g, "").replace(/^0/, "");
    const shift = r.shift ?? "";
    return {
      id: r.id, area: r.area, shift, note: r.note ?? "", driver_id: r.driver_id,
      name: cleanName(d ? (d.roster?.employee_full_name || d.last_name || "") : r.raw_name ?? ""),
      away: r.driver_id ? awayOf(r.driver_id, shift) : null,
      phone: phone ? `+84${phone}` : d ? "" : "Liên hệ Đội điều phối",
    };
  });
  return { lines, awayOf };
}

export const loadSundayLines = async (date: string) => (await loadSunday(date)).lines;

/** The picture URL is public (Zalo fetches it), so it carries a signature: the
 *  roster has names on it, and a guessable date-only URL would hand it out. */
function imageSig(date: string): string {
  const key = process.env.ZALO_REPORT_SECRET || process.env.CRON_SECRET || process.env.DRIVER_SESSION_SECRET || process.env.CARTRACK_WEB_PASS || "";
  return crypto.createHmac("sha256", key).update(`sunday-roster:${date}`).digest("base64url").slice(0, 22);
}
export const imageSigOk = (date: string, sig: string | null) => !!sig && sig === imageSig(date);
/** The two pictures: the whole roster, and the open slots on their own. */
export type ImageKind = "roster" | "open";
const imageUrl = (date: string, kind: ImageKind, stage: Stage, v: string) =>
  `${BASE_URL}/api/sunday-roster/image?date=${date}&kind=${kind}&stage=${stage}&sig=${imageSig(date)}&v=${v}`;
const imageKey = (date: string, kind: ImageKind, v: string) => `sunday_roster:img:${date}:${kind}:${v}`;

/** Draw one picture; null for "open" when nothing is open. */
export async function drawImage(date: string, kind: ImageKind, stage: Stage, lines: SundayLine[]): Promise<Buffer | null> {
  const published = lines.filter((l) => isPublished(l.area));
  const res = kind === "roster" ? await renderRosterImage(date, published, stage) : await renderOpenSlotsImage(date, published, stage);
  return res ? Buffer.from(await res.arrayBuffer()) : null;
}

/** Draw the pictures NOW and keep them for a day, so the links answer at once.
 *  Drawing takes 6–8 s, and Zalo refused a link that slow ("photo URL is
 *  invalid") while taking instant Cartrack images. ~0.8 MB per post, two posts
 *  a week. The open-slots picture is left out when nothing is open. */
export async function preparedImageUrls(
  date: string, lines: SundayLine[], stage: Stage, kinds: readonly ImageKind[] = ["roster", "open"],
): Promise<string[]> {
  const v = String(Date.now());
  const redis = getRedis();
  const urls: string[] = [];
  for (const kind of kinds) {
    const png = await drawImage(date, kind, stage, lines);
    if (!png) continue;
    await redis?.set(imageKey(date, kind, v), png.toString("base64"), { ex: 86_400 }).catch((e) => console.error("[sunday-roster] image cache:", e));
    urls.push(imageUrl(date, kind, stage, v));
  }
  return urls;
}

/** Links that draw on request — the admin preview, which nobody times out. */
export const previewImageUrls = (date: string, lines: SundayLine[], stage: Stage): string[] =>
  (openLines(lines).length ? (["roster", "open"] as const) : (["roster"] as const)).map((k) => imageUrl(date, k, stage, "0"));

/** The picture prepared for this link, or null (expired, or never stored). */
export async function preparedImage(date: string, kind: ImageKind, v: string | null): Promise<Buffer | null> {
  if (!v || !/^\d+$/.test(v) || v === "0") return null;
  const b64 = await getRedis()?.get<string>(imageKey(date, kind, v)).catch(() => null);
  return typeof b64 === "string" && b64 ? Buffer.from(b64, "base64") : null;
}

async function sendZaloPhoto(botToken: string, chatId: string, photo: string, caption?: string): Promise<boolean> {
  try {
    const res = await fetch(`https://bot-api.zaloplatforms.com/bot${botToken}/sendPhoto`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, photo, ...(caption ? { caption } : {}) }),
    });
    // Zalo refuses with HTTP 200 and ok:false in the body.
    return res.ok && (await res.json().catch(() => null))?.ok === true;
  } catch {
    return false;
  }
}

/** The drivers' groups — ZALO_DRIVER_CHAT_ID is comma-separated (there are two). */
const driverGroups = () => {
  const token = process.env.ZALO_ADMIN_BOT_TOKEN;
  const chats = (process.env.ZALO_DRIVER_CHAT_ID ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  return token && chats.length ? { token, chats } : null;
};

/** Text to every drivers' group; false when unconfigured or any group refused. */
export async function sendDriverGroup(text: string): Promise<boolean> {
  const g = driverGroups();
  if (!g) return false;
  const sent = await Promise.all(g.chats.map((c) => sendZaloMessage(g.token, c, text)));
  return sent.every(Boolean);
}

/** The post — Wednesday's draft or Friday's final: the roster picture, the
 *  open-slots picture (when anything is open), then the text. */
export async function postWeekly(date: string, stage: Stage, opts: { test?: boolean } = {}): Promise<{ ok: boolean; sent: boolean; reason?: string }> {
  // A test send is the same post to the ADMIN group only, marked as a test.
  const adminChat = process.env.ZALO_ADMIN_CHAT_ID;
  const g = opts.test
    ? (process.env.ZALO_ADMIN_BOT_TOKEN && adminChat ? { token: process.env.ZALO_ADMIN_BOT_TOKEN, chats: [adminChat] } : null)
    : driverGroups();
  if (!g) return { ok: false, sent: false, reason: opts.test ? "ZALO_ADMIN_BOT_TOKEN / ZALO_ADMIN_CHAT_ID chưa cấu hình" : "ZALO_ADMIN_BOT_TOKEN / ZALO_DRIVER_CHAT_ID chưa cấu hình" };
  const lines = await loadSundayLines(date);
  if (!lines.length) {
    if (opts.test) return { ok: false, sent: false, reason: `chưa lưu Lịch CN ${dm(date)}` };
    const which = stage === "draft" ? "bản dự kiến thứ Tư" : "bản chính thức thứ Sáu";
    await notifyAdminGroup(`⚠️ Chưa lưu Lịch CN ${dm(date)} — ${which} cho tài xế chưa được gửi. Lưu Lịch Chủ nhật rồi bấm "Đăng Zalo".`);
    return { ok: false, sent: true, reason: "no roster saved" };
  }
  const urls = await preparedImageUrls(date, lines, stage);
  const text = (opts.test ? "[GỬI THỬ — chỉ nhóm admin, tài xế chưa nhận]\n\n" : "") + weeklyPostText(date, lines, stage);
  // Per group in order — pictures first, then the text — so each group reads them as one post.
  const results = await Promise.all(g.chats.map(async (c) => {
    const photos: boolean[] = [];
    for (const u of urls) photos.push(await sendZaloPhoto(g.token, c, u));
    return { c, photos, text: await sendZaloMessage(g.token, c, text) };
  }));
  const failed = results.filter((r) => !r.text || r.photos.some((p) => !p));
  return failed.length
    ? { ok: false, sent: results.some((r) => r.text || r.photos.some(Boolean)), reason: failed.map((r) => `${r.c}: photos=${r.photos} text=${r.text}`).join("; ") }
    : { ok: true, sent: true };
}

/** The day before a drivers' post: tell the admins what is still open — or
 *  that the roster is not saved at all, which would stop the post. */
async function alertAdmins(date: string, next: Stage): Promise<void> {
  const lines = await loadSundayLines(date);
  if (!lines.length) {
    await notifyAdminGroup(`⚠️ Chưa lưu Lịch CN ${dm(date)} — ${STAGE_LABEL[next].toLowerCase()} gửi tài xế lúc 13:00 ${POST_DAY[next]}. Lưu Lịch Chủ nhật trước giờ đó.`);
    return;
  }
  const text = adminAlertText(date, lines, next);
  if (!text) return;
  // The same "Ca còn trống" picture the drivers will get, then the list.
  const token = process.env.ZALO_ADMIN_BOT_TOKEN, chat = process.env.ZALO_ADMIN_CHAT_ID;
  if (token && chat) {
    const [url] = await preparedImageUrls(date, lines, next, ["open"]);
    if (url && !(await sendZaloPhoto(token, chat, url))) console.warn("[sunday-roster] admin alert picture not sent", date);
  }
  await notifyAdminGroup(text);
}

/**
 * Save `date`'s roster as a copy of the latest saved Sunday before it — only
 * when nothing is saved for `date` yet. Returns the Sunday copied from, or null
 * (already saved, nothing to copy, or an admin saved first). It is exactly what
 * the Lịch Chủ nhật editor offers when it opens an unsaved week, done without
 * waiting for someone to press Lưu (supervisor, 2026-10-27).
 *
 * Never overwrites: `expected_ids: []` makes master_write_sunday_roster refuse
 * if any line exists for that Sunday by the time it runs.
 */
export async function autoSaveRoster(date: string): Promise<string | null> {
  if (!masterEnabled()) return null;
  if ((await sbSelect<{ id: number }>("master_sunday_roster", `select=id&work_date=eq.${date}&limit=1`)).length) return null;
  const [src] = await sbSelect<{ work_date: string }>("master_sunday_roster",
    `select=work_date&work_date=lt.${date}&order=work_date.desc&limit=1`);
  if (!src) return null;
  type Line = { area: string; driver_id: string | null; raw_name: string | null; shift: string | null; note: string | null };
  const rows = await sbSelectAll<Line>("master_sunday_roster",
    `select=area,driver_id,raw_name,shift,note&work_date=eq.${src.work_date}`, "sort.asc,id.asc");
  try {
    await sbRpc<number>("master_write_sunday_roster", {
      roster_date: date, expected_ids: [],
      lines: rows.map((r) => ({ area: r.area, driver_id: r.driver_id, raw_name: r.driver_id ? null : r.raw_name, shift: r.shift ?? "", note: r.note ?? "" })),
    });
  } catch (e) {
    if (String(e).includes("Roster changed since it was loaded")) return null; // an admin saved it meanwhile
    throw e;
  }
  // The roster decides who drives every Sunday rule.
  await invalidateConfigCache();
  console.log(`[sunday-roster] auto-saved ${date} from ${src.work_date} (${rows.length} lines)`);
  await notifyAdminGroup(`📋 Đã tự lưu Lịch CN ${dm(date)} (sao chép từ CN ${dm(src.work_date)}). Kiểm tra và sửa trong Lịch Chủ nhật — tài xế nhận bản dự kiến 13:00 thứ Tư, bản chính thức 13:00 thứ Sáu.`);
  return src.work_date;
}

/** The week, all at 13:00 VN (supervisor, 2026-10-27): Monday auto-save of the
 *  coming Sunday, Tuesday admin alert, Wednesday draft to drivers, Thursday
 *  admin alert, Friday final to drivers. Every job saves first if still unsaved. */
const WEEK: Record<number, { kind: "save" | "alert" | "post"; stage: Stage }> = {
  1: { kind: "save", stage: "draft" },
  2: { kind: "alert", stage: "draft" },
  3: { kind: "post", stage: "draft" },
  4: { kind: "alert", stage: "final" },
  5: { kind: "post", stage: "final" },
};

/** Called on every assign-cron ping. Free outside 13:00–13:59 Mon–Fri; inside,
 *  one Redis SET NX per ping until that day's job is done. A post where nothing
 *  went out releases the key so the next ping (3 minutes on) tries again. */
export async function maybeSundayRosterPost(now = new Date()): Promise<void> {
  const day = new Date(`${vnDate(now)}T00:00:00Z`).getUTCDay();
  const job = Math.floor(vnMinutesSinceMidnight(now) / 60) === 13 ? WEEK[day] : undefined;
  if (!job) return;
  const redis = getRedis();
  if (!redis) return;
  const date = rosterSunday(vnDate(now));
  const key = `sunday_roster:${job.kind}:${job.stage}:${date}`;
  if (await redis.set(key, Date.now(), { nx: true, ex: 3 * 86_400 }) !== "OK") return;
  try {
    await autoSaveRoster(date);
    if (job.kind === "save") return;
    if (job.kind === "alert") return await alertAdmins(date, job.stage);
    const res = await postWeekly(date, job.stage);
    console.log(`[sunday-roster] ${job.stage} post ${date}:`, JSON.stringify(res));
    // Retry only when NOTHING went out: a half-sent post retried would post the
    // pictures twice, and "no roster saved" has already alerted the admins.
    if (!res.sent) await redis.del(key);
  } catch (e) {
    console.error(`[sunday-roster] ${job.kind} ${job.stage} ${date}:`, e);
    await redis.del(key).catch(() => {});
  }
}
