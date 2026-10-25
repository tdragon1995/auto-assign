/**
 * The Sunday roster as a PNG — the picture the drivers' Zalo group gets on
 * Friday. Drawn from the same lines as the post's text and the Lịch CN tab, so
 * the red rows here are exactly the slots the text lists and "Nhận ca" offers.
 */
import { ImageResponse } from "next/og";
import type { SundayLine } from "./sunday-roster-zalo";
import { isMorning, isOpen } from "./sunday-roster-post";

const W = 1080, PAD = 36, FONT = 19, LINE = 26;
const COLS = { n: 58, name: 226, area: 296, shift: 150, note: W - 2 * PAD - 58 - 226 - 296 - 150 };

/** Be Vietnam Pro, subset to exactly the text drawn. The bundled default font
 *  has no Vietnamese, so without this every tone mark renders as a box. */
async function font(weight: 400 | 700, text: string): Promise<ArrayBuffer | null> {
  try {
    const css = await (await fetch(`https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@${weight}&text=${encodeURIComponent(text)}`)).text();
    const url = css.match(/src: url\((.+?)\) format\('(?:opentype|truetype)'\)/)?.[1];
    return url ? await (await fetch(url)).arrayBuffer() : null;
  } catch {
    return null;
  }
}

/** Satori needs the height up front: estimate each row's wrapped line count. */
function rowLines(l: SundayLine): number {
  const wrap = (s: string, w: number) => s.split("\n").reduce((n, p) => n + Math.max(1, Math.ceil((p.length * FONT * 0.56) / (w - 16))), 0);
  return Math.max(wrap(l.name || "Còn trống", COLS.name), wrap(l.area, COLS.area), wrap(l.note, COLS.note), 1);
}

const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

function Section({ title, color, rows }: { title: string; color: string; rows: SundayLine[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", marginTop: 18, border: "1px solid #d1d5db", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ display: "flex", background: color, color: "white", fontWeight: 700, fontSize: 22, padding: "10px 16px" }}>{`${title} · ${rows.length}`}</div>
      {rows.map((l, i) => {
        const open = isOpen(l);
        return (
          <div key={l.id} style={{ display: "flex", background: open ? "#fee2e2" : i % 2 ? "#f9fafb" : "white", borderTop: "1px solid #e5e7eb", padding: "8px 0" }}>
            <div style={{ display: "flex", width: COLS.n, paddingLeft: 16, color: "#9ca3af" }}>{String(i + 1)}</div>
            <div style={{ display: "flex", width: COLS.name, paddingRight: 16, fontWeight: 700, color: open ? "#b91c1c" : "#111827" }}>
              {!l.name ? "— Còn trống —" : l.away ? "Cần người thay" : l.name}
            </div>
            <div style={{ display: "flex", width: COLS.area, paddingRight: 16, color: "#374151" }}>{l.area}</div>
            <div style={{ display: "flex", width: COLS.shift, paddingRight: 12, fontWeight: 700, color: "#111827" }}>{l.shift}</div>
            <div style={{ display: "flex", width: COLS.note, paddingRight: 16, color: "#92400e", fontSize: FONT - 2, whiteSpace: "pre-wrap" }}>{l.note}</div>
          </div>
        );
      })}
    </div>
  );
}

/** `lines` already filtered to the published ones. */
export async function renderRosterImage(date: string, lines: SundayLine[]): Promise<ImageResponse> {
  const morning = lines.filter((l) => isMorning(l.shift)), afternoon = lines.filter((l) => !isMorning(l.shift));
  const open = lines.filter(isOpen).length;

  const title = "LỊCH LÀM VIỆC CHỦ NHẬT";
  const sub = `Ngày ${dmy(date)}`;
  const legend = open ? `Dòng đỏ: còn trống ${open} vị trí — bấm "Nhận ca" trong Tab "Lịch CN"` : "Đã đủ người";
  const headers = ["#", "Họ và tên", "Địa điểm", "Ca", "Ghi chú", "Ca sáng", "Ca chiều", "— Còn trống —", "Cần người thay", "·"];
  const text = [title, sub, legend, ...headers, ...lines.flatMap((l) => [l.name, l.area, l.shift, l.note]), "0123456789"].join(" ");
  const [regular, bold] = await Promise.all([font(400, text), font(700, text)]);
  if (!regular || !bold) console.warn("[sunday-roster] image font not loaded — Vietnamese will not render");

  const sectionH = (rows: SundayLine[]) => (rows.length ? 18 + 46 + rows.reduce((h, l) => h + rowLines(l) * LINE + 17, 0) : 0);
  const height = PAD * 2 + 120 + 44 + sectionH(morning) + sectionH(afternoon);

  return new ImageResponse(
    (
      <div style={{ display: "flex", flexDirection: "column", width: W, height, padding: PAD, background: "white", fontFamily: "BVP", fontSize: FONT, lineHeight: `${LINE}px` }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ display: "flex", fontSize: 32, fontWeight: 700, color: "#1e3a8a", lineHeight: "42px" }}>{title}</div>
          <div style={{ display: "flex", fontSize: 26, fontWeight: 700, color: "#111827", lineHeight: "36px" }}>{sub}</div>
          <div style={{ display: "flex", marginTop: 6, color: open ? "#b91c1c" : "#047857", fontWeight: 700 }}>{legend}</div>
        </div>
        <div style={{ display: "flex", marginTop: 16, color: "#6b7280", fontSize: FONT - 2, fontWeight: 700 }}>
          <div style={{ display: "flex", width: COLS.n, paddingLeft: 16 }}>#</div>
          <div style={{ display: "flex", width: COLS.name }}>Họ và tên</div>
          <div style={{ display: "flex", width: COLS.area }}>Địa điểm</div>
          <div style={{ display: "flex", width: COLS.shift }}>Ca</div>
          <div style={{ display: "flex", width: COLS.note }}>Ghi chú</div>
        </div>
        {morning.length > 0 && <Section title="Ca sáng" color="#f59e0b" rows={morning} />}
        {afternoon.length > 0 && <Section title="Ca chiều" color="#2563eb" rows={afternoon} />}
      </div>
    ),
    {
      width: W, height,
      fonts: [regular && { name: "BVP", data: regular, weight: 400 as const }, bold && { name: "BVP", data: bold, weight: 700 as const }]
        .filter((f): f is { name: string; data: ArrayBuffer; weight: 400 | 700 } => !!f),
      headers: { "Cache-Control": "no-store" },
    },
  );
}
