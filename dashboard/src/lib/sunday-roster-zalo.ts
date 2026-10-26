/**
 * The Sunday roster's Zalo side: Friday 17:00 the drivers' group gets the
 * roster picture plus the open slots, every "Nhận ca" claim is announced there,
 * and Saturday 18:00 the admin group hears about anything still open.
 *
 * Rides the assign cron like the pickup-ETA update — no schedule of its own.
 * Sent by the admin bot (ZALO_ADMIN_BOT_TOKEN), which must be a member of the
 * drivers' group ZALO_DRIVER_CHAT_ID. Unset chat id = nothing is posted.
 */
import crypto from "crypto";
import { sbSelectAll } from "./supabase-rest";
import { loadLeaveEntries, leaveEntriesOnDate, resignationOn, type LeaveEntry } from "./leave-config";
import { notifyAdminGroup, sendZaloMessage } from "./zalo";
import { getRedis } from "./tat-archive";
import { vnDate, vnMinutesSinceMidnight } from "./time";
import { rosterSunday } from "./sunday-roster";
import { adminAlertText, awayFor, isPublished, weeklyPostText, type AwayFact, type PostLine } from "./sunday-roster-post";
import { renderRosterImage } from "./sunday-roster-image";

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
const imageUrl = (date: string, v: string) => `${BASE_URL}/api/sunday-roster/image?date=${date}&sig=${imageSig(date)}&v=${v}`;
const imageKey = (date: string, v: string) => `sunday_roster:img:${date}:${v}`;

/** Draw the picture NOW and keep it for a day, so the link answers at once.
 *  Drawing takes 6–8 s, and Zalo refused a link that slow ("photo URL is
 *  invalid") while taking instant Cartrack images. Without Redis the link still
 *  works, drawing on request. ~0.7 MB per post, a few posts a week. */
export async function preparedImageUrl(date: string, lines: SundayLine[]): Promise<string> {
  const v = String(Date.now());
  const redis = getRedis();
  if (redis) {
    const res = await renderRosterImage(date, lines.filter((l) => isPublished(l.area)));
    const png = Buffer.from(await res.arrayBuffer());
    await redis.set(imageKey(date, v), png.toString("base64"), { ex: 86_400 }).catch((e) => console.error("[sunday-roster] image cache:", e));
  }
  return imageUrl(date, v);
}

/** The picture prepared for this link, or null (expired, or never stored). */
export async function preparedImage(date: string, v: string | null): Promise<Buffer | null> {
  if (!v || !/^\d+$/.test(v)) return null;
  const b64 = await getRedis()?.get<string>(imageKey(date, v)).catch(() => null);
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

/** Friday's post: the picture, then the text (a caption is too short for it). */
export async function postWeekly(date: string): Promise<{ ok: boolean; sent: boolean; reason?: string }> {
  const g = driverGroups();
  if (!g) return { ok: false, sent: false, reason: "ZALO_ADMIN_BOT_TOKEN / ZALO_DRIVER_CHAT_ID chưa cấu hình" };
  const lines = await loadSundayLines(date);
  if (!lines.length) {
    await notifyAdminGroup(`⚠️ Chưa lưu Lịch CN ${dm(date)} — bài đăng thứ Sáu cho tài xế chưa được gửi. Lưu Lịch Chủ nhật rồi đăng lại.`);
    return { ok: false, sent: true, reason: "no roster saved" };
  }
  const url = await preparedImageUrl(date, lines), text = weeklyPostText(date, lines);
  // Per group, picture first then text, so each group reads them in order.
  const results = await Promise.all(g.chats.map(async (c) => {
    const photo = await sendZaloPhoto(g.token, c, url);
    return { c, photo, text: await sendZaloMessage(g.token, c, text) };
  }));
  const failed = results.filter((r) => !r.photo || !r.text);
  return failed.length
    ? { ok: false, sent: results.some((r) => r.photo || r.text), reason: failed.map((r) => `${r.c}: photo=${r.photo} text=${r.text}`).join("; ") }
    : { ok: true, sent: true };
}

/** Saturday evening: tell the admins what is still open. */
async function alertAdmins(date: string): Promise<void> {
  const text = adminAlertText(date, await loadSundayLines(date));
  if (text) await notifyAdminGroup(text);
}

/** Called on every assign-cron ping. Free outside its two windows; inside, one
 *  Redis SET NX per ping until the week's post is done. A failed send releases
 *  the key so the next ping (3 minutes on) tries again. */
export async function maybeSundayRosterPost(now = new Date()): Promise<void> {
  const day = new Date(`${vnDate(now)}T00:00:00Z`).getUTCDay(); // 5 = Friday, 6 = Saturday
  const minute = vnMinutesSinceMidnight(now);
  const job = day === 5 && minute >= 17 * 60 && minute < 18 * 60 ? "post"
    : day === 6 && minute >= 18 * 60 && minute < 19 * 60 ? "alert" : null;
  if (!job) return;
  const redis = getRedis();
  if (!redis) return;
  const date = rosterSunday(vnDate(now));
  const key = `sunday_roster:${job}:${date}`;
  if (await redis.set(key, Date.now(), { nx: true, ex: 3 * 86_400 }) !== "OK") return;
  try {
    if (job === "post") {
      const res = await postWeekly(date);
      console.log(`[sunday-roster] weekly post ${date}:`, JSON.stringify(res));
      // Retry only when NOTHING went out: a half-sent post retried would post the
      // picture twice, and "no roster saved" has already alerted the admins.
      if (!res.sent) await redis.del(key);
    } else {
      await alertAdmins(date);
    }
  } catch (e) {
    console.error(`[sunday-roster] ${job} ${date}:`, e);
    await redis.del(key).catch(() => {});
  }
}
