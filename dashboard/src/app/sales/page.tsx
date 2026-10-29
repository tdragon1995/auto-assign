"use client";

import { useEffect, useState } from "react";
import { SalesTool, type SalesUser } from "@/components/sales-tool";

// Sign-in with the rep's own Labcenter account. The server keeps only the
// confirmed email (signed cookie) and scopes every client lookup to it.
export default function SalesPage() {
  const [user, setUser] = useState<SalesUser | null | undefined>(undefined);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/sales/login").then((r) => r.json()).then((d) => setUser(d.user ?? null)).catch(() => setUser(null));
  }, []);

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/sales/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { setUser(data.user); setPassword(""); }
      else setError(data.error ?? "Đăng nhập thất bại");
    } catch {
      setError("Không kết nối được máy chủ");
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await fetch("/api/sales/login", { method: "DELETE" }).catch(() => {});
    setUser(null);
  };

  if (user === undefined) return <div className="min-h-screen bg-slate-100" />;
  if (user) return <SalesTool user={user} onLogout={logout} />;

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col items-center p-4">
      <form onSubmit={login} className="w-full max-w-sm bg-white rounded-2xl shadow border p-6 space-y-4 mt-12">
        <div>
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">Sales</p>
          <h1 className="text-xl font-bold text-slate-800 mt-0.5">Đăng nhập Labcenter</h1>
          <p className="text-xs text-slate-400 mt-1">Dùng tài khoản Labcenter (Sapoche) của bạn!</p>
        </div>
        <label className="block">
          <span className="block text-sm font-semibold text-slate-700 mb-1">Email</span>
          <input
            type="email" autoComplete="username" required value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
        </label>
        <label className="block">
          <span className="block text-sm font-semibold text-slate-700 mb-1">Mật khẩu</span>
          <input
            type="password" autoComplete="current-password" required value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
        </label>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <button
          type="submit" disabled={busy}
          className="w-full bg-blue-600 text-white rounded-xl py-2.5 text-sm font-semibold hover:bg-blue-700 disabled:opacity-60"
        >
          {busy ? "Đang đăng nhập..." : "Đăng nhập"}
        </button>
      </form>
    </div>
  );
}
