"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, StickyNote } from "lucide-react";
import { FAIL_REASONS, pickNotes, pickPhotos, type ReviewJob } from "@/lib/photo-review";

/**
 * /picture/<job_id> — POD photo review.
 *
 * A supervisor is shown one completed job's photos, two per screen, and files one
 * verdict per job. The queue is today's completed jobs newest-finish-first
 * (GET /api/picture); the photos come from the SAME job-detail endpoint the /qr job
 * sheet uses, so a job opened on both costs one Cartrack fetch, not two.
 *
 * Pass/Fail stays disabled until every photo has been on screen: a verdict filed
 * without seeing photo 3 of 4 is worse than no verdict, because it reads as one.
 */

const PER_SCREEN = 2;

interface QueueItem {
  job_id: number;
  reference_number: string | null;
  completed_ts: string | null;
  driver: string | null;
  pickup: string;
  dropoff: string;
}

type Detail = ReviewJob & { job_id: number; reference_number: string | null };

const hhmm = (ts: string | null) => (ts ? ts.slice(11, 16) : "");

export default function PictureReviewPage() {
  const params = useParams<{ job?: string[] }>();
  const router = useRouter();
  const jobId = Number(params?.job?.[0]) || null;

  const [email, setEmail] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  // Signed in, as distinct from "the queue loaded". A server-side failure must not
  // look like a logged-out session: being shown a login form you have already passed
  // invites a second login that fixes nothing and hides the actual error.
  const [authed, setAuthed] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [seen, setSeen] = useState<Set<number>>(new Set());
  const [failing, setFailing] = useState(false);
  const [reason, setReason] = useState<string>(FAIL_REASONS[0].code);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // ── queue ──────────────────────────────────────────────────────────────────
  const loadQueue = useCallback(async () => {
    const r = await fetch("/api/picture", { cache: "no-store" });
    setAuthChecked(true);
    if (r.status === 401) { setAuthed(false); setEmail(null); return; }
    setAuthed(true);
    const d = await r.json();
    if (d.email) setEmail(d.email);
    if (d.error) { setMsg(d.error); return; }
    setMsg(null);
    setQueue(d.queue ?? []);
  }, []);

  useEffect(() => { loadQueue(); }, [loadQueue]);

  // No job in the URL → open the newest unreviewed one.
  useEffect(() => {
    if (!jobId && email && queue.length) router.replace(`/picture/${queue[0].job_id}`);
  }, [jobId, email, queue, router]);

  // ── one job's photos ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!jobId || !email) return;
    setLoading(true);
    setDetail(null);
    setPage(0);
    setSeen(new Set());
    setFailing(false);
    fetch(`/api/location-jobs?job_id=${jobId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setDetail(d.job ?? null))
      .catch(() => setMsg("Không tải được ảnh."))
      .finally(() => setLoading(false));
  }, [jobId, email]);

  const photos = useMemo(() => pickPhotos(detail), [detail]);

  // The typed note sits beside the photos because one fail reason compares against it.
  const notes = useMemo(() => pickNotes(detail), [detail]);

  const pages = Math.max(1, Math.ceil(photos.length / PER_SCREEN));
  const shown = photos.slice(page * PER_SCREEN, page * PER_SCREEN + PER_SCREEN);

  // Mark what is on screen as seen.
  useEffect(() => {
    if (!photos.length) return;
    setSeen((prev) => {
      const next = new Set(prev);
      for (let i = page * PER_SCREEN; i < Math.min(photos.length, (page + 1) * PER_SCREEN); i++) next.add(i);
      return next;
    });
  }, [page, photos.length]);

  const current = queue.find((q) => q.job_id === jobId) ?? null;
  const nextJobId = useMemo(() => {
    const idx = queue.findIndex((q) => q.job_id === jobId);
    if (idx >= 0 && idx + 1 < queue.length) return queue[idx + 1].job_id;
    const rest = queue.filter((q) => q.job_id !== jobId);
    return rest[0]?.job_id ?? null;
  }, [queue, jobId]);

  const goNext = useCallback(() => {
    setQueue((q) => q.filter((x) => x.job_id !== jobId));
    if (nextJobId) router.replace(`/picture/${nextJobId}`);
    else { setDetail(null); router.replace("/picture"); }
  }, [jobId, nextJobId, router]);

  // Fetch the NEXT job's photos while this one is being looked at. One job's detail is
  // ~2.8 s from Cartrack and is cached for the day once fetched, so by the time a verdict
  // is filed the next job is already in the cache and arrives instantly. Only the first
  // job of a session waits. Fire-and-forget: a failed prefetch just means the normal
  // load happens on arrival.
  useEffect(() => {
    if (!nextJobId || loading || !photos.length) return;
    fetch(`/api/location-jobs?job_id=${nextJobId}`).catch(() => {});
  }, [nextJobId, loading, photos.length]);

  // A job with no photos has nothing to review — skip it rather than record a verdict
  // about pictures that do not exist.
  useEffect(() => {
    if (!loading && detail && photos.length === 0) goNext();
  }, [loading, detail, photos.length, goNext]);

  const submit = async (result: "pass" | "fail") => {
    if (!jobId || saving) return;
    setSaving(true);
    try {
      const r = await fetch("/api/picture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_id: jobId,
          result,
          reason: result === "fail" ? reason : undefined,
          photo_count: photos.length,
        }),
      });
      const d = await r.json();
      if (!r.ok) { setMsg(d.error ?? "Không lưu được."); return; }
      goNext();
    } finally {
      setSaving(false);
    }
  };

  // ── login ──────────────────────────────────────────────────────────────────
  if (authChecked && !authed) return <Login onDone={loadQueue} error={null} />;
  if (!authChecked) return <Shell><p className="text-sm text-slate-500">Đang tải…</p></Shell>;

  const allSeen = photos.length > 0 && seen.size >= photos.length;

  return (
    <Shell>
      <header className="flex items-baseline justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h1 className="text-base font-semibold text-slate-800 truncate">
            {current ? `${current.pickup} → ${current.dropoff}` : `Job ${jobId ?? ""}`}
          </h1>
          <p className="text-xs text-slate-500 truncate">
            {current?.driver ?? ""}
            {current?.completed_ts ? ` · xong ${hhmm(current.completed_ts)}` : ""}
            {detail?.reference_number ? ` · ${detail.reference_number}` : ""}
          </p>
        </div>
        <span className="text-xs text-slate-400 shrink-0">Còn {queue.length}</span>
      </header>

      {notes.length > 0 && (
        <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-2.5">
          {notes.map((n, i) => (
            <p key={i} className="flex items-start gap-1.5 text-xs text-amber-900 leading-snug">
              <StickyNote aria-hidden className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span><span className="text-amber-700">{n.where}:</span> {n.note}</span>
            </p>
          ))}
        </div>
      )}

      {loading && <p className="text-sm text-slate-500">Đang tải ảnh…</p>}

      {/* Only when the queue really is empty — an errored queue is also empty, and
          saying "nothing left to review" over a failure is a lie the reader acts on. */}
      {!loading && !jobId && !msg && (
        <p className="text-sm text-slate-500">Hết việc cần duyệt hôm nay.</p>
      )}

      {!loading && photos.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3">
            {shown.map((p) => (
              <figure key={p.id} className="min-w-0">
                <a href={p.url} target="_blank" rel="noopener noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.url}
                    alt={p.caption || "Ảnh giao nhận"}
                    className="w-full aspect-square object-cover rounded-2xl border border-slate-200 bg-slate-100"
                  />
                </a>
                <figcaption className="text-[11px] text-slate-500 mt-1 leading-tight truncate">
                  {p.where}
                </figcaption>
              </figure>
            ))}
          </div>

          {pages > 1 && (
            <div className="flex items-center justify-center gap-4 mt-3">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="p-2 rounded-full border border-slate-200 disabled:opacity-30"
                aria-label="Ảnh trước"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <span className="text-xs text-slate-500">
                {page + 1}/{pages} · đã xem {seen.size}/{photos.length}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
                disabled={page >= pages - 1}
                className="p-2 rounded-full border border-slate-200 disabled:opacity-30"
                aria-label="Ảnh sau"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>
          )}

          {failing ? (
            <div className="mt-4 space-y-2">
              <select
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm bg-white"
              >
                {FAIL_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
              </select>
              <div className="flex gap-2">
                <button
                  onClick={() => setFailing(false)}
                  className="flex-1 rounded-xl border border-slate-300 py-2.5 text-sm text-slate-600"
                >
                  Huỷ
                </button>
                <button
                  onClick={() => submit("fail")}
                  disabled={saving}
                  className="flex-1 rounded-xl bg-rose-600 py-2.5 text-sm font-medium text-white disabled:opacity-50"
                >
                  Gửi không đạt
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-4 space-y-2">
              <button
                onClick={() => submit("pass")}
                disabled={!allSeen || saving}
                className="w-full rounded-xl bg-emerald-600 py-3 text-sm font-medium text-white disabled:opacity-40"
              >
                Đạt
              </button>
              <button
                onClick={() => setFailing(true)}
                disabled={!allSeen || saving}
                className="w-full rounded-xl bg-rose-600/90 py-3 text-sm font-medium text-white disabled:opacity-40"
              >
                Không đạt
              </button>
              {!allSeen && (
                <p className="text-center text-xs text-slate-400">
                  Xem hết {photos.length} ảnh trước khi duyệt.
                </p>
              )}
            </div>
          )}
        </>
      )}

      {msg && <p className="mt-3 text-xs text-rose-600">{msg}</p>}

      <footer className="mt-6 flex items-center justify-between text-[11px] text-slate-400">
        <span className="truncate">{email}</span>
        <button
          onClick={async () => { await fetch("/api/picture/auth", { method: "DELETE" }); setAuthed(false); setEmail(null); }}
          className="underline shrink-0"
        >
          Đăng xuất
        </button>
      </footer>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-slate-50 p-4">
      <div className="mx-auto max-w-lg rounded-2xl bg-white border border-slate-200 p-4">{children}</div>
    </main>
  );
}

function Login({ onDone, error }: { onDone: () => void; error: string | null }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(error);
  const [busy, setBusy] = useState(false);

  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/picture/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const d = await r.json();
      if (!r.ok) { setErr(d.error ?? "Đăng nhập thất bại."); return; }
      onDone();
    } catch {
      setErr("Không kết nối được máy chủ.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <h1 className="text-base font-semibold text-slate-800 mb-1">Duyệt ảnh giao nhận</h1>
      <p className="text-xs text-slate-500 mb-4">Đăng nhập bằng tài khoản Labcenter.</p>
      <form onSubmit={go} className="space-y-2">
        <input
          type="email" required autoComplete="username" value={email}
          onChange={(e) => setEmail(e.target.value)} placeholder="email@diag-center.com.vn"
          className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm"
        />
        <input
          type="password" required autoComplete="current-password" value={password}
          onChange={(e) => setPassword(e.target.value)} placeholder="Mật khẩu"
          className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm"
        />
        <button
          type="submit" disabled={busy}
          className="w-full rounded-xl bg-slate-800 py-2.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? "Đang kiểm tra…" : "Đăng nhập"}
        </button>
      </form>
      {err && <p className="mt-3 text-xs text-rose-600">{err}</p>}
    </Shell>
  );
}
