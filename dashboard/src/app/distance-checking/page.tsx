"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";

interface Row {
  pickup: string;
  dropoff: string;
  lat1: number;
  lon1: number;
  lat2: number;
  lon2: number;
  // Original coordinate text exactly as typed/uploaded. parseFloat→String()
  // strips trailing zeros (e.g. "106.7200000" → "106.72") and can round very
  // long values, so we keep the raw strings for display and CSV export.
  lat1Raw: string;
  lon1Raw: string;
  lat2Raw: string;
  lon2Raw: string;
}

interface Result extends Row {
  distance_km: number | null;
  duration_mins: number | null;
  error?: string;
}

// Shape we actually rely on from the API — only the computed fields. The echoed
// coordinates are ignored in favour of the original raw strings.
interface ApiResult {
  distance_km: number | null;
  duration_mins: number | null;
  error?: string;
}

// Quote a CSV cell if it contains a comma, quote, or newline (RFC 4180).
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// Each line: "lat1 long1 lat2 long2" (space/tab/comma separated, no header)
function parseText(text: string): { rows: Row[]; errors: string[] } {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, "").trim()).filter(Boolean);
  if (lines.length === 0) return { rows: [], errors: ["Không có dữ liệu"] };

  const rows: Row[] = [];
  const errors: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cols = lines[i].split(/[\t,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (cols.length < 4) { errors.push(`Dòng ${i + 1}: cần 4 giá trị (lat1 long1 lat2 long2)`); continue; }
    const lat1 = parseFloat(cols[0]);
    const lon1 = parseFloat(cols[1]);
    const lat2 = parseFloat(cols[2]);
    const lon2 = parseFloat(cols[3]);
    if ([lat1, lon1, lat2, lon2].some(isNaN)) { errors.push(`Dòng ${i + 1}: toạ độ không hợp lệ`); continue; }
    rows.push({
      pickup: String(i + 1), dropoff: "", lat1, lon1, lat2, lon2,
      lat1Raw: cols[0], lon1Raw: cols[1], lat2Raw: cols[2], lon2Raw: cols[3],
    });
  }
  return { rows, errors };
}

function toCSV(results: Result[]): string {
  const header = "lat1,long1,lat2,long2,distance_km,duration_mins,error";
  const lines = results.map((r) =>
    [r.lat1Raw, r.lon1Raw, r.lat2Raw, r.lon2Raw, r.distance_km ?? "", r.duration_mins ?? "", csvCell(r.error ?? "")].join(",")
  );
  return "\uFEFF" + [header, ...lines].join("\n");
}

