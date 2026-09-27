"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { MasterClient, MasterDriver, MasterRule, RuleInput } from "@/lib/master-store";

type View = "rules" | "clients" | "drivers";
type Selected = { view: View; id: string } | null;
const field = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const label = "block text-xs font-medium text-muted-foreground mb-1";
let sessionKey = "";

function driverName(d: MasterDriver) {
  return `${d.cartrack.first_name ?? ""} ${d.cartrack.last_name ?? ""}`.trim();
}

export function MasterClientInfoPanel() {
  const [key, setKey] = useState(sessionKey);
  const [enteredKey, setEnteredKey] = useState("");
  const [view, setView] = useState<View>("rules");
  const [clients, setClients] = useState<MasterClient[]>([]);
  const [drivers, setDrivers] = useState<MasterDriver[]>([]);
  const [rules, setRules] = useState<MasterRule[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Selected>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [driverIds, setDriverIds] = useState<string[]>([]);
  const [keepGps, setKeepGps] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);

  const request = useCallback(async (path: string, init?: RequestInit) => {
    const res = await fetch(`/api/master-client-info${path}`, {
      ...init, headers: { "Content-Type": "application/json", "x-master-edit-key": key, ...(init?.headers ?? {}) },
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  }, [key]);

  const load = useCallback(async () => {
    if (!key) return;
    setLoading(true);
    try {
      const [c, d, r] = await Promise.all([request("?view=clients"), request("?view=drivers"), request("?view=rules")]);
      setClients(c.rows); setDrivers(d.rows); setRules(r.rows);
    } catch (e) { toast.error(String(e)); }
    finally { setLoading(false); }
  }, [key, request]);

  useEffect(() => { if (key) void load(); }, [key, load]);

  const clientById = useMemo(() => new Map(clients.map((c) => [c.customer_id, c])), [clients]);
  const driverById = useMemo(() => new Map(drivers.map((d) => [d.driver_id, d])), [drivers]);
  const current = selected?.view === "clients" ? clientById.get(selected.id)
    : selected?.view === "drivers" ? driverById.get(selected.id)
    : selected?.view === "rules" ? rules.find((r) => String(r.source_row) === selected.id) : undefined;
  const q = query.trim().toLocaleLowerCase("vi");
  const visible = useMemo(() => {
    if (view === "clients") return clients.filter((c) => `${c.cartrack.customer_name ?? ""} ${c.client_code ?? ""} ${c.new_ward ?? ""} ${c.customer_id}`.toLocaleLowerCase("vi").includes(q)).slice(0, 200);
    if (view === "drivers") return drivers.filter((d) => `${driverName(d)} ${d.cartrack.phone_number ?? ""} ${d.driver_id}`.toLocaleLowerCase("vi").includes(q)).slice(0, 200);
    return rules.filter((r) => `${r.row_data["Điểm Pick-up"] ?? ""} ${r.row_data.Driver ?? ""} ${r.row_data["Điểm Drop-off"] ?? ""}`.toLocaleLowerCase("vi").includes(q)).slice(0, 200);
  }, [view, clients, drivers, rules, q]);

  function choose(next: Selected) {
    setSelected(next); setKeepGps(true);
    if (!next) { setDraft({}); setDriverIds([]); return; }
    if (next.view === "clients") {
      const c = clientById.get(next.id)!;
      setDraft({
        customer_name: String(c.cartrack.customer_name ?? ""),
        address_line_1: String(c.cartrack.address_line_1 ?? ""),
        contact_number: String(c.cartrack.contact_number ?? ""),
        latitude: String(c.cartrack.latitude ?? ""), longitude: String(c.cartrack.longitude ?? ""),
        default_dropoff_id: c.default_dropoff_id ?? "", eta_minutes: String(c.eta_minutes ?? ""),
      });
    } else if (next.view === "drivers") {
      const d = driverById.get(next.id)!;
      setDraft(Object.fromEntries(["first_name", "last_name", "email", "phone_code", "phone_number", "shift_time_start", "shift_time_end", "start_location_customer_id", "end_location_customer_id", "driver_zalo_id", "phone_number_update", "employee_code", "employee_full_name", "code_name"].map((k) => [k, String(d.cartrack[k] ?? d.roster?.[k] ?? (d as unknown as Record<string, unknown>)[k] ?? "")])));
    } else {
      const r = rules.find((r) => String(r.source_row) === next.id);
      setDraft({ customer_id: r?.row_data.customer_id ?? "", dropoff_id: r?.row_data.dropoff_id ?? "", shift_start: r?.row_data.shift_start ?? "", shift_end: r?.row_data.shift_end ?? "", bot_token: r?.row_data.bot_token ?? "", chat_id: r?.row_data.chat_id ?? "", alt_drop_off_id: r?.row_data.alt_drop_off_id ?? "" });
      setDriverIds(r ? (r.row_data.smart_driver_id || r.row_data.driver_id || "").split(",").map((s) => s.trim()).filter(Boolean) : []);
    }
  }

  const set = (name: string, value: string) => setDraft((d) => ({ ...d, [name]: value }));
  async function save() {
    if (!selected) return;
    setSaving(true);
    try {
      if (selected.view === "rules") {
        const input: RuleInput = { customer_id: draft.customer_id, driver_ids: driverIds, dropoff_id: draft.dropoff_id, shift_start: draft.shift_start, shift_end: draft.shift_end, bot_token: draft.bot_token, chat_id: draft.chat_id, alt_drop_off_id: draft.alt_drop_off_id };
        const rule = rules.find((r) => String(r.source_row) === selected.id);
        await request("", { method: rule ? "PATCH" : "POST", body: JSON.stringify({ kind: "rule", input, row: rule?.source_row, version: rule?.updated_at }) });
      } else {
        const old = selected.view === "clients" ? clientById.get(selected.id)! : driverById.get(selected.id)!;
        const original = selected.view === "clients" ? {
          customer_name: old.cartrack.customer_name, address_line_1: old.cartrack.address_line_1,
          contact_number: old.cartrack.contact_number, latitude: old.cartrack.latitude,
          longitude: old.cartrack.longitude, default_dropoff_id: (old as MasterClient).default_dropoff_id,
          eta_minutes: (old as MasterClient).eta_minutes,
        } : { ...old.cartrack, ...(old as MasterDriver).roster, driver_zalo_id: (old as MasterDriver).driver_zalo_id, phone_number_update: (old as MasterDriver).phone_number_update };
        const patch: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(draft)) {
          if (name === "bot_token" && !value) continue; // blank keeps the existing secret
          if (selected.view === "clients" && keepGps && (name === "latitude" || name === "longitude")) continue;
          const parsed = ["latitude", "longitude", "eta_minutes"].includes(name) ? Number(value) : value;
          if (String((original as Record<string, unknown>)[name] ?? "") !== String(value)) patch[name] = parsed;
        }
        if (Object.keys(patch).length) await request("", { method: "PATCH", body: JSON.stringify({ kind: selected.view === "clients" ? "client" : "driver", id: selected.id, patch }) });
      }
      toast.success("Đã lưu Master Client Info");
      await load();
      choose(null);
    } catch (e) { toast.error(String(e)); }
    finally { setSaving(false); }
  }

  async function removeRule() {
    if (selected?.view !== "rules") return;
    const rule = rules.find((r) => String(r.source_row) === selected.id);
    if (!rule || !window.confirm(`Xoá quy tắc ${rule.row_data["Điểm Pick-up"]}?`)) return;
    setSaving(true);
    try {
      await request("", { method: "DELETE", body: JSON.stringify({ kind: "rule", row: rule.source_row, version: rule.updated_at }) });
      toast.success("Đã xoá quy tắc"); await load(); choose(null);
    } catch (e) { toast.error(String(e)); }
    finally { setSaving(false); }
  }

  async function refreshClient() {
    if (selected?.view !== "clients") return;
    setSaving(true);
    try {
      await request("", { method: "POST", body: JSON.stringify({ kind: "refresh_client", id: selected.id }) });
      await load();
      toast.success("Đã làm mới thông tin Sapoche");
    } catch (e) { toast.error(String(e)); }
    finally { setSaving(false); }
  }

  if (!key) return <div className="p-5 max-w-sm space-y-3">
    <h2 className="text-lg font-semibold">Master Client Info</h2>
    <p className="text-sm text-muted-foreground">Nhập mã truy cập để xem và chỉnh sửa thông tin khách hàng, tài xế.</p>
    <label className={label} htmlFor="master-key">Mã truy cập</label>
    <input id="master-key" className={field} type="password" autoComplete="off" value={enteredKey} onChange={(e) => setEnteredKey(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { sessionKey = enteredKey; setKey(enteredKey); } }} />
    <button className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground text-sm" onClick={() => { sessionKey = enteredKey; setKey(enteredKey); }}>Mở</button>
  </div>;

  const textInput = (name: string, title: string, type = "text") => <label className="block" key={name}><span className={label}>{title}</span><input className={field} type={type} value={draft[name] ?? ""} onChange={(e) => set(name, e.target.value)} /></label>;
  const clientSelect = (name: string, title: string, optional = false) => <label className="block" key={name}><span className={label}>{title}</span><select className={field} value={draft[name] ?? ""} onChange={(e) => set(name, e.target.value)}><option value="" disabled={!optional}>{optional ? "—" : "Chọn…"}</option>{clients.map((c) => <option key={c.customer_id} value={c.customer_id}>{String(c.cartrack.customer_name ?? c.customer_id)}</option>)}</select></label>;

  return <div className="h-full min-h-0 flex flex-col gap-3 p-3">
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="text-lg font-semibold mr-auto">Master Client Info</h2>
      <button className="rounded-md border px-2 py-1.5 text-sm hover:bg-accent" onClick={() => { sessionKey = ""; setKey(""); choose(null); }}>Khoá</button>
      {(["rules", "clients", "drivers"] as View[]).map((v) => <button key={v} className={`rounded-md px-3 py-1.5 text-sm ${view === v ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-accent"}`} onClick={() => { setView(v); choose(null); }}>{v === "rules" ? `Quy tắc (${rules.length})` : v === "clients" ? `Khách hàng (${clients.length})` : `Tài xế (${drivers.length})`}</button>)}
      <button className="rounded-md border px-2 py-1.5 text-sm hover:bg-accent" onClick={() => void load()} disabled={loading}>Tải lại</button>
    </div>
    <div className="flex gap-2"><input className={field} aria-label="Tìm trong Master Client Info" placeholder="Tìm tên, mã, địa chỉ…" value={query} onChange={(e) => setQuery(e.target.value)} />{view === "rules" && <button className="shrink-0 rounded-md bg-primary px-3 text-sm text-primary-foreground" onClick={() => choose({ view: "rules", id: "new" })}>Thêm quy tắc</button>}</div>
    <div className="min-h-0 flex-1 grid gap-3 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="overflow-y-auto rounded-lg border" role="list" aria-label="Master Client Info">
        {loading && <p className="p-3 text-sm">Đang tải…</p>}
        {!loading && visible.length === 0 && <p className="p-3 text-sm text-muted-foreground">Không có kết quả.</p>}
        {visible.map((item) => {
          if (view === "rules") {
            const r = item as MasterRule, c = clientById.get(r.row_data.customer_id);
            const title = c ? `Phường mới: ${c.new_ward ?? "—"}\nPSC gần nhất: ${c.nearest_psc_name ?? "—"}\nĐiểm giao mặc định: ${c.default_dropoff_name ?? "—"}\nETA: ${c.eta_minutes ?? "—"} phút\nSales: ${c.sales_name ?? "—"} ${c.sales_email ?? ""}\nSupervisor: ${c.supervisor_name ?? "—"} ${c.supervisor_email ?? ""}` : "";
            return <button role="listitem" title={title} key={r.id} onClick={() => choose({ view, id: String(r.source_row) })} className="w-full text-left px-3 py-2 border-b hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className="font-medium text-sm">{r.row_data["Điểm Pick-up"] || r.row_data.customer_id || "Chưa có tên"}</span><span className="block text-xs text-muted-foreground">{r.row_data.Driver || "Chưa có tài xế"} · {r.row_data.shift_start || "Cả ngày"}–{r.row_data.shift_end || ""}{r.row_data["Điểm Drop-off"] ? ` · ${r.row_data["Điểm Drop-off"]}` : ""}</span></button>;
          }
          if (view === "clients") {
            const c = item as MasterClient;
            return <button role="listitem" key={c.customer_id} title={`Phường mới: ${c.new_ward ?? "—"}\nPSC gần nhất: ${c.nearest_psc_name ?? "—"} (${c.nearest_psc_km?.toFixed(1) ?? "—"} km)\nĐiểm giao mặc định: ${c.default_dropoff_name ?? "—"}\nETA: ${c.eta_minutes ?? "—"} phút\nSales: ${c.sales_name ?? "—"} ${c.sales_email ?? ""}\nSupervisor: ${c.supervisor_name ?? "—"} ${c.supervisor_email ?? ""}`} onClick={() => choose({ view, id: c.customer_id })} className="w-full text-left px-3 py-2 border-b hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className="font-medium text-sm">{String(c.cartrack.customer_name ?? c.customer_id)}</span><span className="block text-xs text-muted-foreground">{String(c.cartrack.address_line_1 ?? "")} · {c.new_ward ?? "Chưa xác định phường"}</span></button>;
          }
          const d = item as MasterDriver;
          return <button role="listitem" key={d.driver_id} title={`Email: ${d.cartrack.email ?? "—"}\nZalo ID: ${d.driver_zalo_id ?? "—"}\nBot token: ${d.bot_token ? "Đã lưu" : "Chưa có"}`} onClick={() => choose({ view, id: d.driver_id })} className="w-full text-left px-3 py-2 border-b hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className="font-medium text-sm">{driverName(d)}</span><span className="block text-xs text-muted-foreground">{String(d.cartrack.phone_number ?? "")} · {d.cartrack.is_active === false ? "Ngừng hoạt động" : "Hoạt động"}</span></button>;
        })}
      </div>
      <div className="overflow-y-auto rounded-lg border p-3">
        {!selected && <p className="text-sm text-muted-foreground">Chọn một mục để xem hoặc chỉnh sửa. Di chuột lên dòng để xem thông tin bổ sung.</p>}
        {selected && <div className="space-y-3">
          <div className="flex items-center justify-between"><h3 className="font-semibold">{selected.view === "clients" ? "Khách hàng" : selected.view === "drivers" ? "Tài xế" : "Quy tắc phân công"}</h3><button className="text-sm underline" onClick={() => choose(null)}>Đóng</button></div>
          {selected.view === "clients" && <>
            {textInput("customer_name", "Tên")}{textInput("contact_number", "Điện thoại")}{textInput("address_line_1", "Địa chỉ")}
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={keepGps} onChange={(e) => setKeepGps(e.target.checked)} />Giữ nguyên GPS khi sửa địa chỉ</label>
            {!keepGps && <div className="grid grid-cols-2 gap-2">{textInput("latitude", "Vĩ độ", "number")}{textInput("longitude", "Kinh độ", "number")}</div>}
            <p className="text-xs text-muted-foreground">Phường mới: {(current as MasterClient)?.new_ward ?? "—"}<br />PSC gần nhất: {(current as MasterClient)?.nearest_psc_name ?? "—"}<br />Sales: {(current as MasterClient)?.sales_name ?? "—"} · {(current as MasterClient)?.sales_email ?? "—"}<br />Supervisor: {(current as MasterClient)?.supervisor_name ?? "—"} · {(current as MasterClient)?.supervisor_email ?? "—"}</p>
            {clientSelect("default_dropoff_id", "Điểm giao mặc định", true)}{textInput("eta_minutes", "ETA (phút)", "number")}
          </>}
          {selected.view === "drivers" && <>
            {textInput("first_name", "Họ / mã")}{textInput("last_name", "Tên")}{textInput("email", "Email", "email")}{textInput("phone_code", "Mã vùng")}{textInput("phone_number", "Điện thoại")}
            {textInput("shift_time_start", "Bắt đầu ca")}{textInput("shift_time_end", "Kết thúc ca")}
            {clientSelect("start_location_customer_id", "Điểm xuất phát", true)}{clientSelect("end_location_customer_id", "Điểm kết thúc", true)}
            {textInput("driver_zalo_id", "Zalo ID")}{textInput("phone_number_update", "Điện thoại thay thế")}
            {textInput("employee_code", "Mã nhân viên")}{textInput("employee_full_name", "Tên nhân viên MISA")}{textInput("code_name", "Mã / tên nội bộ")}
            <label className="block"><span className={label}>Bot token · để trống để giữ token hiện tại</span><input className={field} type="password" value={draft.bot_token ?? ""} onChange={(e) => set("bot_token", e.target.value)} placeholder={(current as MasterDriver)?.bot_token ? "Đã lưu" : "Chưa có"} /></label>
          </>}
          {selected.view === "rules" && <>
            {clientSelect("customer_id", "Điểm lấy mẫu")}{clientSelect("dropoff_id", "Chỉ áp dụng cho điểm giao", true)}
            <label className="block"><span className={label}>Tài xế · chọn nhiều để phân công thông minh</span><select className={field} multiple size={7} value={driverIds} onChange={(e) => setDriverIds(Array.from(e.target.selectedOptions, (o) => o.value))}>{drivers.filter((d) => d.cartrack.is_active !== false).map((d) => <option key={d.driver_id} value={d.driver_id}>{driverName(d)}</option>)}</select></label>
            <div className="grid grid-cols-2 gap-2">{textInput("shift_start", "Từ", "time")}{textInput("shift_end", "Đến", "time")}</div>
            {textInput("bot_token", "Bot token")}{textInput("chat_id", "Chat ID")}{clientSelect("alt_drop_off_id", "Đổi điểm giao sang", true)}
          </>}
          <div className="flex gap-2"><button disabled={saving} className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50" onClick={() => void save()}>{saving ? "Đang lưu…" : "Lưu"}</button>{selected.view === "clients" && <button disabled={saving} className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50" onClick={() => void refreshClient()}>Làm mới Sapoche</button>}{selected.view === "rules" && selected.id !== "new" && <button disabled={saving} className="rounded-md border border-destructive px-3 py-1.5 text-sm text-destructive" onClick={() => void removeRule()}>Xoá</button>}</div>
        </div>}
      </div>
    </div>
    <p className="text-xs text-muted-foreground">Hiển thị tối đa 200 mục đầu tiên. Dùng tìm kiếm để thu hẹp kết quả.</p>
  </div>;
}
