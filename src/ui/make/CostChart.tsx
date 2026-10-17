// Cost per part as the quantity grows, on log scales: one line per way of
// making the part, the quantities of the tiers marked, and a crosshair that
// reads every line at the quantity under the pointer. Tooling makes a
// moulded part dear at ten and cheap at ten thousand; this is where that
// shows.

import { useEffect, useMemo, useRef, useState } from "react";
import { estimateCost } from "../../mfg/cost";
import { withStats } from "../../mfg/geometry";
import { PROCESSES } from "../../mfg/profiles";
import { money } from "../../materials/advise";
import type { ManufacturingPlan, Route } from "../../mfg/advisor";
import type { PlannedPart } from "../../mfg/plan";

/** Categorical slots, fixed order (validated for colour-blind separation in both themes: see styles/make.css). */
const SLOTS = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];

export interface Series {
  route: Route;
  color: string;
  /** a route drawn only while hovered elsewhere: dashed and neutral */
  ghost?: boolean;
}

/** Up to three routes worth drawing: each tier's pick first, then the best of the rest. */
export function chartRoutes(plan: ManufacturingPlan): Route[] {
  const out: Route[] = [];
  const add = (r: Route | undefined) => r && !out.includes(r) && out.length < SLOTS.length && out.push(r);
  for (const t of plan.tiers) add(t.recommended);
  for (const t of plan.tiers) add(t.cheapest);
  for (const r of plan.routes) if (r.status === "ok") add(r);
  return out;
}

export function seriesFor(plan: ManufacturingPlan, hovered: Route | null): Series[] {
  const routes = chartRoutes(plan);
  const out: Series[] = routes.map((route, i) => ({ route, color: SLOTS[i] }));
  if (hovered && !routes.includes(hovered) && hovered.status !== "no-material") out.push({ route: hovered, color: "var(--text-3)", ghost: true });
  return out;
}

const H = 196;
const PAD = { l: 46, r: 92, t: 18, b: 24 };

const fmtQty = (q: number) => (q >= 1e6 ? `${q / 1e6}M` : q >= 1000 ? `${q / 1000}k` : String(q));
const fmtAxisMoney = (v: number) => (v >= 1000 ? `$${v / 1000}k` : v >= 1 ? `$${v}` : `${Math.round(v * 100)}¢`);

/** Round ticks across a log range: powers of ten, with 2 and 5 between when the range is short. */
function logTicks(lo: number, hi: number): number[] {
  const out: number[] = [];
  const decades = Math.log10(hi / lo);
  const steps = decades < 2.5 ? [1, 2, 5] : [1];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) for (const m of steps) {
    const v = m * 10 ** e;
    if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v);
  }
  return out;
}