export default function DistanceCheckingPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows]           = useState<Row[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [fileName, setFileName]   = useState("");
  const [pasteText, setPasteText] = useState("");
  const [status, setStatus]       = useState<"idle" | "loading" | "done" | "error">("idle");
  const [results, setResults]     = useState<Result[]>([]);
  const [progress, setProgress]   = useState(0);
  const [runError, setRunError]   = useState("");

  const applyText = (text: string) => {
    setResults([]);
    setStatus("idle");
    setRunError("");
    const { rows: parsed, errors } = parseText(text);
    setRows(parsed);
    setParseErrors(errors);
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setPasteText("");
    const reader = new FileReader();
    reader.onload = (ev) => applyText(ev.target?.result as string);
    reader.readAsText(file, "utf-8");
  };

  const handlePaste = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setFileName("");
    setPasteText(e.target.value);
    applyText(e.target.value);
  };

  const run = async () => {
    if (rows.length === 0) return;
    setStatus("loading");
    setResults([]);
    setProgress(0);
    setRunError("");

    const CHUNK = 50;
    // Order indices by pickup so identical pickups cluster into the same chunk
    // and the server can collapse them into one matrix call.
    const order = rows
      .map((r, i) => ({ i, key: `${r.lat1.toFixed(6)},${r.lon1.toFixed(6)}` }))
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((o) => o.i);

    // Fill results back at their original positions for stable display/CSV order.
    const byOriginal: (Result | undefined)[] = new Array(rows.length);
    let done = 0;
    try {
      for (let i = 0; i < order.length; i += CHUNK) {
        const idxChunk = order.slice(i, i + CHUNK);
        const chunk = idxChunk.map((idx) => rows[idx]);
        const res = await fetch("/api/distance-checking", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows: chunk }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Unknown error");
        // Merge computed fields onto the original row so the raw coordinate
        // strings (full precision) survive — never trust the echoed coords.
        (data.results as ApiResult[]).forEach((r, j) => {
          const orig = rows[idxChunk[j]];
          byOriginal[idxChunk[j]] = {
            ...orig,
            distance_km: r.distance_km,
            duration_mins: r.duration_mins,
            error: r.error,
          };
        });
        done += idxChunk.length;
        setProgress(done);
        setResults(byOriginal.filter((r): r is Result => r != null));
      }
      setStatus("done");
    } catch (e) {
      setRunError(String(e));
      setStatus("error");
    }
  };

  const download = () => {
    const csv = toCSV(results);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `distances_${(fileName || "result").replace(/\.csv$/i, "")}_result.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const successCount = results.filter((r) => r.distance_km != null).length;
  const failCount    = results.filter((r) => r.distance_km == null).length;

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-5xl mx-auto space-y-6">

        <div>
          <h1 className="text-2xl font-bold">Kiểm tra khoảng cách</h1>
          <p className="text-sm text-slate-500 mt-1">
            Mỗi dòng: <code className="bg-slate-100 px-1 rounded text-xs">lat1 long1 lat2 long2</code> — ngăn cách bởi khoảng trắng, tab, hoặc dấu phẩy. Không cần header.
          </p>
        </div>

        {/* Upload */}
        <div
          className="border-2 border-dashed border-slate-300 rounded-xl p-6 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/40 transition-colors"
          onClick={() => { if (fileRef.current) fileRef.current.value = ""; fileRef.current?.click(); }}
        >
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleFile} />
          <p className="text-sm text-slate-500">
            {fileName ? `📄 ${fileName}` : "Nhấn để upload CSV"}
          </p>
        </div>

        <div className="flex items-center gap-3 text-xs text-slate-400">
          <div className="flex-1 h-px bg-slate-200" />
          hoặc paste từ Excel bên dưới
          <div className="flex-1 h-px bg-slate-200" />
        </div>

        {/* Paste area */}
        <textarea
          className="w-full h-36 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-mono text-slate-700 resize-y focus:outline-none focus:ring-2 focus:ring-blue-400"
          placeholder={"10.77 106.68 10.85 106.72\n10.80 106.70 10.90 106.75"}
          value={pasteText}
          onChange={handlePaste}
        />

        {/* Row count */}
        {rows.length > 0 && (
          <p className="text-xs text-slate-500">{rows.length} dòng hợp lệ</p>
        )}

        {/* Parse errors */}
        {parseErrors.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1">
            {parseErrors.map((e, i) => (
              <p key={i} className="text-xs text-amber-800">{e}</p>
            ))}
          </div>
        )}

        {/* Preview */}
        {rows.length > 0 && (
          <div className="rounded-lg border bg-white overflow-x-auto">
            <table className="w-full text-xs min-w-[600px]">
              <thead className="bg-slate-50 border-b text-slate-500 uppercase tracking-wide">
                <tr>
                  <th className="px-3 py-2 text-right">#</th>
                  <th className="px-3 py-2 text-right">Lat 1</th>
                  <th className="px-3 py-2 text-right">Long 1</th>
                  <th className="px-3 py-2 text-right">Lat 2</th>
                  <th className="px-3 py-2 text-right">Long 2</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.slice(0, 10).map((r, i) => (
                  <tr key={i} className="hover:bg-slate-50/60">
                    <td className="px-3 py-2 text-right text-slate-400">{r.pickup}</td>
                    <td className="px-3 py-2 text-right text-slate-500">{r.lat1Raw}</td>
                    <td className="px-3 py-2 text-right text-slate-500">{r.lon1Raw}</td>
                    <td className="px-3 py-2 text-right text-slate-500">{r.lat2Raw}</td>
                    <td className="px-3 py-2 text-right text-slate-500">{r.lon2Raw}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 10 && (
              <p className="text-xs text-slate-400 px-3 py-2 border-t">…và {rows.length - 10} dòng khác</p>
            )}
          </div>
        )}

        {/* Run button */}
        {rows.length > 0 && (
          <Button onClick={run} disabled={status === "loading"} className="w-full h-12 text-base font-semibold">
            {status === "loading"
              ? `Đang tính… ${progress}/${rows.length} tuyến`
              : `🛵 Tính khoảng cách (${rows.length} tuyến)`}
          </Button>
        )}

        {status === "error" && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{runError}</div>
        )}

        {/* Results */}
        {results.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex gap-2 text-sm flex-wrap">
                <span className="rounded-full bg-green-100 text-green-700 px-3 py-1 font-medium">✓ {successCount} thành công</span>
                {failCount > 0 && <span className="rounded-full bg-red-100 text-red-700 px-3 py-1 font-medium">✗ {failCount} lỗi</span>}
              </div>
              <Button variant="outline" size="sm" onClick={download}>⬇ Tải CSV</Button>
            </div>

            <div className="rounded-lg border bg-white overflow-x-auto">
              <table className="w-full text-xs min-w-[480px]">
                <thead className="bg-slate-50 border-b text-slate-500 uppercase tracking-wide">
                  <tr>
                    <th className="px-3 py-2 text-right">#</th>
                    <th className="px-3 py-2 text-right">Lat 1</th>
                    <th className="px-3 py-2 text-right">Long 1</th>
                    <th className="px-3 py-2 text-right">Lat 2</th>
                    <th className="px-3 py-2 text-right">Long 2</th>
                    <th className="px-3 py-2 text-right">Km</th>
                    <th className="px-3 py-2 text-right">Phút</th>
                    <th className="px-3 py-2 text-left">Ghi chú</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {results.map((r, i) => (
                    <tr key={i} className={r.error ? "bg-red-50/40" : "hover:bg-slate-50/60"}>
                      <td className="px-3 py-2 text-right text-slate-400">{r.pickup}</td>
                      <td className="px-3 py-2 text-right text-slate-400 font-mono text-[11px]">{r.lat1Raw}</td>
                      <td className="px-3 py-2 text-right text-slate-400 font-mono text-[11px]">{r.lon1Raw}</td>
                      <td className="px-3 py-2 text-right text-slate-400 font-mono text-[11px]">{r.lat2Raw}</td>
                      <td className="px-3 py-2 text-right text-slate-400 font-mono text-[11px]">{r.lon2Raw}</td>
                      <td className="px-3 py-2 text-right font-mono">
                        {r.distance_km != null ? r.distance_km : <span className="text-red-400">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {r.duration_mins != null ? r.duration_mins : <span className="text-red-400">—</span>}
                      </td>
                      <td className="px-3 py-2 text-slate-400 text-[11px]">{r.error ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
