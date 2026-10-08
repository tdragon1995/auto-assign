import { NextRequest, NextResponse } from "next/server";
import { dispatchMisaSync } from "@/lib/misa-sync";
export const runtime="nodejs";
export const preferredRegion="sin1";
export const maxDuration=300;
/** cron-job.org 05:00 VN: Cartrack → Labcenter → MISA → Supabase → cached configuration. */
export async function GET(req:NextRequest) {
  if(!process.env.CRON_SECRET||req.headers.get("authorization")!==`Bearer ${process.env.CRON_SECRET}`)
    return NextResponse.json({error:"unauthorized"},{status:401});
  const result=await dispatchMisaSync(null,true);
  const body=await result.json();
  return NextResponse.json(body,{status:body.status==="disabled"?503:result.status});
}
