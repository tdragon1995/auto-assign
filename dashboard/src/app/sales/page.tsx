"use client";

import { useMemo, useState } from "react";

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
    .replace(/[\u0300-\u036f]/g, "")
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

  const [maKh, setMaKh] = useState("");
  const [quanCu, setQuanCu] = useState("");
  const [tenDuong, setTenDuong] = useState("");
  const [tenKh, setTenKh] = useState("");
  const [diaChi, setDiaChi] = useState("");
  const [phone, setPhone] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [mapLink, setMapLink] = useState("");
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkError, setLinkError] = useState("");

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [newCustomer, setNewCustomer] = useState<{ customer_id: string; customer_name: string; lat: number; lon: number; ma_kh: string } | null>(null);
  const [tripLoading, setTripLoading] = useState(false);
  const [tripResult, setTripResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const extractFromLink = async () => {
    const url = mapLink.trim();
    if (!url) return;
    setLinkLoading(true);
    setLinkError("");
    try {
      // Client-side fast path
      const patterns = [
        /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
        /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
        /[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
        /[?&]ll=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
      ];
      for (const re of patterns) {
        const m = url.match(re);
        if (m) {
          setLat(m[1]);
          setLon(m[2]);
          setLinkLoading(false);
          return;
        }
      }
      // Short link — resolve server-side
      const res = await fetch("/api/geo/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLinkError(data.error ?? "Không đọc được link");
        return;
      }
      setLat(String(data.latitude));
      setLon(String(data.longitude));
    } catch (e) {
      setLinkError(String(e));
    } finally {
      setLinkLoading(false);
    }
  };

  const maKhValid = /^\d{5,8}$/.test(maKh);

  const customerName = useMemo(() => {
    const abbr = abbrStreet(tenDuong);
    const parts = [maKh, quanCu, abbr, `${tenKh} ${tenDuong}`.trim()].filter(Boolean);
    return parts.join(" - ");
  }, [maKh, quanCu, tenDuong, tenKh]);

  const canSubmit =
    maKhValid &&
    quanCu.trim() &&
    tenDuong.trim() &&
    tenKh.trim() &&
    !loading;

  const submit = async () => {
    if (!canSubmit) return;
    setLoading(true);
    setResult(null);
    try {
      const payload: Record<string, unknown> = {
        customer_name: customerName,
        address_line_1: diaChi.trim() || undefined,
        contact_number: phone.trim() || undefined,
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
        setResult({ ok: false, msg: data.error ?? "Lỗi không xác định" });
      } else {
        setResult({ ok: true, msg: "Tạo địa điểm lấy mẫu thành công, SPC sẽ được cập nhật sau." });
        const latNum = parseFloat(lat);
        const lonNum = parseFloat(lon);
        if (data.customer?.customer_id && !Number.isNaN(latNum) && !Number.isNaN(lonNum)) {
          setNewCustomer({
            customer_id: data.customer.customer_id,
            customer_name: data.customer.customer_name ?? customerName,
            lat: latNum,
            lon: lonNum,
            ma_kh: maKh,
          });
          setTripResult(null);
        }
        setMaKh(""); setQuanCu(""); setTenDuong(""); setTenKh(""); setDiaChi(""); setLat(""); setLon(""); setPhone("");
      }
    } catch (e) {
      setResult({ ok: false, msg: String(e) });
    } finally {
      setLoading(false);
    }
  };

  const createTrip = async () => {
    if (!newCustomer) return;
    setTripLoading(true);
    setTripResult(null);
    try {
      const res = await fetch("/api/sales/create-trip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newCustomer),
      });
      const data = await res.json();
      if (!res.ok) {
        setTripResult({ ok: false, msg: data.error ?? "Tạo chuyến thất bại" });
      } else {
        setTripResult({
          ok: true,
          msg: "Đã tạo chuyến, liên hệ điều phối để biết thêm thông tin!",
        });
        setNewCustomer(null);
      }
    } catch (e) {
      setTripResult({ ok: false, msg: String(e) });
    } finally {
      setTripLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col items-center p-4 gap-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow border overflow-hidden">
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
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">Mã giao nhận</label>
              <input
                value={refNumber}
                onChange={(e) => setRefNumber(e.target.value)}
                placeholder="VD: 26041602062639822062"
                className="w-full border rounded-xl px-3 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">Lý do từ chối</label>
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
              <div
                className={`rounded-xl p-3.5 text-sm font-medium text-center ${
                  rejectResult.ok
                    ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
                    : "bg-red-50 border border-red-200 text-red-800"
                }`}
              >
                {rejectResult.msg}
              </div>
            )}
          </div>
        )}

        {tab === "customer" && (
        <div className="p-6 space-y-4 border-t border-slate-100">
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1.5">Mã KH</label>
            <input
              value={maKh}
              onChange={(e) => setMaKh(e.target.value.replace(/\D/g, ""))}
              inputMode="numeric"
              placeholder="5-8 chữ số"
              className="w-full border rounded-xl px-3 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
            {maKh && !maKhValid && (
              <p className="text-xs text-red-600 mt-1">Mã KH phải là số, 5-8 chữ số.</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1.5">Quận Cũ</label>
            <select
              value={quanCu}
              onChange={(e) => setQuanCu(e.target.value)}
              className="w-full border rounded-xl px-3 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
            >
              <option value="">-- Chọn khu vực --</option>
              {QUAN_CU_OPTIONS.map((o) => (
                <option key={o.code} value={o.code}>{o.label} — {o.code}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1.5">Tên Đường</label>
            <input
              value={tenDuong}
              onChange={(e) => setTenDuong(e.target.value)}
              placeholder="VD: Điện Biên Phủ"
              className="w-full border rounded-xl px-3 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
            {tenDuong && (
              <p className="text-xs text-slate-500 mt-1">
                Viết tắt: <span className="font-semibold text-slate-700">{abbrStreet(tenDuong)}</span>
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1.5">Tên khách hàng</label>
            <input
              value={tenKh}
              onChange={(e) => setTenKh(e.target.value)}
              className="w-full border rounded-xl px-3 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1.5">Địa chỉ</label>
            <textarea
              value={diaChi}
              onChange={(e) => setDiaChi(e.target.value)}
              rows={2}
              className="w-full border rounded-xl px-3 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-slate-400 resize-none"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1.5">Số điện thoại liên hệ nhận mẫu</label>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
              inputMode="tel"
              placeholder="VD: 0909123456"
              className="w-full border rounded-xl px-3 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1.5">Google Maps link</label>
            <div className="flex gap-2">
              <input
                value={mapLink}
                onChange={(e) => setMapLink(e.target.value)}
                placeholder="Dán link Google Maps"
                className="flex-1 border rounded-xl px-3 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
              <button
                type="button"
                onClick={extractFromLink}
                disabled={linkLoading || !mapLink.trim()}
                className="px-4 rounded-xl bg-slate-800 text-white text-sm font-semibold disabled:opacity-40"
              >
                {linkLoading ? "..." : "Lấy"}
              </button>
            </div>
            {linkError && <p className="text-xs text-red-600 mt-1">{linkError}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">Vĩ độ</label>
              <input
                value={lat}
                onChange={(e) => setLat(e.target.value)}
                inputMode="decimal"
                placeholder="10.7626"
                className="w-full border rounded-xl px-3 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">Kinh độ</label>
              <input
                value={lon}
                onChange={(e) => setLon(e.target.value)}
                inputMode="decimal"
                placeholder="106.6602"
                className="w-full border rounded-xl px-3 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
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
            <div
              className={`rounded-xl p-3.5 text-sm font-medium text-center ${
                result.ok
                  ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
                  : "bg-red-50 border border-red-200 text-red-800"
              }`}
            >
              {result.msg}
            </div>
          )}

          {newCustomer && (
            <button
              onClick={createTrip}
              disabled={tripLoading}
              className="w-full py-3.5 rounded-xl font-bold text-white text-base bg-indigo-600 hover:bg-indigo-700 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              {tripLoading ? "Đang tạo chuyến..." : "Tạo chuyến giao nhận"}
            </button>
          )}

          {tripResult && (
            <div
              className={`rounded-xl p-3.5 text-sm font-medium text-center ${
                tripResult.ok
                  ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
                  : "bg-red-50 border border-red-200 text-red-800"
              }`}
            >
              {tripResult.msg}
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
