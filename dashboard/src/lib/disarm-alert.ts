import { vnTimestamp } from "./time";
import { getArmHold, claimDisarmAlert, clearDisarmAlert } from "./smart-log-kv";

const DASHBOARD_URL = "https://diag-logistics.vercel.app";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// One reminder a day while the engine sits off. The off itself is deliberate —
// nothing self-heals it any more — so this is a standing reminder, not an alarm
// about a single event. Cleared on arm, so turning it back on ends the reminders.
const HELD_ALERT_TTL_SEC = 24 * 60 * 60;

/**
 * Email a reminder that the engine is switched OFF during the auto-arm window
 * and will stay off until someone turns it back on. The caller (cron) has
 * already established that a manual hold is in force inside business hours.
 *
 * Debounced via a Redis claim flag cleared on every arm — one email per day for
 * as long as the engine is left off, and none once it is armed again.
 */
export async function maybeAlertHeldOff(): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return; // transport not configured — nothing to send

  // Only the ping that wins the claim sends (others within the day no-op).
  if (!(await claimDisarmAlert(HELD_ALERT_TTL_SEC))) return;

  try {
    await sendHeldOffEmail(apiKey);
  } catch (e) {
    console.error("[disarm-alert] send failed:", e);
    // Release the claim so the next ping can retry instead of silently swallowing.
    await clearDisarmAlert().catch(() => {});
  }
}

async function sendHeldOffEmail(apiKey: string): Promise<void> {
  const to = process.env.ALERT_EMAIL_TO || "long.nguyen@diag.vn";
  const from = process.env.ALERT_EMAIL_FROM || "Fleet Auto-Assign <onboarding@resend.dev>";

  const hold = await getArmHold();
  const who = hold?.by?.trim() ? escapeHtml(hold.by.trim()) : "không rõ";
  const offSince = hold?.ts ? vnTimestamp(new Date(hold.ts)) : "không rõ";
  const detectedAt = vnTimestamp();

  const subject = "⚠️ Fleet Auto-Assign đang TẮT trong giờ làm việc";
  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.5;color:#111">
      <h2 style="color:#b91c1c;margin:0 0 8px">⚠️ Hệ thống tự động gán đang TẮT</h2>
      <p>Auto-assign đã bị <b>TẮT thủ công</b> và <b>sẽ vẫn TẮT cho tới khi có người bật lại</b> trên dashboard — hệ thống không tự bật lại nữa. Khi tắt, các chuyến (kể cả <b>chuyến về PSC</b>) không được tạo/gán tự động.</p>
      <table style="border-collapse:collapse;margin:8px 0">
        <tr><td style="padding:3px 10px 3px 0;color:#666">Người tắt</td><td style="padding:3px 0"><b>${who}</b></td></tr>
        <tr><td style="padding:3px 10px 3px 0;color:#666">Tắt lúc</td><td style="padding:3px 0">${offSince}</td></tr>
        <tr><td style="padding:3px 10px 3px 0;color:#666">Kiểm tra lúc</td><td style="padding:3px 0">${detectedAt}</td></tr>
      </table>
      <p style="margin-top:12px">👉 <a href="${DASHBOARD_URL}" style="color:#2563eb">Mở dashboard</a> để bật lại khi cần.</p>
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
