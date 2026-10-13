import serverChromium from "@sparticuz/chromium";
import { chromium } from "playwright-core";
import { authenticator } from "otplib";
import { runMisaSync } from "../../../misa-fetcher/lib/run.mjs";

const run = async (month: string) => runMisaSync({month,chromium,writeDump:false,statePath:"/tmp/misa-session.json",
  launchOptions:{args:serverChromium.args,executablePath:await serverChromium.executablePath()},
  creds:{username:process.env.MISA_USERNAME,password:process.env.MISA_PASSWORD,totpSecret:process.env.MISA_TOTP_SECRET,
    generateTotp:()=>authenticator.generate(process.env.MISA_TOTP_SECRET!)}});

export async function runNativeMisa(month:string) {
  try { return await run(month); }
  catch (e) {
    // Each month is its own invocation, and the next one often lands on the same
    // warm instance seconds after the previous Chromium closed — before it has let
    // go of its resources, so the first page load fails (2026-10-13). That failure
    // comes before anything is read or written, so waiting and retrying is safe.
    if (!/ERR_INSUFFICIENT_RESOURCES/.test(e instanceof Error ? e.message : String(e))) throw e;
    console.warn("[misa] Chromium out of resources on start — retrying in 20s");
    await new Promise((r) => setTimeout(r, 20_000));
    return run(month);
  }
}
