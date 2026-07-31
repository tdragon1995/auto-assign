import { getSalesStats, formatVnd, formatVnDate } from "./kiotviet";
import { vnDate, addDays, vnHoursMinutes } from "./time";

// ── Shared config readers ────────────────────────────────────────────────────

/** First non-blank env value. `??` is wrong here — the env template ships these
 *  keys present-but-empty, and "" is not nullish, so it would win the fallback. */
export function envOr(...names: string[]): string {
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (v) return v;
  }
  return "";
}

/** Same bot as the leave notifications unless split onto its own identity. */
export function botToken(): string {
  return envOr("ZALO_KIOT_BOT_TOKEN", "ZALO_ADMIN_BOT_TOKEN");
}

/** Chats allowed to see revenue — both the on-demand replies and the daily push.
 *
 *  The admin group is inherited ONLY when the admin bot is also inherited. Once the
 *  revenue bot has its own identity it is a different account, quite possibly not a
 *  member of the admin group, so silently targeting that group would be wrong. With
 *  no allowlist the webhook replies with the chat's own id, which is how you collect
 *  the right ids for the new bot's groups. */
export function allowedChats(): string[] {
  const explicit = envOr("ZALO_KIOT_ALLOWED_CHATS");
  const source = explicit || (botHasOwnIdentity() ? "" : envOr("ZALO_ADMIN_CHAT_ID"));
  return source
    .split(",")
    .map((s) => normalizeChatId(s))
    .filter(Boolean);
}

/** Chat ids get pasted through dashboards and chat apps, which is where an exact
 *  string compare goes wrong: a value saved as "zgr-abc" (with quotes) or with a
 *  stray zero-width character silently never matches, and the only symptom is a
 *  permanently refused group. Strip the decoration before comparing. */
export function normalizeChatId(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "") // quotes pasted along with the value
    .replace(/[^ -~]/g, "") // zero-width/BOM/NBSP from copy-paste
    .trim()
    .toLowerCase();
}

/** Whether a chat may see revenue. Empty allowlist = nothing allowed (fail closed). */
export function isChatAllowed(chatId: string): boolean {
  return allowedChats().includes(normalizeChatId(chatId));
}

/** True when the revenue bot runs under its own token rather than the admin bot's. */
export function botHasOwnIdentity(): boolean {
  return Boolean(envOr("ZALO_KIOT_BOT_TOKEN"));
}

// Command parsing + reply text for the Zalo revenue bot. Kept out of the route
// handler so the parsing rules can be exercised without standing up a request.

/** Lowercase + strip Vietnamese diacritics, so "Doanh Thu" and "doanh thu" match. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/g, "d")
    .trim();
}

export const HELP = [
  "🤖 Bot doanh thu KiotViet",
  "",
  "• doanh thu — số liệu hôm nay",
  "• hôm qua — số liệu hôm qua",
  "• 30/07 hoặc 2026-07-30 — theo ngày",
  "• id — xem chat id của nhóm này",
].join("\n");

/** Each intent is its own member so `cmd.kind` narrows at the call site. */
export type Command =
  | { kind: "stats"; date: string }
  | { kind: "help" }
  | { kind: "id" }
  | { kind: "ignore" };

/** Pull a VN date out of a message, or null. Accepts 2026-07-30, 30/07 and 30/07/2026. */
function extractDate(t: string, today: string): string | null {
  const iso = t.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (iso) return iso[0];

  const dmy = t.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}))?\b/);
  if (!dmy) return null;

  const [, d, m, y] = dmy;
  const day = Number(d);
  const month = Number(m);
  // Reject impossible dates rather than asking KiotViet about 2026-13-45.
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;

  return `${y ?? today.slice(0, 4)}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

/** Map an incoming message to the VN date it asks about, or a non-date intent.
 *
 *  Deliberately conservative: bare words like "hôm nay" only count when they are
 *  the *entire* message. In a busy group "hôm nay trời đẹp" is ordinary chatter,
 *  and a bot that answers it with a revenue report gets muted within a day.
 *  Anything unrecognised maps to "ignore" so the bot stays quiet by default. */
export function parseCommand(raw: string, today: string = vnDate()): Command {
  const hadSlash = raw.trim().startsWith("/");
  const t = normalize(raw).replace(/^\//, "").trim();

  if (!t) return { kind: "ignore" };
  if (t === "id" || t === "chatid") return { kind: "id" };
  if (t === "help" || t === "start" || t === "?") return { kind: "help" };

  const isYesterday = (s: string) => s === "hom qua" || s === "homqua" || s === "yesterday";
  const isToday = (s: string) => s === "hom nay" || s === "homnay" || s === "today" || s === "dt";

  // An explicit trigger ("/..." or the words "doanh thu") lets the rest of the
  // message be free-form: "doanh thu hôm qua", "/doanhthu 30/07" both work.
  const explicit = hadSlash || t.includes("doanh thu") || t.includes("doanhthu");
  if (explicit) {
    const date = extractDate(t, today);
    if (date) return { kind: "stats", date };
    if (t.includes("hom qua") || t.includes("homqua") || t.includes("yesterday")) {
      return { kind: "stats", date: addDays(today, -1) };
    }
    return { kind: "stats", date: today };
  }

  // No trigger word — only a message that is *nothing but* a date or a bare
  // keyword counts, so normal conversation never sets the bot off.
  if (isYesterday(t)) return { kind: "stats", date: addDays(today, -1) };
  if (isToday(t)) return { kind: "stats", date: today };

  const onlyDate = extractDate(t, today);
  if (onlyDate && /^[\d/-]+$/.test(t)) return { kind: "stats", date: onlyDate };

  return { kind: "ignore" };
}

/** The scheduled afternoon push. Explicitly stamped "tính đến HH:MM" because the
 *  trading day is still open at 16:00 — an unqualified "Doanh thu hôm nay" would
 *  be read as the day's final total and make every afternoon look like a bad one. */
export async function buildDailyPushReply(): Promise<string> {
  const today = vnDate();
  const stats = await getSalesStats(today);
  const { hours, minutes } = vnHoursMinutes();
  const clock = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;

  const lines = [
    `📊 Doanh thu ${formatVnDate(today)} (tính đến ${clock})`,
    `🧾 Số đơn: ${stats.orders.toLocaleString("vi-VN")}`,
    `💰 Doanh thu: ${formatVnd(stats.revenue)}`,
  ];
  if (stats.orders > 0) {
    lines.push(`📈 Trung bình/đơn: ${formatVnd(Math.round(stats.revenue / stats.orders))}`);
  }
  return lines.join("\n");
}

/** The message body for a stats request. */
export async function buildStatsReply(date: string): Promise<string> {
  const stats = await getSalesStats(date);
  const label = date === vnDate() ? "hôm nay" : formatVnDate(date);

  const lines = [
    `📊 Doanh thu ${label}`,
    `🧾 Số đơn: ${stats.orders.toLocaleString("vi-VN")}`,
    `💰 Doanh thu: ${formatVnd(stats.revenue)}`,
  ];
  if (stats.orders > 0) {
    lines.push(`📈 Trung bình/đơn: ${formatVnd(Math.round(stats.revenue / stats.orders))}`);
  }
  return lines.join("\n");
}
