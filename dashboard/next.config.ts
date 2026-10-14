import type { NextConfig } from "next";
import path from "node:path";
const nextConfig:NextConfig={
  outputFileTracingRoot:path.resolve(process.cwd(),".."),
  serverExternalPackages:["@sparticuz/chromium-min","playwright-core","otplib"],
  // The admin dashboard runs on account B so its polling spends B's CPU allowance,
  // not A's. Only "/" moves; drivers and branches stay on A. Served by Vercel's
  // router, no function runs. 307 so browsers don't cache it — delete to undo.
  async redirects(){
    return [{source:"/", has:[{type:"host" as const,value:"diag-logistics.vercel.app"}], destination:"https://diag-bo.vercel.app/", permanent:false}];
  },
  outputFileTracingIncludes:{"/api/morning-sync":["./node_modules/playwright-core/browsers.json"],"/api/misa-sync/**/*":["./node_modules/playwright-core/browsers.json"],"/api/misa-sync":["./node_modules/playwright-core/browsers.json"]},
};
export default nextConfig;
