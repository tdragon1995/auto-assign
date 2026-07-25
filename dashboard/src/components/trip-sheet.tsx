"use client";

import { Camera, PenLine, Link2, StickyNote } from "lucide-react";

/**
 * Chain-of-custody presentation shared by every job detail sheet (/qr, /psc-tinh).
 * A trip's own composition (header, driver block, which events exist) stays local to
 * each page — only the visual primitives are shared here.
 */

export interface TodoImage {
  image_id: number;
  image_url: string;
  is_deleted: boolean;
}

export interface Todo {
  todo_type_id: number;
  description?: string | null;
  note?: string | null;
  images?: TodoImage[];
}

// Which todo types get shown, and the icon each gets. Doubles as the filter: a type
// absent from here is not rendered.
export const TODO_ICON: Record<number, typeof Camera> = { 1: PenLine, 2: Camera, 3: Link2, 5: StickyNote };

// Cartrack's own todo descriptions lead with an emoji ("📦 Chụp thấy rõ mẫu…"). That's
// their data, but rendering it would put colour back into a page that is otherwise line
// icons, so the leading pictograph is stripped and the todo type supplies an icon instead.
const LEADING_EMOJI = /^\p{Extended_Pictographic}️?\s*/u;

export function Photos({ todos }: { todos: Todo[] }) {
  const shots = todos.flatMap((t) => {
    const Icon = TODO_ICON[t.todo_type_id] ?? Camera;
    const caption = (t.description || t.note || "").replace(LEADING_EMOJI, "").trim();
    return (t.images ?? []).filter((i) => !i.is_deleted).map((img) => ({ img, caption, Icon }));
  });
  if (!shots.length) return null;
  return (
    <div className="flex gap-2.5 mt-2.5 overflow-x-auto pb-1">
      {shots.map(({ img, caption, Icon }) => (
        <figure key={img.image_id} className="flex-none w-[88px]">
          <a href={img.image_url} target="_blank" rel="noopener noreferrer">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img.image_url} alt={caption || "Ảnh giao nhận"} className="w-[88px] h-[88px] rounded-xl object-cover border border-slate-200" />
          </a>
          <figcaption className="flex items-start gap-1 text-[10px] text-slate-500 mt-1 leading-tight">
            <Icon aria-hidden className="w-3 h-3 shrink-0 mt-px" />
            <span>{caption}</span>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

export type Tone = "done" | "now" | "future";
export interface TlEvent { tone: Tone; time?: string | null; label: string; body?: React.ReactNode }

// The rail is drawn per event, so the trailing connector below the final event has to be
// suppressed explicitly — `last:` would match every event's own line.
export function Timeline({ events }: { events: TlEvent[] }) {
  return (
    <div className="mt-5">
      {events.map(({ tone, time, label, body }, i) => (
        <div key={`${label}-${i}`} className="flex">
          <div className={`w-12 flex-none text-right pr-3 text-xs font-bold tabular-nums leading-tight ${tone === "future" ? "text-slate-500" : "text-slate-700"}`}>
            {time ?? ""}
          </div>
          <div className="w-6 flex-none flex flex-col items-center">
            <span aria-hidden className={`w-3 h-3 rounded-full border-[3px] mt-0.5 z-10 ${
              tone === "done" ? "bg-green-600 border-green-600"
                : tone === "now" ? "bg-white border-blue-600 animate-pulse"
                : "bg-white border-slate-200"
            }`} />
            {i < events.length - 1 && (
              <span aria-hidden className={`w-[3px] flex-1 my-0.5 ${tone === "done" ? "bg-green-600" : "bg-slate-200"}`} />
            )}
          </div>
          <div className={`flex-1 min-w-0 pl-3 ${i < events.length - 1 ? "pb-5" : "pb-1"}`}>
            <p className={`text-sm font-bold leading-tight ${tone === "future" ? "text-slate-500 font-semibold" : tone === "now" ? "text-blue-700" : "text-slate-800"}`}>
              {label}
            </p>
            {body}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Shared "Đóng" sheet chrome: backdrop, drag handle, scroll body, close button. */
export function SheetShell({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Chi tiết chuyến"
        className="w-full max-w-sm bg-white rounded-t-[20px] max-h-[86vh] overflow-y-auto px-5 pt-2.5 pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div aria-hidden className="w-10 h-1 rounded-full bg-slate-200 mx-auto mt-1 mb-3.5" />
        {children}
        <button onClick={onClose} className="w-full mt-4 py-3 rounded-xl text-sm font-semibold border border-slate-200 text-slate-600 active:bg-slate-50">
          Đóng
        </button>
      </div>
    </div>
  );
}
