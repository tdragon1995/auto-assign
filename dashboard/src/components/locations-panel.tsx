"use client";

import { useEffect, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { Button } from "./ui/button";
import { foldName } from "@/lib/driver-cell";
import type { TplEntry } from "@/lib/psc-config";
import { QRCodeSVG } from "qrcode.react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
// PSC routes are a hard-coded constant ([[psc-routes-data]]); import directly instead of
// fetching /api/psc-routes — no function invocation, no network round-trip, instant render.
import { PSC_ROUTES } from "@/lib/psc-routes-data";

export function LocationsPanel() {
  const routes = PSC_ROUTES;
  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div>
      <p className="text-muted-foreground text-sm mb-3">
        {routes.length} route(s) loaded. Scan a QR code to preview & assign the job.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {routes.map((route) => {
          const code = route.pickup;
          const qrUrl = `${baseUrl}/qr/${code}`;

          return (
            // pickup alone is not unique: D036 has two routes (D001 and 3PL).
            <Card key={`${code}-${route.dropoff}`} className="relative">
              <CardHeader className="pb-2">
                <CardTitle>
                  <span>{route.psc_pickup}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col items-center gap-3">
                <a href={`/qr/${code}`}>
                  <QRCodeSVG value={qrUrl} size={160} level="M" className="rounded" />
                </a>
                <div className="w-full text-sm space-y-1">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Route</span>
                    <span className="font-medium">
                      {route.psc_pickup} &#x27A1; {route.dropoff_location}
                    </span>
                  </div>
                  {route.ref_number && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Ref</span>
                      <span className="font-mono text-xs">{route.ref_number}</span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}


export function TplMappingsPanel() {
  const [entries, setEntries] = useState<TplEntry[]>([]);
  const [search, setSearch] = useState("");
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void (async () => {
      try {
        const res = await fetch(`/api/psc-tinh?mode=mappings${reload ? "&fresh=1" : ""}`, { cache: "no-store", signal: controller.signal });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Không tải được cấu hình 3PL");
        if (!controller.signal.aborted) setEntries(data.entries);
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [reload]);
  const filtered = entries.filter(e => foldName(`${e.psc_tinh} ${e.tpl_name} ${e.address}`).includes(foldName(search.trim())));
  return <section aria-label="3PL Mapping" className="flex h-full min-h-0 flex-col rounded-xl border border-slate-200 bg-white text-slate-900">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-3">
      <div><h2 className="text-sm font-semibold">3PL Mapping</h2><p className="mt-1 text-xs text-slate-600">PSC tỉnh → điểm nhận mẫu 3PL</p></div>
      <Button variant="outline" size="sm" disabled={loading} onClick={() => setReload(n => n + 1)}><RefreshCw aria-hidden="true" className="size-4" strokeWidth={1.75} />Tải lại</Button>
      <label className="relative w-full"><span className="sr-only">Tìm trong 3PL Mapping</span><Search aria-hidden="true" className="absolute left-3 top-3 size-4 text-slate-500" strokeWidth={1.75} /><input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Tìm PSC, điểm 3PL hoặc địa chỉ…" className="h-10 w-full rounded-md border border-slate-300 bg-white pl-9 pr-3 text-sm placeholder:text-slate-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600" /></label>
    </header>
    <div aria-busy={loading} className="min-h-0 flex-1 overflow-auto">
      {error ? <p role="alert" className="p-4 text-sm text-red-700">{error}</p> : loading ? <p role="status" className="p-4 text-sm text-slate-600">Đang đọc cấu hình 3PL…</p> : !filtered.length ? <p className="p-4 text-sm text-slate-600">{search ? "Không có mapping khớp tìm kiếm." : "Chưa có cấu hình 3PL."}</p> : <table className="w-full text-left text-sm">
        <thead className="hidden bg-slate-50 text-xs text-slate-600 sm:table-header-group"><tr><th className="p-3">PSC tỉnh</th><th className="p-3">Điểm 3PL</th><th className="p-3">Địa chỉ</th></tr></thead>
        <tbody className="block sm:table-row-group">{filtered.map((e, i) => <tr key={`${e.psc_tinh}:${e.tpl_uuid}:${i}`} className="block border-t border-slate-200 p-3 first:border-t-0 sm:table-row sm:p-0 sm:first:border-t">
          <td className="block font-medium sm:table-cell sm:p-3 sm:align-top"><span className="mr-2 text-xs font-normal text-slate-600 sm:hidden">PSC tỉnh</span>{e.psc_tinh}</td>
          <td className="mt-2 block break-words sm:mt-0 sm:table-cell sm:p-3 sm:align-top"><span className="mb-0.5 block text-xs text-slate-600 sm:hidden">Điểm 3PL</span>{e.tpl_name}</td>
          <td className="mt-2 block break-words text-slate-600 sm:mt-0 sm:table-cell sm:p-3 sm:align-top">{e.address}</td>
        </tr>)}</tbody>
      </table>}
    </div>
    <p className="border-t border-slate-200 px-3 py-2 text-xs text-slate-600">{loading ? "Đang đọc cấu hình" : `${filtered.length}/${entries.length} mapping đang áp dụng`}</p>
  </section>;
}
