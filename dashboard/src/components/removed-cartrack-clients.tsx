"use client";
import { useEffect,useState } from "react";
import { toast } from "sonner";
import { AlertTriangle,RefreshCw,Trash2 } from "lucide-react";
import { Button } from "./ui/button";
import type { RemovedClient } from "@/lib/master-removed-clients";

export function RemovedCartrackClients({refreshKey,onDeleted}:{refreshKey:number;onDeleted:()=>Promise<void>}) {
  const [rows,setRows]=useState<RemovedClient[]>([]);
  const [checks,setChecks]=useState<Record<string,Record<string,number>>>({});
  const [busy,setBusy]=useState("");
  const [error,setError]=useState("");
  useEffect(()=>{
    let live=true;
    fetch("/api/master-client-info/removed",{cache:"no-store"}).then(async res=>{
      const data=await res.json();if(!res.ok) throw new Error(data.error||`HTTP ${res.status}`);
      if(live){setRows(data.rows);setChecks({});setError("");}
    }).catch(e=>{if(live)setError(`Không tải được danh sách địa điểm thiếu trên Cartrack: ${String(e)}`);});
    return ()=>{live=false;};
  },[refreshKey]);
  const check=async(id:string)=>{
    setBusy(id);
    try{const res=await fetch(`/api/master-client-info/removed?id=${id}`,{cache:"no-store"});const data=await res.json();if(!res.ok)throw new Error(data.error);setChecks(old=>({...old,[id]:data.references}));}
    catch(e){toast.error(String(e));}finally{setBusy("");}
  };
  const drop=async(row:RemovedClient)=>{
    if(!window.confirm(`Xoá vĩnh viễn ${row.customer_name} khỏi Supabase?\n${row.customer_id}\nChỉ xoá nếu vẫn không có tham chiếu. Cartrack và Labcenter không bị thay đổi.`))return;
    setBusy(row.customer_id);
    try{const res=await fetch("/api/master-client-info/removed",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:row.customer_id,missingAt:row.cartrack_missing_at,confirmed:true})});const data=await res.json();if(!res.ok)throw new Error(data.error);setRows(old=>old.filter(r=>r.customer_id!==row.customer_id));toast.success("Đã xoá địa điểm không còn tham chiếu khỏi Supabase");await onDeleted();}
    catch(e){toast.error(String(e));}finally{setBusy("");}
  };
  if(error)return <p role="alert" className="text-xs text-amber-800">{error}</p>;
  if(!rows.length)return null;
  return <details className="shrink-0 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950">
    <summary className="cursor-pointer font-semibold"><AlertTriangle aria-hidden="true" className="mr-2 inline size-4" />{rows.length} địa điểm không còn trong danh sách Cartrack · Kiểm tra trước khi xoá</summary>
    <p className="mt-2 leading-5">Supabase đang giữ các địa điểm này. Chỉ cho phép xoá sau khi kiểm tra config, lịch, điểm giao, lịch sử và Google Sheet.</p>
    <ul className="mt-2 max-h-64 overflow-y-auto divide-y divide-amber-200">{rows.map(row=>{
      const refs=checks[row.customer_id],blocked=refs&&Object.keys(refs).length>0;
      return <li key={row.customer_id} className="flex flex-wrap items-center justify-between gap-3 py-2">
        <div className="min-w-0 flex-1"><p className="font-medium">{row.customer_name}</p><p className="mt-0.5 break-all text-[11px] text-amber-800">{row.customer_id}</p>{refs&&<p className="mt-1">{blocked?`Giữ lại: ${Object.entries(refs).map(([name,count])=>`${name} (${count})`).join(" · ")}`:"Không có tham chiếu; có thể yêu cầu xoá."}</p>}</div>
        <Button size="sm" variant="outline" disabled={!!busy} onClick={()=>void check(row.customer_id)}><RefreshCw className={`size-3.5 ${busy===row.customer_id?"animate-spin":""}`} />Kiểm tra</Button>
        {refs&&!blocked&&<Button size="sm" variant="outline" className="text-red-700" disabled={!!busy} onClick={()=>void drop(row)}><Trash2 className="size-3.5" />Xoá khỏi Supabase</Button>}
      </li>;
    })}</ul>
  </details>;
}
