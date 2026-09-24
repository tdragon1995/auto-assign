"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A floating panel pinned to an anchor, opened by hover and kept by use.
 *
 * Hand-rolled rather than Radix Popover for one reason: Radix positions its
 * content with a CSS `transform`, and a transformed ancestor becomes the
 * containing block for every `position: fixed` descendant. `DriverCombobox`
 * places its menu with `position: fixed` at viewport coordinates, so inside a
 * Radix popover the menu would open offset by wherever the popover happens to
 * sit. This panel is placed with top/left only, so fixed children stay fixed.
 *
 * The parent owns open/pinned; this only draws, places, and reports the
 * pointer and the outside click. `onEngage` fires on any pointer-down or focus
 * inside — the moment a hover preview becomes something being worked in, and
 * must no longer vanish when the pointer drifts off it.
 */
export function HoverPanel({
  anchor,
  open,
  label,
  onClose,
  onEngage,
  onPointerEnter,
  onPointerLeave,
  children,
}: {
  anchor: HTMLElement | null;
  open: boolean;
  label: string;
  onClose: () => void;
  onEngage: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxH: number } | null>(null);

  useLayoutEffect(() => {
    // No reset when closed: placement below runs before paint, so a stale
    // position from the last opening is never seen.
    if (!open || !anchor) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const el = ref.current;
      const w = el?.offsetWidth ?? 0;
      const h = el?.scrollHeight ?? 0;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const pad = 8;
      const gap = 4;
      // BESIDE the anchor, not under it: below, the panel covered the next
      // names in the same column, so a day's list could not be hovered down.
      // Right if it fits, else left, else (a phone) below.
      const right = a.right + gap;
      const leftSide = a.left - gap - w;
      let left: number;
      let top: number;
      let maxH: number;
      if (right + w <= vw - pad || leftSide >= pad) {
        left = right + w <= vw - pad ? right : leftSide;
        maxH = vh - 2 * pad;
        top = Math.max(pad, Math.min(a.top, vh - pad - Math.min(h, maxH)));
      } else {
        left = Math.max(pad, Math.min(a.left, vw - w - pad));
        const below = vh - a.bottom - gap - pad;
        const above = a.top - gap - pad;
        const flip = h > below && above > below;
        maxH = Math.max(160, flip ? above : below);
        top = flip ? Math.max(pad, a.top - gap - Math.min(h, maxH)) : a.bottom + gap;
      }
      setPos((p) => (p && p.top === top && p.left === left && p.maxH === maxH ? p : { top, left, maxH }));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    const ro = new ResizeObserver(place);
    if (ref.current) ro.observe(ref.current);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      ro.disconnect();
    };
  }, [open, anchor]);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      onClose();
      anchor?.focus();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key);
    };
  }, [open, anchor, onClose]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDownCapture={onEngage}
      onFocusCapture={onEngage}
      style={pos ? { top: pos.top, left: pos.left, maxHeight: pos.maxH } : { top: 0, left: 0, visibility: "hidden" }}
      className="fixed z-50 w-[min(30rem,calc(100vw-1rem))] overflow-y-auto rounded-md border border-indigo-300 bg-white p-1.5 shadow-lg animate-in fade-in duration-100 motion-reduce:animate-none"
    >
      {children}
    </div>,
    document.body,
  );
}
