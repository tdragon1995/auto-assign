"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { AoExcludedTest, AoExclusion } from "@/lib/handover";

interface ClientHit { code: string; client_legal_name: string }

/** A search box that offers Labcenter matches as you type; `endpoint` ends in `q=`. */
function SearchPick<T>({ label, endpoint, text, onPick }: { label: string; endpoint: string; text: (r: T) => string; onPick: (r: T) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const s = q.trim();
    if (s.length < 2) { setResults([]); return; }
    const ac = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(endpoint + encodeURIComponent(s), { signal: ac.signal });
        const data = await res.json();
        setResults(res.ok ? data.results ?? [] : []);
      } catch { /* aborted or offline */ } finally { setLoading(false); }
    }, 300);
    return () => { clearTimeout(t); ac.abort(); };
  }, [q, endpoint]);
  return (
    <div className="relative">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={label} aria-label={label}
        className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-800 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400" />
      {q.trim().length >= 2 && (loading || results.length > 0) && (
        <ul className="absolute z-10 left-0 right-0 mt-1 max-h-56 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          {loading && !results.length && <li className="px-3 py-2 text-xs text-slate-500">Đang tìm…</li>}
          {results.map((r, i) => (
            <li key={i}>
              <button type="button" onClick={() => { onPick(r); setQ(""); setResults([]); }}
                className="w-full px-3 py-1.5 text-left text-xs text-blue-950 hover:bg-blue-50 focus-visible:bg-blue-50 focus-visible:outline-none">
                {text(r)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Clients, or some of their tests, whose hard copies are left off the lookup and the print. */
export function AoExclusions({ list, busy, onChange }: { list: AoExclusion[]; busy: boolean; onChange: (list: AoExclusion[]) => void }) {
  const set = (code: string, tests: AoExcludedTest[]) => onChange(list.map((e) => (e.client_code === code ? { ...e, tests } : e)));
  return (
    <div className="space-y-3">
      <SearchPick<ClientHit> label="Thêm khách hàng (tên hoặc mã)…" endpoint="/api/labcenter/client?q="
        text={(c) => `${c.client_legal_name} · ${c.code}`}
        onPick={(c) => { if (!busy && !list.some((e) => e.client_code === c.code)) onChange([...list, { client_code: c.code, client_name: c.client_legal_name, tests: [] }]); }} />
      {!list.length && <p className="text-xs text-slate-500">Chưa loại trừ khách hàng nào.</p>}
      <ul className="divide-y divide-slate-100">
        {list.map((e) => (
          <li key={e.client_code} className="py-2 space-y-1.5">
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs font-bold text-slate-800">{e.client_name} <span className="font-normal text-slate-500">· {e.client_code}</span></p>
              <button type="button" disabled={busy} onClick={() => onChange(list.filter((x) => x.client_code !== e.client_code))}
                className="shrink-0 text-xs font-semibold text-red-700 hover:underline disabled:opacity-40">Bỏ</button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {e.tests.length ? e.tests.map((t) => (
                <span key={t.code} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-800">
                  {t.names[0]}
                  <button type="button" disabled={busy} aria-label={`Bỏ ${t.names[0]}`} onClick={() => set(e.client_code, e.tests.filter((x) => x.code !== t.code))}
                    className="text-slate-500 hover:text-red-700 disabled:opacity-40"><X aria-hidden className="w-3 h-3" /></button>
                </span>
              )) : <span className="text-xs font-semibold text-amber-700">Loại toàn bộ khách hàng</span>}
            </div>
            <SearchPick<AoExcludedTest> label="Chỉ loại xét nghiệm… (tìm trong POS)" endpoint={`/api/labcenter/tests?account_code=${encodeURIComponent(e.client_code)}&q=`}
              text={(t) => `${t.names.join(" · ")} · ${t.code}`}
              onPick={(t) => { if (!busy && !e.tests.some((x) => x.code === t.code)) set(e.client_code, [...e.tests, t]); }} />
          </li>
        ))}
      </ul>
    </div>
  );
}
