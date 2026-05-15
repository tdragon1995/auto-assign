"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Prediction = {
  place_id: string;
  description: string;
  structured_formatting?: { main_text?: string; secondary_text?: string };
};

type ClientResult = { code: string; client_legal_name: string };

const CLIENT_OVERRIDES: Record<string, string> = {
  "21362": "PS315",
  "21361": "TM315",
  "46651876": "ND315",
};

const QUAN_CU_OPTIONS: { label: string; code: string }[] = [
  { label: "Quận 1",     code: "D1"     },
  { label: "Quận 3",     code: "D3"     },
  { label: "Quận 10",    code: "D10"    },
  { label: "Quận 11",    code: "D11"    },
  { label: "Phú Nhuận",  code: "PNhuan" },
  { label: "Bình Thạnh", code: "BThanh" },
  { label: "Tân Bình",   code: "TBinh"  },
  { label: "Gò Vấp",     code: "GVap"   },
  { label: "Quận 4",     code: "D4"     },
  { label: "Quận 5",     code: "D5"     },
  { label: "Quận 6",     code: "D6"     },
  { label: "Quận 7",     code: "D7"     },
  { label: "Quận 8",     code: "D8"     },
  { label: "Quận 12",    code: "D12"    },
  { label: "Tân Phú",    code: "TPhu"   },
  { label: "Bình Tân",   code: "BTan"   },
  { label: "Thủ Đức",    code: "TDuc"   },
  { label: "Quận 2",     code: "D2"     },
  { label: "Quận 9",     code: "D9"     },
  { label: "Bình Chánh", code: "BChanh" },
  { label: "Nhà Bè",     code: "NBe"    },
  { label: "Hóc Môn",    code: "HMon"   },
  { label: "Củ Chi",     code: "CChi"   },
  { label: "Cần Thạnh",  code: "CThanh" },
  { label: "Dĩ An",      code: "DAn"    },
  { label: "Thuận An",   code: "ThAn"   },
  { label: "Thủ Dầu 1",  code: "TD1"    },
  { label: "Tân Uyên",   code: "TUyen"  },
  { label: "Bến Cát",    code: "BCat"   },
  { label: "Biên Hòa",   code: "BHoa"   },
  { label: "Nhơn Trạch", code: "NTrach" },
  { label: "Long Thành", code: "LThanh" },
  { label: "Vĩnh Cửu",   code: "VCuu"   },
  { label: "Tam Phước",  code: "TPhuoc" },
  { label: "Mỹ Tho",     code: "MTho"   },
  { label: "Tân An",     code: "TAn"    },
  { label: "Thủ Thừa",   code: "TThua"  },
  { label: "Bến Lức",    code: "BLuc"   },
  { label: "Trảng Bàng", code: "TBang"  },
  { label: "Vũng Tàu",   code: "VTau"   },
];

function stripDiacritics(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

function titleCase(word: string): string {
  if (!word) return "";
  return word[0].toUpperCase() + word.slice(1).toLowerCase();
}

// "Điện Biên Phủ" → "DBPhu"
function abbrStreet(raw: string): string {
  const cleaned = stripDiacritics(raw).trim();
  if (!cleaned) return "";
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 1) return titleCase(words[0]);
  const initials = words.slice(0, -1).map((w) => w[0].toUpperCase()).join("");
  return initials + titleCase(words[words.length - 1]);
}

