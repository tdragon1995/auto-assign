import { BASE_URL, getCustomerById, getHeaders } from "./cartrack";
import { DELIVERY_BASE, getAdminToken, updateLocationAddress, updateLocationPhone, updatePickDropLocation } from "./labcenter";
import { nearestPsc, newWard, GEO_DATASET_VERSION } from "./master-geo";
import { masterClient, masterDriver, masterEnabled } from "./master-store";
import { sbPatch, sbSelect, sbUpsert } from "./supabase-rest";
import { SHEET_GID, SHEET_ID } from "./sheets";
import { getSheetsClient } from "./sheets-writer";
import { commitPickupSetup, type SetupRow } from "./pickup-setup";
import { isInactiveLocation, locationName } from "./location-status";

export async function assertSheetRenameSafe(id:string,names:string[]) {
  const sheets=getSheetsClient();
  const meta=await sheets.spreadsheets.get({spreadsheetId:SHEET_ID,fields:"sheets.properties"});
  const gids=new Set<string>([SHEET_GID.sunday,SHEET_GID.drivers,SHEET_GID.locations,
    ...(masterEnabled() ? [] : [SHEET_GID.mapping,SHEET_GID.nghi_phep])]);
  const relevant=meta.data.sheets?.filter(s=>gids.has(String(s.properties?.sheetId)) ||
    (!masterEnabled() && s.properties?.title?.startsWith("(Edit weekly) PUBLIC SUNDAY")))??[];
  if(relevant.length<gids.size) throw new Error("Không xác minh được các tab Google Sheet còn dùng tên");
  const ranges=relevant.map(s=>`'${s.properties!.title!.replace(/'/g,"''")}'`);
  const values=await sheets.spreadsheets.values.batchGet({spreadsheetId:SHEET_ID,ranges});
  if(values.data.valueRanges?.length!==ranges.length) throw new Error("Không đọc đủ tham chiếu Google Sheet");
  const oldNames=new Set(names.filter(Boolean).map(n=>n.trim()));
  for(const sheet of values.data.valueRanges??[]) for(const [index,row] of (sheet.values??[]).entries()) {
    const cells=row.map(value=>String(value??"").trim());
    const hasName=cells.some(cell=>oldNames.has(cell) || cell.split(/[,;\n]/).some(v=>oldNames.has(v.trim())));
    // Retained Sheet directories are aliases for Sunday formulas. Renaming the
    // profile does not change those aliases or the already-resolved UUIDs.
    const hasId=cells.some(cell=>cell.split(/[,;\n]/).some(v=>v.trim()===id));
    if (masterEnabled() ? hasName && !hasId : hasName || hasId)
      throw new Error(`Chưa thể đổi tên: ${sheet.range}, dòng ${index+1} còn dùng tên chưa liên kết ID trong Google Sheet`);
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} không hợp lệ`);
  return value.trim();
}

export async function editClient(id: string, patch: Record<string, unknown>) {
  if (!uuid.test(id)) throw new Error("Mã khách hàng không hợp lệ");
  const row = await masterClient(id);
  if (!row) throw new Error("Khách hàng không có trong Master Client Info");
  const token = row.labcenter_location_id ? await getAdminToken() : null;
  if (row.labcenter_location_id && !token) throw new Error("Không đăng nhập được Labcenter — chưa thay đổi Cartrack");
  const allowed = new Set(["customer_name", "address_line_1", "address_line_2", "email", "postal_code", "client_reference", "latitude", "longitude", "contact_number", "default_dropoff_id", "eta_minutes", "is_active"]);
  if (Object.keys(patch).some((k) => !allowed.has(k))) throw new Error("Trường cập nhật không hợp lệ");
  for (const [key, value] of Object.entries(patch)) {
    if (key === "is_active") {
      if (typeof value !== "boolean") throw new Error("Trạng thái không hợp lệ");
    } else if (["latitude", "longitude", "eta_minutes"].includes(key)) {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} không hợp lệ`);
    } else if (typeof value !== "string") throw new Error(`${key} không hợp lệ`);
  }
  const current = (await getCustomerById(id))?.data;
  if (!current) throw new Error("Không đọc được khách hàng từ Cartrack");
  const requestedName = patch.customer_name === undefined ? String(current.customer_name ?? "") : requiredText(patch.customer_name, "Tên");
  const active = patch.is_active === undefined ? !isInactiveLocation(current.customer_name) : patch.is_active as boolean;
  const name = patch.is_active === undefined && patch.customer_name === undefined ? requestedName : locationName(requestedName, active);
  if (!locationName(name,true)) throw new Error("Tên không hợp lệ");
  if (name !== current.customer_name) await assertSheetRenameSafe(id,[String(current.customer_name??"")]);
  const address = patch.address_line_1 === undefined ? current.address_line_1 : requiredText(patch.address_line_1, "Địa chỉ");
  const lat = patch.latitude === undefined ? Number(current.latitude) : Number(patch.latitude);
  const lon = patch.longitude === undefined ? Number(current.longitude) : Number(patch.longitude);
  const changeCartrack = ["customer_name", "address_line_1", "address_line_2", "email", "postal_code", "client_reference", "latitude", "longitude", "contact_number"].some((k) => k in patch) || name !== current.customer_name;
  if (changeCartrack && (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)) throw new Error("GPS không hợp lệ");
  const contact = patch.contact_number === undefined ? current.contact_number : requiredText(patch.contact_number, "Số điện thoại");
  const dropId = patch.default_dropoff_id === undefined ? row.default_dropoff_id : String(patch.default_dropoff_id);
  const eta = patch.eta_minutes === undefined ? row.eta_minutes : Number(patch.eta_minutes);
  const changeDropoff = patch.default_dropoff_id !== undefined || patch.eta_minutes !== undefined;
  const drop = changeDropoff && dropId && uuid.test(dropId) ? await masterClient(dropId) : null;
  if (changeDropoff) {
    if ((dropId && (!uuid.test(dropId) || !drop)) || (eta !== null && (!Number.isInteger(eta) || eta < 0 || eta > 1440))) throw new Error("Điểm giao hoặc ETA không hợp lệ");
    if (drop && isInactiveLocation(drop.cartrack.customer_name)) throw new Error("Điểm giao đã ngừng hoạt động");
    if (row.labcenter_location_id && (!drop?.labcenter_location_id || eta === null)) throw new Error("Chọn điểm giao đã liên kết Labcenter và nhập ETA");
  }
  const previousSetup = changeDropoff && row.labcenter_location_id
    ? (await sbSelect<SetupRow>("pickup_setup", `select=*&lc_location_id=eq.${row.labcenter_location_id}`))[0] ?? null : null;
  let after = current;
  if (changeCartrack) {
    const payload = {
      customer_name: name, email: current.email, contact_code: current.contact_code,
      contact_number: contact, address_line_1: address, address_line_2: current.address_line_2,
      postal_code: current.postal_code, country_id: current.country_id,
      latitude: lat, longitude: lon, client_reference: current.client_reference,
      ...Object.fromEntries(["address_line_2", "email", "postal_code", "client_reference"].filter(k => k in patch).map(k => [k, patch[k]])),
    };
    const res = await fetch(`${BASE_URL}/customers/${id}`, { method: "PUT", headers: getHeaders(), body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(`Cartrack HTTP ${res.status}: ${(await res.text()).slice(0, 180)}`);
    after = (await getCustomerById(id))?.data;
    if (!after || after.customer_name !== name || after.address_line_1 !== address ||
        Number(after.latitude) !== lat || Number(after.longitude) !== lon || String(after.contact_number ?? "") !== String(contact ?? "") ||
        ["address_line_2", "email", "postal_code", "client_reference"].some(k => k in patch && String(after[k] ?? "") !== String(patch[k] ?? ""))) {
      throw new Error("Cartrack trả 200 nhưng dữ liệu không khớp khi đọc lại");
    }
    const gpsChanged = lat !== Number(current.latitude) || lon !== Number(current.longitude);
    const psc = gpsChanged ? await nearestPsc(lat, lon) : null;
    await sbUpsert("master_clients", [{
      customer_id: id, cartrack: after,
      ...(gpsChanged ? { new_ward: newWard(lat, lon), nearest_psc_id: psc?.id ?? null,
        nearest_psc_km: psc?.km ?? null,
        geo_calculated_at:new Date().toISOString(),geo_dataset_version:GEO_DATASET_VERSION } : {}),
    }], "customer_id");
  }
  if (changeCartrack && token && row.labcenter_location_id) {
    if (patch.address_line_1 !== undefined || patch.latitude !== undefined || patch.longitude !== undefined) {
      const result = await updateLocationAddress(row.labcenter_location_id, { address, latitude: lat, longitude: lon }, token);
      if (!result.ok) throw new Error(`Cartrack đã lưu; Labcenter: ${result.error}`);
    }
    if (patch.contact_number !== undefined) {
      const result = await updateLocationPhone(row.labcenter_location_id, contact, token);
      if (!result.ok) throw new Error(`Cartrack đã lưu; Labcenter: ${result.error}`);
    }
  }
  // A retry must reconcile Labcenter even when Cartrack already has the marker.
  if(token && row.labcenter_location_id && (name!==current.customer_name || patch.is_active!==undefined)) {
    const url=`${DELIVERY_BASE}/api/locations/${row.labcenter_location_id}`;
    const headers={Authorization:`Bearer ${token}`,"Content-Type":"application/json"};
    const res=await fetch(url,{method:"PUT",headers,body:JSON.stringify({name,is_active:active})});
    if(!res.ok) throw new Error(`Cartrack/Supabase đã lưu; Labcenter trạng thái HTTP ${res.status}`);
    const check=await fetch(url,{headers,cache:"no-store"});
    if(!check.ok) throw new Error(`Không đọc lại được trạng thái Labcenter (HTTP ${check.status})`);
    const saved=(await check.json()).data;
    if(saved?.name!==name || saved?.is_active!==active) throw new Error("Labcenter nhận yêu cầu nhưng tên/trạng thái không khớp khi đọc lại");
  }
  if (changeDropoff && row.labcenter_location_id && token && dropId && drop?.labcenter_location_id) {
    const result = await updatePickDropLocation({
      pickId: id, dropId, etaMins: eta!, lcLocationId: row.labcenter_location_id,
      dropLocationId: drop.labcenter_location_id,
    }, token);
    if (!result.ok) throw new Error(result.error ?? "Labcenter không lưu điểm giao");
  }
  if (changeDropoff && row.labcenter_location_id && drop?.labcenter_location_id) {
    await commitPickupSetup({lc_location_id:row.labcenter_location_id,pick_id:id,pick_name:name,
      drop_location_id:drop.labcenter_location_id,drop_id:dropId,drop_name:String(drop.cartrack.customer_name ?? ""),eta_mins:eta!},
      "client_edit",previousSetup);
  } else if (changeDropoff) await sbPatch("master_clients", `customer_id=eq.${id}`, {
    default_dropoff_id: dropId || null, eta_minutes: eta,
  });
  return { customer_id: id };
}

export async function editDriver(id: string, patch: Record<string, unknown>) {
  if (!uuid.test(id)) throw new Error("Mã tài xế không hợp lệ");
  const row = await masterDriver(id);
  if (!row) throw new Error("Tài xế không có trong Master Client Info");
  const profileFields = ["first_name", "last_name", "email", "phone_code", "phone_number", "shift_time_start", "shift_time_end", "start_location_customer_id", "end_location_customer_id"];
  const localFields = ["driver_zalo_id", "bot_token", "phone_number_update"];
  const rosterFields = ["employee_code", "employee_full_name", "code_name"];
  if (Object.keys(patch).some((k) => !profileFields.includes(k) && !localFields.includes(k) && !rosterFields.includes(k))) throw new Error("Trường cập nhật không hợp lệ");
  const cartrackPatch = Object.fromEntries(Object.entries(patch).filter(([k]) => profileFields.includes(k)));
  const localPatch = Object.fromEntries(Object.entries(patch).filter(([k]) => localFields.includes(k)));
  const rosterPatch = Object.fromEntries(Object.entries(patch).filter(([k]) => rosterFields.includes(k)));
  if (["first_name", "last_name"].some(k => k in patch && patch[k] !== row.cartrack[k]) ||
      Object.entries(rosterPatch).some(([k,v]) => row.roster[k] !== v)) {
    await assertSheetRenameSafe(id,[`${row.cartrack.first_name??""} ${row.cartrack.last_name??""}`,
      String(row.roster?.Driver??""),String(row.roster?.employee_full_name??"")]);
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null && typeof value !== "string") throw new Error(`${key} không hợp lệ`);
    if (["start_location_customer_id", "end_location_customer_id"].includes(key) && value !== null) {
      const location = typeof value === "string" && uuid.test(value) ? await masterClient(value) : null;
      if (!location) throw new Error("Điểm tài xế không hợp lệ");
      if (isInactiveLocation(location.cartrack.customer_name)) throw new Error("Điểm tài xế đã ngừng hoạt động");
    }
    if (["shift_time_start", "shift_time_end"].includes(key) && value !== null &&
        (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?(\+07:00)?$/.test(value))) throw new Error("Ca tài xế không hợp lệ");
  }
  let after = row.cartrack;
  if (Object.keys(cartrackPatch).length) {
    const res = await fetch(`${BASE_URL}/drivers/${id}`, { method: "PUT", headers: getHeaders(), body: JSON.stringify(cartrackPatch) });
    if (!res.ok) throw new Error(`Cartrack HTTP ${res.status}: ${(await res.text()).slice(0, 180)}`);
    const check = await fetch(`${BASE_URL}/drivers/${id}`, { headers: getHeaders(), cache: "no-store" });
    if (!check.ok) throw new Error(`Cartrack đã lưu nhưng không đọc lại được (HTTP ${check.status})`);
    after = (await check.json()).data;
    if (Object.entries(cartrackPatch).some(([k, v]) => ["shift_time_start", "shift_time_end"].includes(k)
      ? String(after?.[k] ?? "").slice(0,5) !== String(v ?? "").slice(0,5)
      : String(after?.[k] ?? "") !== String(v ?? ""))) throw new Error("Cartrack trả 200 nhưng dữ liệu không khớp khi đọc lại");
  }
  const renamed = ["first_name", "last_name"].some(k => k in cartrackPatch);
  const roster = Object.fromEntries(Object.entries(row.roster ?? {}).filter(([key]) => !localFields.includes(key)));
  const masterPatch = {...localPatch,
    ...(renamed || Object.keys(rosterPatch).length ? {roster:{...roster,...rosterPatch,
      ...(renamed ? {Driver:`${after.first_name ?? ""} ${after.last_name ?? ""}`.trim()} : {})}} : {})};
  if (Object.keys(cartrackPatch).length) await sbUpsert("master_drivers", [{driver_id:id,cartrack:after,...masterPatch}],"driver_id");
  else if (Object.keys(masterPatch).length) await sbPatch("master_drivers",`driver_id=eq.${id}`,masterPatch);
  return { driver_id: id };
}
