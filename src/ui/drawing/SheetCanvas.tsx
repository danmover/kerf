// The sheet itself: every shape grouped by what it belongs to (a view, a
// part in a view, a dimension, the title block), so hovering and clicking
// work on whole items. Wheel zooms around the cursor, dragging pans.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { keyBoxes } from "../../drawing/compose";
import { PENS, shapeBox, type Box, type Pen, type Sheet, type Shape } from "../../drawing/sheet";
import { pathData } from "../../drawing/render";

export interface SheetTheme {
  paper: string;
  ink: string;
  hidden: string;
  center: string;
  thin: string;
  hatch: string;
  frame: string;
}

export const BLUEPRINT: SheetTheme = { paper: "#0f1624", ink: "#e4ecff", hidden: "#8296bb", center: "#5ec8bd", thin: "#c6d2ec", hatch: "#56688c", frame: "#9fb0d4" };
export const WHITE: SheetTheme = { paper: "#ffffff", ink: "#111111", hidden: "#222222", center: "#222222", thin: "#111111", hatch: "#333333", frame: "#111111" };

const ORDER: Pen[] = ["hatch", "thin", "center", "phantom", "cutting", "hidden", "frame", "visible", "border", "fill"];

function color(pen: Pen, t: SheetTheme) {
  if (pen === "hidden") return t.hidden;
  if (pen === "center" || pen === "cutting" || pen === "phantom") return t.center;
  if (pen === "hatch") return t.hatch;
  if (pen === "thin" || pen === "fill") return t.thin;
  if (pen === "frame" || pen === "border") return t.frame;
  return t.ink;
}

interface Group {
  key: string;
  paths: { pen: Pen; d: string }[];
  texts: Extract<Shape, { t: "text" }>[];
}

function groupShapes(sheet: Sheet): Group[] {
  const map = new Map<string, { paths: Map<Pen, string[]>; texts: Extract<Shape, { t: "text" }>[] }>();
  for (const s of sheet.shapes) {
    let g = map.get(s.key);
    if (!g) map.set(s.key, (g = { paths: new Map(), texts: [] }));
    if (s.t === "text") g.texts.push(s);
    else {
      const list = g.paths.get(s.pen) ?? [];
      list.push(pathData(s));
      g.paths.set(s.pen, list);
    }
  }
  return [...map].map(([key, g]) => ({ key, texts: g.texts, paths: ORDER.filter((p) => g.paths.has(p)).map((pen) => ({ pen, d: g.paths.get(pen)!.join("") })) }));
}

const SheetGroup = memo(function SheetGroup({ g, theme, k, state }: { g: Group; theme: SheetTheme; k: number; state: "" | "hot" | "sel" }) {
  // keep thin lines visible when zoomed out
  const minW = 0.7 / k;
  return (
    <g className={`dwg-g ${state}`}>
      {g.paths.map(({ pen, d }) =>
        pen === "fill" ? (
          <path key={pen} className="fill" d={d} fill={color(pen, theme)} stroke="none" />
        ) : (
          <path key={pen} d={d} fill="none" stroke={color(pen, theme)} strokeWidth={Math.max(PENS[pen].w, minW)} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={PENS[pen].dash?.join(" ")} />
        ),
      )}
      {g.texts.map((t, i) => (
        <text key={i} x={t.at[0]} y={t.at[1]} fontSize={t.size} textAnchor={t.anchor === "start" ? undefined : t.anchor} fontWeight={t.bold ? "bold" : undefined} transform={t.rot ? `rotate(${-t.rot} ${t.at[0]} ${t.at[1]})` : undefined} fill={theme.thin}>
          {t.s}
        </text>
      ))}
    </g>
  );
});

export interface CanvasApi {
  /** screen box (relative to the canvas) of a sheet box */
  toScreen: (b: Box) => Box;
  fit: () => void;
  zoom: (f: number) => void;
}

