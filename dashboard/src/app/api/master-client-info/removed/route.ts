import { NextRequest,NextResponse } from "next/server";
import { dropRemovedCartrackClient,removedCartrackClients,removedClientReferences } from "@/lib/master-removed-clients";
import { invalidateConfigCache } from "@/lib/config";
export const runtime="nodejs";
export const preferredRegion="sin1";
export async function GET(req:NextRequest) {
  try {
    const id=req.nextUrl.searchParams.get("id");
    return NextResponse.json(id ? {references:await removedClientReferences(id)} : {rows:await removedCartrackClients()});
  } catch(e) {return NextResponse.json({error:String(e)},{status:502});}
}
export async function DELETE(req:NextRequest) {
  try {
    const body=await req.json();
    if(body.confirmed!==true||typeof body.id!=="string"||typeof body.missingAt!=="string") return NextResponse.json({error:"Cần xác nhận địa điểm muốn xoá"},{status:400});
    await dropRemovedCartrackClient(body.id,body.missingAt);
    await invalidateConfigCache();
    return NextResponse.json({ok:true});
  } catch(e) {return NextResponse.json({error:String(e)},{status:409});}
}
