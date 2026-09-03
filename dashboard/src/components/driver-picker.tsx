"use client";

import { DriverName } from "./driver-name";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { ConfigDriver } from "@/lib/types";

/**
 * Search-and-pick driver chooser for the "Gán thủ công" actions in the Cần xử lý
 * panel — shared by failed jobs and note-held jobs so both offer the same list
 * and the same interaction.
 *
 * The result list stays hidden until something is typed: the roster is ~160
 * active drivers, so an always-open list would bury the row it belongs to.
 * `drivers` is already filtered to active accounts (loadDriversFromSheet), so
 * every name here is one Cartrack will actually accept.
 */
export function DriverPicker({
  drivers,
  onConfirm,
  onCancel,
  confirmLabel = "Gán",
}: {
  drivers: ConfigDriver[];
  onConfirm: (driverId: string) => void;
  onCancel: () => void;
  confirmLabel?: string;
}) {
  const [selectedDriver, setSelectedDriver] = useState<string>("");
  const [searchInput, setSearchInput] = useState<string>("");

  // Accent-insensitive, because nobody typing quickly reaches for the diacritics:
  // "quynh" has to find "Nguyễn Hữu Quỳnh", or the search silently returns
  // nothing and the picker looks broken rather than picky. đ is folded on its own
  // line — it is a distinct Vietnamese letter, not a d with a mark, so Unicode
  // decomposition leaves it exactly as it was.
  const fold = (v: string) =>
    v.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
  const needle = fold(searchInput);

  const filteredDrivers = drivers.filter(d =>
    fold(d.name).includes(needle) ||
    d.driver_id.toLowerCase().includes(searchInput.toLowerCase())
  );

  const handleSelectDriver = (driverId: string) => {
    setSelectedDriver(driverId);
    setSearchInput("");
  };

  const selectedDriverName = drivers.find(d => d.driver_id === selectedDriver)?.name;

  return (
    <div className="space-y-1.5 mt-1.5">
      <div className="flex items-center gap-1">
        <div className="relative flex-1">
          <input
            type="text"
            placeholder="Tìm tài xế..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-full px-2 py-1 text-xs border border-slate-300 rounded"
            autoFocus
          />
          {selectedDriver && (
            <button
              onClick={() => {
                setSelectedDriver("");
                setSearchInput("");
              }}
              className="absolute right-1 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            >
              ✕
            </button>
          )}
        </div>
      </div>
      {selectedDriver && selectedDriverName && (
        <div className="text-xs px-2 py-1 bg-indigo-50 border border-indigo-200 rounded text-indigo-800">
          Đã chọn: {selectedDriverName}
        </div>
      )}
      {searchInput && filteredDrivers.length > 0 && (
        <div className="border border-slate-300 rounded max-h-32 overflow-y-auto bg-white">
          {filteredDrivers.map((d) => (
            <button
              key={d.driver_id}
              onClick={() => handleSelectDriver(d.driver_id)}
              className="flex w-full flex-wrap items-baseline gap-x-1.5 text-left px-2 py-1.5 text-xs hover:bg-slate-100 border-b border-slate-200 last:border-b-0"
            >
              <DriverName full={d.name} className="text-xs text-slate-800" />
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-1">
        <Button
          size="sm"
          className="flex-1 h-6 text-[11px] bg-indigo-600 hover:bg-indigo-700"
          disabled={!selectedDriver}
          onClick={() => selectedDriver && onConfirm(selectedDriver)}
        >
          {confirmLabel}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="flex-1 h-6 text-[11px]"
          onClick={onCancel}
        >
          Hủy
        </Button>
      </div>
    </div>
  );
}
