// Sheet cutting, by hand: a workspace over the app where the design's flat parts lie nested on sheets for a laser,
// plasma table or waterjet. The sheet fills the space (scroll to zoom, drag to pan, double-click or F to fit) with
// each part's cuts, lead-ins and pierces; play runs the cutter round them in order, each part coming free as its
// outline closes. The panel picks the material and thickness, how many of each part, the cutter and its settings,
// and saves DXF, SVG or G-code. Claude's sheet_layout tool lays out the same job and can open it here.

import { AnimatePresence, motion } from "framer-motion";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDesign } from "../core/engine";
import { materialInfo } from "../mfg/materials";
import { area, bounds, inside, type Pt, type Region } from "../cam/clip";
import { CUTTERS, cutAt, cutTimeline, isLaser, type CutPath, type CutTimeline, type Cutter, type Placed } from "../cam/sheet";
import {
  chooseGroup,
  closeSheets,
  cutterOf,
  cutterStart,
  FORMAT_INFO,
  fitOf,
  groupName,
  groupOf,
  perSet,
  planKey,
  regather,
  renest,
  saveSheets,
  totals,
  useSheets,
  type SheetFormat,
  type SheetGroup,
  type SheetJob,
} from "../cam/sheetJob";
import { useCam } from "../cam/job";
import { fmtDuration, NumIn, Pick, SmallNum } from "./CamPanel";
import { Icon } from "./icons";

/** how long playing through one sheet takes, s */
const PLAY_SECONDS = 16;

const num = (x: number, d = 1) => String(+x.toFixed(d));
const f2 = (x: number) => String(Math.round(x * 100) / 100);

/** the stage's own "fit" key, so F fits the sheet rather than the hidden 3D view */
const fitWanted = new Set<() => void>();

interface Look {
  sheet: string;
  part: string;
  kerf: string;
  beam: string;
  label: string;
}

/** The sheet as it looks: the material, the burnt or dark line the cut leaves, and the beam's or jet's glow. */
function lookOf(material: string, cutter: Cutter): Look {
  const fam = materialInfo(material).family;
  const m = material.toLowerCase();
  const beam = cutter === "plasma" ? "#e3ebff" : cutter === "waterjet" ? "#8fdcff" : cutter === "fiber" ? "#ffe08a" : "#ff8a3d";
  if (fam === "wood") return { sheet: "#8f6a41", part: "#d6b07a", kerf: "#22150a", beam, label: "#3a2610" };
  if (fam === "metal") return /alum/.test(m) ? { sheet: "#7f8995", part: "#c6ced7", kerf: "#2a3036", beam, label: "#1d2328" } : { sheet: "#636b76", part: "#a7afb9", kerf: "#1d2126", beam, label: "#161a1e" };
  if (/acrylic|pmma|polycarbonate|\bpc\b/.test(m)) return { sheet: "rgba(120, 175, 220, 0.28)", part: "rgba(165, 214, 246, 0.62)", kerf: "#d9f0ff", beam, label: "#0d2233" };
  return { sheet: "#73777f", part: "#b7bbc4", kerf: "#22252b", beam, label: "#1b1e24" };
}

/** Paths for a sheet H tall, drawn with y down as the screen has it. */
function drawer(H: number) {
  const P = (p: Pt) => `${f2(p[0])} ${f2(H - p[1])}`;
  const loop = (l: Pt[]) => (l.length ? `M${l.map(P).join("L")}Z` : "");
  return { P, loop, region: (r: Region) => r.map(loop).join(""), line: (pts: Pt[]) => (pts.length ? `M${pts.map(P).join("L")}` : "") };
}

/** The longest run of material along a line through a part, from a to b, sampled n times: [from, to] as fractions. */
function longestRun(r: Region, at: (f: number) => Pt, n: number, through?: number): [number, number] | null {
  let best: [number, number] | null = null;
  let from = -1;
  for (let i = 0; i <= n; i++) {
    const f = (i + 0.5) / n;
    const ins = i < n && inside(at(f), r);
    if (ins && from < 0) from = i;
    if (!ins && from >= 0) {
      const run: [number, number] = [from / n, i / n];
      const holds = through === undefined || (through >= run[0] && through <= run[1]);
      if (holds && (!best || run[1] - run[0] > best[1] - best[0])) best = run;
      from = -1;
    }
  }
  return best;
}

