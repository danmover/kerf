// The measure tool in the 3D view: click a face, edge or corner to read its
// exact size from the kernel, then a second one for the distance and angle
// between them. A measurement can go onto the part's drawing as a dimension,
// or into the chat. It only reads the scene (camera, meshes tagged with
// their part id), so the viewport needs nothing more than a host handle.

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import * as THREE from "three";
import { create } from "zustand";
import { meshes, useDesign } from "../../core/engine";
import type { EvalPart } from "../../core/model";
import { commitSource, endComparison } from "../../app/project";
import { kernel } from "../../kernel/client";
import type { EntityInfo, PickMeasure, PickRef } from "../../kernel/drawing";
import type { MeshData } from "../../kernel/build";
import { xformMatrix, type V3 } from "../../kernel/recipe";
import { drawingFor, openDrawings, useDrawings } from "../../drawing/engine";
import { addBlockLine, ensureBlock } from "../../drawing/source";
import { fmtNum } from "../../lang/values";
import { useChatDraft } from "../chatDraft";
import { useView } from "../../app/view";
import { useUi } from "../../app/ui";
import { useSketch } from "../sketch/session";
import { useMarkup } from "../Markup";
import { Icon } from "../icons";
import "../drawing/drawing.css";

export const useMeasure = create<{ on: boolean }>(() => ({ on: false }));
export const measuring = () => useMeasure.getState().on;
export const toggleMeasure = (on = !measuring()) => useMeasure.setState({ on });

export interface MeasureHost {
  canvas: HTMLCanvasElement;
  camera: THREE.Camera;
  scene: THREE.Object3D;
  /** the part the viewport itself would pick here (it knows what is ghosted or hidden) */
  hit?: (clientX: number, clientY: number) => { id: string } | null;
  /** the camera controls, which say when the view moves */
  controls?: { addEventListener(type: "change", fn: () => void): void; removeEventListener(type: "change", fn: () => void): void };
}

interface Snap {
  partId: string;
  kind: "face" | "edge" | "vertex";
  id?: number;
  /** picked point in the solid's own coordinates */
  local: THREE.Vector3;
  data: MeshData;
  /** the face's index range or the edge's point range in the mesh data */
  range?: [number, number];
}

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
};

export function MeasureButton() {
  const on = useMeasure((s) => s.on);
  return (
    <button className={`icon-btn ${on ? "active" : ""}`} onClick={() => toggleMeasure()} data-tip="Measure (R)" aria-label="Measure">
      <RulerIcon />
    </button>
  );
}

function RulerIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 15.5 15.5 3.5l5 5-12 12z" />
      <path d="m7.5 11.5 2 2M10.5 8.5l2 2M13.5 5.5l2 2" />
    </svg>
  );
}

