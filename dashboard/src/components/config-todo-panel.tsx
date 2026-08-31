"use client";

import { useState } from "react";
import { ClipboardList } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { CoverageGap, UnfinishedConfigRow, ConfigDriver } from "@/lib/types";

/**
 * What the CONFIG is waiting on a person for — its own card, beside the leave
 * one, rather than a section buried in the failures list.
 *
 * The distinction is what earns the separate card. Everything in the failures
 * panel is a job stuck right now, and stays there only until someone deals with
 * it. These are the opposite: a branch with no driver, or an hour nobody is
 * rostered for, both of which sit until a person edits the config, and neither
 * of which is urgent in the way a late pickup is. Mixed in, they buried the
 * things that were.
 *
 * Two shapes of the same problem, folded away together:
 *   * an hour a job fell into that no rule covers — fixed by moving a boundary
 *     or splitting a rule out;
 *   * a branch with a line but no driver — fixed by naming one.
 */

/**
 * Fold accents so a name typed quickly still matches: "quynh" has to find
 * "Nguyễn Hữu Quỳnh". đ is handled separately — it is a distinct Vietnamese
 * letter, not a d with a mark, so decomposition leaves it untouched.
 */
const foldName = (v: string) =>
  v.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();

/**
 * Resolve a typed name against the roster, refusing anything ambiguous.
 *
 * The roster is what the sheet's own lookup resolves against, so a name that is
 * not on it writes perfectly well and then resolves to nothing — a row that
 * looks finished and assigns nobody.
 */
function resolveDriver(typed: string, drivers: ConfigDriver[]): { name: string } | { error: string } {
  const q = foldName(typed.trim());
  if (!q) return { error: "Chưa chọn tài xế" };
  const exact = drivers.filter((d) => foldName(d.name) === q);
  const hits = exact.length ? exact : drivers.filter((d) => foldName(d.name).includes(q));
  if (hits.length === 0) return { error: `"${typed}" không có trong tab Driver — chọn từ danh sách` };
  if (hits.length > 1) return { error: `"${typed}" khớp ${hits.length} tài xế — gõ rõ hơn` };
  return { name: hits[0].name };
}


/**
 * Five-minute grid, the whole day.
 *
 * Finer than the leave form's half-hour slots, and for a different reason: a
 * leave window is somebody's shift, which lands on the half hour, while these
 * are collection boundaries that genuinely sit at 15:15 or 06:45 — the live
 * sheet has both. Rounding those to the nearest half hour would silently move
 * cover the supervisor did not ask to move.
 *
 * The whole day rather than 05:00–22:00, because the config already carries
 * overnight rules (22:00–06:00) that the leave form has no reason to offer.
 */
const TIME_SLOTS_5: string[] = (() => {
  const slots: string[] = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 5) {
      slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return slots;
})();

/**
 * A prefilled value off the grid is kept as an extra option rather than
 * discarded — the sheet holds times typed by hand, and one landing on 08:54
 * would otherwise render the select blank while still holding that time, so the
 * supervisor could not see what they were about to save.
 */
function TimeSelect({
  value, onChange, label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  const options = value && !TIME_SLOTS_5.includes(value) ? [...TIME_SLOTS_5, value].sort() : TIME_SLOTS_5;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      className="rounded border border-slate-300 bg-white px-1 py-1 text-xs font-mono"
    >
      <option value="">--:--</option>
      {options.map((t) => <option key={t} value={t}>{t}</option>)}
    </select>
  );
}

const CONFIG_NAMES_LIST_ID = "config-driver-names";

/**
 * One unfinished config line, and the decision it is waiting for.
 *
 * Shaped like the leave module's substitute editor on purpose: the same people
 * use both, and the same gesture should look the same — a name, a window, and a
 * button that splits the work across more than one row.
 *
 * The hours are editable because the engine only guessed them, from the hour
 * block around the job that failed. That is a hint about when the branch needs
 * collecting, not a shift anyone agreed to.
 */
