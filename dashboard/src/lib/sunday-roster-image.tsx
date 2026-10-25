/**
 * The Sunday roster as a PNG — the picture the drivers' Zalo group gets on
 * Friday. Drawn from the same lines as the post's text and the Lịch CN tab, so
 * the red rows here are exactly the slots the text lists and "Nhận ca" offers.
 */
import { ImageResponse } from "next/og";
import type { SundayLine } from "./sunday-roster-zalo";
import { isMorning, isOpen } from "./sunday-roster-post";

// Two columns, so the picture comes out about square. A single 1080-wide
// column was ~1:3.5 and showed in Zalo as a thin strip nobody could read.
const PAD = 36, GAP = 32, FONT = 22, LINE = 30, NOTE_FONT = 19, NOTE_LINE = 26;
const COLS = { n: 46, name: 290, area: 360, shift: 180 };
const COL_W = COLS.n + COLS.name + COLS.area + COLS.shift + 2;
const W = PAD * 2 + COL_W * 2 + GAP;
const HEAD_H = 150, LABELS_H = 40, SECTION_HEAD_H = 50, SEGMENT_GAP = 16;

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
const wrap = (s: string, w: number, font: number) =>
  s.split("\n").reduce((n, p) => n + Math.max(1, Math.ceil((p.length * font * 0.58) / (w - 16))), 0);
function rowH(l: SundayLine): number {
  const main = Math.max(wrap(l.name || "— Còn trống —", COLS.name, FONT), wrap(l.area, COLS.area, FONT), 1);
  return 17 + main * LINE + (l.note ? 4 + wrap(l.note, COLS.name + COLS.area + COLS.shift, NOTE_FONT) * NOTE_LINE : 0);
}

const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

type Segment = { title: string; color: string; total: number; first: number; rows: SundayLine[] };

/** Cut the morning and afternoon lists into two columns of about equal height.
 *  A section broken across the columns repeats its header ("tiếp") on the right. */
function columns(sections: Omit<Segment, "first" | "total">[]): Segment[][] {
  const items = sections.flatMap((s) => s.rows.map((l, i) => ({ s, l, i })));
  const hs = items.map((it) => rowH(it.l));
  const total = hs.reduce((a, b) => a + b, 0) + sections.length * SECTION_HEAD_H;
  let cut = items.length, acc = 0;
  const seen = new Set<string>();
  for (let k = 0; k < items.length; k++) {
    if (!seen.has(items[k].s.title)) { seen.add(items[k].s.title); acc += SECTION_HEAD_H; }
    if (acc + hs[k] / 2 > total / 2) { cut = k; break; }
    acc += hs[k];
  }
  const segs = (from: number, to: number): Segment[] => {
    const out: Segment[] = [];
    for (const it of items.slice(from, to)) {
      const last = out[out.length - 1];
      if (last && last.title === it.s.title) last.rows.push(it.l);
      else out.push({ title: it.s.title, color: it.s.color, total: it.s.rows.length, first: it.i, rows: [it.l] });
    }
    return out;
  };
  return [segs(0, cut), segs(cut, items.length)];
}

const segmentH = (s: Segment) => SECTION_HEAD_H + s.rows.reduce((h, l) => h + rowH(l), 0);
const columnH = (c: Segment[]) => c.reduce((h, s, i) => h + segmentH(s) + (i ? SEGMENT_GAP : 0), 0);

