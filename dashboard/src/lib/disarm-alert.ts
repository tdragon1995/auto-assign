import { vnTimestamp } from "./time";
import { getLastDisarm, claimDisarmAlert, clearDisarmAlert } from "./smart-log-kv";

const DASHBOARD_URL = "https://diag-logistics.vercel.app";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Email an alert that someone manually turned the engine OFF during the auto-arm
 * window. The caller (cron via autoArmIfDue) already gated the window and the
 * "fresh bare manual disarm" condition, and has already auto-re-armed the engine.
 *
 * Debounced via a Redis claim flag that is cleared on every (re)arm — so the
 * self-heal that follows a disarm lets the *next* disarm alert again, giving
 * exactly one email per manual disarm.
 */
export async function maybeAlertDisarmed(): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return; // transport not configured — nothing to send

  // Only the ping that wins the claim sends (others within the episode no-op).
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
  const who = rec?.by?.trim() ? escapeHtml(rec.by.trim()) : "không rõ";
  const offSince = rec?.ts ? vnTimestamp(new Date(rec.ts)) : "không rõ";
  const detectedAt = vnTimestamp();

  const subject = "⚠️ Có người TẮT Fleet Auto-Assign trong giờ làm việc";
  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.5;color:#111">
      <h2 style="color:#b91c1c;margin:0 0 8px">⚠️ Có người vừa TẮT hệ thống tự động gán</h2>
      <p>Auto-assign vừa bị <b>TẮT thủ công</b> trong giờ làm việc (05:30–22:00). Hệ thống đã được <b>tự động bật lại</b>, nhưng nên kiểm tra vì sao bị tắt — khi tắt, các chuyến (kể cả <b>chuyến về PSC</b>) không được tạo/gán tự động.</p>
      <table style="border-collapse:collapse;margin:8px 0">
        <tr><td style="padding:3px 10px 3px 0;color:#666">Người tắt</td><td style="padding:3px 0"><b>${who}</b></td></tr>
        <tr><td style="padding:3px 10px 3px 0;color:#666">Tắt lúc</td><td style="padding:3px 0">${offSince}</td></tr>
        <tr><td style="padding:3px 10px 3px 0;color:#666">Phát hiện lúc</td><td style="padding:3px 0">${detectedAt}</td></tr>
      </table>
      <p style="margin-top:12px">👉 <a href="${DASHBOARD_URL}" style="color:#2563eb">Mở dashboard</a> để kiểm tra trạng thái.</p>
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
