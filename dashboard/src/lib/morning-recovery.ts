import { getRedis, LOCK_TTL_S, TAT_LOOKBACK_DAYS } from "./tat-archive";
import { getLastRun, saveLastRun } from "./schedule-job-kv";
import { runScheduleJobCycle } from "./schedule-job";
import { getArmState } from "./smart-log-kv";
import { sendResendEmail } from "./disarm-alert";
import { addDays, vnDate, vnMinutesSinceMidnight } from "./time";

let checkedOn: string | null = null;

/** Piggyback the existing cron. Finished work costs no further Cartrack reads.
 * Completion markers, not a catch/finally, reveal a process killed mid-run. */
export async function recoverMorning(now = new Date()): Promise<void> {
  const minute = vnMinutesSinceMidnight(now);
  if (minute < 5 * 60 || minute >= 22 * 60) return;
  const redis = getRedis();
  if (!redis) { console.error("[morning-recovery] Redis unavailable"); return; }
  const date = vnDate(now);
  if (checkedOn === date) return;

  if (minute < 6 * 60) {
    // Do not report missing new markers on a deployment made after the window.
    await redis.set(`morning:watch:${date}`, "1", { nx: true, ex: 172_800 });
    if (minute < 5 * 60 + 5) return; // allow the 05:00 invocation to finish
    const previous = await getLastRun();
    if (previous?.date === date && !previous.results.some((r) => r.status === "ERROR" && !r.job_id)) return;
    const key = `schedule_job:retry:prod:${date}`;
    if (await redis.set(key, "1", { nx: true, ex: LOCK_TTL_S }) !== "OK") return;
    try {
      const result = await runScheduleJobCycle("prod");
      // A created job with a failed park must remain visible as an error. A
      // subsequent existence hit does not prove that parking was repaired.
      const parkErrors = new Map((previous?.date === date ? previous.results : [])
        .filter((r) => r.status === "ERROR" && r.job_id).map((r) => [r.job_id, r]));
      result.results = result.results.map((r) => r.status === "SKIPPED" && parkErrors.has(r.job_id)
        ? { ...r, status: "ERROR", message: parkErrors.get(r.job_id)!.message } : r);
      await saveLastRun({ ...result, ts: new Date().toISOString(), trigger: "retry" });
      console.log(`[morning-recovery] scheduled rows=${result.results.length} errors=${result.results.filter((r) => r.status === "ERROR").length}`);
    } finally {
      await redis.del(key);
    }
    return;
  }

  if (minute < 6 * 60 + 5 || !await redis.get(`morning:watch:${date}`)) return;
  const auditKey = `morning:checked:${date}`;
  if (await redis.set(auditKey, "1", { nx: true, ex: LOCK_TTL_S }) !== "OK") {
    if (await redis.get(auditKey) === "done") checkedOn = date;
    return;
  }
  try {
    const days = Array.from({ length: TAT_LOOKBACK_DAYS }, (_, i) => addDays(date, -i - 1));
    const [schedule, arm, archiveTtls, rolloverTtl, cleaned] = await Promise.all([
      getLastRun(), getArmState(),
      Promise.all(days.map((d) => redis.ttl(`tat:sealed:prod:${d}`))),
      redis.ttl(`assign:rollover_morning:prod:${date}`),
      redis.get(`cleanup:rollover:complete:prod:${date}`),
    ]);
    let failures: string[] = [];
    if (schedule?.date !== date) failures.push("Fixed-schedule job run has no completed result (missed run or timeout).");
    else {
      const errors = schedule.results.filter((r) => r.status === "ERROR").length;
      if (errors) failures.push(`Fixed-schedule jobs: ${errors} rows still failed.`);
    }
    for (let i = 0; i < days.length; i++) {
      // A 90-second claim is in progress, not a completed seven-day seal.
      if (archiveTtls[i] <= LOCK_TTL_S) failures.push(`Archive ${days[i]}: TAT, Payroll and pickup ETA are not all confirmed complete.`);
    }
    if (arm?.env === "prod") {
      if (rolloverTtl <= LOCK_TTL_S) failures.push("Morning rollover is not confirmed complete.");
      if (process.env.CLEANUP_STALE_TRIPS === "1" && !cleaned) failures.push("Yesterday's cleanup is not confirmed complete.");
    }
    // Keep the same payload on a delivery retry, including when the first send
    // was accepted just before the invocation died. Resend deduplicates by key.
    const emailKey = `morning:failure:${date}`;
    const pendingEmail = await redis.get<string[]>(emailKey);
    if (pendingEmail) failures = pendingEmail;
    else if (failures.length) await redis.set(emailKey, failures, { ex: 172_800 });
    if (failures.length) {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) throw new Error("RESEND_API_KEY missing; morning failure email cannot be sent");
      await sendResendEmail(apiKey, {
        to: process.env.ALERT_EMAIL_TO || "long.nguyen@diag.vn",
        from: process.env.ALERT_EMAIL_FROM || "Fleet Auto-Assign <onboarding@resend.dev>",
        subject: `⚠️ Fleet morning work incomplete — ${date}`,
        html: `<p>Morning work was incomplete after the consecutive retry window (checked after 06:05 Vietnam time).</p><ul>${failures.map((f) => `<li>${f}</li>`).join("")}</ul><p>Completed archive outputs are retained. Check the logs and retry unfinished work at <a href="https://diag-logistics.vercel.app">the dashboard</a>.</p>`,
      }, `morning-failure-${date}`);
      console.log(`[morning-recovery] failure email sent; incomplete checks=${failures.length}`);
    }
    await redis.set(auditKey, "done", { ex: 172_800 });
    checkedOn = date;
  } catch (e) {
    await redis.del(auditKey).catch(() => {}); // retry delivery on a later ping
    throw e;
  }
}