function SegmentCard({ seg }: { seg: Segment }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", border: "1px solid #d1d5db", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ display: "flex", height: SECTION_HEAD_H, alignItems: "center", background: seg.color, color: "white", fontWeight: 700, fontSize: 24, padding: "0 16px" }}>
        {seg.first ? `${seg.title} (tiếp)` : `${seg.title} · ${seg.total}`}
      </div>
      {seg.rows.map((l, j) => {
        const i = seg.first + j, open = isOpen(l);
        return (
          <div key={l.id} style={{ display: "flex", flexDirection: "column", background: open ? "#fee2e2" : i % 2 ? "#f9fafb" : "white", borderTop: "1px solid #e5e7eb", padding: "8px 0" }}>
            <div style={{ display: "flex" }}>
              <div style={{ display: "flex", width: COLS.n, paddingLeft: 14, color: "#9ca3af", fontSize: NOTE_FONT }}>{String(i + 1)}</div>
              <div style={{ display: "flex", width: COLS.name, paddingRight: 16, fontWeight: 700, color: open ? "#b91c1c" : "#111827" }}>
                {!l.name ? "— Còn trống —" : l.away ? "Cần người thay" : l.name}
              </div>
              <div style={{ display: "flex", width: COLS.area, paddingRight: 16, color: "#374151" }}>{l.area}</div>
              <div style={{ display: "flex", width: COLS.shift, fontWeight: 700, color: "#111827", whiteSpace: "nowrap" }}>{l.shift}</div>
            </div>
            {l.note && (
              <div style={{ display: "flex", marginTop: 4, marginLeft: COLS.n, paddingRight: 16, color: "#92400e", fontSize: NOTE_FONT, lineHeight: `${NOTE_LINE}px`, whiteSpace: "pre-wrap" }}>
                {l.note}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Labels() {
  return (
    <div style={{ display: "flex", height: LABELS_H, alignItems: "center", color: "#6b7280", fontSize: NOTE_FONT, fontWeight: 700 }}>
      <div style={{ display: "flex", width: COLS.n, paddingLeft: 14 }}>#</div>
      <div style={{ display: "flex", width: COLS.name }}>Họ và tên</div>
      <div style={{ display: "flex", width: COLS.area }}>Địa điểm</div>
      <div style={{ display: "flex", width: COLS.shift }}>Ca</div>
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
  const headers = ["#", "Họ và tên", "Địa điểm", "Ca", "Ca sáng", "Ca chiều", "(tiếp)", "— Còn trống —", "Cần người thay", "·"];
  const text = [title, sub, legend, ...headers, ...lines.flatMap((l) => [l.name, l.area, l.shift, l.note]), "0123456789"].join(" ");
  const [regular, bold] = await Promise.all([font(400, text), font(700, text)]);
  if (!regular || !bold) console.warn("[sunday-roster] image font not loaded — Vietnamese will not render");

  const cols = columns([
    { title: "Ca sáng", color: "#f59e0b", rows: morning },
    { title: "Ca chiều", color: "#2563eb", rows: afternoon },
  ].filter((s) => s.rows.length));
  const height = PAD * 2 + HEAD_H + LABELS_H + Math.max(...cols.map(columnH), 0) + 8;

  return new ImageResponse(
    (
      <div style={{ display: "flex", flexDirection: "column", width: W, height, padding: PAD, background: "white", fontFamily: "BVP", fontSize: FONT, lineHeight: `${LINE}px` }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", height: HEAD_H }}>
          <div style={{ display: "flex", fontSize: 44, fontWeight: 700, color: "#1e3a8a", lineHeight: "56px" }}>{title}</div>
          <div style={{ display: "flex", fontSize: 32, fontWeight: 700, color: "#111827", lineHeight: "42px" }}>{sub}</div>
          <div style={{ display: "flex", marginTop: 8, fontSize: 24, color: open ? "#b91c1c" : "#047857", fontWeight: 700 }}>{legend}</div>
        </div>
        <div style={{ display: "flex", gap: GAP }}>
          {cols.map((c, ci) => (
            <div key={ci} style={{ display: "flex", flexDirection: "column", width: COL_W }}>
              <Labels />
              <div style={{ display: "flex", flexDirection: "column", gap: SEGMENT_GAP }}>
                {c.map((seg) => <SegmentCard key={`${seg.title}-${seg.first}`} seg={seg} />)}
              </div>
            </div>
          ))}
        </div>
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