export function MeasureTool({ host }: { host: () => MeasureHost | null }) {
  const on = useMeasure((s) => s.on);
  // the sketch editor takes over the view's clicks
  const sketching = useSketch((s) => !!s.active || s.picking);
  useEffect(() => {
    if (sketching) toggleMeasure(false);
  }, [sketching]);
  const model = useDesign((s) => s.model);
  const [hover, setHover] = useState<Snap | null>(null);
  const [picks, setPicks] = useState<Snap[]>([]);
  const [res, setRes] = useState<{ r?: PickMeasure; error?: string; busy: boolean } | null>(null);
  const [, setFrame] = useState(0);
  const job = useRef(0);
  const picksRef = useRef<Snap[]>([]);

  const setPicksNow = useCallback((next: Snap[]) => {
    picksRef.current = next;
    setPicks(next);
  }, []);

  const clear = useCallback(() => {
    job.current++;
    setPicksNow([]);
    setRes(null);
  }, [setPicksNow]);

  // the R key toggles the tool, Esc clears the picks and then leaves it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || useDrawings.getState().open) return;
      // dialogs, the sketch editor and markup keep their own keys
      const ui = useUi.getState();
      const sk = useSketch.getState();
      if (ui.settingsOpen || ui.shortcutsOpen || ui.confirm || sk.active || sk.picking || useMarkup.getState().on) return;
      if (e.key === "r" || e.key === "R") toggleMeasure();
      else if (e.key === "Escape" && measuring()) {
        if (picksRef.current.length) clear();
        else toggleMeasure(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clear]);

  useEffect(() => {
    if (!on) {
      clear();
      setHover(null);
    }
  }, [on, clear]);
  // a rebuild may move or remove what was picked
  useEffect(() => clear(), [model, clear]);

  const run = useCallback((list: Snap[]) => {
    const m = useDesign.getState().model;
    const refs = list.map((s) => pickRef(s, m?.parts.find((p) => p.id === s.partId)));
    if (refs.some((r) => !r)) return;
    const n = ++job.current;
    setRes({ busy: true });
    kernel.measurePick(refs[0]!, refs[1] ?? undefined).then(
      (r) => n === job.current && setRes({ r, busy: false }),
      (e: unknown) => n === job.current && setRes({ error: e instanceof Error ? e.message : String(e), busy: false }),
    );
  }, []);

  // pointer handling on the canvas: hover snaps, clicks pick
  useEffect(() => {
    const h = host();
    if (!on || !h) return;
    const el = h.canvas;
    let down: { x: number; y: number } | null = null;
    let pending: PointerEvent | null = null;
    let raf = 0;
    const prevCursor = el.style.cursor;
    el.style.cursor = "crosshair";
    const move = (e: PointerEvent) => {
      if (e.buttons) return setHover(null);
      pending = e;
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (pending) setHover(snapAt(h, pending.clientX, pending.clientY));
        });
    };
    const pd = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    const pu = (e: PointerEvent) => {
      if (!down || e.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) >= 5) return;
      const s = snapAt(h, e.clientX, e.clientY);
      if (!s) return;
      const prev = picksRef.current;
      const next = prev.length >= 2 ? [s] : [...prev, s];
      setPicksNow(next);
      run(next);
    };
    const leave = () => setHover(null);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerdown", pd);
    el.addEventListener("pointerup", pu);
    el.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(raf);
      el.style.cursor = prevCursor;
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerdown", pd);
      el.removeEventListener("pointerup", pu);
      el.removeEventListener("pointerleave", leave);
    };
  }, [on, host, run, setPicksNow]);

  // follow the camera, the viewport's size and parts easing apart while something is shown
  useEffect(() => {
    const h = host();
    if (!on || !h || !picks.length) return;
    const bump = () => setFrame((f) => f + 1);
    h.controls?.addEventListener("change", bump);
    const ro = new ResizeObserver(bump);
    ro.observe(h.canvas);
    let raf = 0;
    let until = 0;
    const tick = () => {
      bump();
      raf = performance.now() < until ? requestAnimationFrame(tick) : 0;
    };
    const unsub = useView.subscribe((s, p) => {
      if (s.explode === p.explode && s.playing === p.playing) return;
      until = performance.now() + (s.playing ? 60_000 : 1500);
      if (!raf) raf = requestAnimationFrame(tick);
    });
    return () => {
      h.controls?.removeEventListener("change", bump);
      ro.disconnect();
      unsub();
      cancelAnimationFrame(raf);
    };
  }, [on, host, picks]);

  const h = on ? host() : null;
  const overlay = h ? drawOverlay(h, hover, picks, res?.r) : null;
  const parts = model?.parts ?? [];
  const nameOf = (s: Snap) => parts.find((p) => p.id === s.partId)?.label ?? s.partId;

  return (
    <>
      {overlay && (
        <svg className="measure-svg">
          {overlay.hover}
          {overlay.picks}
          {overlay.line}
        </svg>
      )}
      <AnimatePresence>
        {on && (
          <motion.div key="measure" className="vp-float measure-card" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <span style={{ color: "var(--accent-2)", display: "inline-flex" }}>
                <RulerIcon />
              </span>
              <div className="grow" style={{ fontWeight: 600 }}>
                Measure
              </div>
              <button className="icon-btn sm" onClick={() => toggleMeasure(false)} aria-label="Close the measure tool">
                <Icon.X size={14} />
              </button>
            </div>
            <MeasureBody picks={picks} res={res} nameOf={nameOf} onClear={clear} />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function MeasureBody({ picks, res, nameOf, onClear }: { picks: Snap[]; res: { r?: PickMeasure; error?: string; busy: boolean } | null; nameOf: (s: Snap) => string; onClear: () => void }) {
  const setDraft = useChatDraft((s) => s.set);
  if (!picks.length) return <div className="sub">Click a face, edge or corner. Click a second one to measure between them. Esc clears.</div>;
  if (res?.error) return <div style={{ color: "var(--fail)", fontSize: 12 }}>{res.error}</div>;
  const r = res?.r;
  if (!r || res?.busy)
    return (
      <div className="sub">
        <span className="shimmer-text">measuring {picks.map((p) => `${p.kind} of ${nameOf(p)}`).join(" to ")}</span>
      </div>
    );
  const a = `${describe(r.a)} of ${nameOf(picks[0])}`;
  if (!r.b || picks.length < 2) {
    const v = primary(r.a);
    return (
      <>
        <div className="val">{v}</div>
        <div className="sub">
          {a}
          {details(r.a).map((d) => (
            <div key={d}>{d}</div>
          ))}
          <div style={{ marginTop: 4 }}>Click another face, edge or corner to measure between them.</div>
        </div>
        <div className="row" style={{ marginTop: 8, gap: 6 }}>
          <button className="btn sm" onClick={() => setDraft(`About the ${a} (${v}): `)}>
            <Icon.Sparkle size={13} /> Ask
          </button>
        </div>
      </>
    );
  }
  const b = `${describe(r.b)} of ${nameOf(picks[1])}`;
  const delta = r.p1 && r.p2 ? r.p2.map((v, i) => Math.abs(v - r.p1![i])) : null;
  const dim = dimPoints(r);
  const target = dim ? drawingTarget(picks) : null;
  const summary = `${fmtNum(r.distance ?? 0, 3)} mm between the ${a} and the ${b}`;
  return (
    <>
      <div className="val">{fmtNum(r.distance ?? 0, 3)} mm</div>
      <div className="sub">
        <div>
          from the {a}
          <br />
          to the {b}
        </div>
        {delta && (
          <div>
            Δx {fmtNum(delta[0], 3)} · Δy {fmtNum(delta[1], 3)} · Δz {fmtNum(delta[2], 3)}
          </div>
        )}
        {r.centerDistance !== undefined && (
          <div>
            {r.a.axis && r.b.axis ? "axes" : "centres"} {fmtNum(r.centerDistance, 3)} mm apart
          </div>
        )}
        {r.angle !== undefined && <div>angle {r.angle < 1e-3 ? "0° (parallel)" : `${fmtNum(r.angle, 2)}°`}</div>}
      </div>
      <div className="row" style={{ marginTop: 8, gap: 6, flexWrap: "wrap" }}>
        {dim && target && (
          <button className="btn sm" onClick={() => addToDrawing(target, dim)} data-tip={`Adds this as a dimension on the ${target.title} drawing`}>
            <Icon.Doc size={13} /> Add to drawing
          </button>
        )}
        <button className="btn sm" onClick={() => setDraft(`I measured ${summary}. `)}>
          <Icon.Sparkle size={13} /> Ask
        </button>
        <button className="btn sm ghost" onClick={onClear}>
          Clear
        </button>
      </div>
    </>
  );
}

// ---------- what was measured, in words ----------

const AXES: [V3, string][] = [
  [[1, 0, 0], "X"],
  [[0, 1, 0], "Y"],
  [[0, 0, 1], "Z"],
];
function axisName(v: V3 | undefined): string {
  if (!v) return "";
  for (const [a, n] of AXES) {
    const d = v[0] * a[0] + v[1] * a[1] + v[2] * a[2];
    if (Math.abs(Math.abs(d) - 1) < 1e-6) return `${d > 0 ? "+" : "−"}${n}`;
  }
  return `(${v.map((x) => fmtNum(x, 3)).join(", ")})`;
}

function describe(e: EntityInfo): string {
  if (e.kind === "vertex") return "corner";
  if (e.kind === "face") return e.type === "surface" ? "face" : `${e.type} face`;
  return e.type === "curve" ? "edge" : `${e.type} edge`;
}

function primary(e: EntityInfo): string {
  if (e.kind === "vertex") return `(${e.point.map((v) => fmtNum(v, 2)).join(", ")})`;
  if (e.radius !== undefined && (e.type === "cylinder" || e.type === "circle" || e.type === "sphere")) return `Ø${fmtNum(e.radius * 2, 3)}`;
  if (e.kind === "edge" && e.length !== undefined) return `${fmtNum(e.length, 3)} mm`;
  if (e.area !== undefined) return `${fmtNum(e.area, 1)} mm²`;
  return describe(e);
}

function details(e: EntityInfo): string[] {
  const out: string[] = [];
  if (e.radius !== undefined) out.push(`radius ${fmtNum(e.radius, 3)}`);
  if (e.axis) out.push(`axis ${axisName(e.axis)}${e.center ? ` through (${e.center.map((v) => fmtNum(v, 2)).join(", ")})` : ""}`);
  if (e.normal) out.push(`normal ${axisName(e.normal)}`);
  if (e.dir) out.push(`along ${axisName(e.dir)}`);
  if (e.kind === "edge" && e.length !== undefined && e.radius !== undefined) out.push(`length ${fmtNum(e.length, 3)}`);
  if (e.kind === "face" && e.area !== undefined && e.radius !== undefined) out.push(`area ${fmtNum(e.area, 1)} mm²`);
  return out;
}

// ---------- onto a drawing ----------

/** Model points for a dimension: centre to centre for holes and shafts, else the closest points. */
function dimPoints(r: PickMeasure): [V3, V3] | null {
  if (!r.b) return null;
  if (r.c1 && r.c2 && (r.centerDistance ?? 0) > 1e-6) return [r.c1, r.c2];
  if (!r.p1 || !r.p2 || (r.distance ?? 0) < 1e-6) return null;
  return [r.p1, r.p2];
}

function drawingTarget(picks: Snap[]) {
  const model = useDesign.getState().model;
  if (!model) return null;
  const names = [...new Set(picks.map((p) => model.parts.find((q) => q.id === p.partId)?.name).filter((n): n is string => !!n))];
  return drawingFor(model, names) ?? null;
}

function addToDrawing(spec: NonNullable<ReturnType<typeof drawingTarget>>, [a, b]: [V3, V3]) {
  // a hover comparison is for looking; the edit builds on the real design
  endComparison();
  const { source, model } = useDesign.getState();
  if (!model) return;
  const v = (p: V3) => `(${p.map((x) => fmtNum(x, 4).replace(/,/g, "")).join(", ")})`;
  const { src, name, created } = ensureBlock(source, model, spec);
  commitSource(addBlockLine(src, name, `dim(${v(a)}, ${v(b)})`), "you", `Added a measured dimension to the ${spec.title} drawing${created ? " (wrote the drawing out)" : ""}`);
  toggleMeasure(false);
  openDrawings(name);
}

// ---------- picking ----------

function shown(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

function partMeshes(scene: THREE.Object3D): Map<string, THREE.Mesh> {
  const out = new Map<string, THREE.Mesh>();
  scene.traverse((o) => {
    const id = o.userData.partId as string | undefined;
    if (id && (o as THREE.Mesh).isMesh) out.set(id, o as THREE.Mesh);
  });
  return out;
}

const raycaster = new THREE.Raycaster();

function toNdc(h: MeasureHost, x: number, y: number) {
  const r = h.canvas.getBoundingClientRect();
  return { rect: r, ndc: new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1) };
}

function meshData(part: EvalPart, mesh: THREE.Mesh): MeshData | undefined {
  const e = meshes.get(part.hash);
  if (!e) return undefined;
  const n = mesh.geometry.index?.count;
  if (e.final && e.final.indices.length === n) return e.final;
  if (e.preview && e.preview.indices.length === n) return e.preview;
  return e.final ?? e.preview;
}

/** What is under the cursor: a corner or an edge within a few pixels, else the face. */
function snapAt(h: MeasureHost, x: number, y: number): Snap | null {
  const { rect, ndc } = toNdc(h, x, y);
  raycaster.setFromCamera(ndc, h.camera);
  const byId = partMeshes(h.scene);
  const target = h.hit ? h.hit(x, y) : undefined;
  if (target === null) return null;
  const list = target ? [byId.get(target.id)].filter((m): m is THREE.Mesh => !!m) : [...byId.values()].filter(shown);
  const hit = raycaster.intersectObjects(list, false).find((i) => {
    const m = (i.object as THREE.Mesh).material as THREE.Material;
    if (m.transparent && m.opacity <= 0.5) return false;
    return !m.clippingPlanes?.some((p) => p.distanceToPoint(i.point) < 0);
  });
  if (!hit) return null;
  const mesh = hit.object as THREE.Mesh;
  const partId = mesh.userData.partId as string;
  const part = useDesign.getState().model?.parts.find((p) => p.id === partId);
  const data = part && meshData(part, mesh);
  if (!part || !data) return null;
  const local = mesh.worldToLocal(hit.point.clone());

  // edges and corners near the cursor, in front of (or on) the surface hit
  const toScreen = (v: THREE.Vector3) => {
    const p = v.clone().applyMatrix4(mesh.matrixWorld).project(h.camera);
    return [(p.x * 0.5 + 0.5) * rect.width + rect.left, (-p.y * 0.5 + 0.5) * rect.height + rect.top, p.z] as const;
  };
  const camPos = new THREE.Vector3().setFromMatrixPosition(h.camera.matrixWorld);
  const size = mesh.geometry.boundingSphere?.radius ?? 10;
  const visible = (lp: THREE.Vector3) => lp.clone().applyMatrix4(mesh.matrixWorld).distanceTo(camPos) <= hit.distance + Math.max(0.05, size * 0.01);
  let best: { d: number; kind: "edge" | "vertex"; id: number; local: THREE.Vector3; range: [number, number] } | null = null;
  const eg = data.edgeGroups;
  const pts = data.edges;
  if (eg && pts.length) {
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let g = 0; g < eg.length; g += 3) {
      const start = eg[g];
      const count = eg[g + 1];
      const id = eg[g + 2];
      for (let k = start; k + 1 < start + count; k += 2) {
        a.fromArray(pts, k * 3);
        b.fromArray(pts, (k + 1) * 3);
        const sa = toScreen(a);
        const sb = toScreen(b);
        // corners: the ends of the edge
        for (const [s, p, end] of [
          [sa, a, k === start],
          [sb, b, k + 2 >= start + count],
        ] as const) {
          if (!end) continue;
          const d = Math.hypot(s[0] - x, s[1] - y);
          if (d < 9 && (!best || best.kind !== "vertex" || d < best.d) && visible(p)) best = { d, kind: "vertex", id, local: p.clone(), range: [start, count] };
        }
        if (best?.kind === "vertex") continue;
        const dx = sb[0] - sa[0];
        const dy = sb[1] - sa[1];
        const L2 = dx * dx + dy * dy;
        const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - sa[0]) * dx + (y - sa[1]) * dy) / L2)) : 0;
        const d = Math.hypot(sa[0] + dx * t - x, sa[1] + dy * t - y);
        if (d < 6 && (!best || d < best.d)) {
          const p = a.clone().lerp(b, t);
          if (visible(p)) best = { d, kind: "edge", id, local: p, range: [start, count] };
        }
      }
    }
  }
  if (best) return { partId, kind: best.kind, id: best.kind === "edge" ? best.id : undefined, local: best.local, data, range: best.range };

  // the face: its group in the mesh by triangle
  let range: [number, number] | undefined;
  let id: number | undefined;
  const fg = data.faceGroups;
  const at = (hit.faceIndex ?? -1) * 3;
  if (fg && at >= 0)
    for (let g = 0; g < fg.length; g += 3)
      if (at >= fg[g] && at < fg[g] + fg[g + 1]) {
        range = [fg[g], fg[g + 1]];
        id = fg[g + 2];
        break;
      }
  return { partId, kind: "face", id, local, data, range };
}

