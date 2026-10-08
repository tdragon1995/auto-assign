import serverChromium from "@sparticuz/chromium";
import { chromium } from "playwright-core";
import { authenticator } from "otplib";
import { runMisaSync } from "../../../misa-fetcher/lib/run.mjs";

export async function runNativeMisa(month:string) {
  return runMisaSync({month,chromium,writeDump:false,statePath:"/tmp/misa-session.json",
    launchOptions:{args:serverChromium.args,executablePath:await serverChromium.executablePath()},
    creds:{username:process.env.MISA_USERNAME,password:process.env.MISA_PASSWORD,totpSecret:process.env.MISA_TOTP_SECRET,
      generateTotp:()=>authenticator.generate(process.env.MISA_TOTP_SECRET!)}});
}
