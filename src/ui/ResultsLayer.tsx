// Analysis results in the viewport: owns the results overlay while an
// analysis is shown, and draws its legend and the value under the cursor.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SceneController } from "./viewport/scene";
import { ResultsOverlay, fieldMode, fieldRange } from "./viewport/resultsOverlay";
import { useAnalysis, showResults, type ResultField } from "../analysis/runtime";
import type { StructuralResult } from "../analysis/fe/structural";
import type { StructuralSpec } from "../analysis/spec";
import { gradientCss, safetyAt } from "../analysis/colormap";
import { modeWords } from "../analysis/dynamics";
import { followers } from "../analysis/carried";
import { meshes, useDesign } from "../core/engine";
import { useSettings } from "../app/settings";
import { useTheme } from "../app/theme";
import { fmtNum } from "../lang/values";
import { Icon } from "./icons";
import "../styles/analysis.css";

export const FIELD_INFO: Record<ResultField, { label: string; short: string; unit: string }> = {
  stress: { label: "Von Mises stress", short: "Stress", unit: "MPa" },
  safety: { label: "Factor of safety", short: "Safety", unit: "" },
  disp: { label: "Deflection", short: "Deflection", unit: "mm" },
  strain: { label: "Principal strain", short: "Strain", unit: "%" },
};

export const FIELDS: ResultField[] = ["stress", "safety", "disp", "strain"];

const sizes = new WeakMap<StructuralResult, number>();

/** Diagonal of the analysed parts (worked out once per result: it walks every vertex). */
export function resultSize(r: StructuralResult): number {
  let d = sizes.get(r);
  if (d === undefined) sizes.set(r, (d = diagonal(r)));
  return d;
}

function diagonal(r: StructuralResult): number {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of r.parts)
    for (let i = 0; i < p.positions.length; i++) {
      const k = i % 3;
      if (p.positions[i] < lo[k]) lo[k] = p.positions[i];
      if (p.positions[i] > hi[k]) hi[k] = p.positions[i];
    }
  return Math.max(Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]), 1);
}

/** Exaggeration that makes the largest deflection about 6% of the part's size (never less than true scale). */
export function autoDeform(r: StructuralResult): number {
  const d = r.maxDisp.value;
  if (!(d > 0)) return 0;
  return Math.max(1, (0.06 * resultSize(r)) / d);
}

/** The mode shape to draw: the one picked, or the first when the analysis only finds frequencies (nothing else moves). */
export function shownMode(r: StructuralResult, picked: number | null): number | null {
  const n = r.modal?.modes.length ?? 0;
  if (!n) return null;
  if (picked !== null) return picked < n ? picked : null;
  return r.maxDisp.value > 0 ? null : 0;
}

function ModeLegend({ result, mode, label }: { result: StructuralResult; mode: number; label: string }) {
  const m = result.modal!.modes[mode];
  return (
    <>
      <div className="row" style={{ gap: 8, marginBottom: 6 }}>
        <span className="res-legend-title">Mode {mode + 1}</span>
        <span className="dim mono">{fmtNum(m.freq, m.freq < 100 ? 1 : 0)} Hz</span>
        <div className="grow" />
        <button className="icon-btn sm" onClick={() => showResults(null)} aria-label="Hide results" data-tip="Hide results">
          <Icon.X size={13} />
        </button>
      </div>
      <div className="res-bar" style={{ background: gradientCss("sequential", 12) }} />
      <div className="res-ticks">
        <span style={{ left: "0%" }}>still</span>
        <span style={{ left: "100%" }}>moves most</span>
      </div>
      <div className="res-meta mono">
        {label} · {modeWords(m)} · shape exaggerated
      </div>
    </>
  );
}

export function deformScale(r: StructuralResult, deform: number, trueScale: boolean): number {
  if (deform <= 0) return 0;
  return trueScale ? 1 : deform * autoDeform(r);
}