export function CostChart({ planned, hovered, onHoverRoute }: { planned: PlannedPart; hovered: Route | null; onHoverRoute?: (r: Route | null) => void }) {
  const { plan, fits } = planned;
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [at, setAt] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const series = useMemo(() => seriesFor(plan, hovered), [plan, hovered]);
  const qLo = 1;
  const qHi = Math.max(10000, ...plan.tiers.map((t) => t.parts * 4));
  const qtys = useMemo(() => {
    const out: number[] = [];
    const n = 64;
    for (let i = 0; i <= n; i++) out.push(Math.max(1, Math.round(qLo * (qHi / qLo) ** (i / n))));
    for (const t of plan.tiers) out.push(t.parts);
    return [...new Set(out)].sort((a, b) => a - b);
  }, [qHi, plan]);

  /** unit cost of a route at a number of parts */
  const unitOf = useMemo(() => {
    const cache = new Map<Route, (q: number) => number | null>();
    return (r: Route) => {
      let f = cache.get(r);
      if (!f) {
        const g = withStats(plan.geometry, fits[r.process]);
        const memo = new Map<number, number | null>();
        f = (q: number) => {
          if (!memo.has(q)) memo.set(q, estimateCost(r.process, r.material, g, q, { access: r.access === "none" ? "order" : r.access, labour: plan.labour })?.unit ?? null);
          return memo.get(q)!;
        };
        cache.set(r, f);
      }
      return f;
    };
  }, [plan, fits]);

  const lines = useMemo(() => series.map((s) => ({ ...s, pts: qtys.map((q) => [q, unitOf(s.route)(q)] as const).filter((p): p is readonly [number, number] => p[1] !== null && p[1] > 0) })), [series, qtys, unitOf]);

  const [yLo, yHi] = useMemo(() => {
    let lo = Infinity;
    let hi = 0;
    for (const l of lines) for (const [, v] of l.pts) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    if (!(lo < Infinity)) return [1, 100];
    // half-decade bounds: a little room above and below, and round ticks
    const a = 10 ** (Math.floor(Math.log10(lo) * 2) / 2);
    const b = 10 ** (Math.ceil(Math.log10(hi) * 2) / 2);
    return [a, b > a * 3 ? b : a * 10];
  }, [lines]);

  const iw = Math.max(40, w - PAD.l - PAD.r);
  const ih = H - PAD.t - PAD.b;
  const x = (q: number) => PAD.l + (Math.log(q / qLo) / Math.log(qHi / qLo)) * iw;
  const y = (v: number) => PAD.t + ih - (Math.log(v / yLo) / Math.log(yHi / yLo)) * ih;
  const qAt = (px: number) => Math.max(qLo, Math.min(qHi, Math.round(qLo * (qHi / qLo) ** ((px - PAD.l) / iw))));

  // end labels, nudged apart so they never overlap
  const labels = useMemo(() => {
    const out = lines
      .filter((l) => l.pts.length)
      .map((l) => ({ l, y: y(l.pts[l.pts.length - 1][1]) }))
      .sort((a, b) => a.y - b.y);
    for (let i = 1; i < out.length; i++) if (out[i].y - out[i - 1].y < 13) out[i].y = out[i - 1].y + 13;
    return out;
  }, [lines, w, yLo, yHi]);

  const reading = at === null ? null : lines.map((l) => ({ l, v: unitOf(l.route)(at) })).filter((r): r is { l: (typeof lines)[number]; v: number } => r.v !== null).sort((a, b) => a.v - b.v);

  const move = (e: React.PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    setAt(qAt(e.clientX - r.left));
  };

  const xTicks = logTicks(qLo, qHi).filter((q) => Math.log10(q) % 1 === 0);
  const yTicks = logTicks(yLo, yHi);
  const path = (pts: readonly (readonly [number, number])[]) => pts.map(([q, v], i) => `${i ? "L" : "M"}${x(q).toFixed(1)},${y(v).toFixed(1)}`).join("");

  return (
    <div className="mk-chart" ref={box}>
      <div className="mk-chart-head">
        <span className="mk-h">Cost per part by quantity</span>
        <div className="mk-legend" role="list">
          {lines.map((l) => (
            <span key={l.route.process} role="listitem" className={`mk-key ${l.ghost ? "ghost" : ""}`} onMouseEnter={() => onHoverRoute?.(l.route)} onMouseLeave={() => onHoverRoute?.(null)}>
              <svg width="16" height="8" aria-hidden="true">
                <line x1="1" y1="4" x2="15" y2="4" stroke={l.color} strokeWidth="2" strokeLinecap="round" strokeDasharray={l.ghost ? "3 3" : undefined} />
              </svg>
              {PROCESSES[l.route.process].short}
              <span className="mk-key-m">{l.route.materialLabel}</span>
            </span>
          ))}
        </div>
      </div>
      {w > 0 && (
        <svg width={w} height={H} className="mk-svg" role="img" aria-label={`Cost per part from ${qLo} to ${fmtQty(qHi)} parts for ${lines.map((l) => PROCESSES[l.route.process].short).join(", ")}`}>
          {yTicks.map((v) => (
            <g key={v}>
              <line className="mk-grid" x1={PAD.l} x2={PAD.l + iw} y1={y(v)} y2={y(v)} />
              <text className="mk-tick" x={PAD.l - 6} y={y(v) + 3.5} textAnchor="end">
                {fmtAxisMoney(v)}
              </text>
            </g>
          ))}
          {xTicks.map((q) => (
            <text key={q} className="mk-tick" x={x(q)} y={H - 8} textAnchor="middle">
              {fmtQty(q)}
            </text>
          ))}
          {plan.tiers.map((t) => (
            <g key={t.qty} className={`mk-tier ${t.brief ? "brief" : ""}`}>
              <line x1={x(t.parts)} x2={x(t.parts)} y1={PAD.t - 4} y2={PAD.t + ih} />
              <text x={x(t.parts) + 3} y={PAD.t - 6}>
                {t.label.toLowerCase()}
              </text>
            </g>
          ))}
          {lines.map((l) => (
            <path key={l.route.process} d={path(l.pts)} fill="none" stroke={l.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={l.ghost ? "4 4" : undefined} className={hovered && hovered !== l.route ? "mk-dim" : undefined} />
          ))}
          {labels.map(({ l, y: ly }) => (
            <g key={l.route.process}>
              <line x1={PAD.l + iw + 4} x2={PAD.l + iw + 12} y1={ly} y2={ly} stroke={l.color} strokeWidth={2} strokeLinecap="round" strokeDasharray={l.ghost ? "3 2" : undefined} />
              <text className="mk-end" x={PAD.l + iw + 16} y={ly + 3.5}>
                {PROCESSES[l.route.process].short}
              </text>
            </g>
          ))}
          {reading && at !== null && (
            <g className="mk-cross">
              <line x1={x(at)} x2={x(at)} y1={PAD.t} y2={PAD.t + ih} />
              {reading.map((r) => (
                <circle key={r.l.route.process} cx={x(at)} cy={y(r.v)} r={4} fill={r.l.color} className="mk-dot" />
              ))}
            </g>
          )}
          <rect x={PAD.l} y={PAD.t} width={iw} height={ih} fill="transparent" onPointerMove={move} onPointerDown={move} onPointerLeave={() => setAt(null)} />
        </svg>
      )}
      {reading && at !== null && (
        <div className="mk-tip" style={{ left: Math.min(x(at) + 12, Math.max(0, w - 190)), top: PAD.t + 4 }}>
          <div className="mk-tip-q">{at.toLocaleString("en-US")} parts</div>
          {reading.map((r) => (
            <div key={r.l.route.process} className="mk-tip-row">
              <svg width="12" height="8" aria-hidden="true">
                <line x1="1" y1="4" x2="11" y2="4" stroke={r.l.color} strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span>{PROCESSES[r.l.route.process].short}</span>
              <b>{money(r.v)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