function placement(part: EvalPart) {
  return new THREE.Matrix4().fromArray(xformMatrix(part.xf));
}

function pickRef(s: Snap, part: EvalPart | undefined): PickRef | null {
  if (!part) return null;
  const p = s.local.clone().applyMatrix4(placement(part));
  return { hash: part.hash, xf: part.xf, kind: s.kind, id: s.id, point: [p.x, p.y, p.z] };
}

// ---------- overlay ----------

function drawOverlay(h: MeasureHost, hover: Snap | null, picks: Snap[], r: PickMeasure | undefined) {
  const rect = h.canvas.getBoundingClientRect();
  // the overlay covers the viewport the canvas sits in
  const parent = h.canvas.closest(".viewport")?.getBoundingClientRect() ?? rect;
  const ox = rect.left - parent.left;
  const oy = rect.top - parent.top;
  const byId = partMeshes(h.scene);
  const model = useDesign.getState().model;
  const screen = (mesh: THREE.Mesh, v: THREE.Vector3): [number, number, boolean] => {
    const p = v.clone().applyMatrix4(mesh.matrixWorld).project(h.camera);
    return [ox + (p.x * 0.5 + 0.5) * rect.width, oy + (-p.y * 0.5 + 0.5) * rect.height, p.z < 1];
  };
  const shape = (s: Snap, cls: string, key: string) => {
    const mesh = byId.get(s.partId);
    if (!mesh) return null;
    const [x, y] = screen(mesh, s.local);
    let path = "";
    if (s.range && s.kind === "face" && s.range[1] <= 30000) {
      const idx = s.data.indices;
      const pos = s.data.positions;
      const v = new THREE.Vector3();
      for (let i = s.range[0]; i < s.range[0] + s.range[1]; i += 3) {
        const tri = [idx[i], idx[i + 1], idx[i + 2]].map((k) => screen(mesh, v.fromArray(pos, k * 3)));
        path += `M${tri.map((t) => `${t[0].toFixed(1)},${t[1].toFixed(1)}`).join("L")}Z`;
      }
    } else if (s.range && s.kind === "edge") {
      const v = new THREE.Vector3();
      for (let k = s.range[0]; k + 1 < s.range[0] + s.range[1]; k += 2) {
        const a = screen(mesh, v.fromArray(s.data.edges, k * 3));
        const b = screen(mesh, v.fromArray(s.data.edges, (k + 1) * 3));
        path += `M${a[0].toFixed(1)},${a[1].toFixed(1)}L${b[0].toFixed(1)},${b[1].toFixed(1)}`;
      }
    }
    return (
      <g key={key} className={`measure-${cls} ${s.kind}`}>
        {path && <path d={path} />}
        {s.kind === "vertex" ? <rect x={x - 4} y={y - 4} width={8} height={8} /> : <circle cx={x} cy={y} r={3.5} />}
      </g>
    );
  };
  let line: ReactElement | null = null;
  if (r?.b && r.p1 && r.p2 && picks.length === 2 && model) {
    // the closest points, shown where their parts are drawn (exploded or not)
    const ends = [r.p1, r.p2].map((p, i) => {
      const s = picks[i];
      const part = model.parts.find((q) => q.id === s.partId);
      const mesh = byId.get(s.partId);
      if (!part || !mesh) return null;
      return screen(mesh, new THREE.Vector3(...p).applyMatrix4(placement(part).invert()));
    });
    if (ends[0] && ends[1]) {
      const [a, b] = ends as [number, number, boolean][];
      const mx = (a[0] + b[0]) / 2;
      const my = (a[1] + b[1]) / 2;
      const label = `${fmtNum(r.distance ?? 0, 2)}`;
      line = (
        <g className="measure-line">
          <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />
          <circle cx={a[0]} cy={a[1]} r={2.5} />
          <circle cx={b[0]} cy={b[1]} r={2.5} />
          <rect x={mx - label.length * 3.6 - 6} y={my - 10} width={label.length * 7.2 + 12} height={20} rx={5} />
          <text x={mx} y={my + 4}>
            {label}
          </text>
        </g>
      );
    }
  }
  return {
    hover: hover && !picks.some((p) => sameSnap(p, hover)) ? shape(hover, "hover", "hover") : null,
    picks: picks.map((p, i) => shape(p, "pick", `p${i}`)),
    line,
  };
}

function sameSnap(a: Snap, b: Snap) {
  return a.partId === b.partId && a.kind === b.kind && a.id === b.id && (a.kind !== "vertex" || a.local.distanceTo(b.local) < 1e-6);
}
