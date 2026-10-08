import { NextRequest, NextResponse } from "next/server";
import { dailyDriverShifts,shiftDrivers,shiftPatterns,visiblePtPatterns,saveDriverShift, type ShiftPattern } from "@/lib/driver-shifts";
import { cartrackHistoryCutoff,vnDate } from "@/lib/time";
import { invalidateShiftCache } from "@/lib/shift-window";
import { invalidateConfigCache } from "@/lib/config";
import { masterRules } from "@/lib/master-store";
export const runtime="nodejs";
export const preferredRegion="sin1";
export async function GET(req:NextRequest){
 try{const pattern=req.nextUrl.searchParams.get("mode")==="patterns",date=req.nextUrl.searchParams.get("date")||vnDate();
  const [rows,drivers,rules]=await Promise.all([pattern?shiftPatterns():dailyDriverShifts(date),shiftDrivers(),
   pattern?Promise.all([masterRules("weekday",{resolveNames:false}),masterRules("sunday",{resolveNames:false})]):Promise.resolve([])]);
  const configuredDriverIds=[...new Set(rules.flat().filter(r=>r.pickup_customer_id&&!r.review_issues.length).flatMap(r=>r.driver_ids))];
  return NextResponse.json({rows:pattern?visiblePtPatterns(rows as ShiftPattern[],drivers):rows,drivers,configuredDriverIds,date,cutoff:cartrackHistoryCutoff()});
 }catch(e){return NextResponse.json({error:e instanceof Error?e.message:String(e)},{status:400});}
}
export async function POST(req:NextRequest){
 try{const body=await req.json();const row=await saveDriverShift(body.data,body.mode==="patterns");
  await Promise.all([invalidateShiftCache(),invalidateConfigCache()]);return NextResponse.json({ok:true,row});
 }catch(e){return NextResponse.json({error:e instanceof Error?e.message:String(e)},{status:400});}
}
