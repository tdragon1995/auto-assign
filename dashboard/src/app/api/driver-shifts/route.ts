import { NextRequest, NextResponse } from "next/server";
import { dailyDriverShifts,shiftDrivers,shiftPatterns,saveDriverShift } from "@/lib/driver-shifts";
import { cartrackHistoryCutoff,vnDate } from "@/lib/time";
import { invalidateShiftCache } from "@/lib/shift-window";
import { invalidateConfigCache } from "@/lib/config";
export const runtime="nodejs";
export const preferredRegion="sin1";
export async function GET(req:NextRequest){
 try{const pattern=req.nextUrl.searchParams.get("mode")==="patterns",date=req.nextUrl.searchParams.get("date")||vnDate();
  const [rows,drivers]=await Promise.all([pattern?shiftPatterns():dailyDriverShifts(date),shiftDrivers()]);
  return NextResponse.json({rows,drivers,date,cutoff:cartrackHistoryCutoff()});
 }catch(e){return NextResponse.json({error:e instanceof Error?e.message:String(e)},{status:400});}
}
export async function POST(req:NextRequest){
 try{const body=await req.json();const row=await saveDriverShift(body.data,body.mode==="patterns");
  await Promise.all([invalidateShiftCache(),invalidateConfigCache()]);return NextResponse.json({ok:true,row});
 }catch(e){return NextResponse.json({error:e instanceof Error?e.message:String(e)},{status:400});}
}