function UnfinishedRow({
  u, drivers, onSaved,
}: {
  u: UnfinishedConfigRow;
  drivers: ConfigDriver[];
  onSaved: (key?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [from, to] = (u.window ?? "–").split("–");
  // One block = one rule. A branch collected morning and afternoon by different
  // drivers needs two rows, which is what "+ Thêm config" adds — the same split
  // the leave editor offers, for the same reason.
  const [blocks, setBlocks] = useState([{ name: "", start: from ?? "", end: to ?? "" }]);

  const patch = (i: number, v: Partial<(typeof blocks)[number]>) =>
    setBlocks((bs) => bs.map((b, j) => (j === i ? { ...b, ...v } : b)));
  const addBlock = () => setBlocks((bs) => [...bs, { name: "", start: "", end: "" }]);
  const dropBlock = (i: number) => setBlocks((bs) => bs.filter((_, j) => j !== i));

  async function save() {
    setErr(null);
    const resolved: { name: string; start: string; end: string }[] = [];
    for (const b of blocks) {
      const r = resolveDriver(b.name, drivers);
      if ("error" in r) { setErr(r.error); return; }
      // More than one rule for a branch means each MUST carry its own window:
      // an open one covers the whole day and would clash with its siblings.
      if (blocks.length > 1 && (!b.start.trim() || !b.end.trim())) {
        setErr("Nhiều dòng thì mỗi dòng cần khung giờ riêng");
        return;
      }
      resolved.push({ name: r.name, start: b.start.trim(), end: b.end.trim() });
    }

    setBusy(true);
    try {
      // The first block fills the row that already exists; the rest become new
      // rows. Sequential on purpose — a failure part way through then leaves a
      // clear picture rather than an unknown number of half-written lines.
      const [first, ...rest] = resolved;
      const post = async (url: string, body: unknown) => {
        const res = await fetch(url, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) throw new Error(j.error || `Lỗi ${res.status}`);
        return j;
      };
      await post("/api/config/complete-row", {
        row: u.row, pickup_name: u.pickup_name, driver_name: first.name,
        shift_start: first.start, shift_end: first.end,
      });
      for (const b of rest) {
        await post("/api/config/add-rule", {
          pickup_name: u.pickup_name, dropoff_name: u.dropoff_name,
          driver_name: b.name, shift_start: b.start, shift_end: b.end,
        });
      }
      toast.success(
        rest.length
          ? `Đã tạo ${resolved.length} dòng cho ${u.pickup_name}`
          : `Đã gán ${first.name} cho ${u.pickup_name} (dòng ${u.row})`,
      );
      setOpen(false);
      onSaved(`u:${u.row}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-2 py-1.5 hover:bg-slate-50">
      <div className="flex items-center gap-2 min-w-0">
        <span className="shrink-0 font-mono text-[11px] text-slate-500" title="Dòng trong Google Sheet">
          #{u.row}
        </span>
        <span
          className="min-w-0 flex-1 break-words md:truncate text-sm font-medium text-slate-800"
          title={`${u.pickup_name}${u.dropoff_name ? ` → ${u.dropoff_name}` : ""}`}
        >
          {u.pickup_name}
          {u.dropoff_name && <span className="text-slate-400"> → {u.dropoff_name}</span>}
        </span>
        {!open && u.window && (
          <span className="shrink-0 text-[11px] text-slate-600 bg-slate-100 border border-slate-200 rounded px-1.5 py-0.5">
            {u.window}
          </span>
        )}
        {!open && (
          <Button size="sm" className="h-6 shrink-0 text-[11px] px-2" onClick={() => setOpen(true)}>
            Chọn tài xế
          </Button>
        )}
      </div>

      {open && (
        <div className="mt-1 space-y-1 rounded border border-slate-300 bg-white p-1.5">
          {blocks.map((b, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1">
              <input
                type="text"
                list={CONFIG_NAMES_LIST_ID}
                placeholder="Tên tài xế…"
                value={b.name}
                onChange={(e) => patch(i, { name: e.target.value })}
                className="min-w-[140px] flex-1 rounded border border-slate-300 px-1.5 py-1 text-xs"
              />
              <TimeSelect label="Từ giờ" value={b.start} onChange={(v) => patch(i, { start: v })} />
              <span className="text-slate-400 text-[11px]">→</span>
              <TimeSelect label="Đến giờ" value={b.end} onChange={(v) => patch(i, { end: v })} />
              {blocks.length > 1 && (
                <button
                  type="button"
                  onClick={() => dropBlock(i)}
                  className="text-slate-400 hover:text-red-600 text-[11px] px-0.5"
                  title="Bỏ dòng này"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <div className="flex items-center gap-1">
            {blocks.length < 3 && (
              <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={addBlock} disabled={busy}>
                + Thêm config
              </Button>
            )}
            <div className="ml-auto flex gap-1">
              <Button
                size="sm" variant="outline" className="h-6 px-2 text-[11px]"
                onClick={() => { setOpen(false); setErr(null); }} disabled={busy}
              >
                Hủy
              </Button>
              <Button
                size="sm" className="h-6 px-2 text-[11px] bg-indigo-600 hover:bg-indigo-700"
                onClick={save} disabled={busy}
              >
                {busy ? "Đang lưu…" : "Lưu"}
              </Button>
            </div>
          </div>
          {err && <div className="text-[11px] text-red-600">{err}</div>}
        </div>
      )}
    </div>
  );
}

/**
 * An hour a job needed and nobody was rostered for.
 *
 * Shows the cover either side of the hole, because that is the diagnosis: "ends
 * 14:30, next starts 16:30" tells you at a glance which boundary is wrong.
 *
 * Only ONE of the three closes it. Widening both neighbours would leave them
 * overlapping, which is the fault this same panel reports elsewhere; and the
 * third — a rule of its own — is often the honest one, because when nobody
 * either side really works that stretch, stretching their hours records
 * something untrue about who is on duty.
 */
function GapRow({
  g, drivers, onSaved,
}: {
  g: CoverageGap;
  drivers: ConfigDriver[];
  onSaved: (key?: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [splitting, setSplitting] = useState(false);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const key = `g:${g.customer_id}|${g.at}`;
  const splitFrom = g.before ? g.before.window.split("–")[1] : g.at;
  const splitTo = g.after ? g.after.window.split("–")[0] : g.at;
  const [sFrom, setSFrom] = useState(splitFrom);
  const [sTo, setSTo] = useState(splitTo);

  const post = async (url: string, body: unknown) => {
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) throw new Error(j.error || `Lỗi ${res.status}`);
    return j;
  };

  async function stretch(row: number, edge: "start" | "end", tag: string) {
    setBusy(tag); setErr(null);
    try {
      await post("/api/config/stretch-rule", { row, pickup_name: g.pickup_name, edge, value: g.at });
      toast.success(`Đã sửa ca dòng ${row} — ${g.pickup_name}`);
      onSaved(key);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function addRule() {
    const r = resolveDriver(name, drivers);
    if ("error" in r) { setErr(r.error); return; }
    setBusy("split"); setErr(null);
    try {
      const j = await post("/api/config/add-rule", {
        pickup_name: g.pickup_name, driver_name: r.name, shift_start: sFrom, shift_end: sTo,
      });
      toast.success(`Đã thêm dòng ${j.row} — ${r.name} ${sFrom}–${sTo}`);
      setSplitting(false);
      onSaved(key);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="px-2 py-1.5 hover:bg-slate-50">
      <div className="flex items-center gap-2 min-w-0">
        <span className="shrink-0 rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[11px] text-amber-800">
          {g.at}
        </span>
        <span className="min-w-0 flex-1 break-words md:truncate text-sm font-medium text-slate-800" title={g.pickup_name}>
          {g.pickup_name}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-600">
        <span>
          {g.before ? `Ca trước hết lúc ${g.before.window.split("–")[1]}` : "Không có ca trước"}
          {" · "}
          {g.after ? `ca sau bắt đầu ${g.after.window.split("–")[0]}` : "không có ca sau"}
        </span>
        {g.before && (
          <Button
            size="sm" variant="outline" className="h-6 px-2 text-[11px]"
            disabled={busy !== null}
            onClick={() => stretch(g.before!.row, "end", "before")}
            title={`Dòng ${g.before.row} · ${g.before.driver}`}
          >
            {busy === "before" ? "Đang lưu…" : `Kéo dài ca trước đến ${g.at}`}
          </Button>
        )}
        {g.after && (
          <Button
            size="sm" variant="outline" className="h-6 px-2 text-[11px]"
            disabled={busy !== null}
            onClick={() => stretch(g.after!.row, "start", "after")}
            title={`Dòng ${g.after.row} · ${g.after.driver}`}
          >
            {busy === "after" ? "Đang lưu…" : `Ca sau bắt đầu từ ${g.at}`}
          </Button>
        )}
        {!splitting && splitFrom !== splitTo && (
          <Button
            size="sm" variant="outline" className="h-6 px-2 text-[11px]"
            disabled={busy !== null}
            onClick={() => { setSplitting(true); setErr(null); }}
          >
            + Thêm config {splitFrom}–{splitTo}
          </Button>
        )}
      </div>

      {splitting && (
        <div className="mt-1 space-y-1 rounded border border-slate-300 bg-white p-1.5">
          <div className="flex flex-wrap items-center gap-1">
            <input
              type="text"
              list={CONFIG_NAMES_LIST_ID}
              placeholder="Tên tài xế…"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="min-w-[140px] flex-1 rounded border border-slate-300 px-1.5 py-1 text-xs"
            />
            {/* Prefilled from the neighbours, but editable: the hole runs
                14:30–16:30 only because that is where the two rules happen to
                stop and start, and the person who knows the round may want a
                narrower window than the whole space between them. */}
            <TimeSelect label="Từ giờ" value={sFrom} onChange={setSFrom} />
            <span className="text-slate-400 text-[11px]">→</span>
            <TimeSelect label="Đến giờ" value={sTo} onChange={setSTo} />
          </div>
          <div className="flex items-center gap-1">
            <div className="ml-auto flex gap-1">
              <Button
                size="sm" variant="outline" className="h-6 px-2 text-[11px]"
                onClick={() => { setSplitting(false); setErr(null); }} disabled={busy !== null}
              >
                Hủy
              </Button>
              <Button
                size="sm" className="h-6 px-2 text-[11px] bg-indigo-600 hover:bg-indigo-700"
                onClick={addRule} disabled={busy !== null}
              >
                {busy === "split" ? "Đang tạo…" : "Tạo dòng"}
              </Button>
            </div>
          </div>
        </div>
      )}
      {err && <div className="mt-1 text-[11px] text-red-600">{err}</div>}
    </div>
  );
}

export function ConfigTodoPanel({
  gaps,
  unfinished,
  drivers,
  parsedAt,
  onSaved,
}: {
  gaps: CoverageGap[];
  unfinished: UnfinishedConfigRow[];
  drivers: ConfigDriver[];
  /** When the sheet behind both lists was last read. */
  parsedAt: string;
  onSaved: (key?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (gaps.length === 0 && unfinished.length === 0) return null;

  const listBox = "divide-y divide-slate-100 overflow-hidden rounded-md border border-slate-200";

  return (
    <Card className="py-2 shrink-0 border-slate-200">
      <CardContent className="space-y-1.5 px-3">
        <datalist id={CONFIG_NAMES_LIST_ID}>
          {drivers.map((d) => <option key={d.driver_id} value={d.name} />)}
        </datalist>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 text-left"
          aria-expanded={open}
        >
          <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
            <ClipboardList className="size-4 text-amber-600" strokeWidth={2} />
            Cần tạo config
          </span>
          {gaps.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-700 border border-amber-200 px-1.5 py-0 text-[11px] font-semibold leading-relaxed">
              {gaps.length} thiếu ca
            </span>
          )}
          {unfinished.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 text-slate-700 border border-slate-200 px-1.5 py-0 text-[11px] font-semibold leading-relaxed">
              {unfinished.length} chưa có tài xế
            </span>
          )}
          {/* When the sheet was last READ, not when the cycle ran. The parse is
              event-based, so a hand-edit stays invisible until someone presses
              Refresh — without this, a row already fixed in the sheet reads as a
              bug rather than as a stale list. */}
          {parsedAt && (
            <span className="text-[11px] text-slate-400">
              đọc sheet {parsedAt.slice(11, 16)} · vừa sửa sheet thì bấm Làm mới
            </span>
          )}
          <span className="ml-auto shrink-0 text-xs text-slate-400">{open ? "▾" : "▸"}</span>
        </button>

        {open && gaps.length > 0 && (
          <div className={listBox}>
            {gaps.map((g) => (
              <GapRow key={`${g.customer_id}-${g.at}`} g={g} drivers={drivers} onSaved={onSaved} />
            ))}
          </div>
        )}
        {open && unfinished.length > 0 && (
          <div className={listBox}>
            {unfinished.map((u) => (
              <UnfinishedRow key={u.row} u={u} drivers={drivers} onSaved={onSaved} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
