import serverChromium from "@sparticuz/chromium";
import { chromium } from "playwright-core";
import { authenticator } from "otplib";
import { runMisaSync } from "../../../misa-fetcher/lib/run.mjs";

const run = async (months: string[]) => runMisaSync({month:months[0],flags:[`--months=${months.length}`],chromium,
  writeDump:false,statePath:"/tmp/misa-session.json",
  launchOptions:{args:serverChromium.args,executablePath:await serverChromium.executablePath()},
  creds:{username:process.env.MISA_USERNAME,password:process.env.MISA_PASSWORD,totpSecret:process.env.MISA_TOTP_SECRET,
    generateTotp:()=>authenticator.generate(process.env.MISA_TOTP_SECRET!)}});

/** Every month in ONE browser. One launch per month, each its own invocation, kept
 * landing on the same warm instance seconds after the previous Chromium closed, and
 * the third one could not load its first page (net::ERR_INSUFFICIENT_RESOURCES,
 * 2026-10-13). The retry stays as a safety net for a warm instance an earlier sync
 * left short: the failure comes before anything is read or written. */
export async function runNativeMisa(months:string[]) {
  try { return await run(months); }
  catch (e) {
    if (!/ERR_INSUFFICIENT_RESOURCES/.test(e instanceof Error ? e.message : String(e))) throw e;
    console.warn("[misa] Chromium out of resources on start — retrying in 20s");
    await new Promise((r) => setTimeout(r, 20_000));
    return run(months);
  }
}