/** Where a part's name fits: up its middle on the longest run of material, as big as fits across there. */
function labelSpot(r: Region, text: string, cap: number): { p: Pt; size: number } | null {
  const b = bounds(r);
  if (!b) return null;
  const w = b.hi[0] - b.lo[0],
    h = b.hi[1] - b.lo[1];
  const cx = b.lo[0] + w / 2;
  const up = longestRun(r, (f) => [cx, b.lo[1] + f * h], 32);
  if (!up) return null;
  const y = b.lo[1] + ((up[0] + up[1]) / 2) * h;
  const across = longestRun(r, (f) => [b.lo[0] + f * w, y], 48, 0.5);
  const free = across ? 2 * Math.min(0.5 - across[0], across[1] - 0.5) * w : w;
  const size = Math.min(cap, (up[1] - up[0]) * h * 0.4, free / (0.62 * text.length + 0.8));
  return { p: [cx, y], size };
}

const PartsLayer = memo(function PartsLayer({ parts, H, look, freedKey, hi, cap, minText }: { parts: Placed[]; H: number; look: Look; freedKey: string; hi: string; cap: number; minText: number }) {
  const d = drawer(H);
  return (
    <g>
      {parts.map((p, i) => {
        const free = freedKey[i] === "1";
        const name = `${p.label}${p.copy > 1 ? ` ${p.copy}` : ""}`;
        const spot = labelSpot(p.region, name, cap);
        return (
          <g key={i} className={`sheet-part ${p.key === hi ? "hi" : ""}`}>
            <title>{`${p.label}, copy ${p.copy}${p.turn ? `, turned ${p.turn * 90}°` : ""}`}</title>
            <path d={d.region(p.region)} fillRule="evenodd" fill={free ? look.part : "transparent"} stroke={free ? look.kerf : "rgba(255,255,255,0.34)"} strokeWidth={free ? 1 : 0.8} strokeDasharray={free ? undefined : "3 3"} vectorEffect="non-scaling-stroke" filter={free ? "url(#sheet-lift)" : undefined} />
            {spot && spot.size >= minText && (
              <text x={f2(spot.p[0])} y={f2(H - spot.p[1])} fontSize={f2(spot.size)} textAnchor="middle" dominantBaseline="central" fill={free ? look.label : "rgba(255,255,255,0.5)"} className="sheet-label">
                {name}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
});

/** The cuts done so far: the dark line each leaves. */
const KerfLayer = memo(function KerfLayer({ tl, done, H, color }: { tl: CutTimeline; done: number; H: number; color: string }) {
  const d = drawer(H);
  const s = tl.steps
    .slice(0, done)
    .filter((x) => x.kind === "cut")
    .map((x) => d.line(x.pts))
    .join("");
  return <path d={s} fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />;
});

/** Lead-ins, pierces, travel between cuts and the order the cuts go in. */
const PathsLayer = memo(function PathsLayer({ paths, tl, H, order, size }: { paths: CutPath[]; tl: CutTimeline; H: number; order: boolean; size: number }) {
  const d = drawer(H);
  const travel = tl.steps
    .filter((x) => x.kind === "travel")
    .map((x) => d.line(x.pts))
    .join("");
  return (
    <g className="sheet-paths">
      <path d={travel} fill="none" className="sheet-travel" vectorEffect="non-scaling-stroke" />
      <path d={paths.map((p) => d.line([p.pierce, p.loop[0]])).join("")} fill="none" className="sheet-lead" vectorEffect="non-scaling-stroke" />
      <path d={paths.map((p) => `M${d.P(p.pierce)}h0`).join("")} fill="none" className="sheet-pierce" vectorEffect="non-scaling-stroke" />
      {order &&
        paths.map((p, i) => (
          <text key={i} x={f2(p.pierce[0])} y={f2(H - p.pierce[1] - size * 0.8)} fontSize={f2(size)} textAnchor="middle" className="sheet-order">
            {i + 1}
          </text>
        ))}
    </g>
  );
});

/** Every sheet small, to pick one. */
const Thumbs = memo(function Thumbs({ sheets, size, current, look }: { sheets: Placed[][]; size: [number, number]; current: number; look: Look }) {
  const [W, H] = size;
  const d = drawer(H);
  return (
    <div className="sheet-thumbs" role="tablist" aria-label="Sheets">
      {sheets.map((s, i) => {
        const used = Math.round((s.reduce((a, p) => a + area(p.region), 0) / (W * H)) * 100);
        return (
          <button key={i} role="tab" aria-selected={i === current} className={`sheet-thumb ${i === current ? "on" : ""}`} onClick={() => useSheets.setState({ sheet: i, t: 1 })} data-tip={`Sheet ${i + 1}: ${s.length} parts, ${used}% used`}>
            <svg viewBox={`0 0 ${f2(W)} ${f2(H)}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
              <rect width={W} height={H} fill={look.sheet} />
              <path d={s.map((p) => d.region(p.region)).join("")} fillRule="evenodd" fill={look.part} />
            </svg>
            <span className="mono">{i + 1}</span>
          </button>
        );
      })}
    </div>
  );
});

/** The sheet, with the cutting as far as the time shown. Scroll zooms, drag pans, double-click or F fits. */
function SheetStage({ job, g, sheets, parts, paths, tl, size, hi }: { job: SheetJob; g: SheetGroup; sheets: Placed[][]; parts: Placed[]; paths: CutPath[]; tl: CutTimeline; size: [number, number]; hi: string }) {
  const { t, show, sheet } = useSheets();
  const [W, H] = size;
  const box = useRef<HTMLDivElement | null>(null);
  const [px, setPx] = useState<[number, number]>([900, 600]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => setPx([Math.max(1, el.clientWidth), Math.max(1, el.clientHeight)]);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // the whole sheet, clear of the sheet's name and thumbnails above it and the hint below
  const fit = useMemo(() => {
    const [cw, ch] = px;
    const top = 62,
      bottom = 34,
      side = 24;
    const k = Math.max(1e-6, Math.min((cw - 2 * side) / W, (ch - top - bottom) / H));
    return { x: -(cw / k - W) / 2, y: -(top + (ch - top - bottom - H * k) / 2) / k, w: cw / k, h: ch / k };
  }, [px, W, H]);
  const [view, setView] = useState(fit);
  const svg = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ x: number; y: number; v: typeof view; k: number } | null>(null);
  useEffect(() => setView(fit), [fit]);
  useEffect(() => {
    const f = () => setView(fit);
    fitWanted.add(f);
    return () => void fitWanted.delete(f);
  }, [fit]);

  // zoom about the pointer
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const m = el.getScreenCTM();
      if (!m) return;
      const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
      const k = Math.pow(1.0015, e.deltaY);
      setView((v) => {
        const w = Math.min(fit.w * 4, Math.max(fit.w / 80, v.w * k));
        const s = w / v.w;
        return { x: pt.x - (pt.x - v.x) * s, y: pt.y - (pt.y - v.y) * s, w, h: v.h * s };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [fit]);

  const s = t * tl.total;
  const now = t >= 1 ? { step: tl.steps.length, done: [] as Pt[] } : cutAt(tl, s);
  const doneSteps = t >= 1 ? tl.steps.length : now.step;
  // a part is free once its last cut is done
  const lastCut = useMemo(() => {
    const last = parts.map(() => -1);
    tl.steps.forEach((st, k) => {
      if (st.kind === "cut") last[paths[st.path].part] = k;
    });
    return last;
  }, [tl, parts, paths]);
  const freedKey = lastCut.map((k) => (t >= 1 || (k >= 0 && k < doneSteps) ? "1" : "0")).join("");
  const step = t < 1 ? tl.steps[now.step] : undefined;
  const d = drawer(H);
  const look = lookOf(g.material, job.cutter);
  const head = now.done.length ? now.done[now.done.length - 1] : null;
  const on = !!step && step.kind !== "travel";
  const big = Math.max(W, H);
  const glow = big * 0.008;
  const used = Math.round((parts.reduce((a, p) => a + area(p.region), 0) / (W * H)) * 100);

  return (
    <div className="sheet-stage" ref={box}>
      <svg
        ref={svg}
        viewBox={`${f2(view.x)} ${f2(view.y)} ${f2(view.w)} ${f2(view.h)}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Sheet ${sheet + 1} of ${sheets.length}, ${num(W)} by ${num(H)} mm, with ${parts.length} parts`}
        onDoubleClick={() => setView(fit)}
        onPointerDown={(e) => {
          const m = svg.current?.getScreenCTM();
          if (!m || e.button !== 0) return;
          svg.current?.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, v: view, k: 1 / m.a };
        }}
        onPointerMove={(e) => {
          const dr = drag.current;
          if (!dr) return;
          setView({ ...dr.v, x: dr.v.x - (e.clientX - dr.x) * dr.k, y: dr.v.y - (e.clientY - dr.y) * dr.k });
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <defs>
          <filter id="sheet-lift" x="-10%" y="-10%" width="120%" height="120%">
            <feDropShadow dx={f2(glow * 0.15)} dy={f2(glow * 0.3)} stdDeviation={f2(glow * 0.35)} floodColor="#000" floodOpacity="0.55" />
          </filter>
          <radialGradient id="sheet-beam">
            <stop offset="0" stopColor="#fff" stopOpacity="1" />
            <stop offset="0.25" stopColor={look.beam} stopOpacity="0.95" />
            <stop offset="1" stopColor={look.beam} stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect x={0} y={0} width={W} height={H} fill={look.sheet} className="sheet-sheet" />
        <rect x={job.margin} y={job.margin} width={Math.max(0, W - 2 * job.margin)} height={Math.max(0, H - 2 * job.margin)} fill="none" className="sheet-margin" vectorEffect="non-scaling-stroke" />
        <PartsLayer parts={parts} H={H} look={look} freedKey={freedKey} hi={hi} cap={big * 0.032} minText={big * 0.006} />
        <KerfLayer tl={tl} done={doneSteps} H={H} color={look.kerf} />
        {show.paths && <PathsLayer paths={paths} tl={tl} H={H} order={show.order} size={big * 0.012} />}
        {step && step.kind === "cut" && now.done.length > 1 && (
          <>
            <path d={d.line(now.done)} fill="none" stroke={look.beam} strokeOpacity={0.35} strokeWidth={7} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            <path d={d.line(now.done)} fill="none" stroke={look.beam} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </>
        )}
        {step && step.kind === "travel" && head && <path d={d.line([step.pts[0], head])} fill="none" className="sheet-move" vectorEffect="non-scaling-stroke" />}
        {head && (
          <g transform={`translate(${f2(head[0])} ${f2(H - head[1])})`} className={on ? "sheet-head on" : "sheet-head"}>
            {on && <circle r={f2(glow * (step?.kind === "pierce" ? 1.6 : 1))} fill="url(#sheet-beam)" className="sheet-glow" />}
            <circle r={f2(glow * 0.32)} fill="none" stroke={on ? "#fff" : "var(--accent-2)"} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          </g>
        )}
      </svg>
      <div className="sheet-info">
        <b>
          Sheet {sheet + 1}
          {sheets.length > 1 ? ` of ${sheets.length}` : ""}
        </b>
        <span className="dim mono">
          {num(W, 0)} × {num(H, 0)} mm · {parts.length} parts · {used}%
        </span>
      </div>
      {sheets.length > 1 && <Thumbs sheets={sheets} size={size} current={sheet} look={look} />}
      <div className="sheet-hint dim">Scroll to zoom · drag to pan · double-click or F to fit</div>
    </div>
  );
}

const setJob = (patch: Partial<SheetJob>) => {
  const j = useSheets.getState().job;
  if (j) useSheets.setState({ job: { ...j, ...patch } });
};

function QtyIn({ value, onChange, tip }: { value: number; onChange: (v: number) => void; tip: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <input
      className="input mono sheet-qty"
      type="number"
      step={1}
      min={0}
      max={500}
      value={text}
      aria-label={tip}
      onChange={(e) => {
        setText(e.target.value);
        const v = Math.round(Number(e.target.value));
        if (e.target.value !== "" && Number.isFinite(v) && v >= 0 && v <= 500) onChange(v);
      }}
    />
  );
}

function SheetPanel({ hover, setHover }: { hover: string; setHover: (k: string) => void }) {
  const { job, groups, result, busy, gathering, error, planned } = useSheets();
  const [more, setMore] = useState(false);
  const g = groupOf(job, groups);
  const stale = !!result && !!job && planned !== planKey(job, g);
  const head = (
    <div className="mt-head">
      <Icon.LaserCut size={14} />
      <span className="grow" style={{ marginLeft: 6 }}>
        Sheet cutting
      </span>
      {(busy || gathering) && <span className="spinner sm" aria-label="Working" />}
      <button className="icon-btn sm" onClick={closeSheets} aria-label="Close" data-tip="Back to the model (Esc)">
        <Icon.X size={12} />
      </button>
    </div>
  );
  if (!job || !g)
    return (
      <div className="cam-panel sheet-panel" role="dialog" aria-label="Sheet cutting">
        {head}
        {error ? <div className="cam-note fail">{error}</div> : <div className="cam-note">{gathering ? "Finding the flat parts and their outlines…" : "No flat parts to cut."}</div>}
      </div>
    );
  const fit = fitOf(job, g);
  const laser = isLaser(job.cutter);
  const sum = result ? totals(job, result) : null;
  const n = result?.nest.sheets.length ?? 0;
  const total = g.items.reduce((a, it) => a + perSet(job, g, it), 0) * job.sets;
  const stepped = g.items.filter((it) => it.stepped && perSet(job, g, it) > 0);
  return (
    <div className="cam-panel sheet-panel" role="dialog" aria-label="Sheet cutting">
      {head}
      {fit.status !== "pass" && <div className={`cam-note ${fit.status}`}>{fit.why.replace(/^./, (c) => c.toUpperCase())}.</div>}
      {error && <div className="cam-note fail">{error}</div>}
      {result && sum && (
        <div className={`cam-result ${stale ? "stale" : ""}`}>
          <div className="cam-sum">
            <b>{n ? `${n} sheet${n > 1 ? "s" : ""}, ${Math.round(result.nest.used * 100)}% used` : total ? "Nothing fits" : "No parts chosen"}</b>
            {n > 0 && (
              <span className="dim">
                {" "}
                · {total} parts · {num(sum.cut / 1000, 2)} m of cutting · {sum.pierces} pierces · about {fmtDuration(sum.seconds)}
              </span>
            )}
          </div>
          {result.nest.unplaced.length > 0 && (
            <div className="cam-note warn">
              Too big for the sheet: {result.nest.unplaced.map((u) => `${u.label} × ${u.count}`).join(", ")}. Use a bigger sheet or a smaller edge.
            </div>
          )}
          {stepped.length > 0 && (
            <div className="cam-note warn">
              {stepped.map((x) => x.label).join(", ")} {stepped.length > 1 ? "are" : "is"} not the same all the way through: only the outline and through holes are cut, so pockets and steps need another step.
            </div>
          )}
        </div>
      )}
      {!result && !error && <div className="cam-note">{gathering ? "Finding the flat parts and their outlines…" : "Nesting the parts…"}</div>}
      <Pick label="Material" tip="Each material and thickness is its own sheet stock" value={g.key} options={groups.map((x) => ({ value: x.key, label: `${groupName(x)} (${x.items.length})` }))} onChange={chooseGroup} />
      <div className="sheet-items" onPointerLeave={() => setHover("")}>
        {g.items.map((it) => {
          const q = perSet(job, g, it);
          return (
            <div key={it.key} className={`sheet-item ${q ? "" : "off"} ${hover === it.key ? "hi" : ""}`} onPointerEnter={() => setHover(it.key)}>
              <span className="grow sheet-item-name" data-tip={`${it.label}${it.names.length > 1 ? ` (${it.names.join(", ")})` : ""}: ${it.count} in the design${it.how === "sheet" ? ", cut as its flat pattern" : it.how === "flat" ? ", flat but not set to be cut (process: laser_cut)" : ""}`}>
                {it.label}
                {it.how === "sheet" && <span className="dim"> · flat pattern</span>}
                {it.stepped && <Icon.Alert size={11} className="sheet-warn" />}
              </span>
              <QtyIn value={q} tip={`How many ${it.label} each set has`} onChange={(v) => setJob({ qty: { ...job.qty, [it.key]: v } })} />
              <span className="dim mono sheet-of" data-tip="In the design">
                / {it.count}
              </span>
            </div>
          );
        })}
      </div>
      <NumIn label="Sets" unit="" min={1} max={100} tip="Cut this many of everything: kits of parts" value={job.sets} onChange={(v) => setJob({ sets: Math.max(1, Math.round(v)) })} />
      <Pick
        label="Cutter"
        tip="What cuts: the speeds, kerf, lead-ins and gap start from it"
        value={job.cutter}
        options={CUTTERS.map((c) => ({ value: c.id, label: c.label }))}
        onChange={(c) => {
          const start = cutterStart(c, g.material, g.thickness);
          setJob({ ...start, margin: Math.max(job.margin, start.gap) });
        }}
      />
      <div className="mt-num cam-nums" data-tip="The sheet, or the machine's bed: x by y">
        <span className="mono">Sheet</span>
        <div className="cam-nums-row">
          <SmallNum word="×" tip="Sheet width, mm" step={10} min={10} value={job.sheet[0]} onChange={(v) => setJob({ sheet: [v, job.sheet[1]] })} />
          <SmallNum word="" tip="Sheet depth, mm" step={10} min={10} value={job.sheet[1]} onChange={(v) => setJob({ sheet: [job.sheet[0], v] })} />
        </div>
        <span className="dim mono">mm</span>
      </div>
      <div className="mt-num cam-nums" data-tip="Space between parts, and from the sheet's edges">
        <span className="mono">Gap, edge</span>
        <div className="cam-nums-row">
          <SmallNum word="" tip="Space between parts, mm" step={0.5} value={job.gap} onChange={(v) => setJob({ gap: v })} />
          <SmallNum word="" tip="Space from the sheet's edges, mm" step={0.5} value={job.margin} onChange={(v) => setJob({ margin: v })} />
        </div>
        <span className="dim mono">mm</span>
      </div>
      <Pick
        label="Turning"
        tip="Turn parts a quarter at a time to fit more on a sheet; keep them as drawn for wood grain or brushed metal"
        value={job.rotate ? "turn" : "keep"}
        options={[
          { value: "turn", label: "Turn parts to fit" },
          { value: "keep", label: "Keep as drawn (grain)" },
        ]}
        onChange={(v) => setJob({ rotate: v === "turn" })}
      />
      <button className="btn sm ghost cam-more" onClick={() => setMore(!more)} aria-expanded={more}>
        <Icon.ChevronDown size={11} style={{ transform: more ? "none" : "rotate(-90deg)" }} /> Kerf, lead-ins and speed
      </button>
      {more && (
        <>
          <NumIn label="Kerf" step={0.05} min={0} max={5} tip="The width the cut takes: the cuts run half of it outside each part, so parts come out to size" value={job.kerf} onChange={(v) => setJob({ kerf: v })} />
          <NumIn label="Lead-in" step={0.5} min={0} max={20} tip="Pierce this far off the line in the scrap and lead in, so the pierce mark is not on the part (0: pierce on the line)" value={job.lead} onChange={(v) => setJob({ lead: v })} />
          <NumIn label="Overcut" step={0.25} min={0} max={10} tip="Cut on past the start, to close each loop cleanly" value={job.overcut} onChange={(v) => setJob({ overcut: v })} />
          <NumIn label="Speed" unit="mm/min" step={50} min={10} max={50000} tip="Cutting speed: a starting point, test on scrap" value={job.speed} onChange={(v) => setJob({ speed: v })} />
          {laser && <NumIn label="Power" unit="%" step={5} min={1} max={100} value={job.power} onChange={(v) => setJob({ power: v })} />}
          <NumIn label="Passes" unit="" min={1} max={20} tip="Times round each cut: a diode laser takes thick wood in several" value={job.passes} onChange={(v) => setJob({ passes: Math.max(1, Math.round(v)) })} />
          {!laser && <NumIn label="Pierce wait" unit="s" step={0.1} min={0} max={10} tip="How long the torch or jet waits to get through before moving" value={job.pierceDelay} onChange={(v) => setJob({ pierceDelay: v })} />}
        </>
      )}
      <div className="sheet-save">
        <span className="dim">Save {n > 1 ? `all ${n} sheets` : "the sheet"} as</span>
        {(Object.keys(FORMAT_INFO) as SheetFormat[]).map((f) => (
          <button key={f} className={`btn sm ${f === "dxf" ? "primary" : ""}`} disabled={!n || stale || busy} onClick={() => void saveSheets(f)} data-tip={`${FORMAT_INFO[f].tip}${n > 1 ? ". A file per sheet, in a zip" : ""}`}>
            <Icon.Download size={12} /> {FORMAT_INFO[f].label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Along the bottom: play the cutting of the sheet shown, how far through, which sheet, and what to show. */
function SheetBar({ playing, setPlaying, tl, parts, paths }: { playing: boolean; setPlaying: (p: boolean) => void; tl: CutTimeline; parts: Placed[]; paths: CutPath[] }) {
  const { result, t, sheet, show } = useSheets();
  const n = result?.nest.sheets.length ?? 0;
  if (!result || !n) return <div className="cam-bar sheet-bar" />;
  const s = t * tl.total;
  const now = t < 1 ? cutAt(tl, s) : null;
  const step = now ? tl.steps[now.step] : undefined;
  const path = step ? paths[step.path] : undefined;
  const part = path ? parts[path.part] : undefined;
  const name = part ? `${part.label}${part.copy > 1 ? ` ${part.copy}` : ""}` : "";
  const go = (k: number) => (setPlaying(false), useSheets.setState({ sheet: Math.max(0, Math.min(n - 1, k)), t: 1 }));
  return (
    <div className="cam-bar sheet-bar">
      <button className="icon-btn" onClick={() => setPlaying(!playing)} aria-label={playing ? "Pause" : "Play the cutting"} data-tip={playing ? "Pause (Space)" : "Play the cutting (Space)"}>
        {playing ? <Icon.Pause size={14} /> : <Icon.Play size={14} />}
      </button>
      <div className="cam-track grow">
        <input className="slider" type="range" min={0} max={1} step={0.0005} value={t} aria-label="How far through the cutting" style={{ ["--p" as string]: `${t * 100}%` }} onChange={(e) => (setPlaying(false), useSheets.setState({ t: Number(e.target.value) }))} />
        <div className="cam-now dim">{!step ? <>Done: {parts.length} parts cut free</> : step.kind === "travel" ? <>Moving to the next cut</> : step.kind === "pierce" ? <>Piercing for {name}</> : <>{path?.hole ? `Cutting a hole in ${name}` : `Cutting out ${name}`}</>}</div>
      </div>
      <span className="mono cam-clock">
        {fmtDuration(s)} <span className="dim">/ {fmtDuration(tl.total)}</span>
      </span>
      {n > 1 && (
        <div className="sheet-nav">
          <button className="icon-btn sm" disabled={sheet <= 0} onClick={() => go(sheet - 1)} aria-label="Sheet before" data-tip="Sheet before (←)">
            <Icon.Chevron size={12} style={{ transform: "rotate(180deg)" }} />
          </button>
          <span className="mono">
            {sheet + 1}/{n}
          </span>
          <button className="icon-btn sm" disabled={sheet >= n - 1} onClick={() => go(sheet + 1)} aria-label="Next sheet" data-tip="Next sheet (→)">
            <Icon.Chevron size={12} />
          </button>
        </div>
      )}
      <button className={`btn sm ${show.paths ? "active" : "ghost"}`} aria-pressed={show.paths} onClick={() => useSheets.setState({ show: { ...show, paths: !show.paths } })} data-tip="Lead-ins, pierces and the moves between cuts">
        Paths
      </button>
      <button className={`btn sm ${show.order ? "active" : "ghost"}`} aria-pressed={show.order} onClick={() => useSheets.setState({ show: { paths: show.paths || !show.order, order: !show.order } })} data-tip="Number the cuts in the order they run: holes before the outline round them, a part in another's hole before that hole">
        Order
      </button>
    </div>
  );
}

/** The sheet cutting workspace over the app, laid out again a moment after anything changes. */
export function SheetLayer() {
  const { open, job, groups, result, sheet } = useSheets();
  const model = useDesign((s) => s.model);
  const [playing, setPlaying] = useState(false);
  const [hover, setHover] = useState("");
  const [top, setTop] = useState(46);
  const gathered = useRef(model);
  const g = groupOf(job, groups);
  const key = planKey(job, g);

  // under the app's top bar, which keeps the menus
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => setTop(Math.round(document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 46));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  // look through the design again after an edit
  useEffect(() => {
    if (!open) return;
    if (gathered.current === model && groups.length) return;
    const tm = setTimeout(() => {
      gathered.current = model;
      void regather();
    }, 400);
    return () => clearTimeout(tm);
  }, [open, model]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || !key) return;
    const tm = setTimeout(() => void renest(), 250);
    return () => clearTimeout(tm);
  }, [open, key]);

  // the CNC panel and this take turns
  useEffect(() => useCam.subscribe((s, prev) => void (s.open && !prev.open && closeSheets())), []);

  useEffect(() => {
    if (!playing || !open) return;
    let raf = 0;
    let last = performance.now();
    if (useSheets.getState().t >= 1) useSheets.setState({ t: 0 });
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const next = Math.min(1, useSheets.getState().t + dt / PLAY_SECONDS);
      useSheets.setState({ t: next });
      if (next >= 1) setPlaying(false);
      else raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, open]);

  // Esc closes it; Space plays and pauses; arrows step through the sheets; F fits. The hidden 3D view's own keys
  // wait until it is back.
  useEffect(() => {
    if (!open) {
      setPlaying(false);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const typing = !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
      const st = useSheets.getState();
      const n = st.result?.nest.sheets.length ?? 0;
      if (e.key === "Escape") {
        if (typing && !el?.closest(".sheet-work")) return;
        e.stopPropagation();
        setPlaying(false);
        closeSheets();
        return;
      }
      if (typing) return;
      e.stopPropagation();
      if (e.key === " " && n) {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && n > 1) {
        e.preventDefault();
        setPlaying(false);
        useSheets.setState({ sheet: Math.max(0, Math.min(n - 1, st.sheet + (e.key === "ArrowLeft" ? -1 : 1))), t: 1 });
      } else if (e.key === "f" || e.key === "F") for (const f of fitWanted) f();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  const sheets = result?.nest.sheets ?? [];
  const parts = sheets[sheet] ?? [];
  const paths = result?.paths[sheet] ?? [];
  const tl = useMemo<CutTimeline>(() => (job ? cutTimeline(paths, cutterOf(job)) : { steps: [], total: 0 }), [paths, job?.cutter, job?.speed, job?.passes, job?.pierceDelay]); // eslint-disable-line react-hooks/exhaustive-deps

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div key="sheet-work" className="sheet-work" style={{ top }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }} onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
          {job && g && result && sheets.length > 0 ? (
            <SheetStage job={job} g={g} sheets={sheets} parts={parts} paths={paths} tl={tl} size={result.nest.sheet} hi={hover} />
          ) : (
            <div className="sheet-stage empty">
              <span className="dim">{useSheets.getState().gathering ? "Finding the flat parts…" : result ? "Nothing to lay out: set how many of each part to cut." : "Nesting…"}</span>
            </div>
          )}
          <SheetPanel hover={hover} setHover={setHover} />
          <SheetBar playing={playing} setPlaying={setPlaying} tl={tl} parts={parts} paths={paths} />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