export function ResultsLayer({ scene }: { scene: SceneController }) {
  const shown = useAnalysis((s) => s.shown);
  const run = useAnalysis((s) => (s.shown ? s.runs.get(s.shown) : undefined));
  const field = useAnalysis((s) => s.field);
  const deform = useAnalysis((s) => s.deform);
  const trueScale = useAnalysis((s) => s.trueScale);
  const animate = useAnalysis((s) => s.animate);
  const pickedMode = useAnalysis((s) => s.mode);
  const model = useDesign((s) => s.model);
  const reduceMotion = useSettings((s) => s.reduceMotion);
  const theme = useTheme();
  const spec = model?.analyses.find((a): a is StructuralSpec => a.label === shown && a.kind === "structural");
  const target = spec?.safety ?? 2;
  const result = run?.result;
  const mode = result ? shownMode(result, pickedMode) : null;
  const ov = useRef<ResultsOverlay | null>(null);
  const [probe, setProbe] = useState<{ x: number; y: number; text: string; part: string } | null>(null);

  // rebuilt on a theme change, as its markers and labels are drawn in the theme's colours; the parts the analysed ones
  // carry (a number clicked into a bracket) move with them
  useEffect(() => {
    if (!result) return;
    const design = useDesign.getState().model;
    const carried = design ? followers(design, result, (p) => meshes.get(p.hash)?.bbox) : [];
    const o = new ResultsOverlay(result, theme, carried.length ? { followers: carried, pose: (m) => scene.setPose(m) } : undefined);
    ov.current = o;
    scene.addOverlay(o);
    return () => {
      scene.removeOverlay(o);
      o.dispose();
      if (ov.current === o) ov.current = null;
    };
  }, [result, scene, theme]);

  const scale = result ? deformScale(result, deform, trueScale) : 0;
  useEffect(() => {
    ov.current?.configure({ field, scale, animate: animate && !reduceMotion, safetyTarget: target, mode });
    scene.invalidate();
  }, [field, scale, animate, reduceMotion, target, result, scene, theme, mode]);

  // the value under the cursor
  useEffect(() => {
    if (!result) return;
    const el = scene.renderer.domElement;
    let pending: PointerEvent | null = null;
    const onMove = (e: PointerEvent) => {
      if (e.buttons) return setProbe(null);
      if (!pending)
        requestAnimationFrame(() => {
          const ev = pending;
          pending = null;
          if (!ev || !ov.current) return;
          const hit = ov.current.probe(scene.raycasterAt(ev.clientX, ev.clientY), scene.activeSection());
          const rect = el.getBoundingClientRect();
          setProbe(hit ? { x: ev.clientX - rect.left, y: ev.clientY - rect.top, text: formatValue(hit.field, hit.value), part: hit.part } : null);
        });
      pending = e;
    };
    const onLeave = () => setProbe(null);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      setProbe(null);
    };
  }, [result, scene]);

  return (
    <>
      <AnimatePresence>
        {result && shown && (
          <motion.div key="legend" className="vp-float res-legend" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}>
            {mode !== null ? (
              <ModeLegend result={result} mode={mode} label={shown} />
            ) : (
              <Legend result={result} field={field} target={target} scale={scale} trueScale={trueScale} label={shown} stale={run?.status === "running" || run?.status === "waiting"} />
            )}
          </motion.div>
        )}
      </AnimatePresence>
      {probe && result && (
        <div className="res-probe" style={{ left: probe.x + 14, top: probe.y + 12 }}>
          <b>{probe.text}</b> <span>{probe.part}</span>
        </div>
      )}
    </>
  );
}

export function formatValue(field: ResultField, v: number): string {
  if (field === "safety") return v >= 100 ? "safety > 100" : `safety ${fmtNum(v, 2)}`;
  if (field === "strain") return `${fmtNum(v * 100, 3)} %`;
  if (field === "disp") return `${fmtNum(v, v < 0.1 ? 4 : 3)} mm`;
  return `${fmtNum(v, v < 10 ? 2 : 1)} MPa`;
}

function Legend({ result, field, target, scale, trueScale, label, stale }: { result: StructuralResult; field: ResultField; target: number; scale: number; trueScale: boolean; label: string; stale: boolean }) {
  const mode = fieldMode(field);
  const ticks = useMemo(() => {
    if (field === "safety") return [0, 0.25, 0.5, 1].map((t) => ({ t, text: t === 1 ? `≥${fmtNum(safetyAt(1, target), 1)}` : fmtNum(safetyAt(t, target), 2) }));
    const [lo, hi] = fieldRange(result, field);
    const mul = field === "strain" ? 100 : 1;
    return [0, 0.5, 1].map((t) => ({ t, text: fmtNum((lo + (hi - lo) * t) * mul, Math.abs(hi * mul) < 1 ? 4 : 2) }));
  }, [result, field, target]);
  const info = FIELD_INFO[field];
  return (
    <>
      <div className="row" style={{ gap: 8, marginBottom: 6 }}>
        <span className="res-legend-title">{info.label}</span>
        {info.unit && <span className="dim mono">{info.unit}</span>}
        <div className="grow" />
        {stale && <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} aria-label="Updating" />}
        <button className="icon-btn sm" onClick={() => showResults(null)} aria-label="Hide results" data-tip="Hide results">
          <Icon.X size={13} />
        </button>
      </div>
      <div className="res-bar" style={{ background: gradientCss(mode, 12) }} />
      <div className="res-ticks">
        {ticks.map((k) => (
          <span key={k.t} style={{ left: `${k.t * 100}%` }}>
            {k.text}
          </span>
        ))}
      </div>
      {field === "safety" && (
        <div className="res-safety-key">
          <span className="fail">below 1: fails</span>
          <span className="warn">below target {fmtNum(target, 1)}</span>
          <span className="pass">meets target</span>
        </div>
      )}
      <div className="res-meta mono">
        {label} · {scale <= 0 ? "undeformed" : trueScale ? "true-scale shape" : `shape ×${fmtNum(scale, scale < 10 ? 1 : 0)}`}
      </div>
    </>
  );
}
