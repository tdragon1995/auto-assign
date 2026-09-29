import { BASE_URL, getCustomerById, getHeaders } from "./cartrack";
import { DELIVERY_BASE, getAdminToken, updateLocationAddress, updateLocationPhone, updatePickDropLocation } from "./labcenter";
import { nearestPsc, newWard, GEO_DATASET_VERSION } from "./master-geo";
import { masterClient, masterDriver } from "./master-store";
import { sbPatch, sbUpsert } from "./supabase-rest";
import { SHEET_GID, SHEET_ID } from "./sheets";
import { getSheetsClient } from "./sheets-writer";

async function assertSheetRenameSafe(id:string,names:string[]) {
  const sheets=getSheetsClient();
  const meta=await sheets.spreadsheets.get({spreadsheetId:SHEET_ID,fields:"sheets.properties"});
  const gids=new Set<string>([SHEET_GID.mapping,SHEET_GID.sunday,SHEET_GID.nghi_phep,SHEET_GID.drivers,SHEET_GID.locations]);
  const relevant=meta.data.sheets?.filter(s=>gids.has(String(s.properties?.sheetId)) ||
    s.properties?.title?.startsWith("(Edit weekly) PUBLIC SUNDAY"))??[];
  if(relevant.length<5) throw new Error("Không xác minh được các tab Google Sheet còn dùng tên");
  const ranges=relevant.map(s=>`'${s.properties!.title!.replace(/'/g,"''")}'`);
  const values=await sheets.spreadsheets.values.batchGet({spreadsheetId:SHEET_ID,ranges});
  if(values.data.valueRanges?.length!==ranges.length) throw new Error("Không đọc đủ tham chiếu Google Sheet");
  const oldNames=new Set(names.filter(Boolean).map(n=>n.trim()));
  for(const sheet of values.data.valueRanges??[]) for(const row of sheet.values??[]) for(const value of row) {
    const cell=String(value??"").trim();
    if(cell===id || oldNames.has(cell) || cell.split(/[,;\n]/).some(v=>oldNames.has(v.trim())))
      throw new Error(`Chưa thể đổi tên: ${sheet.range} còn tham chiếu tên hoặc ID cũ trong Google Sheet`);
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
  const allowed = new Set(["customer_name", "address_line_1", "latitude", "longitude", "contact_number", "default_dropoff_id", "eta_minutes"]);
  if (Object.keys(patch).some((k) => !allowed.has(k))) throw new Error("Trường cập nhật không hợp lệ");
  const current = (await getCustomerById(id))?.data;
  if (!current) throw new Error("Không đọc được khách hàng từ Cartrack");
  const name = patch.customer_name === undefined ? current.customer_name : requiredText(patch.customer_name, "Tên");
  if (name !== current.customer_name) await assertSheetRenameSafe(id,[String(current.customer_name??"")]);
  const address = patch.address_line_1 === undefined ? current.address_line_1 : requiredText(patch.address_line_1, "Địa chỉ");
  const lat = patch.latitude === undefined ? Number(current.latitude) : Number(patch.latitude);
  const lon = patch.longitude === undefined ? Number(current.longitude) : Number(patch.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error("GPS không hợp lệ");
  const contact = patch.contact_number === undefined ? current.contact_number : requiredText(patch.contact_number, "Số điện thoại");
  const changeCartrack = ["customer_name", "address_line_1", "latitude", "longitude", "contact_number"].some((k) => k in patch);
  let after = current;
  if (changeCartrack) {
    const payload = {
      customer_name: name, email: current.email, contact_code: current.contact_code,
      contact_number: contact, address_line_1: address, address_line_2: current.address_line_2,
      postal_code: current.postal_code, country_id: current.country_id,
      latitude: lat, longitude: lon, client_reference: current.client_reference,
    };
    const res = await fetch(`${BASE_URL}/customers/${id}`, { method: "PUT", headers: getHeaders(), body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(`Cartrack HTTP ${res.status}: ${(await res.text()).slice(0, 180)}`);
    after = (await getCustomerById(id))?.data;
    if (!after || after.customer_name !== name || after.address_line_1 !== address ||
        Number(after.latitude) !== lat || Number(after.longitude) !== lon || after.contact_number !== contact) {
      throw new Error("Cartrack trả 200 nhưng dữ liệu không khớp khi đọc lại");
    }
    const psc = await nearestPsc(lat, lon);
    await sbUpsert("master_clients", [{
      customer_id: id, cartrack: after, new_ward: newWard(lat, lon),
      nearest_psc_id: psc?.id ?? null, nearest_psc_name: psc?.name ?? null,
      nearest_psc_km: psc?.km ?? null, geo_calculated_at:new Date().toISOString(),geo_dataset_version:GEO_DATASET_VERSION,
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
    if (patch.customer_name !== undefined) {
      const res = await fetch(`${DELIVERY_BASE}/api/locations/${row.labcenter_location_id}`, {
        method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(`Cartrack đã lưu; Labcenter tên HTTP ${res.status}`);
    }
  }
  if (patch.default_dropoff_id !== undefined || patch.eta_minutes !== undefined) {
    if (!row.labcenter_location_id || !token) throw new Error("Điểm này chưa liên kết Labcenter");
    const dropId = patch.default_dropoff_id === undefined ? row.default_dropoff_id : String(patch.default_dropoff_id);
    const eta = patch.eta_minutes === undefined ? row.eta_minutes : Number(patch.eta_minutes);
    if (!dropId || !uuid.test(dropId) || !Number.isInteger(eta) || eta! < 0 || eta! > 1440) throw new Error("Điểm giao hoặc ETA không hợp lệ");
    const drop = await masterClient(dropId);
    if (!drop?.labcenter_location_id) throw new Error("Điểm giao chưa liên kết Labcenter");
    const result = await updatePickDropLocation({
      pickId: id, dropId, etaMins: eta!, lcLocationId: row.labcenter_location_id,
      dropLocationId: drop.labcenter_location_id,
    }, token);
    if (!result.ok) throw new Error(result.error ?? "Labcenter không lưu điểm giao");
    await sbPatch("master_clients", `customer_id=eq.${id}`, {
      default_dropoff_id: dropId, default_dropoff_name: drop.cartrack.customer_name ?? "", eta_minutes: eta,
    });
  }
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
  }
  let after = row.cartrack;
  if (Object.keys(cartrackPatch).length) {
    const res = await fetch(`${BASE_URL}/drivers/${id}`, { method: "PUT", headers: getHeaders(), body: JSON.stringify(cartrackPatch) });
    if (!res.ok) throw new Error(`Cartrack HTTP ${res.status}: ${(await res.text()).slice(0, 180)}`);
    const check = await fetch(`${BASE_URL}/drivers/${id}`, { headers: getHeaders(), cache: "no-store" });
    if (!check.ok) throw new Error(`Cartrack đã lưu nhưng không đọc lại được (HTTP ${check.status})`);
    after = (await check.json()).data;
    if (Object.entries(cartrackPatch).some(([k, v]) => after?.[k] !== v)) throw new Error("Cartrack trả 200 nhưng dữ liệu không khớp khi đọc lại");
    await sbUpsert("master_drivers", [{ driver_id: id, cartrack: after }], "driver_id");
  }
  if (Object.keys(localPatch).length) await sbPatch("master_drivers", `driver_id=eq.${id}`, localPatch);
  if (Object.keys(rosterPatch).length) await sbPatch("master_drivers", `driver_id=eq.${id}`, { roster: { ...row.roster, ...rosterPatch } });
  return { driver_id: id };
}
