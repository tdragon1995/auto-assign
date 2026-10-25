import { NextRequest, NextResponse, after } from "next/server";
import { runMisaSyncStep } from "@/lib/misa-sync";
export const runtime="nodejs";
export const preferredRegion="sin1";
export const maxDuration=300;
export async function POST(req:NextRequest) {
  if(!process.env.CRON_SECRET||req.headers.get("authorization")!==`Bearer ${process.env.CRON_SECRET}`)
    return NextResponse.json({error:"unauthorized"},{status:401});
  const id=Number(req.nextUrl.searchParams.get("run"));
  if(!Number.isSafeInteger(id)||id<=0)return NextResponse.json({error:"Invalid run"},{status:400});
  // A call without hop (a deploy mid-run) is treated as at the cap: the cron ping resumes it.
  const hop=Number(req.nextUrl.searchParams.get("hop")??NaN);
  after(()=>runMisaSyncStep(id,Number.isSafeInteger(hop)&&hop>0?hop:undefined));return NextResponse.json({accepted:true},{status:202});
}