function Icon({ paths, className }: { paths: string[]; className?: string }) {
  return (
    <svg
      className={`w-4 h-4 ${className ?? ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      viewBox="0 0 24 24"
    >
      {paths.map((d, i) => (
        <path key={i} strokeLinecap="round" strokeLinejoin="round" d={d} />
      ))}
    </svg>
  );
}

function FieldIcon({ paths }: { paths: string[] }) {
  return (
    <span className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400">
      <Icon paths={paths} />
    </span>
  );
}

const ICON_SEARCH = ["M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"];
const ICON_PIN = [
  "M15 10.5a3 3 0 11-6 0 3 3 0 016 0z",
  "M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z",
];
const ICON_MAP = [
  "M9 6.75V15m6-6v8.25m.503 3.498l4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 00-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0z",
];
const ICON_USER = [
  "M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z",
];
const ICON_PHONE = [
  "M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z",
];

const REJECT_REASONS = [
  "Khách hàng không còn nhu cầu gửi mẫu",
  "Đã book grab",
  "Book dư",
];

export default function SalesPage() {
  const [tab, setTab] = useState<"customer" | "reject">("customer");

  // Reject job state
  const [refNumber, setRefNumber] = useState("");
  const [rejectReason, setRejectReason] = useState(REJECT_REASONS[0]);
  const [rejectLoading, setRejectLoading] = useState(false);
  const [rejectResult, setRejectResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const rejectJob = async () => {
    const ref = refNumber.trim();
    if (!ref) return;
    setRejectLoading(true);
    setRejectResult(null);
    try {
      const res = await fetch("/api/sales/reject-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference_number: ref, reject_reason: rejectReason }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRejectResult({ ok: false, msg: data.error ?? "Huỷ thất bại" });
      } else {
        const who = data.pickup_customer_name ? `, ${data.pickup_customer_name}` : "";
        setRejectResult({ ok: true, msg: `Đã huỷ thành công ${data.reference_number ?? ref}${who}` });
        setRefNumber("");
      }
    } catch (e) {
      setRejectResult({ ok: false, msg: String(e) });
    } finally {
      setRejectLoading(false);
    }
  };

  // Customer form state
  const [maKh, setMaKh] = useState("");
  const [quanCu, setQuanCu] = useState("");
  const [tenDuong, setTenDuong] = useState("");
  const [tenKh, setTenKh] = useState("");
  const [diaChi, setDiaChi] = useState("");
  const [phone, setPhone] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");

  // Client search (Thông Tin Khách Hàng)
  const [clientSearch, setClientSearch] = useState("");
  const [clientResults, setClientResults] = useState<ClientResult[]>([]);
  const [showClientResults, setShowClientResults] = useState(false);
  const [clientSearchLoading, setClientSearchLoading] = useState(false);
  const [clientSelected, setClientSelected] = useState(false);

  useEffect(() => {
    if (clientSelected) return;
    const q = clientSearch.trim();
    if (q.length < 2) { setClientResults([]); return; }
    const ac = new AbortController();
    const t = setTimeout(async () => {
      setClientSearchLoading(true);
      try {
        const res = await fetch(`/api/labcenter/client?q=${encodeURIComponent(q)}`, { signal: ac.signal });
        const data = await res.json();
        if (res.ok) setClientResults(data.results ?? []);
      } catch {
        // aborted or network — ignore
      } finally {
        setClientSearchLoading(false);
      }
    }, 300);
    return () => { clearTimeout(t); ac.abort(); };
  }, [clientSearch, clientSelected]);

  const selectClient = (r: ClientResult) => {
    const name = CLIENT_OVERRIDES[r.code] ?? r.client_legal_name;
    setMaKh(r.code);
    setTenKh(name);
    setClientSearch(`${r.code} — ${r.client_legal_name}`);
    setClientSelected(true);
    setShowClientResults(false);
    setClientResults([]);
  };

  const clearClient = () => {
    setMaKh("");
    setTenKh("");
    setClientSearch("");
    setClientSelected(false);
    setClientResults([]);
  };

  // Address autocomplete
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [showPredictions, setShowPredictions] = useState(false);
  const [predictionsLoading, setPredictionsLoading] = useState(false);
  const skipNextFetchRef = useRef(false);

  useEffect(() => {
    if (skipNextFetchRef.current) {
      skipNextFetchRef.current = false;
      return;
    }
    const q = diaChi.trim();
    if (q.length < 3) { setPredictions([]); return; }
    const ac = new AbortController();
    const t = setTimeout(async () => {
      setPredictionsLoading(true);
      try {
        const res = await fetch(`/api/geo/autocomplete?input=${encodeURIComponent(q)}`, { signal: ac.signal });
        const data = await res.json();
        if (res.ok) setPredictions(data.predictions ?? []);
      } catch {
        // aborted or network — ignore
      } finally {
        setPredictionsLoading(false);
      }
    }, 250);
    return () => { clearTimeout(t); ac.abort(); };
  }, [diaChi]);

  const selectPrediction = async (p: Prediction) => {
    skipNextFetchRef.current = true;
    setDiaChi(p.description);
    setShowPredictions(false);
    setPredictions([]);
    try {
      const res = await fetch(`/api/geo/place?place_id=${encodeURIComponent(p.place_id)}`);
      const data = await res.json();
      if (res.ok) {
        setLat(String(data.latitude));
        setLon(String(data.longitude));
      }
    } catch {
      // ignore — user can still paste a maps link
    }
  };

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [newCustomer, setNewCustomer] = useState<{ customer_id: string; customer_name: string; lat: number; lon: number; ma_kh: string } | null>(null);
  const [tripLoading, setTripLoading] = useState(false);
  const [tripResult, setTripResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [tripNote, setTripNote] = useState("");
  const [duplicates, setDuplicates] = useState<{ customer_id: string; customer_name: string; address_line_1?: string }[] | null>(null);

  const maKhValid = /^\d{5,8}$/.test(maKh);

  const { customerName, checkPrefix } = useMemo(() => {
    const includeStreet = ["21362", "21361", "46651876"].includes(maKh);
    const abbr = abbrStreet(tenDuong);
    const lastPart = includeStreet
      ? `${tenKh} ${tenDuong}`.trim()
      : tenKh.trim();
    const parts = [maKh, quanCu, abbr, lastPart].filter(Boolean);
    const prefix = [maKh, quanCu, abbr].filter(Boolean).join(" - ");
    return { customerName: parts.join(" - "), checkPrefix: prefix };
  }, [maKh, quanCu, tenDuong, tenKh]);

  const canSubmit =
    maKhValid &&
    quanCu.trim() &&
    tenDuong.trim() &&
    tenKh.trim() &&
    phone.trim() &&
    !loading;

  const doSubmit = async (forceName?: string) => {
    if (!canSubmit) return;
    const name = forceName ?? customerName;
    setLoading(true);
    setResult(null);
    try {
      const payload: Record<string, unknown> = {
        customer_name: name,
        address_line_1: diaChi.trim() || undefined,
        contact_number: phone.trim() || undefined,
        check_prefix: checkPrefix,
        ...(forceName !== undefined ? { force: true } : {}),
      };
      const latNum = parseFloat(lat);
      const lonNum = parseFloat(lon);
      if (!Number.isNaN(latNum) && !Number.isNaN(lonNum)) {
        payload.latitude = latNum;
        payload.longitude = lonNum;
      }
      const res = await fetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409 && data.matches?.length > 0) {
          setDuplicates(data.matches);
        } else {
          setResult({ ok: false, msg: data.error ?? "Lỗi không xác định" });
        }
      } else {
        setResult({ ok: true, msg: `Tạo địa điểm lấy mẫu thành công: ${data.customer?.customer_name ?? name}` });
        const lat2 = parseFloat(lat);
        const lon2 = parseFloat(lon);
        if (data.customer?.customer_id && !Number.isNaN(lat2) && !Number.isNaN(lon2)) {
          setNewCustomer({
            customer_id: data.customer.customer_id,
            customer_name: data.customer.customer_name ?? name,
            lat: lat2,
            lon: lon2,
            ma_kh: maKh,
          });
          setTripResult(null);
        }
        setDuplicates(null);
        setMaKh(""); setQuanCu(""); setTenDuong(""); setTenKh(""); setDiaChi(""); setLat(""); setLon(""); setPhone("");
        setClientSearch(""); setClientSelected(false); setClientResults([]);
      }
    } catch (e) {
      setResult({ ok: false, msg: String(e) });
    } finally {
      setLoading(false);
    }
  };

  const submit = () => doSubmit();

  const submitForce = () => {
    const abbr = abbrStreet(tenDuong);
    const houseNo = diaChi.trim().match(/^([\w/]+)/)?.[1] ?? "";
    const lastPart = `${tenKh} ${houseNo} ${tenDuong}`.replace(/\s+/g, " ").trim();
    doSubmit([maKh, quanCu, abbr, lastPart].filter(Boolean).join(" - "));
  };

  const createTrip = async () => {
    if (!newCustomer) return;
    setTripLoading(true);
    setTripResult(null);
    try {
      const res = await fetch("/api/sales/create-trip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...newCustomer, note: tripNote.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTripResult({ ok: false, msg: data.error ?? "Tạo chuyến thất bại" });
      } else {
        setTripResult({ ok: true, msg: "Tạo chuyến thành công, Liên hệ Logistics để biết thêm thông tin" });
        setNewCustomer(null);
        setTripNote("");
      }
    } catch (e) {
      setTripResult({ ok: false, msg: String(e) });
    } finally {
      setTripLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col items-center p-4 gap-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow border overflow-hidden">
        <div className="px-6 pt-5 pb-4">
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">Sales</p>
          <h1 className="text-xl font-bold text-slate-800 mt-0.5">
            {tab === "customer" ? "Tạo khách hàng" : "Huỷ yêu cầu giao nhận"}
          </h1>
        </div>

        <div className="grid grid-cols-2 border-t border-slate-100">
          <button
            onClick={() => setTab("customer")}
            className={`py-2.5 text-sm font-semibold transition-colors ${
              tab === "customer" ? "bg-blue-600 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
            }`}
          >
            Khách hàng mới
          </button>
          <button
            onClick={() => setTab("reject")}
            className={`py-2.5 text-sm font-semibold transition-colors border-l border-slate-100 ${
              tab === "reject" ? "bg-blue-600 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
            }`}
          >
            Huỷ yêu cầu giao nhận
          </button>
        </div>

        {tab === "reject" && (
          <div className="p-6 space-y-4 border-t border-slate-100">
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">Mã Giao Nhận</label>
              <input
                value={refNumber}
                onChange={(e) => setRefNumber(e.target.value)}
                placeholder="VD: 26041602062639822062"
                className="w-full border rounded-xl px-3 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">Lý Do Từ Chối</label>
              <select
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                className="w-full border rounded-xl px-3 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
              >
                {REJECT_REASONS.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            <button
              onClick={rejectJob}
              disabled={!refNumber.trim() || rejectLoading}
              className="w-full py-3.5 rounded-xl font-bold text-white text-base bg-red-600 hover:bg-red-700 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              {rejectLoading ? "Đang huỷ..." : "Huỷ yêu cầu giao nhận"}
            </button>
            {rejectResult && (
              <div className={`rounded-xl p-3.5 text-sm font-medium text-center ${
                rejectResult.ok
                  ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
                  : "bg-red-50 border border-red-200 text-red-800"
              }`}>
                {rejectResult.msg}
              </div>
            )}
          </div>
        )}

        {tab === "customer" && (
          <div className="p-6 space-y-4 border-t border-slate-100">

            {/* Thông Tin Khách Hàng — search by code or name */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">Thông Tin Khách Hàng</label>
              <p className="text-[10.5px] text-slate-400 mb-1.5 leading-relaxed">
                Điền Client Code hoặc tên khách hàng
              </p>
              <div className="relative">
                <div className="relative">
                  <FieldIcon paths={ICON_SEARCH} />
                  <input
                    value={clientSearch}
                    onChange={(e) => { setClientSearch(e.target.value); setShowClientResults(true); }}
                    onFocus={() => { if (!clientSelected) setShowClientResults(true); }}
                    onBlur={() => setTimeout(() => setShowClientResults(false), 150)}
                    readOnly={clientSelected}
                    placeholder="Search..."
                    className={`w-full border rounded-xl pl-9 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-400 ${clientSelected ? "pr-8 cursor-default" : "pr-3"}`}
                  />
                  {clientSelected && (
                    <button
                      type="button"
                      onMouseDown={(e) => { e.preventDefault(); clearClient(); }}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                      aria-label="Xoá"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
                {showClientResults && !clientSelected && (clientSearchLoading || clientResults.length > 0) && (
                  <ul className="absolute z-10 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg max-h-64 overflow-y-auto">
                    {clientSearchLoading && clientResults.length === 0 && (
                      <li className="px-3 py-2 text-sm text-slate-400">Đang tìm...</li>
                    )}
                    {clientResults.map((r) => (
                      <li
                        key={r.code}
                        onMouseDown={(e) => { e.preventDefault(); selectClient(r); }}
                        className="px-3 py-2 text-sm hover:bg-slate-50 cursor-pointer border-b last:border-b-0 border-slate-100"
                      >
                        <span className="font-mono text-xs text-slate-500 mr-2">{r.code}</span>
                        <span className="font-medium text-slate-800">{r.client_legal_name}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {maKh && !maKhValid && (
                <p className="text-xs text-red-600 mt-1">Mã KH không hợp lệ.</p>
              )}
            </div>

            {/* Tên Khách Hàng — always locked, auto-filled from search */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">Tên Khách Hàng</label>
              <div className="relative flex items-center w-full border rounded-xl pl-9 pr-3 py-2.5 text-sm bg-slate-50 min-h-[38px]">
                <FieldIcon paths={ICON_USER} />
                <span className={tenKh ? "text-slate-800 font-medium" : "text-slate-400 italic"}>
                  {tenKh || "Tự động điền khi chọn khách hàng"}
                </span>
              </div>
            </div>

            {/* Quận Cũ */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">Quận Cũ</label>
              <p className="text-[10.5px] text-slate-400 mb-1.5 leading-relaxed">
                Với khu vực xa trung tâm, chọn tỉnh hoặc thành phố như Thuận An, Dĩ An, Bến Cát, Biên Hòa...
              </p>
              <div className="relative">
                <FieldIcon paths={ICON_PIN} />
                <select
                  value={quanCu}
                  onChange={(e) => setQuanCu(e.target.value)}
                  className="w-full border rounded-xl pl-9 pr-3 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-slate-400 appearance-none"
                >
                  <option value="">-- Chọn khu vực --</option>
                  {QUAN_CU_OPTIONS.map((o) => (
                    <option key={o.code} value={o.code}>{o.label} — {o.code}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Tên Đường */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">Tên Đường</label>
              <p className="text-[10.5px] text-slate-400 mb-1.5 leading-relaxed">
                Chỉ điền tên đường — không ghi "Đường" hay "Phố".<br />
                Đường Điện Biên Phủ → <span className="font-semibold">Điện Biên Phủ</span><br />
                Đường số 6 → <span className="font-semibold">6</span><br />
                Đường 3/2 → <span className="font-semibold">3/2</span><br />
                Đường Tỉnh Lộ 8 → <span className="font-semibold">Tỉnh Lộ 8</span>
              </p>
              <div className="relative">
                <FieldIcon paths={ICON_MAP} />
                <input
                  value={tenDuong}
                  onChange={(e) => setTenDuong(e.target.value)}
                  className="w-full border rounded-xl pl-9 pr-3 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
                />
              </div>
              {tenDuong && (
                <p className="text-xs text-slate-500 mt-1">
                  Viết tắt: <span className="font-semibold text-slate-700">{abbrStreet(tenDuong)}</span>
                </p>
              )}
            </div>

            {/* Địa Chỉ */}
            <div className="relative">
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">Địa Chỉ</label>
              <div className="relative">
                <FieldIcon paths={ICON_PIN} />
                <input
                  value={diaChi}
                  onChange={(e) => { setDiaChi(e.target.value); setShowPredictions(true); }}
                  onFocus={() => setShowPredictions(true)}
                  onBlur={() => setTimeout(() => setShowPredictions(false), 150)}
                  placeholder="Search..."
                  className="w-full border rounded-xl pl-9 pr-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
                />
              </div>
              {showPredictions && (predictionsLoading || predictions.length > 0) && (
                <ul className="absolute z-10 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg max-h-64 overflow-y-auto">
                  {predictionsLoading && predictions.length === 0 && (
                    <li className="px-3 py-2 text-sm text-slate-400">Đang tìm...</li>
                  )}
                  {predictions.map((p) => (
                    <li
                      key={p.place_id}
                      onMouseDown={(e) => { e.preventDefault(); selectPrediction(p); }}
                      className="px-3 py-2 text-sm hover:bg-slate-50 cursor-pointer border-b last:border-b-0 border-slate-100"
                    >
                      <div className="font-medium text-slate-800">
                        {p.structured_formatting?.main_text ?? p.description}
                      </div>
                      {p.structured_formatting?.secondary_text && (
                        <div className="text-xs text-slate-500 truncate">
                          {p.structured_formatting.secondary_text}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Số Điện Thoại */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">Số Điện Thoại Liên Hệ Nhận Mẫu</label>
              <div className="relative">
                <FieldIcon paths={ICON_PHONE} />
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
                  inputMode="tel"
                  placeholder="VD: 0909123456"
                  className="w-full border rounded-xl pl-9 pr-3 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
                />
              </div>
            </div>

            {customerName && (
              <div className="rounded-xl bg-slate-50 border border-slate-200 p-3">
                <p className="text-xs font-medium text-slate-500 mb-1">Tên trên Cartrack</p>
                <p className="text-sm font-semibold text-slate-800 break-words">{customerName}</p>
              </div>
            )}

            <button
              onClick={submit}
              disabled={!canSubmit}
              className="w-full py-3.5 rounded-xl font-bold text-white text-base bg-blue-600 hover:bg-blue-700 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              {loading ? "Đang kiểm tra & tạo..." : "Tạo khách hàng"}
            </button>

            {result && (
              <div className={`rounded-xl p-3.5 text-sm font-medium text-center ${
                result.ok
                  ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
                  : "bg-red-50 border border-red-200 text-red-800"
              }`}>
                {result.msg}
              </div>
            )}

            {duplicates && duplicates.length > 0 && (
              <div className="rounded-xl bg-amber-50 border border-amber-200 p-3.5 space-y-3">
                <p className="text-sm font-semibold text-amber-800">
                  Tìm thấy {duplicates.length} khách hàng có thể trùng:
                </p>
                <ul className="space-y-2">
                  {duplicates.map((d) => (
                    <li key={d.customer_id} className="text-xs text-amber-700">
                      <span className="font-mono break-all">{d.customer_name}</span>
                      {d.address_line_1 && (
                        <span className="block text-amber-600 mt-0.5">{d.address_line_1}</span>
                      )}
                    </li>
                  ))}
                </ul>
                <button
                  onClick={submitForce}
                  disabled={loading}
                  className="w-full py-3.5 rounded-xl font-bold text-white text-base bg-amber-600 hover:bg-amber-700 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                >
                  {loading ? "Đang tạo..." : "Khách hàng có nhiều địa điểm trên cùng đường"}
                </button>
              </div>
            )}

            {newCustomer && (
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-1.5">Ghi Chú Thêm</label>
                  <textarea
                    value={tripNote}
                    onChange={(e) => setTripNote(e.target.value)}
                    rows={2}
                    placeholder="VD: gọi trước khi đến, tầng 3..."
                    className="w-full border rounded-xl px-3 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-slate-400 resize-none"
                  />
                </div>
                <button
                  onClick={createTrip}
                  disabled={tripLoading}
                  className="w-full py-3.5 rounded-xl font-bold text-white text-base bg-indigo-600 hover:bg-indigo-700 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                >
                  {tripLoading ? "Đang tạo chuyến..." : "Tạo chuyến giao nhận"}
                </button>
              </div>
            )}

            {tripResult && (
              <div className={`rounded-xl p-3.5 text-sm font-medium text-center ${
                tripResult.ok
                  ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
                  : "bg-red-50 border border-red-200 text-red-800"
              }`}>
                {tripResult.msg}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
