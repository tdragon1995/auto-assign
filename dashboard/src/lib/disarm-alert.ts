import { vnMinutesSinceMidnight, vnTimestamp } from "./time";
import { getLastDisarm, claimDisarmAlert, clearDisarmAlert } from "./smart-log-kv";

// Business window: outside this, the engine being off is expected (overnight /
// auto-off at 22:00), so no alert. End is exclusive so the 22:00 auto-off itself
// never trips a false alarm. Every day — Diag runs samples Mon–Sun.
const BIZ_START_MIN = 6 * 60;   // 06:00
const BIZ_END_MIN = 22 * 60;    // 22:00 (exclusive)

const DASHBOARD_URL = "https://diag-logistics.vercel.app";

function inBusinessHours(): boolean {
  const m = vnMinutesSinceMidnight();
  return m >= BIZ_START_MIN && m < BIZ_END_MIN;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * If the engine is disarmed during business hours, email an alert once per
 * disarm episode. Called from the cron route on the disarmed path; safe to call
 * every ping (debounced via a Redis claim flag, cleared on re-arm).
 */
export async function maybeAlertDisarmed(): Promise<void> {
  if (!inBusinessHours()) return;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return; // transport not configured — nothing to send

  // One email per episode: only the ping that wins the claim sends.
  if (!(await claimDisarmAlert())) return;

  try {
    await sendDisarmEmail(apiKey);
  } catch (e) {
    console.error("[disarm-alert] send failed:", e);
    // Release the claim so the next ping can retry instead of silently swallowing.
    await clearDisarmAlert().catch(() => {});
  }
}

async function sendDisarmEmail(apiKey: string): Promise<void> {
  const to = process.env.ALERT_EMAIL_TO || "long.nguyen@diag.vn";
  const from = process.env.ALERT_EMAIL_FROM || "Fleet Auto-Assign <onboarding@resend.dev>";

  const rec = await getLastDisarm();
  const who = rec?.by?.trim() ? escapeHtml(rec.by.trim()) : "không rõ (có thể chưa bật sáng nay)";
  const reason = rec?.reason?.trim() ? ` <span style="color:#666">(${escapeHtml(rec.reason.trim())})</span>` : "";
  const offSince = rec?.ts ? vnTimestamp(new Date(rec.ts)) : "không rõ";
  const detectedAt = vnTimestamp();

  const subject = "⚠️ Fleet Auto-Assign ĐANG TẮT trong giờ làm việc";
  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.5;color:#111">
      <h2 style="color:#b91c1c;margin:0 0 8px">⚠️ Hệ thống tự động gán đang TẮT</h2>
      <p>Auto-assign hiện đang <b>TẮT</b> trong giờ làm việc. Khi tắt, các chuyến — kể cả <b>chuyến về PSC</b> — sẽ không được tạo/gán tự động cho tới khi bật lại.</p>
      <table style="border-collapse:collapse;margin:8px 0">
        <tr><td style="padding:3px 10px 3px 0;color:#666">Người tắt</td><td style="padding:3px 0"><b>${who}</b>${reason}</td></tr>
        <tr><td style="padding:3px 10px 3px 0;color:#666">Tắt lúc</td><td style="padding:3px 0">${offSince}</td></tr>
        <tr><td style="padding:3px 10px 3px 0;color:#666">Phát hiện lúc</td><td style="padding:3px 0">${detectedAt}</td></tr>
      </table>
      <p style="margin-top:12px">👉 <a href="${DASHBOARD_URL}" style="color:#2563eb">Mở dashboard và bật lại</a> nếu đây là nhầm lẫn.</p>
    </div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend ${res.status}: ${body}`);
  }
}
