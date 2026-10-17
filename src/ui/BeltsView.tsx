// The Build tab's Belts section: each timing belt drawn in its own plane with
// the length and pluck note of every free span, what its tension does, and a
// tension control that edits the design (the parameter, or the tension: text).

import { useEffect, useMemo, useState } from "react";
import { useDesign } from "../core/engine";
import { commitSource } from "../app/project";
import { revealSpan, select } from "../app/view";
import { setParamValue } from "../core/sourceEdit";
import type { Model } from "../core/model";
import { beltChecks, beltTitle, insertTension, pluckSpan, spanHz } from "../machine/belts";
import type { BeltDef, MachineData } from "../machine/types";
import { fmtNum } from "../lang/values";
import { StatusIcon } from "./icons";
import "../styles/belts.css";

const N = (x: number, d = 1) => fmtNum(x, d);

export function Belts({ model, m }: { model: Model; m: MachineData }) {
  return (
    <div className="mp-pad belts">
      {m.belts.map((b) => (
        <BeltCard key={b.name} model={model} b={b} />
      ))}
    </div>
  );
}

function BeltCard({ model, b }: { model: Model; b: BeltDef }) {
  // the tension being dragged, before it is written to the design
  const [draft, setDraft] = useState<number | null>(null);
  const t = draft ?? b.tension;
  const checks = useMemo(() => beltChecks(b), [b]);
  const worst = checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "warn") ? "warn" : "pass";
  const ids = (name: string) => model.parts.filter((p) => p.name === name).map((p) => p.id);
  const f = b.figures;
  // what the dragged tension changes, before the design is rebuilt: pluck notes go with √T, the rest with T
  const dt = t - b.tension;
  const k = b.tension > 0 ? t / b.tension : 1;
  const pluck = pluckSpan(b);
  const inRange = t >= b.belt.tMin && t <= b.belt.tMax;
  const lo = Math.max(1, Math.floor(b.belt.tMin * 0.5));
  const hi = Math.ceil(b.belt.tMax * 1.4);

  return (
    <section className={`belt-card ${worst}`}>
      <header className="belt-head">
        <StatusIcon status={worst} />
        <button className="belt-title" onClick={() => select(ids(b.name))} data-tip="Select it in the model">
          <span className="name">{beltTitle(b)}</span>
          <span className="mono dim">{b.name}</span>
        </button>
        <span className="belt-kind">{b.label}</span>
      </header>

      <BeltDiagram b={b} tension={t} onNode={(n) => select(ids(n))} />

      <div className="belt-tension">
        <label htmlFor={`bt-${b.name}`}>Tension</label>
        <input
          id={`bt-${b.name}`}
          type="range"
          min={lo}
          max={hi}
          step={0.5}
          value={t}
          style={{ ["--lo" as string]: `${((b.belt.tMin - lo) / (hi - lo)) * 100}%`, ["--hi" as string]: `${((b.belt.tMax - lo) / (hi - lo)) * 100}%` }}
          onChange={(e) => setDraft(Number(e.target.value))}
          onPointerUp={() => draft !== null && commitTension(b, draft, () => setDraft(null))}
          onKeyUp={(e) => draft !== null && (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") && commitTension(b, draft, () => setDraft(null))}
        />
        <TensionField value={t} onCommit={(v) => commitTension(b, v, () => setDraft(null))} />
        <span className={`chip ${inRange ? "pass" : "warn"}`} data-tip={`A ${N(b.belt.width, 0)} mm ${b.belt.core} belt wants ${N(b.belt.tMin, 0)} to ${N(b.belt.tMax, 0)} N`}>
          {inRange ? `${N(b.belt.tMin, 0)}–${N(b.belt.tMax, 0)} N suits it` : t < b.belt.tMin ? "loose" : "over-tight"}
        </span>
        {b.tensionAssumed && draft === null && <span className="dim belt-note">not in the design yet: Kerf assumed it</span>}
      </div>

      <div className="belt-figs">
        {pluck && <Fig k="Pluck" v={`${N(spanHz(t, pluck.length, b.belt.mass), 0)} Hz`} s={`${N(pluck.length, 0)} mm span`} tip={`Pluck ${pluck.from} to ${pluck.to} and tune to this note`} />}
        <Fig k="Length" v={`${N(b.length, 0)} mm`} s={b.open ? `cut ${N(b.cutLength ?? 0, 0)} mm` : `${N(b.stockLength ?? 0, 0)} mm loop`} tip={b.open ? "Pitch length, and the length to cut: stretch taken off, clamp tails added" : "Pitch length, and the stock loop that fits"} />
        <Fig k="Stretch" v={`${N(f.stretch * k, 2)} mm`} tip="How much the belt stretches when tensioned" />
        {f.ringMin !== undefined && <Fig k="Rings at" v={`${N(f.ringMin, 0)} Hz`} s={`${N(f.kTotalMin ?? 0, 0)} N/mm softest`} tip="Lowest ringing frequency of what it moves; tune input shaping from a measurement" />}
        {f.lag !== undefined && <Fig k="Lag" v={`${N(f.lag * 1000, 0)} µm`} s="at full accel" tip="How far the load trails the motor while accelerating" />}
        {f.slack !== undefined && f.tight !== undefined && <Fig k="Slack / tight" v={`${N(f.slack + dt)} / ${N(f.tight + dt)} N`} s="at peak pull" warn={f.slack + dt <= 0.15 * t} tip="Belt tension on each side at the hardest acceleration: the slack side must stay above zero" />}
        {f.hubStatic !== undefined && f.hubLimit !== undefined && (
          <Fig k="Motor shaft" v={`${N(Math.max(f.hubStatic, f.hubPeak ?? 0) * k, 0)} N`} s={`of ${N(f.hubLimit, 0)} N`} warn={Math.max(f.hubStatic, f.hubPeak ?? 0) * k > f.hubLimit} tip={`Pull on ${b.motor?.name}'s front bearing, against its rating where the belt runs`} />
        )}
        {f.teethInMesh !== undefined && <Fig k="Teeth in mesh" v={N(f.teethInMesh, 0)} s={b.drive} warn={f.teethInMesh < 6} tip="Teeth engaged on the drive pulley: six or more carry the full rating" />}
      </div>

      <div className="mp-list belt-checks">
        {checks.map((c) => (
          <div key={c.id} className="check-item" onClick={() => c.span && revealSpan(c.span)} role="button" tabIndex={0}>
            <StatusIcon status={c.status} />
            <div style={{ minWidth: 0 }}>
              <div className="title">{c.title}</div>
              <div className="detail">{c.detail}</div>
            </div>
            <div className="basis">{c.basis === "geometry" ? "geom" : "calc"}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Fig({ k, v, s, tip, warn }: { k: string; v: string; s?: string; tip?: string; warn?: boolean }) {
  return (
    <div className={`mp-stat belt-fig ${warn ? "warn" : ""}`} data-tip={tip}>
      <span className="k">{k}</span>
      <span className="v">{v}</span>
      {s && <span className="s">{s}</span>}
    </div>
  );
}

function TensionField({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(N(value));
  useEffect(() => setText(N(value)), [value]);
  const commit = () => {
    const v = Number(text.replace(",", ".").replace(/\s*N$/i, ""));
    if (!Number.isFinite(v) || v <= 0 || v > 500 || Math.abs(v - value) < 1e-9) return setText(N(value));
    onCommit(v);
  };
  return (
    <span className="belt-field">
      <input value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} aria-label="Tension in newtons" />
      <span className="dim">N</span>
    </span>
  );
}

/** Writes a new tension into the design: the parameter it comes from, the tension: text, or a new tension: argument. */
function commitTension(b: BeltDef, value: number, done: () => void) {
  const v = Math.round(value * 10) / 10;
  done();
  if (Math.abs(v - b.tension) < 1e-9) return;
  const { source, model } = useDesign.getState();
  const p = b.tensionParam ? model?.params.find((q) => q.name === b.tensionParam) : undefined;
  let next: string | null = null;
  if (p) next = setParamValue(source, p, v);
  else if (b.tensionSpan) next = source.slice(0, b.tensionSpan.start) + `${fmtNum(v, 1)}N` + source.slice(b.tensionSpan.end);
  else next = insertTension(source, b, v);
  if (next && next !== source) commitSource(next, "you", `Set ${b.name}'s tension to ${fmtNum(v, 1)} N${p ? ` (${p.name})` : ""}`);
}

// ---------------------------------------------------------------- diagram

const W = 720;
const PAD_X = 44;
const PAD_Y = 30;
const MAX_H = 240;

/** The belt in its plane (u right, v up), drawn to scale: pulleys, clamps, and each free span with its length and note. */
function BeltDiagram({ b, tension, onNode }: { b: BeltDef; tension: number; onNode: (name: string) => void }) {
  const g = useMemo(() => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const grow = (x: number, y: number, r = 0) => {
      x0 = Math.min(x0, x - r);
      x1 = Math.max(x1, x + r);
      y0 = Math.min(y0, y - r);
      y1 = Math.max(y1, y + r);
    };
    for (const nd of b.nodes) grow(nd.c[0], nd.c[1], nd.r);
    for (const s of b.spans) {
      grow(s.a[0], s.a[1]);
      grow(s.b[0], s.b[1]);
    }
    const dx = Math.max(1, x1 - x0);
    const dy = Math.max(1, y1 - y0);
    const scale = Math.min((W - 2 * PAD_X) / dx, (MAX_H - 2 * PAD_Y) / dy);
    const h = Math.max(96, dy * scale + 2 * PAD_Y);
    const ox = (W - dx * scale) / 2 - x0 * scale;
    const oy = (h + dy * scale) / 2 + y0 * scale;
    // centroid of the path, so span labels sit on the outside of the loop
    const cx = b.nodes.reduce((n, nd) => n + nd.c[0], 0) / b.nodes.length;
    const cy = b.nodes.reduce((n, nd) => n + nd.c[1], 0) / b.nodes.length;
    return { scale, h, X: (u: number) => ox + u * scale, Y: (v: number) => oy - v * scale, cx, cy };
  }, [b]);
  const { X, Y, scale } = g;

  const path = b.pieces
    .map((p) => {
      if (p.k === "line") return `M${X(p.a[0])},${Y(p.a[1])} L${X(p.b[0])},${Y(p.b[1])}`;
      const a1 = p.a0 + p.sweep;
      const s = [p.c[0] + p.r * Math.cos(p.a0), p.c[1] + p.r * Math.sin(p.a0)];
      const e = [p.c[0] + p.r * Math.cos(a1), p.c[1] + p.r * Math.sin(a1)];
      const large = Math.abs(p.sweep) > Math.PI ? 1 : 0;
      // v is flipped on screen, so counter-clockwise in (u, v) is clockwise on screen
      const sweep = p.sweep > 0 ? 0 : 1;
      const r = p.r * scale;
      return `M${X(s[0])},${Y(s[1])} A${r},${r} 0 ${large} ${sweep} ${X(e[0])},${Y(e[1])}`;
    })
    .join(" ");

  return (
    <svg className="belt-svg" viewBox={`0 0 ${W} ${g.h}`} role="img" aria-label={`${beltTitle(b)} path`}>
      <path d={path} className="belt-line" />
      {b.spans.map((s, i) => {
        const mx = (s.a[0] + s.b[0]) / 2;
        const my = (s.a[1] + s.b[1]) / 2;
        // label on the side of the span away from the middle of the loop
        let nx = -(s.b[1] - s.a[1]);
        let ny = s.b[0] - s.a[0];
        const len = Math.hypot(nx, ny) || 1;
        nx /= len;
        ny /= len;
        if (nx * (mx - g.cx) + ny * (my - g.cy) < 0) {
          nx = -nx;
          ny = -ny;
        }
        const lx = X(mx) + nx * 13;
        const ly = Y(my) - ny * 13;
        return (
          <text key={i} x={lx} y={ly + 4} className="belt-span" textAnchor={Math.abs(nx) > 0.8 ? (nx > 0 ? "start" : "end") : "middle"}>
            {N(s.length, 0)} mm · <tspan className="hz">{N(spanHz(tension, s.length, b.belt.mass), 0)} Hz</tspan>
          </text>
        );
      })}
      {b.nodes.map((nd) => {
        const x = X(nd.c[0]);
        const y = Y(nd.c[1]);
        if (nd.kind === "clamp") return <rect key={nd.name} x={x - 4} y={y - 4} width={8} height={8} rx={1.5} className="belt-clamp" />;
        const r = Math.max(4, nd.r * scale);
        const drive = nd.name === b.drive;
        const below = nd.c[1] <= g.cy;
        const label = `${nd.name}${drive && b.motor ? ` · ${b.motor.name}` : ""}`;
        // keep the label inside the drawing at either end
        const half = label.length * 3.2;
        const anchor = x - half < 4 ? "start" : x + half > W - 4 ? "end" : "middle";
        const lx = anchor === "start" ? Math.max(4, x - r) : anchor === "end" ? Math.min(W - 4, x + r) : x;
        return (
          <g key={nd.name} className={`belt-node ${drive ? "drive" : ""}`} onClick={() => onNode(nd.name)}>
            <circle cx={x} cy={y} r={r} />
            <circle cx={x} cy={y} r={Math.max(1.2, r * 0.18)} className="hub" />
            <text x={lx} y={below ? y + r + 13 : y - r - 6} textAnchor={anchor}>
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
