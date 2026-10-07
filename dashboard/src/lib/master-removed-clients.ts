import { BASE_URL, getHeaders } from "./cartrack";
import { sbRpc, sbSelectAll } from "./supabase-rest";
import { fetchSheetRows, SHEET_GID, SHEET_CONTRACT } from "./sheets";
import { loadTplEntries } from "./psc-config";
import { PSC_ROUTES } from "./psc-routes-data";
import { UUID } from "./master-reconcile";

export type RemovedClient = {customer_id:string;customer_name:string;cartrack_missing_at:string};
export const removedCartrackClients=()=>sbSelectAll<RemovedClient>("master_clients","select=customer_id,customer_name,cartrack_missing_at&cartrack_missing_at=not.is.null","customer_id.asc");
export async function removedClientReferences(id:string) {
  if(!UUID.test(id)) throw new Error("Mã địa điểm không hợp lệ");
  const [references,sunday,tpl]=await Promise.all([
    sbRpc<Record<string,number>>("master_client_references",{p_id:id}),
    fetchSheetRows(SHEET_GID.sunday,SHEET_CONTRACT.sunday),
    loadTplEntries(),
  ]);
  const contains=(value:unknown):boolean=>JSON.stringify(value).includes(id);
  const sundayCount=sunday.filter(contains).length,tplCount=tpl.filter(contains).length,pscCount=PSC_ROUTES.filter(contains).length;
  if(sundayCount) references["Sunday (Google Sheet)"]=sundayCount;
  if(tplCount) references["3PL (Supabase)"]=tplCount;
  if(pscCount) references["PSC routes"]=pscCount;
  return references;
}
export async function dropRemovedCartrackClient(id:string,missingAt:string) {
  if(!UUID.test(id)||!missingAt||!Number.isFinite(Date.parse(missingAt))) throw new Error("Địa điểm hoặc phiên bản không hợp lệ");
  const response=await fetch(`${BASE_URL}/customers/${id}`,{headers:getHeaders(),cache:"no-store"});
  const body=response.status===422 ? await response.json().catch(()=>null) : null;
  const missing=response.status===404||response.status===410||(response.status===422&&body?.error?.code===422&&body?.error?.data?.customer_id?.includes("The selected customer_id is invalid."));
  if(!missing) throw new Error(response.ok ? "Địa điểm còn tồn tại trên Cartrack; đồng bộ lại trước khi xoá" : `Không xác minh được Cartrack (HTTP ${response.status}); chưa xoá`);
  const references=await removedClientReferences(id);
  if(Object.keys(references).length) throw new Error(`Không thể xoá: còn tham chiếu ${JSON.stringify(references)}`);
  await sbRpc("master_drop_removed_client",{p_id:id,expected_missing_at:missingAt});
}