/** Which item a shape key belongs to when clicked: parts keep their view-part key. */
export function itemKey(key: string): string | null {
  if (/^v\d+:p\d+$/.test(key) || /^v\d+$/.test(key) || /^d\d+$/.test(key) || /^b\d+$/.test(key)) return key;
  if (key === "tb" || key === "bom" || key === "n" || key.startsWith("sec:") || key.startsWith("det:")) return key;
  if (key.startsWith("tbl")) return "tb";
  return null;
}

export function SheetCanvas({
  sheet,
  theme,
  selected,
  highlightParts,
  asked,
  onSelect,
  apiRef,
}: {
  sheet: Sheet;
  theme: SheetTheme;
  selected: string | null;
  /** part indexes to show as selected (from the 3D selection) */
  highlightParts: Set<number>;
  asked: string[];
  onSelect: (key: string | null) => void;
  apiRef: React.MutableRefObject<CanvasApi | null>;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [tf, setTf] = useState({ k: 1, tx: 0, ty: 0 });
  const [hover, setHover] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const groups = useMemo(() => groupShapes(sheet), [sheet]);
  const boxes = useMemo(() => keyBoxes(sheet), [sheet]);
  const fitted = useRef("");

  useLayoutEffect(() => {
    const el = svg.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    const pad = 28;
    const k = Math.max(0.05, Math.min((size.w - pad * 2) / sheet.w, (size.h - pad * 2 - 40) / sheet.h));
    setTf({ k, tx: (size.w - sheet.w * k) / 2, ty: 40 + (size.h - 40 - sheet.h * k) / 2 });
  }, [size.w, size.h, sheet.w, sheet.h]);

  // fit when another drawing or sheet size comes up, not when the same one recomposes
  useEffect(() => {
    const id = `${sheet.name}|${sheet.w}|${sheet.h}|${size.w > 0}`;
    if (fitted.current === id) return;
    fitted.current = id;
    fit();
  }, [sheet.name, sheet.w, sheet.h, size.w, fit]);

  const zoomAt = useCallback((f: number, cx: number, cy: number) => {
    setTf((t) => {
      const k = Math.max(0.2, Math.min(80, t.k * f));
      const r = k / t.k;
      return { k, tx: cx - (cx - t.tx) * r, ty: cy - (cy - t.ty) * r };
    });
  }, []);

  apiRef.current = {
    toScreen: (b) => [tf.tx + b[0] * tf.k, tf.ty + b[1] * tf.k, tf.tx + b[2] * tf.k, tf.ty + b[3] * tf.k],
    fit,
    zoom: (f) => zoomAt(f, size.w / 2, size.h / 2),
  };

  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean; id: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    drag.current = { x: e.clientX, y: e.clientY, tx: tf.tx, ty: tf.ty, moved: false, id: e.pointerId };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d && d.id === e.pointerId) {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) > 4) {
        d.moved = true;
        setPanning(true);
        svg.current?.setPointerCapture(e.pointerId);
      }
      if (d.moved) setTf((t) => ({ ...t, tx: d.tx + dx, ty: d.ty + dy }));
      return;
    }
    const k = (e.target as Element).getAttribute?.("data-k");
    setHover(k ? itemKey(k) : null);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setPanning(false);
    if (!d || d.moved) return;
    const k = (e.target as Element).getAttribute?.("data-k");
    onSelect(k ? itemKey(k) : null);
  };

  // what lights up: the hovered item, every view of a hovered part, balloons of its item
  const partOf = (key: string | null) => (key && /^v\d+:p(\d+)$/.exec(key)?.[1]) ?? null;
  const hoverPart = partOf(hover);
  const selPart = partOf(selected);
  const stateOf = (key: string): "" | "hot" | "sel" => {
    if (key === selected) return "sel";
    const p = partOf(key);
    if (p !== null && (p === selPart || highlightParts.has(Number(p)))) return "sel";
    if (key === hover || (p !== null && p === hoverPart)) return "hot";
    return "";
  };

  const partHits = useMemo(() => groups.filter((g) => /^v\d+:p\d+$/.test(g.key)), [groups]);
  // dimensions and balloons nest and overlap, so they are hit on their own
  // lines and text; the other items on their boxes, smallest on top
  const lineHits = useMemo(() => groups.filter((g) => /^[db]\d+$/.test(g.key)).map((g) => ({ key: g.key, d: g.paths.map((p) => p.d).join(""), texts: g.texts.map(shapeBox) })), [groups]);
  const itemHits = useMemo(
    () =>
      [...boxes]
        .filter(([k]) => k === "tb" || k === "bom" || k === "n" || k.startsWith("sec:") || k.startsWith("det:"))
        .sort(([, a], [, b]) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1])),
    [boxes],
  );
  const hoverBox = hover && !/^v\d+/.test(hover) ? boxes.get(hover) : null;
  const pad = Math.max(0.8, 3 / tf.k);

  return (
    <svg ref={svg} className={`dwg-svg ${panning ? "panning" : ""}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={() => setHover(null)} onDoubleClick={fit}>
      <g transform={`translate(${tf.tx} ${tf.ty}) scale(${tf.k})`}>
        <rect className="dwg-sheet-shadow" x={0} y={0} width={sheet.w} height={sheet.h} fill={theme.paper} />
        {groups.map((g) => (
          <SheetGroup key={g.key} g={g} theme={theme} k={quantise(tf.k)} state={stateOf(g.key)} />
        ))}
        {/* hit targets: views at the bottom, part outlines above them, sheet items on top */}
        {sheet.views.map((v, i) => (
          <rect key={`hv${i}`} className="dwg-hit view" data-k={`v${i}`} x={v.box[0] - 2} y={v.box[1] - 2} width={v.box[2] - v.box[0] + 4} height={v.box[3] - v.box[1] + 4} />
        ))}
        {partHits.map((g) => (
          <path key={`hp${g.key}`} className="dwg-hit part" data-k={g.key} d={g.paths.filter((p) => p.pen !== "hatch").map((p) => p.d).join("")} strokeWidth={Math.max(1.6, 7 / tf.k)} />
        ))}
        {itemHits.map(([k, b]) => (
          <rect key={`hi${k}`} className="dwg-hit" data-k={k} x={b[0] - 1} y={b[1] - 1} width={b[2] - b[0] + 2} height={b[3] - b[1] + 2} />
        ))}
        {lineHits.map((h) => (
          <g key={`hl${h.key}`}>
            {h.d && <path className="dwg-hit part" data-k={h.key} d={h.d} strokeWidth={Math.max(1.4, 6 / tf.k)} />}
            {h.texts.map((b, i) => (
              <rect key={i} className="dwg-hit" data-k={h.key} x={b[0] - pad} y={b[1] - pad} width={b[2] - b[0] + 2 * pad} height={b[3] - b[1] + 2 * pad} />
            ))}
          </g>
        ))}
        {hoverBox && <rect className="dwg-hit-box" x={hoverBox[0] - 1.2} y={hoverBox[1] - 1.2} width={hoverBox[2] - hoverBox[0] + 2.4} height={hoverBox[3] - hoverBox[1] + 2.4} strokeWidth={1 / tf.k} rx={1} />}
        {asked.map((k, i) => {
          const b = boxes.get(k);
          if (!b) return null;
          const r = Math.max(2.2, 9 / tf.k);
          return (
            <g key={`pin${k}`} className="dwg-pin">
              <circle cx={b[2] + r * 0.6} cy={b[1] - r * 0.6} r={r} />
              <text x={b[2] + r * 0.6} y={b[1] - r * 0.6 + r * 0.42} fontSize={r * 1.2} textAnchor="middle">
                {i + 1}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

/** Zoom bucket for stroke widths, so zooming does not re-render every group. */
function quantise(k: number) {
  return Math.pow(2, Math.round(Math.log2(k) * 2) / 2);
}
