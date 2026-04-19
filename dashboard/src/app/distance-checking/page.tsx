"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";

interface Row {
  route: string;
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

function parseCSV(text: string): { rows: Row[]; errors: string[] } {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, "").trim()).filter(Boolean);
  if (lines.length < 2) return { rows: [], errors: ["File phải có ít nhất 1 dòng dữ liệu"] };

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const required = ["route", "lat1", "long1", "lat2", "long2"];
  const missing = required.filter((h) => !headers.includes(h));
  if (missing.length) return { rows: [], errors: [`Thiếu cột: ${missing.join(", ")}`] };

  const rows: Row[] = [];
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 5) { errors.push(`Dòng ${i + 1}: không đủ 5 cột`); continue; }
    // Take last 4 as coords; everything before is the route name (handles commas in name)
    const lon2  = parseFloat(cols[cols.length - 1].trim());
    const lat2  = parseFloat(cols[cols.length - 2].trim());
    const lon1  = parseFloat(cols[cols.length - 3].trim());
    const lat1  = parseFloat(cols[cols.length - 4].trim());
    const route = cols.slice(0, cols.length - 4).join(",").trim();

    if (!route) { errors.push(`Dòng ${i + 1}: thiếu tên route`); continue; }
    if ([lat1, lon1, lat2, lon2].some(isNaN)) { errors.push(`Dòng ${i + 1} (${route}): toạ độ không hợp lệ`); continue; }

    rows.push({ route, lat1, lon1, lat2, lon2 });
  }

  return { rows, errors };
}

function toCSV(results: Result[]): string {
  const header = "route,lat1,long1,lat2,long2,distance_km,duration_mins,error";
  const lines = results.map((r) =>
    [r.route, r.lat1, r.lon1, r.lat2, r.lon2, r.distance_km ?? "", r.duration_mins ?? "", r.error ?? ""].join(",")
  );
  return [header, ...lines].join("\n");
}

export default function DistanceCheckingPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows]       = useState<Row[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [fileName, setFileName] = useState("");
  const [status, setStatus]   = useState<"idle" | "loading" | "done" | "error">("idle");
  const [results, setResults] = useState<Result[]>([]);
  const [runError, setRunError] = useState("");

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setResults([]);
    setStatus("idle");
    setRunError("");

    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const { rows: parsed, errors } = parseCSV(text);
      setRows(parsed);
      setParseErrors(errors);
    };
    reader.readAsText(file, "utf-8");
  };

  const run = async () => {
    if (rows.length === 0) return;
    setStatus("loading");
    setRunError("");
    try {
      const res = await fetch("/api/distance-checking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unknown error");
      setResults(data.results);
      setStatus("done");
    } catch (e) {
      setRunError(String(e));
      setStatus("error");
    }
  };

  const download = () => {
    const csv = toCSV(results);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `distances_${fileName.replace(/\.csv$/i, "")}_result.csv`;
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
            Upload CSV với 5 cột: <code className="bg-slate-100 px-1 rounded text-xs">route, lat1, long1, lat2, long2</code>
          </p>
        </div>

        {/* Upload */}
        <div
          className="border-2 border-dashed border-slate-300 rounded-xl p-8 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/40 transition-colors"
          onClick={() => { if (fileRef.current) fileRef.current.value = ""; fileRef.current?.click(); }}
        >
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleFile} />
          {fileName ? (
            <p className="text-sm font-medium text-slate-700">📄 {fileName} — {rows.length} dòng hợp lệ</p>
          ) : (
            <p className="text-sm text-slate-400">Nhấn để chọn file CSV</p>
          )}
        </div>

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
            <table className="w-full text-xs min-w-[500px]">
              <thead className="bg-slate-50 border-b text-slate-500 uppercase tracking-wide">
                <tr>
                  <th className="px-3 py-2 text-left">Route</th>
                  <th className="px-3 py-2 text-right">Lat 1</th>
                  <th className="px-3 py-2 text-right">Long 1</th>
                  <th className="px-3 py-2 text-right">Lat 2</th>
                  <th className="px-3 py-2 text-right">Long 2</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.slice(0, 10).map((r, i) => (
                  <tr key={i} className="hover:bg-slate-50/60">
                    <td className="px-3 py-2 font-medium text-slate-800">{r.route}</td>
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
          <Button
            onClick={run}
            disabled={status === "loading"}
            className="w-full h-12 text-base font-semibold"
          >
            {status === "loading" ? `Đang tính… (${rows.length} tuyến)` : `🛵 Tính khoảng cách (${rows.length} tuyến)`}
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
              <table className="w-full text-xs min-w-[600px]">
                <thead className="bg-slate-50 border-b text-slate-500 uppercase tracking-wide">
                  <tr>
                    <th className="px-3 py-2 text-left">Route</th>
                    <th className="px-3 py-2 text-right">Khoảng cách (km)</th>
                    <th className="px-3 py-2 text-right">Thời gian (phút)</th>
                    <th className="px-3 py-2 text-left">Ghi chú</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {results.map((r, i) => (
                    <tr key={i} className={r.error ? "bg-red-50/40" : "hover:bg-slate-50/60"}>
                      <td className="px-3 py-2 font-medium text-slate-800">{r.route}</td>
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
