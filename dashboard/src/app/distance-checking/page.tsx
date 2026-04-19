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
}

interface Result extends Row {
  distance_km: number | null;
  duration_mins: number | null;
  error?: string;
}

// Auto-detects tab (Excel paste) or comma (CSV) separator
function parseText(text: string): { rows: Row[]; errors: string[] } {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, "").trim()).filter(Boolean);
  if (lines.length < 2) return { rows: [], errors: ["Cần ít nhất 1 dòng dữ liệu (không kể header)"] };

  const sep = lines[0].includes("\t") ? "\t" : ",";
  const headers = lines[0].split(sep).map((h) => h.trim().toLowerCase());
  const required = ["pickup", "dropoff", "lat1", "long1", "lat2", "long2"];
  const missing = required.filter((h) => !headers.includes(h));
  if (missing.length) return { rows: [], errors: [`Thiếu cột: ${missing.join(", ")}`] };

  const rows: Row[] = [];
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(sep);
    if (cols.length < 6) { errors.push(`Dòng ${i + 1}: không đủ 6 cột`); continue; }

    if (sep === "\t") {
      // Tab-separated: columns are clean, use header index
      const idx = (name: string) => headers.indexOf(name);
      const pickup  = cols[idx("pickup")]?.trim() ?? "";
      const dropoff = cols[idx("dropoff")]?.trim() ?? "";
      const lat1    = parseFloat(cols[idx("lat1")]?.trim() ?? "");
      const lon1    = parseFloat(cols[idx("long1")]?.trim() ?? "");
      const lat2    = parseFloat(cols[idx("lat2")]?.trim() ?? "");
      const lon2    = parseFloat(cols[idx("long2")]?.trim() ?? "");
      if (!pickup)                             { errors.push(`Dòng ${i + 1}: thiếu pickup`); continue; }
      if ([lat1, lon1, lat2, lon2].some(isNaN)) { errors.push(`Dòng ${i + 1} (${pickup}): toạ độ không hợp lệ`); continue; }
      rows.push({ pickup, dropoff, lat1, lon1, lat2, lon2 });
    } else {
      // CSV: names may contain commas — last 4 cols are always coords,
      // second-to-last text col = dropoff, everything before = pickup
      const lon2    = parseFloat(cols[cols.length - 1].trim());
      const lat2    = parseFloat(cols[cols.length - 2].trim());
      const lon1    = parseFloat(cols[cols.length - 3].trim());
      const lat1    = parseFloat(cols[cols.length - 4].trim());
      const textCols = cols.slice(0, cols.length - 4);
      const dropoff  = textCols[textCols.length - 1]?.trim() ?? "";
      const pickup   = textCols.slice(0, textCols.length - 1).join(",").trim();
      if (!pickup)                             { errors.push(`Dòng ${i + 1}: thiếu pickup`); continue; }
      if ([lat1, lon1, lat2, lon2].some(isNaN)) { errors.push(`Dòng ${i + 1} (${pickup}): toạ độ không hợp lệ`); continue; }
      rows.push({ pickup, dropoff, lat1, lon1, lat2, lon2 });
    }
  }

  return { rows, errors };
}

function toCSV(results: Result[]): string {
  const header = "pickup,dropoff,lat1,long1,lat2,long2,distance_km,duration_mins,error";
  const lines = results.map((r) =>
    [`"${r.pickup}"`, `"${r.dropoff}"`, r.lat1, r.lon1, r.lat2, r.lon2,
      r.distance_km ?? "", r.duration_mins ?? "", r.error ?? ""].join(",")
  );
  // UTF-8 BOM so Excel opens correctly
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

    const CHUNK = 20;
    const accumulated: Result[] = [];
    try {
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const res = await fetch("/api/distance-checking", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows: chunk }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Unknown error");
        accumulated.push(...data.results);
        setProgress(accumulated.length);
        setResults([...accumulated]);
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
            6 cột: <code className="bg-slate-100 px-1 rounded text-xs">pickup, dropoff, lat1, long1, lat2, long2</code>
            {" "}— upload CSV hoặc paste thẳng từ Excel
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
          placeholder={"pickup\tdropoff\tlat1\tlong1\tlat2\tlong2\nD001\tD007\t10.77\t106.68\t10.85\t106.72"}
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
                  <th className="px-3 py-2 text-left">Pickup</th>
                  <th className="px-3 py-2 text-left">Dropoff</th>
                  <th className="px-3 py-2 text-right">Lat 1</th>
                  <th className="px-3 py-2 text-right">Long 1</th>
                  <th className="px-3 py-2 text-right">Lat 2</th>
                  <th className="px-3 py-2 text-right">Long 2</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.slice(0, 10).map((r, i) => (
                  <tr key={i} className="hover:bg-slate-50/60">
                    <td className="px-3 py-2 font-medium text-slate-800">{r.pickup}</td>
                    <td className="px-3 py-2 text-slate-600">{r.dropoff}</td>
                    <td className="px-3 py-2 text-right text-slate-500">{r.lat1}</td>
                    <td className="px-3 py-2 text-right text-slate-500">{r.lon1}</td>
                    <td className="px-3 py-2 text-right text-slate-500">{r.lat2}</td>
                    <td className="px-3 py-2 text-right text-slate-500">{r.lon2}</td>
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
              <table className="w-full text-xs min-w-[640px]">
                <thead className="bg-slate-50 border-b text-slate-500 uppercase tracking-wide">
                  <tr>
                    <th className="px-3 py-2 text-left">Pickup</th>
                    <th className="px-3 py-2 text-left">Dropoff</th>
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
                      <td className="px-3 py-2 font-medium text-slate-800">{r.pickup}</td>
                      <td className="px-3 py-2 text-slate-600">{r.dropoff}</td>
                      <td className="px-3 py-2 text-right text-slate-400 font-mono text-[11px]">{r.lat1}</td>
                      <td className="px-3 py-2 text-right text-slate-400 font-mono text-[11px]">{r.lon1}</td>
                      <td className="px-3 py-2 text-right text-slate-400 font-mono text-[11px]">{r.lat2}</td>
                      <td className="px-3 py-2 text-right text-slate-400 font-mono text-[11px]">{r.lon2}</td>
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
