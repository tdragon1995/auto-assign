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

// A real Phòng Khám/Bác Sĩ name must contain at least one letter. A bare client
// code (all digits) or any "full number" name is not usable for sample handover.
function hasLetters(s: string): boolean {
  return /\p{L}/u.test(s);
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

// Client lookup against Labcenter, shared by the "Khách hàng mới" and
// "Cập nhật SĐT" tabs. The parent owns what a pick means; this only handles
// the search box, the dropdown and the clear button. Remount it (via `key`)
// to reset the query after a successful submit.
// `onSelectCode` opts into a fallback: some clients have live locations in
// spc-delivery but are missing from the spc-pos client list (e.g. 22303), so the
// search can never find them. When it's set and a numeric query returns nothing,
// offer to look the code up directly. Only the phone tab wants this — creating a
// customer still requires a client that actually exists in the list.
function ClientSearch({
  display,
  selected,
  onSelect,
  onClear,
  onBlurUnselected,
  onSelectCode,
}: {
  display: string;
  selected: boolean;
  onSelect: (r: ClientResult) => void;
  onClear: () => void;
  onBlurUnselected?: () => void;
  onSelectCode?: (code: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ClientResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (selected) return;
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    const ac = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/labcenter/client?q=${encodeURIComponent(q)}`, { signal: ac.signal });
        const data = await res.json();
        if (res.ok) setResults(data.results ?? []);
      } catch {
        // aborted or network — ignore
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => { clearTimeout(t); ac.abort(); };
  }, [query, selected]);

  const clear = () => {
    setQuery("");
    setResults([]);
    onClear();
  };

  const codeQuery = query.trim();
  const showCodeFallback =
    !!onSelectCode && !loading && results.length === 0 && /^\d{4,8}$/.test(codeQuery);

  return (
    <div className="relative">
      <div className="relative">
        <FieldIcon paths={ICON_SEARCH} />
        <input
          value={selected ? display : query}
          onChange={(e) => { setQuery(e.target.value); setShowResults(true); }}
          onFocus={() => { if (!selected) setShowResults(true); }}
          onBlur={() => {
            setTimeout(() => setShowResults(false), 150);
            if (!selected && query.trim()) onBlurUnselected?.();
          }}
          readOnly={selected}
          placeholder="Search..."
          className={`w-full border rounded-xl pl-9 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-400 ${selected ? "pr-8 cursor-default" : "pr-3"}`}
        />
        {selected && (
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); clear(); }}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            aria-label="Xoá"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
      {showResults && !selected && (loading || results.length > 0 || showCodeFallback) && (
        <ul className="absolute z-10 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg max-h-64 overflow-y-auto">
          {loading && results.length === 0 && (
            <li className="px-3 py-2 text-sm text-slate-400">Đang tìm...</li>
          )}
          {results.map((r) => (
            <li
              key={r.code}
              onMouseDown={(e) => { e.preventDefault(); onSelect(r); setShowResults(false); }}
              className="px-3 py-2 text-sm hover:bg-slate-50 cursor-pointer border-b last:border-b-0 border-slate-100"
            >
              <span className="font-mono text-xs text-slate-500 mr-2">{r.code}</span>
              <span className="font-medium text-slate-800">{r.client_legal_name}</span>
            </li>
          ))}
          {showCodeFallback && (
            <li
              onMouseDown={(e) => { e.preventDefault(); onSelectCode!(codeQuery); setShowResults(false); }}
              className="px-3 py-2 hover:bg-slate-50 cursor-pointer"
            >
              <p className="text-sm font-medium text-slate-800">
                Tra địa điểm theo mã KH <span className="font-mono">{codeQuery}</span>
              </p>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Không tìm thấy trong danh sách khách hàng — tìm trực tiếp theo mã.
              </p>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

type SalesLocation = { id: number; name: string; phone: string; address: string };

export default function SalesPage() {
  const [tab, setTab] = useState<"customer" | "phone" | "address" | "reject">("customer");

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

  // ── Cập nhật SĐT tab ──────────────────────────────────────────────────────
  const [phClientSearch, setPhClientSearch] = useState("");
  const [phClientSelected, setPhClientSelected] = useState(false);
  const [phLocations, setPhLocations] = useState<SalesLocation[]>([]);
  const [phLocationsLoading, setPhLocationsLoading] = useState(false);
  const [phLocationId, setPhLocationId] = useState<number | null>(null);
  const [phNewPhone, setPhNewPhone] = useState("");
  const [phLoading, setPhLoading] = useState(false);
  const [phResult, setPhResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const phSelectedLocation = phLocations.find((l) => l.id === phLocationId) ?? null;
  const phPhoneValid = phNewPhone.length >= 9 && phNewPhone.length <= 11;
  // Nothing to do if the number already matches what's on file.
  const phUnchanged =
    !!phSelectedLocation && phSelectedLocation.phone.replace(/\D/g, "") === phNewPhone;

  const phLoadLocations = async (code: string, label: string) => {
    setPhClientSearch(label);
    setPhClientSelected(true);
    setPhLocationId(null);
    setPhNewPhone("");
    setPhResult(null);
    setPhLocationsLoading(true);
    setPhLocations([]);
    try {
      const res = await fetch(`/api/sales/locations?client_code=${encodeURIComponent(code)}`);
      const data = await res.json();
      if (res.ok) setPhLocations(data.locations ?? []);
      else setPhResult({ ok: false, msg: data.error ?? "Không tải được danh sách địa điểm" });
    } catch (e) {
      setPhResult({ ok: false, msg: String(e) });
    } finally {
      setPhLocationsLoading(false);
    }
  };

  const phSelectClient = (r: ClientResult) =>
    phLoadLocations(r.code, `${r.code} — ${r.client_legal_name}`);

  const phClearClient = () => {
    setPhClientSearch("");
    setPhClientSelected(false);
    setPhLocations([]);
    setPhLocationId(null);
    setPhNewPhone("");
    setPhResult(null);
  };

  const submitPhone = async () => {
    if (phLocationId == null || !phPhoneValid || phLoading) return;
    setPhLoading(true);
    setPhResult(null);
    try {
      const res = await fetch("/api/sales/locations", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location_id: phLocationId, phone: phNewPhone }),
      });
      const data = await res.json();
      if (!res.ok) {
        // A partial failure leaves the two systems disagreeing — name which
        // side landed so the user knows what a retry still has to fix.
        const parts: string[] = [];
        if (data.labcenter) parts.push(`Labcenter: ${data.labcenter.ok ? "đã cập nhật" : "thất bại"}`);
        if (data.cartrack) parts.push(`Cartrack: ${data.cartrack.ok ? "đã cập nhật" : "thất bại"}`);
        setPhResult({
          ok: false,
          msg: parts.length ? `${data.error} (${parts.join(" · ")})` : (data.error ?? "Cập nhật thất bại"),
        });
      } else {
        setPhResult({ ok: true, msg: `Đã cập nhật SĐT thành ${data.phone} trên Cartrack và Labcenter.` });
        // Reflect the new number locally so the row shows the updated value.
        setPhLocations((prev) =>
          prev.map((l) => (l.id === phLocationId ? { ...l, phone: data.phone } : l)),
        );
      }
    } catch (e) {
      setPhResult({ ok: false, msg: String(e) });
    } finally {
      setPhLoading(false);
    }
  };

  // ── Cập nhật địa chỉ tab ──────────────────────────────────────────────────
  const [adClientSearch, setAdClientSearch] = useState("");
  const [adClientSelected, setAdClientSelected] = useState(false);
  const [adLocations, setAdLocations] = useState<SalesLocation[]>([]);
  const [adLocationsLoading, setAdLocationsLoading] = useState(false);
  const [adLocationId, setAdLocationId] = useState<number | null>(null);
  // The new address, picked from Goong. Coords only come from a real pick, so a
  // typed-but-unpicked string can't submit (no coordinates to send).
  const [adAddress, setAdAddress] = useState("");
  const [adLat, setAdLat] = useState<number | null>(null);
  const [adLon, setAdLon] = useState<number | null>(null);
  const [adPredictions, setAdPredictions] = useState<Prediction[]>([]);
  const [adShowPredictions, setAdShowPredictions] = useState(false);
  const [adPredLoading, setAdPredLoading] = useState(false);
  const adSkipFetch = useRef(false);
  const [adLoading, setAdLoading] = useState(false);
  const [adResult, setAdResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const adSelectedLocation = adLocations.find((l) => l.id === adLocationId) ?? null;
  const adHasNewCoords = adLat != null && adLon != null;

  const adLoadLocations = async (code: string, label: string) => {
    setAdClientSearch(label);
    setAdClientSelected(true);
    setAdLocationId(null);
    setAdAddress(""); setAdLat(null); setAdLon(null);
    setAdResult(null);
    setAdLocationsLoading(true);
    setAdLocations([]);
    try {
      const res = await fetch(`/api/sales/locations?client_code=${encodeURIComponent(code)}`);
      const data = await res.json();
      if (res.ok) setAdLocations(data.locations ?? []);
      else setAdResult({ ok: false, msg: data.error ?? "Không tải được danh sách địa điểm" });
    } catch (e) {
      setAdResult({ ok: false, msg: String(e) });
    } finally {
      setAdLocationsLoading(false);
    }
  };

  const adClearClient = () => {
    setAdClientSearch(""); setAdClientSelected(false);
    setAdLocations([]); setAdLocationId(null);
    setAdAddress(""); setAdLat(null); setAdLon(null);
    setAdResult(null);
  };

  // Goong autocomplete for the new address (same proxy the new-customer tab uses).
  useEffect(() => {
    if (adSkipFetch.current) { adSkipFetch.current = false; return; }
    const q = adAddress.trim();
    if (q.length < 3) { setAdPredictions([]); return; }
    const ac = new AbortController();
    const t = setTimeout(async () => {
      setAdPredLoading(true);
      try {
        const res = await fetch(`/api/geo/autocomplete?input=${encodeURIComponent(q)}`, { signal: ac.signal });
        const data = await res.json();
        if (res.ok) setAdPredictions(data.predictions ?? []);
      } catch { /* aborted or network — ignore */ } finally {
        setAdPredLoading(false);
      }
    }, 250);
    return () => { clearTimeout(t); ac.abort(); };
  }, [adAddress]);

  const adSelectPrediction = async (p: Prediction) => {
    adSkipFetch.current = true;
    setAdAddress(p.description);
    setAdShowPredictions(false);
    setAdPredictions([]);
    setAdLat(null); setAdLon(null);
    try {
      const res = await fetch(`/api/geo/place?place_id=${encodeURIComponent(p.place_id)}`);
      const data = await res.json();
      if (res.ok) { setAdLat(data.latitude); setAdLon(data.longitude); }
    } catch { /* user can re-pick */ }
  };

  const submitAddress = async () => {
    if (adLocationId == null || !adAddress.trim() || !adHasNewCoords || adLoading) return;
    setAdLoading(true);
    setAdResult(null);
    try {
      const res = await fetch("/api/sales/address", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location_id: adLocationId,
          address_line_1: adAddress.trim(),
          latitude: adLat,
          longitude: adLon,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Partial failure — name which side landed so the user knows what a
        // retry still has to fix, matching the phone tab.
        const parts: string[] = [];
        if (data.cartrack) parts.push(`Cartrack: ${data.cartrack.ok ? "đã cập nhật" : "thất bại"}`);
        if (data.labcenter) parts.push(`Labcenter: ${data.labcenter.ok ? "đã cập nhật" : "thất bại"}`);
        setAdResult({
          ok: false,
          msg: parts.length ? `${data.error} (${parts.join(" · ")})` : (data.error ?? "Cập nhật thất bại"),
        });
      } else {
        setAdResult({
          ok: true,
          msg: `Đã cập nhật địa chỉ & toạ độ trên Cartrack và Labcenter (${data.latitude}, ${data.longitude}).`,
        });
        setAdLocations((prev) =>
          prev.map((l) => (l.id === adLocationId ? { ...l, address: data.address_line_1 } : l)),
        );
      }
    } catch (e) {
      setAdResult({ ok: false, msg: String(e) });
    } finally {
      setAdLoading(false);
    }
  };

  // Customer form state
  const [maKh, setMaKh] = useState("");
  const [quanCu, setQuanCu] = useState("");
  const [tenDuong, setTenDuong] = useState("");
  const [showStreetModal, setShowStreetModal] = useState(false);
  const [addressPicked, setAddressPicked] = useState(false);
  const [showClientNameModal, setShowClientNameModal] = useState(false);
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
  const [clientSelected, setClientSelected] = useState(false);
  const [clientBlurred, setClientBlurred] = useState(false);
  // Bumped on a successful submit to remount ClientSearch with an empty query.
  const [clientSearchKey, setClientSearchKey] = useState(0);

  const selectClient = (r: ClientResult) => {
    const name = CLIENT_OVERRIDES[r.code] ?? r.client_legal_name;
    setMaKh(r.code);
    setTenKh(name);
    setClientSearch(`${r.code} — ${r.client_legal_name}`);
    setClientSelected(true);
    // Only force the confirm/override prompt when Labcenter has no real name on
    // file (the legal name is just the numeric client code). A proper name is
    // accepted as-is; the user can still edit it via the "Sửa" button.
    if (!hasLetters(name)) setShowClientNameModal(true);
  };

  const clearClient = () => {
    setMaKh("");
    setTenKh("");
    setClientSearch("");
    setClientSelected(false);
    setClientBlurred(false);
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
    setAddressPicked(true); // reveal Quận Cũ + Tên Đường
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
  const [duplicates, setDuplicates] = useState<{ customer_id: string; customer_name: string; address_line_1?: string; distance_m?: number }[] | null>(null);
  // A blocked duplicate sits within 100m of an existing location — same place.
  // Unlike the plain warning, there is no force path out of it.
  const [duplicateBlocked, setDuplicateBlocked] = useState(false);
  // Snapshot of what was submitted, kept visible after submit for troubleshooting.
  const [lastSubmitted, setLastSubmitted] = useState<{
    name: string; maKh: string; quanCu: string; tenDuong: string; abbr: string;
    tenKh: string; phone: string; diaChi: string; coords: string;
  } | null>(null);

  const maKhValid = /^\d{5,8}$/.test(maKh);
  const hasCoords = !Number.isNaN(parseFloat(lat)) && !Number.isNaN(parseFloat(lon));
  // Customer name is mandatory and must not be a bare number — it has to carry a
  // real Phòng Khám/Bác Sĩ name so drivers can hand over samples.
  const nameValid = hasLetters(tenKh);

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
    nameValid &&
    phone.trim() &&
    hasCoords &&
    !loading;

  const doSubmit = async (forceName?: string) => {
    if (!canSubmit) return;
    const name = forceName ?? customerName;
    setLoading(true);
    setResult(null);
    setLastSubmitted({
      name, maKh, quanCu, tenDuong, abbr: abbrStreet(tenDuong),
      tenKh, phone, diaChi: diaChi.trim(),
      coords: hasCoords ? `${parseFloat(lat)}, ${parseFloat(lon)}` : "(chưa có)",
    });
    try {
      const payload: Record<string, unknown> = {
        customer_name: name,
        address_line_1: diaChi.trim() || undefined,
        contact_number: phone.trim() || undefined,
        check_prefix: checkPrefix,
        client_code: maKh,
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
          setDuplicateBlocked(!!data.blocked);
          if (data.blocked) setResult({ ok: false, msg: data.error });
        } else {
          setResult({ ok: false, msg: data.error ?? "Lỗi không xác định" });
        }
      } else {
        setResult({ ok: true, msg: `Tạo địa điểm lấy mẫu thành công: ${data.customer?.customer_name ?? name}` });
        setDuplicates(null);
        setDuplicateBlocked(false);
        setMaKh(""); setQuanCu(""); setTenDuong(""); setTenKh(""); setDiaChi(""); setLat(""); setLon(""); setPhone("");
        setClientSearch(""); setClientSelected(false); setClientSearchKey((k) => k + 1);
        setQuanSearch(""); setQuanSelected(false);
        setAddressPicked(false); setShowStreetModal(false); setShowClientNameModal(false);
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

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col items-center p-4 gap-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow border overflow-hidden">
        <div className="px-6 pt-5 pb-4">
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">Sales</p>
          <h1 className="text-xl font-bold text-slate-800 mt-0.5">
            {tab === "customer"
              ? "Tạo địa điểm lấy mẫu cho khách hàng mới"
              : tab === "phone"
              ? "Cập nhật số điện thoại liên hệ"
              : tab === "address"
              ? "Cập nhật địa chỉ & toạ độ"
              : "Huỷ yêu cầu giao nhận"}
          </h1>
        </div>

        <div className="grid grid-cols-4 border-t border-slate-100">
          {([
            ["customer", "KH mới"],
            ["phone", "SĐT"],
            ["address", "Địa chỉ"],
            ["reject", "Huỷ"],
          ] as const).map(([key, label], i) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`py-2.5 text-xs font-semibold transition-colors ${i > 0 ? "border-l border-slate-100" : ""} ${
                tab === key ? "bg-blue-600 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "address" && (
          <div className="p-6 space-y-4 border-t border-slate-100 min-h-[340px]">
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">Thông Tin Khách Hàng</label>
              <p className="text-[10.5px] text-slate-400 mb-1.5 leading-relaxed">
                Điền Client Code hoặc tên khách hàng
              </p>
              <ClientSearch
                display={adClientSearch}
                selected={adClientSelected}
                onSelect={(r) => adLoadLocations(r.code, `${r.code} — ${r.client_legal_name}`)}
                onClear={adClearClient}
                onSelectCode={(code) => adLoadLocations(code, `${code} — (tra theo mã)`)}
              />
            </div>

            {adClientSelected && (
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">Chọn Địa Điểm</label>
                {adLocationsLoading ? (
                  <p className="text-sm text-slate-400 py-2">Đang tải địa điểm...</p>
                ) : adLocations.length === 0 ? (
                  <p className="text-sm text-slate-500 py-2">Khách hàng này chưa có địa điểm nào.</p>
                ) : (
                  <ul className="border border-slate-200 rounded-xl divide-y divide-slate-100 max-h-60 overflow-y-auto">
                    {adLocations.map((l) => (
                      <li key={l.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setAdLocationId(l.id);
                            setAdAddress(""); setAdLat(null); setAdLon(null);
                            setAdResult(null);
                          }}
                          className={`w-full text-left px-3 py-2.5 transition-colors ${
                            adLocationId === l.id ? "bg-blue-50" : "hover:bg-slate-50"
                          }`}
                        >
                          <p className="text-sm font-medium text-slate-800 break-words">{l.name}</p>
                          <p className="text-[11px] text-slate-400 mt-0.5 break-words">
                            {l.address || "(chưa có địa chỉ)"}
                          </p>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {adSelectedLocation && (
              <div className="relative">
                <label className="block text-sm font-semibold text-slate-700 mb-1">Địa Chỉ Mới</label>
                <p className="text-[10.5px] text-slate-400 mb-1.5 leading-relaxed">
                  Chọn từ gợi ý để lấy toạ độ mới. Toạ độ quyết định điểm tài xế đến.
                </p>
                <div className="relative">
                  <FieldIcon paths={ICON_PIN} />
                  <input
                    value={adAddress}
                    onChange={(e) => { setAdAddress(e.target.value); setAdShowPredictions(true); }}
                    onFocus={() => setAdShowPredictions(true)}
                    onBlur={() => setTimeout(() => setAdShowPredictions(false), 150)}
                    placeholder="Tìm địa chỉ mới..."
                    className="w-full border rounded-xl pl-9 pr-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
                  />
                </div>
                {adShowPredictions && (adPredLoading || adPredictions.length > 0) && (
                  <ul className="absolute z-10 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg max-h-64 overflow-y-auto">
                    {adPredLoading && adPredictions.length === 0 && (
                      <li className="px-3 py-2 text-sm text-slate-400">Đang tìm...</li>
                    )}
                    {adPredictions.map((p) => (
                      <li
                        key={p.place_id}
                        onMouseDown={(e) => { e.preventDefault(); adSelectPrediction(p); }}
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
            )}

            {adSelectedLocation && adHasNewCoords && (
              <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 space-y-2 text-xs">
                <div>
                  <p className="text-slate-400">Địa chỉ hiện tại</p>
                  <p className="font-medium text-slate-600 break-words">{adSelectedLocation.address || "(trống)"}</p>
                </div>
                <div>
                  <p className="text-blue-500">Địa chỉ mới</p>
                  <p className="font-semibold text-slate-800 break-words">{adAddress}</p>
                  <p className="text-slate-500 mt-0.5">Toạ độ: {adLat}, {adLon}</p>
                </div>
              </div>
            )}

            {adSelectedLocation && (
              <button
                onClick={submitAddress}
                disabled={!adHasNewCoords || adLoading}
                className="w-full py-3.5 rounded-xl font-bold text-white text-base bg-blue-600 hover:bg-blue-700 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                {adLoading ? "Đang cập nhật..." : "Cập nhật địa chỉ & toạ độ"}
              </button>
            )}

            {adResult && (
              <div className={`rounded-xl p-3.5 text-sm font-medium text-center ${
                adResult.ok
                  ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
                  : "bg-red-50 border border-red-200 text-red-800"
              }`}>
                {adResult.msg}
              </div>
            )}
          </div>
        )}

        {tab === "phone" && (
          // min-height keeps the client-search dropdown from being clipped by
          // the card's overflow-hidden while this tab is still just one field.
          <div className="p-6 space-y-4 border-t border-slate-100 min-h-[340px]">
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">Thông Tin Khách Hàng</label>
              <p className="text-[10.5px] text-slate-400 mb-1.5 leading-relaxed">
                Điền Client Code hoặc tên khách hàng
              </p>
              <ClientSearch
                display={phClientSearch}
                selected={phClientSelected}
                onSelect={phSelectClient}
                onClear={phClearClient}
                onSelectCode={(code) => phLoadLocations(code, `${code} — (tra theo mã)`)}
              />
            </div>

            {phClientSelected && (
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">Chọn Địa Điểm</label>
                {phLocationsLoading ? (
                  <p className="text-sm text-slate-400 py-2">Đang tải địa điểm...</p>
                ) : phLocations.length === 0 ? (
                  <p className="text-sm text-slate-500 py-2">Khách hàng này chưa có địa điểm nào.</p>
                ) : (
                  <ul className="border border-slate-200 rounded-xl divide-y divide-slate-100 max-h-72 overflow-y-auto">
                    {phLocations.map((l) => (
                      <li key={l.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setPhLocationId(l.id);
                            setPhNewPhone(l.phone.replace(/\D/g, ""));
                            setPhResult(null);
                          }}
                          className={`w-full text-left px-3 py-2.5 transition-colors ${
                            phLocationId === l.id ? "bg-blue-50" : "hover:bg-slate-50"
                          }`}
                        >
                          <p className="text-sm font-medium text-slate-800 break-words">{l.name}</p>
                          <p className="text-xs text-slate-500 mt-0.5">
                            SĐT hiện tại: <span className="font-semibold text-slate-700">{l.phone || "(trống)"}</span>
                          </p>
                          {l.address && (
                            <p className="text-[11px] text-slate-400 mt-0.5 break-words">{l.address}</p>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {phSelectedLocation && (
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">Số Điện Thoại Mới</label>
                <div className="relative">
                  <FieldIcon paths={ICON_PHONE} />
                  <input
                    value={phNewPhone}
                    onChange={(e) => setPhNewPhone(e.target.value.replace(/\D/g, ""))}
                    inputMode="tel"
                    placeholder="VD: 0909123456"
                    className="w-full border rounded-xl pl-9 pr-3 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
                  />
                </div>
                {phNewPhone && !phPhoneValid && (
                  <p className="text-xs text-red-600 mt-1">Số điện thoại phải có 9–11 chữ số.</p>
                )}
                <p className="text-[10.5px] text-slate-400 mt-1.5 leading-relaxed">
                  Cập nhật đồng thời trên Cartrack (tài xế nhìn thấy) và Labcenter (khách hàng nhìn thấy).
                </p>
              </div>
            )}

            {phSelectedLocation && (
              <button
                onClick={submitPhone}
                disabled={!phPhoneValid || phUnchanged || phLoading}
                className="w-full py-3.5 rounded-xl font-bold text-white text-base bg-blue-600 hover:bg-blue-700 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                {phLoading ? "Đang cập nhật..." : phUnchanged ? "Số điện thoại không thay đổi" : "Cập nhật số điện thoại"}
              </button>
            )}

            {phResult && (
              <div className={`rounded-xl p-3.5 text-sm font-medium text-center ${
                phResult.ok
                  ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
                  : "bg-red-50 border border-red-200 text-red-800"
              }`}>
                {phResult.msg}
              </div>
            )}
          </div>
        )}

        {tab === "reject" && (
          <div className="p-6 space-y-4 border-t border-slate-100">
            <div className="space-y-4">
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
              <ClientSearch
                key={clientSearchKey}
                display={clientSearch}
                selected={clientSelected}
                onSelect={selectClient}
                onClear={clearClient}
                onBlurUnselected={() => setClientBlurred(true)}
              />
              {clientBlurred && !clientSelected && (
                <p className="text-xs text-red-600 mt-1">Vui lòng chọn khách hàng từ danh sách gợi ý.</p>
              )}
              {maKh && !maKhValid && (
                <p className="text-xs text-red-600 mt-1">Mã KH không hợp lệ.</p>
              )}
            </div>

            {/* Tên Khách Hàng — confirmed via popup after picking a client */}
            {clientSelected && (
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">Tên Khách Hàng</label>
                <button
                  type="button"
                  onClick={() => setShowClientNameModal(true)}
                  className={`w-full flex items-center justify-between gap-2 border rounded-xl px-3 py-3 bg-slate-50 text-left hover:bg-slate-100 transition-colors ${
                    nameValid ? "" : "border-red-300"
                  }`}
                >
                  <span className="text-base font-medium text-slate-800 break-words">
                    {tenKh || <span className="text-slate-400 font-normal">(chưa có tên — bấm để nhập)</span>}
                  </span>
                  <span className="text-xs font-semibold text-blue-600 shrink-0">Sửa</span>
                </button>
                {!nameValid && (
                  <p className="text-xs text-red-600 mt-1">
                    Điền đúng tên Phòng Khám/Bác Sĩ để thuận tiện giao nhận mẫu.
                  </p>
                )}
              </div>
            )}

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

            {/* Quận Cũ — appears after an address is picked (auto-filled, editable) */}
            {addressPicked && (
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
            )}

            {/* Tên Đường — auto-derived from the address pick, confirmed via popup */}
            {addressPicked && (
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
                  Không lấy được tên đường — bấm để nhập
                </button>
              )}
            </div>
            )}

            {/* Client name confirm popup — mandatory: only the "Xác nhận"
                button (enabled once a real name is entered) can dismiss it. */}
            {showClientNameModal && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
                <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5 space-y-3">
                  <h3 className="text-base font-bold text-slate-800">Xác nhận tên khách hàng</h3>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    Điền đúng tên Phòng Khám/Bác Sĩ để thuận tiện giao nhận mẫu.
                  </p>
                  <input
                    value={tenKh}
                    onChange={(e) => setTenKh(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && nameValid) setShowClientNameModal(false); }}
                    autoFocus
                    placeholder="VD: PK Đa Khoa Sài Gòn"
                    className={`w-full border rounded-xl px-3 py-3 text-base bg-white focus:outline-none focus:ring-2 ${
                      tenKh.trim() && !nameValid
                        ? "border-red-300 focus:ring-red-400"
                        : "focus:ring-slate-400"
                    }`}
                  />
                  {tenKh.trim() && !nameValid && (
                    <p className="text-xs text-red-600">
                      Tên không được chỉ gồm số — điền đúng tên Phòng Khám/Bác Sĩ.
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowClientNameModal(false)}
                    disabled={!nameValid}
                    className="w-full py-3 rounded-xl font-bold text-white text-base bg-blue-600 hover:bg-blue-700 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                  >
                    Xác nhận
                  </button>
                </div>
              </div>
            )}

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

            {!hasCoords && maKhValid && quanCu.trim() && tenDuong.trim() && nameValid && phone.trim() && (
              <p className="text-xs text-amber-600 font-medium -mt-1">
                ⚠ Chọn Địa Chỉ từ gợi ý để lấy toạ độ — bắt buộc để tạo địa điểm và yêu cầu giao nhận.
              </p>
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

            {lastSubmitted && (
              <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 text-xs text-slate-600 space-y-0.5">
                <p className="font-semibold text-slate-500 mb-1">Dữ liệu đã nhập</p>
                <p>• Tên tạo: <span className="font-medium text-slate-800 break-words">{lastSubmitted.name}</span></p>
                <p>• Mã KH: <span className="font-medium text-slate-800">{lastSubmitted.maKh || "(trống)"}</span></p>
                <p>• Quận Cũ: <span className="font-medium text-slate-800">{lastSubmitted.quanCu || "(trống)"}</span></p>
                <p>• Tên đường: <span className="font-medium text-slate-800">{lastSubmitted.tenDuong || "(trống)"}</span> → {lastSubmitted.abbr || "(trống)"}</p>
                <p>• Tên KH: <span className="font-medium text-slate-800">{lastSubmitted.tenKh || "(trống)"}</span></p>
                <p>• SĐT: <span className="font-medium text-slate-800">{lastSubmitted.phone || "(trống)"}</span></p>
                <p>• Địa chỉ: <span className="font-medium text-slate-800 break-words">{lastSubmitted.diaChi || "(trống)"}</span></p>
                <p>• Toạ độ: <span className="font-medium text-slate-800">{lastSubmitted.coords}</span></p>
              </div>
            )}

            {duplicates && duplicates.length > 0 && (
              duplicateBlocked ? (
                // Within 100m of an existing location — no force button, because
                // the server rejects the force path for this case too.
                <div className="rounded-xl bg-red-50 border border-red-200 p-3.5 space-y-3">
                  <p className="text-sm font-semibold text-red-800">
                    Không thể tạo — đã có địa điểm ở ngay vị trí này:
                  </p>
                  <ul className="space-y-2">
                    {duplicates.map((d) => (
                      <li key={d.customer_id} className="text-xs text-red-700">
                        <span className="font-mono break-all">{d.customer_name}</span>
                        {d.distance_m != null && (
                          <span className="block font-semibold text-red-800 mt-0.5">
                            Cách {d.distance_m}m
                          </span>
                        )}
                        {d.address_line_1 && (
                          <span className="block text-red-600 mt-0.5">{d.address_line_1}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                  <p className="text-[11px] text-red-600 leading-relaxed">
                    Nếu đây thật sự là địa điểm khác, hãy kiểm tra lại toạ độ trên bản đồ.
                    Để đổi số điện thoại của địa điểm đã có, dùng tab <span className="font-semibold">Cập nhật SĐT</span>.
                  </p>
                </div>
              ) : (
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
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}
