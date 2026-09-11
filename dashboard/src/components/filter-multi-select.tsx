"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { foldName } from "@/lib/driver-cell";

export interface FilterOption {
  value: string;
  label: string;
}

export function FilterMultiSelect({
  label,
  values,
  options,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  options: readonly FilterOption[];
  onChange: (values: string[]) => void;
  placeholder: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const inputId = useId();
  const listId = useId();
  const selected = useMemo(() => new Set(values), [values]);
  const labels = useMemo(() => new Map(options.map((option) => [option.value, option.label])), [options]);
  const matches = useMemo(() => {
    const q = foldName(query.trim());
    return options.filter((option) =>
      !selected.has(option.value) && (!q || foldName(`${option.label} ${option.value}`).includes(q)),
    );
  }, [options, query, selected]);

  const place = useCallback(() => {
    const box = boxRef.current?.getBoundingClientRect();
    if (box) setRect({ left: box.left, top: box.bottom + 2, width: Math.min(Math.max(box.width, 240), 440) });
  }, []);

  const openMenu = useCallback(() => {
    place();
    setOpen(true);
  }, [place]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    document.addEventListener("mousedown", closeOutside);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("mousedown", closeOutside);
    };
  }, [open, place]);

  const add = (value: string) => {
    onChange([...values, value]);
    setQuery("");
    setActive(0);
    inputRef.current?.focus();
    requestAnimationFrame(place);
  };

  const remove = (value: string) => onChange(values.filter((item) => item !== value));

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      setActive((index) => {
        if (!matches.length) return 0;
        return (index + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
      });
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (open && matches[active]) add(matches[active].value);
    } else if (event.key === "Escape") {
      setOpen(false);
    } else if (event.key === "Backspace" && !query && values.length) {
      remove(values[values.length - 1]);
    }
  };

  return (
    <div className="min-w-0">
      <label htmlFor={inputId} className="mb-1 block text-[11px] font-medium text-slate-700">
        {label}
      </label>
      <div
        ref={boxRef}
        className="flex min-h-8 flex-wrap items-center gap-1 rounded border border-slate-300 bg-white px-1.5 py-1 focus-within:ring-2 focus-within:ring-indigo-400/50"
      >
        {values.map((value) => (
          <span
            key={value || "__blank__"}
            className="inline-flex max-w-full items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-800"
          >
            <span className="truncate">{labels.get(value) ?? value}</span>
            <button
              type="button"
              onClick={() => remove(value)}
              aria-label={`Bỏ ${labels.get(value) ?? value}`}
              className="rounded text-slate-600 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
            >
              ✕
            </button>
          </span>
        ))}
        <input
          id={inputId}
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setActive(0); openMenu(); }}
          onFocus={openMenu}
          onKeyDown={onKeyDown}
          placeholder={values.length ? "Thêm…" : placeholder}
          className="min-w-[88px] flex-1 bg-transparent px-0.5 py-0.5 text-xs text-slate-900 outline-none placeholder:text-slate-500"
        />
        {open && rect && (
          <ul
            id={listId}
            role="listbox"
            aria-multiselectable="true"
            style={{ position: "fixed", left: rect.left, top: rect.top, width: rect.width, zIndex: 50 }}
            className="max-h-56 overflow-y-auto rounded-md border border-slate-200 bg-white py-1 shadow-md"
          >
            {matches.length === 0 && (
              <li className="px-2 py-1.5 text-[11px] text-slate-600">Không tìm thấy lựa chọn</li>
            )}
            {matches.map((option, index) => (
              <li key={option.value || "__blank__"}>
                <button
                  id={`${listId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected="false"
                  onMouseEnter={() => setActive(index)}
                  onClick={() => add(option.value)}
                  className={`w-full px-2 py-1.5 text-left text-xs ${
                    index === active ? "bg-indigo-50 text-slate-900" : "text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {option.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
