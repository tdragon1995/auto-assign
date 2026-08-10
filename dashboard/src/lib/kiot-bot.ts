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

  // A bare date counts only when the message carries no other *words*. Punctuation,
  // emoji and whitespace are fine ("29/07/2026?"), but leftover letters mean it's a
  // sentence that merely contains a date — "giao lúc 14/07 nhé" — and the bot stays
  // out of it.
  //
  // A leading @mention is stripped first: addressing the bot in a group prepends its
  // display name, whose letters would otherwise disqualify an otherwise-bare date.
  // Only a LEADING mention and only up to the first digit is removed, so a mention
  // buried in real conversation ("@an hẹn 14/07 nhé") still keeps its words and is
  // still ignored.
  const mentionless = t.replace(/^@[^\d]*/, "").trim();
  const onlyDate = extractDate(mentionless, today);
  if (onlyDate) {
    const withoutDate = mentionless
      .replace(/\b\d{4}-\d{2}-\d{2}\b/, " ")
      .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{4})?\b/, " ");
    if (!/[a-z]/.test(withoutDate)) return { kind: "stats", date: onlyDate };
  }

  return { kind: "ignore" };
}

/** Messages are sent with this parse_mode; sendZaloMessage falls back to plain text
 *  if Zalo ever rejects it, so formatting can never cost us the report itself. */
export const PARSE_MODE = "markdown" as const;

/** Shared body for both the on-demand reply and the scheduled push.
 *
 *  Bold carries the headline and the two numbers someone actually scans for; the
 *  average stays plain so the emphasis still means something. Nothing interpolated
 *  here can contain markdown control characters — the values are formatted numbers
 *  and a date — so there is no user input to escape. */
function statsLines(
  headline: string,
  stats: { orders: number; revenue: number },
  delta: string | null
): string {
  const lines = [
    `📊 **${headline}**`,
    `🧾 Số đơn: **${stats.orders.toLocaleString("vi-VN")}**`,
    `💰 Doanh thu: **${formatVnd(stats.revenue)}**`,
  ];
  if (stats.orders > 0) {
    lines.push(`📈 Trung bình/đơn: ${formatVnd(Math.round(stats.revenue / stats.orders))}`);
  }
  if (delta) lines.push(delta);
  return lines.join("\n");
}

/** The day-over-day revenue line.
 *
 *  Colour is carried by Zalo's {green}/{red} markdown tags, but the arrow and the
 *  explicit +/- sign carry it too: colour alone is invisible to a colour-blind
 *  reader and disappears entirely if the tags ever stop rendering, and a delta
 *  whose direction is ambiguous is worse than no delta at all. */
function deltaLine(current: number, previous: number, label: string): string | null {
  if (previous <= 0) {
    // No baseline: a percentage against zero is either infinity or meaningless.
    return current > 0 ? `📊 So với ${label}: — (${label} chưa có doanh thu)` : null;
  }

  const pct = ((current - previous) / previous) * 100;
  if (Math.abs(pct) < 0.05) return `➖ So với ${label}: không đổi`;

  // Against a very small baseline a percentage explodes into noise — "+29.457,1%"
  // is accurate and unreadable. Past 10x, a multiplier is the honest summary.
  const magnitude =
    pct >= 1000
      ? `gấp ${(current / previous).toLocaleString("vi-VN", { maximumFractionDigits: 0 })} lần`
      : `${pct > 0 ? "+" : "-"}${Math.abs(pct).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`;

  return pct > 0
    ? `📈 So với ${label}: {green}▲ ${magnitude}{/green}`
    : `📉 So với ${label}: {red}▼ ${magnitude}{/red}`;
}

const VN_WEEKDAYS = [
  "Chủ Nhật",
  "Thứ Hai",
  "Thứ Ba",
  "Thứ Tư",
  "Thứ Năm",
  "Thứ Sáu",
  "Thứ Bảy",
] as const;

/** Day of week for a VN date string, 0 = Sunday. Parsed as UTC midnight so the
 *  host machine's timezone can't shift it onto the wrong day. */
function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** The previous *trading* day. The pharmacy is closed Sunday, so Monday compares
 *  back to Saturday — comparing against a closed Sunday means a zero baseline, and
 *  deltaLine would suppress the line entirely every Monday. */
function previousBusinessDay(date: string): string {
  const prev = addDays(date, -1);
  return dayOfWeek(prev) === 0 ? addDays(prev, -1) : prev;
}

/** Current VN wall clock as "HH:MM". */
function vnClock(): string {
  const { hours, minutes } = vnHoursMinutes();
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Build a report for `date`, compared against the day before.
 *
 *  When the date is today the comparison is capped at the current clock time on BOTH
 *  days. Otherwise a query at 09:00 would hold a few hours of trading up against
 *  yesterday's finished total and report a ~-97% crash every morning. */
async function buildReport(date: string, headline: string): Promise<string> {
  const isToday = date === vnDate();
  const untilClock = isToday ? vnClock() : undefined;
  const prevDate = previousBusinessDay(date);

  const [stats, prev] = await Promise.all([
    getSalesStats(date, untilClock),
    getSalesStats(prevDate, untilClock),
  ]);

  // Name the day explicitly whenever it isn't literally yesterday, so a Monday
  // report reads "so với cùng giờ Thứ Bảy 01/08" and nobody has to guess what the
  // percentage is measured against.
  const base =
    prevDate === addDays(date, -1)
      ? "hôm qua"
      : `${VN_WEEKDAYS[dayOfWeek(prevDate)]} ${formatVnDate(prevDate).slice(0, 5)}`;
  const label = isToday ? `cùng giờ ${base}` : base;

  return statsLines(headline, stats, deltaLine(stats.revenue, prev.revenue, label));
}

/** The scheduled afternoon push. Explicitly stamped "tính đến HH:MM" because the
 *  trading day is still open at 16:00 — an unqualified "Doanh thu hôm nay" would
 *  be read as the day's final total and make every afternoon look like a bad one. */
export async function buildDailyPushReply(): Promise<string> {
  const today = vnDate();
  return buildReport(today, `Doanh thu ${formatVnDate(today)} (tính đến ${vnClock()})`);
}

/** The message body for a stats request. */
export async function buildStatsReply(date: string): Promise<string> {
  const label = date === vnDate() ? "hôm nay" : formatVnDate(date);
  return buildReport(date, `Doanh thu ${label}`);
}
