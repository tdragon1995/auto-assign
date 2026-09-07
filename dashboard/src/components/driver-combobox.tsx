"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { foldName } from "@/lib/driver-cell";
import { driverDisplayName } from "@/lib/display-names";
import { DriverName } from "./driver-name";
import type { ConfigDriver } from "@/lib/types";

/**
 * Pick a driver off the roster. One, or several.
 *
 * PICKED, NOT TYPED. Every driver on this dashboard is a long code-prefixed
 * sheet label ("F - C - DC100320 Lý Chánh Hùng"), and the two places that used
 * to ask for one by hand — a config row's driver cell, a leave row's substitute
 * — both bound a plain input to a `<datalist>`. That fails in the same two ways
 * wherever it is done: the value has to match the label EXACTLY, punctuation and
 * diacritics included, and a datalist matches on the raw string, so "quynh"
 * finds nothing and the control looks broken rather than picky. What gets saved
 * is then whatever was left in the box.
 *
 * So the list is the control. The search folds accents (`foldName`), the roster
 * is filtered as you type, arrow keys and Enter work, and the value can only
 * ever be a name that came out of the list.
 *
 * `max` is the whole difference between the two callers. A config cell holds one
 * name for a fixed rule or several for a smart one, so it is unbounded; a leave
 * substitute is one person for one window, so it is `max={1}` and the input
 * stands down once that person is chosen — the ✕ on the chip is how you change
 * your mind. Same control, same search, same keys, one less capability.
 */
export function DriverCombobox({
  names,
  onChange,
  drivers,
  max = Infinity,
  placeholder,
  ariaLabel = "Chọn tài xế",
  className = "flex min-w-[200px] flex-1 flex-wrap items-center gap-1 rounded border border-slate-300 bg-white px-1 py-0.5 focus-within:ring-2 focus-within:ring-indigo-400/50",
}: {
  /** Full sheet labels, in the order they should read. */
  names: string[];
  onChange: (names: string[]) => void;
  drivers: ConfigDriver[];
  /** How many names fit. 1 turns this into an ordinary single picker. */
  max?: number;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  /** The menu is positioned FIXED off this box. It has to escape the panel's
   *  own `overflow-y-auto`, which would otherwise clip it to a few pixels. */
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const listId = useId();

  const full = names.length >= max;
  const taken = new Set(names);
  const matches = drivers.filter(
    (d) => !taken.has(d.name) && (!q.trim() || foldName(d.name).includes(foldName(q.trim()))),
  );

  const place = useCallback(() => {
    const r = boxRef.current?.getBoundingClientRect();
    // Bounded, not simply the field's width: the field stretches to hold several
    // long code-prefixed chips, and a menu that wide leaves each name marooned
    // against a mostly-empty row.
    if (r) setRect({ left: r.left, top: r.bottom + 2, width: Math.min(Math.max(r.width, 240), 420) });
  }, []);

  /** Opening MEASURES first, in the handler, then shows. Placing from inside the
   *  effect instead would set state during the render the effect follows, which
   *  is a cascading render — and would also flash the menu at a stale position. */
  const openMenu = useCallback(() => { place(); setOpen(true); }, [place]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    // `true` so a scroll inside the panel repositions too, not just the window.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    document.addEventListener("mousedown", onDoc);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [open, place]);

  const add = (name: string) => {
    const next = [...names, name].slice(0, max === Infinity ? undefined : max);
    onChange(next);
    setQ(""); setActive(0);
    // At the limit there is no input left to focus and nothing more to choose,
    // so the menu closes instead of hanging open over a full field.
    if (next.length >= max) setOpen(false);
    else {
      inputRef.current?.focus();
      // The field grows by a chip, so the menu hanging off its bottom edge moves.
      requestAnimationFrame(place);
    }
  };
  const remove = (name: string) => onChange(names.filter((n) => n !== name));

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { openMenu(); return; }
      setActive((i) => {
        const n = matches.length;
        return n === 0 ? 0 : (e.key === "ArrowDown" ? i + 1 : i - 1 + n) % n;
      });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && matches[active]) add(matches[active].name);
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Backspace" && q === "" && names.length > 0) {
      // The usual chip-field affordance: rubbing out backwards takes the last
      // name off rather than doing nothing.
      remove(names[names.length - 1]);
    }
  }

  return (
    <div ref={boxRef} className={className}>
      {names.map((n) => (
        <span
          key={n}
          className="inline-flex max-w-full items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-800"
        >
          <span className="inline-flex items-baseline gap-x-1 truncate">
            <DriverName full={n} className="truncate" />
          </span>
          <button
            type="button"
            onClick={() => remove(n)}
            aria-label={`Bỏ ${driverDisplayName(n) || n}`}
            className="rounded text-slate-600 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
          >
            ✕
          </button>
        </span>
      ))}
      {!full && (
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={ariaLabel}
          placeholder={placeholder ?? (names.length ? "Thêm tài xế…" : "Chọn tài xế…")}
          value={q}
          onChange={(e) => { setQ(e.target.value); setActive(0); openMenu(); }}
          onFocus={openMenu}
          onKeyDown={onKeyDown}
          className="min-w-[90px] flex-1 bg-transparent px-0.5 py-0.5 text-xs outline-none"
        />
      )}
      {open && !full && rect && (
        <ul
          id={listId}
          role="listbox"
          style={{ position: "fixed", left: rect.left, top: rect.top, width: rect.width, zIndex: 50 }}
          className="max-h-56 overflow-y-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg"
        >
          {matches.length === 0 && (
            <li className="px-2 py-1 text-[11px] text-slate-600">Không tìm thấy tài xế</li>
          )}
          {matches.map((d, i) => (
            <li key={d.driver_id}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => add(d.name)}
                className={`flex w-full flex-wrap items-baseline gap-x-1.5 px-2 py-1 text-left text-xs ${
                  i === active ? "bg-indigo-50 text-slate-900" : "text-slate-700"
                }`}
              >
                <DriverName full={d.name} className="truncate" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
