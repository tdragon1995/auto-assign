/** Local MISA runner; production uses the Vercel worker triggered by cron-job.org. */
process.env.TZ="Asia/Ho_Chi_Minh";
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright";
import {authenticator} from "otplib";
import {runMisaSync} from "./lib/run.mjs";
const here=path.dirname(fileURLToPath(import.meta.url)),statePath=path.join(here,".state","misa-state.json");
const options={chromium,creds:{username:process.env.MISA_USERNAME,password:process.env.MISA_PASSWORD,totpSecret:process.env.MISA_TOTP_SECRET,generateTotp:()=>authenticator.generate(process.env.MISA_TOTP_SECRET)},flags:process.argv.slice(2),statePath,outDir:path.join(here,"out")};
try {await runMisaSync(options);} catch(error) {console.error(`[run] first attempt failed: ${error.message}; retrying with fresh session`);fs.rmSync(statePath,{force:true});await runMisaSync(options);}
