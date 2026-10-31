/** This deployment's own production address. Calls back into "our own site" (the
 *  morning sync's self-continuation, links in alerts and Zalo posts) must use it
 *  rather than a fixed host: with two Vercel accounts, the one doing the work may
 *  be the only one up — on 2026-10-31 account A was paused and every hard-coded
 *  diag-logistics call from B failed. Set by Vercel, never by a caller, so it is
 *  safe to send CRON_SECRET to. */
export const SELF_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : "https://diag-logistics.vercel.app";
