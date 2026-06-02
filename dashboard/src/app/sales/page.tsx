"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Prediction = {
  place_id: string;
  description: string;
  structured_formatting?: { main_text?: string; secondary_text?: string };
  types?: string[];
  terms?: { offset?: number; value: string }[];
  compound?: { district?: string; commune?: string; province?: string };
};

type ClientResult = { code: string; client_legal_name: string };

type LastCreatedJob = {
  reference_number: string;
  pickup_customer_name: string;
  dropoff_psc: string;
};

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
  { label: "Cần Giờ",    code: "CGio"   },
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

// Goong district names that don't match a Quận Cũ label verbatim (normalized → code).
const DISTRICT_ALIASES: Record<string, string> = {
  "thu dau mot": "TD1", // label is "Thủ Dầu 1"
};

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

// Map a Goong compound.district name ("Quận 10", "Thành phố Thủ Đức",
// "Huyện Củ Chi") to a Quận Cũ option. Returns null if it isn't in the list.
function optionFromDistrict(district?: string): { label: string; code: string } | null {
  if (!district) return null;
  const norm = (s: string) => stripDiacritics(s).trim().toLowerCase().replace(/\s+/g, " ");
  const d = norm(district);
  const stripped = d.replace(/^(quan|huyen|thanh pho|thi xa|thi tran|tp\.?)\s+/, "");
  const aliasCode = DISTRICT_ALIASES[d] ?? DISTRICT_ALIASES[stripped];
  return (
    (aliasCode ? QUAN_CU_OPTIONS.find((o) => o.code === aliasCode) : null) ??
    QUAN_CU_OPTIONS.find((o) => norm(o.label) === d) ??
    QUAN_CU_OPTIONS.find((o) => norm(o.label) === stripped) ??
    null
  );
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

// Strip a leading house number + "Đường/Phố/Số" prefixes to leave a bare street.
// "341 Sư Vạn Hạnh" → "Sư Vạn Hạnh"; "414-416 Cao Thắng" → "Cao Thắng";
// "Đường số 6" → "6"; numbered streets ("3/2", "6") survive.
function cleanStreet(raw: string): string {
  let out = raw.trim();
  // Drop a leading house-number token (starts with a digit) when street words remain.
  const tokens = out.split(/\s+/);
  if (tokens.length > 1 && /^\d/.test(tokens[0])) {
    const rest = tokens.slice(1).join(" ").trim();
    if (/\p{L}/u.test(rest)) out = rest;
  }
  // Drop leading "Đường"/"Đ."/"Phố"/"Số" prefixes (e.g. "Đường số 6" → "6", "Đ. 3 Tháng 2" → "3 Tháng 2").
  let prev: string;
  do {
    prev = out;
    out = out.replace(/^(đường|đ\.?|phố|duong|pho|số|so)\s+/iu, "").trim();
  } while (out !== prev);
  return out;
}

// Derive a bare street name from a Goong prediction.
// The "<house number> <street>" line is the term that begins with a house number —
// admin terms (Phường/Quận/Thành phố) and POI/building names never start with a digit.
// Streets with no house number (types: street) fall back to main_text.
function streetFromPrediction(p: Prediction): string {
  const terms = (p.terms ?? []).map((t) => t.value.trim()).filter(Boolean);
  let candidate = terms.find((v) => /^\d\S*\s+\S/u.test(v)) ?? "";
  if (!candidate) {
    candidate = (p.structured_formatting?.main_text ?? p.description.split(",")[0] ?? "").trim();
  }
  return cleanStreet(candidate);
}

// --- District auto-detection (point-in-polygon) ---
type DistrictFeature = { properties: { code: string }; geometry: { type: string; coordinates: unknown } };
let districtsCache: DistrictFeature[] | null = null;

function raycast(pt: [number, number], ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function ptInGeom(lon: number, lat: number, geom: { type: string; coordinates: unknown }): boolean {
  const pt: [number, number] = [lon, lat];
  if (geom.type === "Polygon") return raycast(pt, (geom.coordinates as number[][][])[0]);
  if (geom.type === "MultiPolygon")
    return (geom.coordinates as number[][][][]).some(poly => raycast(pt, poly[0]));
  return false;
}

async function detectDistrict(lon: number, lat: number): Promise<string | null> {
  if (!districtsCache) {
    try {
      const res = await fetch("/geo/districts.geojson");
      if (!res.ok) return null;
      districtsCache = (await res.json()).features;
    } catch { return null; }
  }
  return districtsCache!.find(f => ptInGeom(lon, lat, f.geometry as { type: string; coordinates: unknown }))?.properties.code ?? null;
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
const ICON_PHONE = [
  "M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z",
];

const REJECT_REASONS = [
  "Khách hàng chưa có mẫu",
  "Khách hàng không còn nhu cầu gửi mẫu",
  "Đã book grab",
  "Book dư",
];

export default function SalesPage() {
  const [tab, setTab] = useState<"customer" | "reject">("customer");

  // Reject job state — manual reference entry (existing)
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

  // Last created trip — persisted in sessionStorage so refresh survives
  const SESSION_KEY = "sales_last_created_job";
  const [lastCreatedJob, setLastCreatedJobState] = useState<LastCreatedJob | null>(null);
  const [lastJobStatus, setLastJobStatus] = useState<number | null>(null);
  const [lastJobStatusLoading, setLastJobStatusLoading] = useState(false);
  const [lastJobCancelLoading, setLastJobCancelLoading] = useState(false);
  const [lastJobCancelResult, setLastJobCancelResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const setLastCreatedJob = (job: LastCreatedJob | null) => {
    setLastCreatedJobState(job);
    try {
      if (job) sessionStorage.setItem(SESSION_KEY, JSON.stringify(job));
      else sessionStorage.removeItem(SESSION_KEY);
    } catch { /* ignore */ }
  };

  // Restore from sessionStorage on mount
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(SESSION_KEY);
      if (saved) setLastCreatedJobState(JSON.parse(saved));
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshLastJobStatus = (job?: LastCreatedJob | null) => {
    const target = job ?? lastCreatedJob;
    if (!target) return;
    setLastJobStatusLoading(true);
    fetch(`/api/sales/job-status?ref=${encodeURIComponent(target.reference_number)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d?.job_status_id != null) setLastJobStatus(d.job_status_id); })
      .catch(() => {})
      .finally(() => setLastJobStatusLoading(false));
  };

  // Fetch live status once when cancel tab is opened
  useEffect(() => {
    if (tab !== "reject" || !lastCreatedJob) return;
    refreshLastJobStatus();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const rejectLastJob = async (overrideReason?: string) => {
    if (!lastCreatedJob) return;
    setLastJobCancelLoading(true);
    setLastJobCancelResult(null);
    try {
      const res = await fetch("/api/sales/reject-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference_number: lastCreatedJob.reference_number, reject_reason: overrideReason ?? rejectReason }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLastJobCancelResult({ ok: false, msg: data.error ?? "Huỷ thất bại" });
      } else {
        setLastJobCancelResult({ ok: true, msg: "Đã huỷ thành công" });
        setLastCreatedJob(null);
        setLastJobStatus(null);
      }
    } catch (e) {
      setLastJobCancelResult({ ok: false, msg: String(e) });
    } finally {
      setLastJobCancelLoading(false);
    }
  };

  // Customer form state
  const [maKh, setMaKh] = useState("");
  const [quanCu, setQuanCu] = useState("");
  const [tenDuong, setTenDuong] = useState("");
  const [showStreetModal, setShowStreetModal] = useState(false);
  const [tenKh, setTenKh] = useState("");
  const [diaChi, setDiaChi] = useState("");
  const [phone, setPhone] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");

  // Quận Cũ search
  const [quanSearch, setQuanSearch] = useState("");
  const [showQuanResults, setShowQuanResults] = useState(false);
  const [quanSelected, setQuanSelected] = useState(false);

  const filteredQuan = quanSearch.trim()
    ? QUAN_CU_OPTIONS.filter((o) => {
        const q = stripDiacritics(quanSearch).toLowerCase();
        return (
          stripDiacritics(o.label).toLowerCase().includes(q) ||
          o.code.toLowerCase().includes(q)
        );
      })
    : QUAN_CU_OPTIONS;

  const selectQuan = (o: { label: string; code: string }) => {
    setQuanCu(o.code);
    setQuanSearch(o.label);
    setQuanSelected(true);
    setShowQuanResults(false);
  };

  const clearQuan = () => {
    setQuanCu("");
    setQuanSearch("");
    setQuanSelected(false);
  };

  // When no option selected, abbreviate free text into quanCu (fallback)
  useEffect(() => {
    if (!quanSelected) setQuanCu(abbrStreet(quanSearch.trim()));
  }, [quanSearch, quanSelected]);

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
    const street = streetFromPrediction(p);
    setTenDuong(street);
    setShowStreetModal(true); // confirm the derived street
    // Quận Cũ: prefer Goong's compound.district; refresh on every pick.
    const goongOpt = optionFromDistrict(p.compound?.district);
    if (goongOpt) selectQuan(goongOpt);
    try {
      const res = await fetch(`/api/geo/place?place_id=${encodeURIComponent(p.place_id)}`);
      const data = await res.json();
      if (res.ok) {
        const latNum: number = data.latitude;
        const lonNum: number = data.longitude;
        setLat(String(latNum));
        setLon(String(lonNum));
        // Fall back to point-in-polygon only when Goong's district didn't map.
        if (!goongOpt) {
          const code = await detectDistrict(lonNum, latNum);
          if (code) {
            const option = QUAN_CU_OPTIONS.find(o => o.code === code);
            if (option) selectQuan(option);
          }
        }
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
        setQuanSearch(""); setQuanSelected(false);
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
    const forceName = [maKh, quanCu, abbr, lastPart].filter(Boolean).join(" - ");
    if (duplicates?.some((d) => d.customer_name.trim().toLowerCase() === forceName.trim().toLowerCase())) {
      setResult({ ok: false, msg: "Tên địa điểm trùng với địa điểm đã tồn tại. Vui lòng điền số nhà trong trường Địa Chỉ để phân biệt." });
      return;
    }
    doSubmit(forceName);
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
        const dropoff = data.dropoff_psc ? ` → Giao tại ${data.dropoff_psc}` : "";
        setTripResult({ ok: true, msg: `Tạo chuyến thành công${dropoff}` });
        setLastCreatedJob({
          reference_number: data.reference_number,
          pickup_customer_name: newCustomer.customer_name,
          dropoff_psc: data.dropoff_psc ?? "",
        });
        setLastJobStatus(2);
        setLastJobCancelResult(null);
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
            {tab === "customer" ? "Tạo địa điểm lấy mẫu cho khách hàng mới" : "Huỷ yêu cầu giao nhận"}
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
          <div className="p-6 space-y-5 border-t border-slate-100">

            {/* Last created job card */}
            {lastCreatedJob ? (
              <div className="space-y-3">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Chuyến vừa tạo</p>
                <div className="rounded-xl border border-slate-200 p-3.5 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-mono text-xs text-slate-500 break-all">{lastCreatedJob.reference_number}</p>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {lastJobStatusLoading ? (
                        <span className="text-xs text-slate-400">...</span>
                      ) : lastJobStatus != null ? (
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                          lastJobStatus === 4 ? "bg-blue-100 text-blue-700" :
                          lastJobStatus === 5 ? "bg-emerald-100 text-emerald-700" :
                          lastJobStatus === 7 ? "bg-slate-100 text-slate-500" :
                          "bg-amber-100 text-amber-700"
                        }`}>
                          {lastJobStatus === 4 ? "Đã phân công" :
                           lastJobStatus === 5 ? "Hoàn thành" :
                           lastJobStatus === 7 ? "Đã huỷ" :
                           "Chờ phân công"}
                        </span>
                      ) : null}
                      <button
                        onClick={() => refreshLastJobStatus()}
                        disabled={lastJobStatusLoading}
                        className="text-slate-400 hover:text-slate-600 disabled:opacity-40 transition-colors"
                        aria-label="Làm mới trạng thái"
                      >
                        <svg className={`w-3.5 h-3.5 ${lastJobStatusLoading ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <div className="space-y-1 text-sm">
                    <div className="flex gap-2">
                      <span className="text-[10px] font-bold uppercase text-slate-400 pt-0.5 w-8 shrink-0">LẤY</span>
                      <span className="text-slate-800 font-medium">{lastCreatedJob.pickup_customer_name}</span>
                    </div>
                    {lastCreatedJob.dropoff_psc && (
                      <div className="flex gap-2">
                        <span className="text-[10px] font-bold uppercase text-slate-400 pt-0.5 w-8 shrink-0">GIAO</span>
                        <span className="text-slate-800 font-medium">{lastCreatedJob.dropoff_psc}</span>
                      </div>
                    )}
                  </div>
                  {!lastJobCancelResult?.ok && lastJobStatus !== 5 && lastJobStatus !== 7 && (
                    <>
                      <select
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        className="w-full border rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
                      >
                        {REJECT_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                      <button
                        onClick={() => rejectLastJob()}
                        disabled={lastJobCancelLoading}
                        className="w-full py-2.5 rounded-xl font-bold text-white text-sm bg-red-600 hover:bg-red-700 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                      >
                        {lastJobCancelLoading ? "Đang huỷ..." : "Huỷ chuyến này"}
                      </button>
                    </>
                  )}
                  {lastJobCancelResult && (
                    <div className={`rounded-xl p-3 text-sm font-medium text-center ${
                      lastJobCancelResult.ok
                        ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
                        : "bg-red-50 border border-red-200 text-red-800"
                    }`}>
                      {lastJobCancelResult.msg}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-400 text-center py-2">Chưa có chuyến nào được tạo trong phiên này</p>
            )}

            <div className="border-t border-slate-100 pt-5 space-y-4">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Huỷ bằng Mã Giao Nhận</p>
              <input
                value={refNumber}
                onChange={(e) => setRefNumber(e.target.value)}
                placeholder="Dán Mã Giao Nhận Từ SPC"
                className="w-full border rounded-xl px-3 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
              <select
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                className="w-full border rounded-xl px-3 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
              >
                {REJECT_REASONS.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
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

            {/* Địa Chỉ */}
            <div className="relative">
              <label className="block text-sm font-semibold text-slate-700 mb-1">Địa Chỉ</label>
              <p className="text-[10.5px] text-slate-400 mb-1.5 leading-relaxed">
                Sẽ hiển thị trên giao diện của khách hàng.
              </p>
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

            {/* Quận Cũ */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">Quận Cũ</label>
              <p className="text-[10.5px] text-slate-400 mb-1.5 leading-relaxed">
                Với khu vực xa trung tâm, chọn tỉnh hoặc thành phố như Thuận An, Dĩ An, Bến Cát, Biên Hòa...
              </p>
              <div className="relative">
                <div className="relative">
                  <input
                    value={quanSearch}
                    onChange={(e) => { setQuanSearch(e.target.value); setShowQuanResults(true); }}
                    onFocus={() => { if (!quanSelected) setShowQuanResults(true); }}
                    onBlur={() => setTimeout(() => setShowQuanResults(false), 150)}
                    readOnly={quanSelected}
                    className={`w-full border rounded-xl pl-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-400 ${quanSelected ? "pr-8 cursor-default" : "pr-3"}`}
                  />
                  {quanSelected && (
                    <button
                      type="button"
                      onMouseDown={(e) => { e.preventDefault(); clearQuan(); }}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                      aria-label="Xoá"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
                {showQuanResults && !quanSelected && filteredQuan.length > 0 && (
                  <ul className="absolute z-10 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg max-h-64 overflow-y-auto">
                    {filteredQuan.map((o) => (
                      <li
                        key={o.code}
                        onMouseDown={(e) => { e.preventDefault(); selectQuan(o); }}
                        className="px-3 py-2 text-sm hover:bg-slate-50 cursor-pointer border-b last:border-b-0 border-slate-100"
                      >
                        <span className="font-medium text-slate-800">{o.label}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {/* Tên Đường — auto-derived from the address pick, confirmed via popup */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">Tên Đường</label>
              {tenDuong ? (
                <button
                  type="button"
                  onClick={() => setShowStreetModal(true)}
                  className="w-full flex items-center justify-between gap-2 border rounded-xl px-3 py-3 bg-slate-50 text-left hover:bg-slate-100 transition-colors"
                >
                  <span className="text-base font-medium text-slate-800 break-words">
                    {tenDuong}
                    <span className="text-slate-400 font-normal text-sm"> · {abbrStreet(tenDuong)}</span>
                  </span>
                  <span className="text-xs font-semibold text-blue-600 shrink-0">Sửa</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowStreetModal(true)}
                  className="w-full border border-dashed rounded-xl px-3 py-3 text-sm text-slate-500 hover:bg-slate-50 transition-colors text-left"
                >
                  Chọn địa chỉ ở trên để tự lấy tên đường, hoặc bấm để nhập
                </button>
              )}
            </div>

            {/* Street confirm popup */}
            {showStreetModal && (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
                onClick={() => setShowStreetModal(false)}
              >
                <div
                  className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5 space-y-3"
                  onClick={(e) => e.stopPropagation()}
                >
                  <h3 className="text-base font-bold text-slate-800">Xác nhận tên đường</h3>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    Chỉ tên đường — không số nhà, không "Đường"/"Phố".<br />
                    VD: Sư Vạn Hạnh · 3/2 · Tỉnh Lộ 8
                  </p>
                  <input
                    value={tenDuong}
                    onChange={(e) => setTenDuong(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && tenDuong.trim()) setShowStreetModal(false); }}
                    autoFocus
                    placeholder="VD: Sư Vạn Hạnh"
                    className="w-full border rounded-xl px-3 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
                  />
                  {tenDuong.trim() && (
                    <p className="text-xs text-slate-500">
                      Viết tắt: <span className="font-semibold text-slate-700">{abbrStreet(tenDuong)}</span>
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowStreetModal(false)}
                    disabled={!tenDuong.trim()}
                    className="w-full py-3 rounded-xl font-bold text-white text-base bg-blue-600 hover:bg-blue-700 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                  >
                    Xác nhận
                  </button>
                </div>
              </div>
            )}

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
              {loading ? "Đang kiểm tra & tạo..." : "Tạo địa điểm lấy mẫu cho khách hàng mới"}
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
                  {tripLoading ? "Đang tạo chuyến..." : "Khách hàng có mẫu, tạo yêu cầu giao nhận"}
                </button>
              </div>
            )}

            {tripResult && (
              <div className="space-y-2">
                <div className={`rounded-xl p-3.5 text-sm font-medium text-center ${
                  tripResult.ok
                    ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
                    : "bg-red-50 border border-red-200 text-red-800"
                }`}>
                  {tripResult.msg}
                </div>
                {tripResult.ok && lastCreatedJob && !lastJobCancelResult?.ok && (
                  <button
                    onClick={() => rejectLastJob("Khách hàng chưa có mẫu")}
                    disabled={lastJobCancelLoading}
                    className="w-full py-2.5 rounded-xl font-semibold text-red-600 text-sm border border-red-200 bg-white hover:bg-red-50 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                  >
                    {lastJobCancelLoading ? "Đang huỷ..." : "Huỷ — Khách hàng chưa có mẫu"}
                  </button>
                )}
                {lastJobCancelResult?.ok && (
                  <div className="rounded-xl p-3 text-sm font-medium text-center bg-slate-50 border border-slate-200 text-slate-600">
                    {lastJobCancelResult.msg}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
