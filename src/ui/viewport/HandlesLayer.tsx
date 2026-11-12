// Drag handles in the 3D view. With one part selected, arrows sit on the
// sizes of its body (a box's sides and top, a cylinder's side and end, an
// extrusion's far face) with their values on the model: drag an arrow to
// pull the face, or click the value to type a new one. Three axis arrows in
// the part's middle slide it along X, Y or Z. The view follows while
// dragging (snapped to a step that suits the zoom; Shift for finer) and
// letting go records one undoable edit. A size given by a parameter moves
// the parameter. H turns the handles off and on.

import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import * as THREE from "three";
import { create } from "zustand";
import { evaluateOnly, useDesign } from "../../core/engine";
import type { Model } from "../../core/model";
import { draggedValue, sizeHandles, type SizeHandle } from "../../core/handles";
import { applyQuick, type Vec3 } from "../../core/quickCommands";
import type { V3 } from "../../kernel/recipe";
import { commitSource, endPreview, previewSource, realSource } from "../../app/project";
import { revealSpan, useView } from "../../app/view";
import { toast, useUi } from "../../app/ui";
import { usePicks } from "../../app/picks";
import { fmtNum } from "../../lang/values";
import { niceStep } from "../sketch/geom";
import { useSketch } from "../sketch/session";
import { useMarkup } from "../Markup";
import { partMeshes, useMeasure } from "./MeasureTool";
import { isTyping, type PickHost } from "./PickLayer";

export const useHandles = create<{ on: boolean }>(() => ({ on: true }));
export const toggleHandles = (on = !useHandles.getState().on) => useHandles.setState({ on });

const AXES: { key: "x" | "y" | "z"; v: V3 }[] = [
  { key: "x", v: [1, 0, 0] },
  { key: "y", v: [0, 1, 0] },
  { key: "z", v: [0, 0, 1] },
];
const PREVIEW = "handle";
const mm = (v: number) => `${fmtNum(v, 2)} mm`;

interface SizeDrag {
  kind: "size";
  key: string;
  base: string;
  handle: SizeHandle;
  write: (src: string, v: number) => string;
  A: THREE.Vector3;
  D: THREE.Vector3;
  s0: number;
  step: number;
  x0: number;
  y0: number;
  moved: boolean;
  last: number;
}
interface MoveDrag {
  kind: "move";
  key: string;
  base: string;
  model: Model;
  block: string;
  axis: V3;
  A: THREE.Vector3;
  D: THREE.Vector3;
  s0: number;
  step: number;
  x0: number;
  y0: number;
  moved: boolean;
  last: number;
  next: { src: string; title: string } | null;
}
type Drag = SizeDrag | MoveDrag;

/** The camera, the screen and a pixel's size there. */
function view(h: PickHost) {
  const rect = h.canvas.getBoundingClientRect();
  const vp = h.canvas.closest(".viewport")?.getBoundingClientRect() ?? rect;
  const cam = h.camera as THREE.PerspectiveCamera;
  const camPos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  const per = cam.isPerspectiveCamera && rect.height > 0 ? (2 * Math.tan(((cam.fov / cam.zoom) * Math.PI) / 360)) / rect.height : 0.002;
  /** where a world point lands, in the viewport's own pixels */
  const screen = (w: THREE.Vector3): [number, number, boolean] => {
    const p = w.clone().project(cam);
    return [rect.left - vp.left + (p.x * 0.5 + 0.5) * rect.width, rect.top - vp.top + (-p.y * 0.5 + 0.5) * rect.height, p.z > -1 && p.z < 1];
  };
  /** mm per pixel at a world point */
  const mmPerPx = (w: THREE.Vector3) => Math.max(1e-6, w.distanceTo(camPos) * per);
  return { rect, vp, cam, camPos, screen, mmPerPx };
}

/** How far along the line O + sD the pointer is: the point of the line nearest the ray under it. */
function axisParam(h: PickHost, x: number, y: number, O: THREE.Vector3, D: THREE.Vector3): number | null {
  const r = h.canvas.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), h.camera);
  const rd = ray.ray.direction;
  const w0 = O.clone().sub(ray.ray.origin);
  const b = D.dot(rd);
  const den = 1 - b * b;
  if (den < 1e-4) return null;
  return (b * rd.dot(w0) - D.dot(w0)) / den;
}

/** A size handle's arrow in the world: on whichever side faces the viewer when it grows both ways. */
function worldArrow(mesh: THREE.Mesh, hd: SizeHandle, camPos: THREE.Vector3) {
  const A = new THREE.Vector3(...hd.at).applyMatrix4(mesh.matrixWorld);
  const D = new THREE.Vector3(...hd.dir).transformDirection(mesh.matrixWorld);
  if (hd.back && D.dot(camPos.clone().sub(A)) < 0) {
    const B = new THREE.Vector3(...hd.back).applyMatrix4(mesh.matrixWorld);
    if (D.dot(camPos.clone().sub(B)) < 0) return { A: B, D: D.negate() };
  }
  return { A, D };
}

/** The middle of a part's mesh, in the world. */
function middleOf(mesh: THREE.Mesh) {
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  return mesh.geometry.boundingBox!.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
}

export function HandlesLayer({ host }: { host: () => PickHost | null }) {
  const on = useHandles((s) => s.on);
  const selected = useView((s) => s.selected);
  const playing = useView((s) => s.playing);
  const model = useDesign((s) => s.model);
  const source = useDesign((s) => s.source);
  const filter = usePicks((s) => s.filter);
  const picking = usePicks((s) => s.picks.length > 0);
  const measureOn = useMeasure((s) => s.on);
  const sketching = useSketch((s) => !!s.active || s.picking);
  const markup = useMarkup((s) => s.on);
  const [live, setLive] = useState<{ key: string; text: string } | null>(null);
  const [edit, setEdit] = useState<{ key: string; text: string; x: number; y: number } | null>(null);
  const [, setFrame] = useState(0);
  const drag = useRef<Drag | null>(null);
  const timer = useRef(0);
  const pending = useRef<string | null>(null);

  const part = selected.length === 1 ? model?.parts.find((p) => p.id === selected[0]) : undefined;
  const shown = !!(on && model && part && part.kind === "part" && !part.locked && !part.hidden && filter === "part" && !picking && !measureOn && !sketching && !markup && !playing);
  const handles = useMemo(() => (shown && part && model ? sizeHandles(source, model, part) : []), [shown, part, model, source]);

  // H turns the handles off and on
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || (e.key !== "h" && e.key !== "H")) return;
      const ui = useUi.getState();
      const sk = useSketch.getState();
      if (ui.settingsOpen || ui.shortcutsOpen || ui.findOpen || ui.confirm || sk.active || sk.picking || useMarkup.getState().on || document.querySelector(".drawing-shell")) return;
      toggleHandles();
      toast({ kind: "info", title: useHandles.getState().on ? "Drag handles on: select a part to pull its sizes or slide it" : "Drag handles off (H brings them back)" }, 2200);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // follow the camera, the viewport's size, rebuilt meshes and parts easing apart
  useEffect(() => {
    const h = host();
    if (!h || !shown) return;
    const bump = () => setFrame((f) => f + 1);
    h.controls?.addEventListener("change", bump);
    const ro = new ResizeObserver(bump);
    ro.observe(h.canvas);
    const unMesh = useDesign.subscribe((s, p) => s.meshVersion !== p.meshVersion && bump());
    let raf = 0;
    let until = 0;
    const tick = () => {
      bump();
      raf = performance.now() < until ? requestAnimationFrame(tick) : 0;
    };
    const unView = useView.subscribe((s, p) => {
      if (s.explode === p.explode) return;
      until = performance.now() + 1500;
      if (!raf) raf = requestAnimationFrame(tick);
    });
    return () => {
      h.controls?.removeEventListener("change", bump);
      ro.disconnect();
      unMesh();
      unView();
      cancelAnimationFrame(raf);
    };
  }, [host, shown]);

  // a drag or a typed value left open when the handles go away
  useEffect(() => {
    if (shown) return;
    setEdit(null);
    if (drag.current) {
      drag.current = null;
      setLive(null);
      endPreview(PREVIEW);
    }
  }, [shown]);

  // Esc lets go of a drag without changing anything
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !drag.current) return;
      e.stopPropagation();
      drag.current = null;
      setLive(null);
      window.clearTimeout(timer.current);
      timer.current = 0;
      endPreview(PREVIEW);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const h = host();
  if (!shown || !h || !part) return null;
  const mesh = partMeshes(h.scene).get(part.id);
  if (!mesh || !mesh.visible) return null;
  const v = view(h);

  /** show a source while dragging, at most every 60 ms */
  const schedule = (src: string) => {
    pending.current = src;
    if (timer.current) return;
    timer.current = window.setTimeout(() => {
      timer.current = 0;
      const next = pending.current;
      pending.current = null;
      if (next !== null && drag.current) previewSource({ key: PREVIEW, label: `Dragging ${part.label}`, quiet: true }, next);
    }, 60);
  };
  const stepAt = (A: THREE.Vector3) => Math.max(0.1, niceStep(1 / v.mmPerPx(A) / 2));

  const begin = (e: RPointerEvent, make: (base: string) => Drag | string | null) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const base = realSource();
    const d = make(base);
    if (typeof d === "string") return toast({ kind: "warn", title: d }, 4000);
    if (!d) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = d;
    setEdit(null);
  };

  const startSize = (e: RPointerEvent, hd: SizeHandle) =>
    begin(e, (base) => {
      const m = base === source && model ? model : evaluateOnly(base);
      const bp = m.parts.find((p) => p.id === part.id);
      const bh = bp && sizeHandles(base, m, bp).find((q) => q.key === hd.key);
      if (!bh) return null;
      const { A, D } = worldArrow(mesh, bh, v.camPos);
      const s0 = axisParam(h, e.clientX, e.clientY, A, D) ?? 0;
      return { kind: "size", key: hd.key, base, handle: bh, write: bh.write ?? ((s) => s), A, D, s0, step: stepAt(A), x0: e.clientX, y0: e.clientY, moved: false, last: bh.value };
    });

  const startMove = (e: RPointerEvent, axis: V3, key: string) =>
    begin(e, (base) => {
      const m = base === source && model ? model : evaluateOnly(base);
      const test = applyQuick({ k: "move", by: axis as Vec3, target: part.name }, { src: base, model: m, target: part.name });
      if (!test.ok) return test.why;
      const A = middleOf(mesh);
      const D = new THREE.Vector3(...axis);
      const s0 = axisParam(h, e.clientX, e.clientY, A, D) ?? 0;
      return { kind: "move", key, base, model: m, block: part.name, axis, A, D, s0, step: stepAt(A), x0: e.clientX, y0: e.clientY, moved: false, last: 0, next: null };
    });

  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 3) return;
    d.moved = true;
    const s = axisParam(h, e.clientX, e.clientY, d.A, d.D);
    if (s === null) return;
    const step = e.shiftKey ? d.step / 10 : d.step;
    if (d.kind === "size") {
      if (!d.handle.write) return;
      const val = draggedValue(d.handle, d.handle.value, s - d.s0, step);
      if (val === d.last) return;
      d.last = val;
      setLive({ key: d.key, text: `${d.handle.label} ${fmtNum(val, 2)}` });
      schedule(d.write(d.base, val));
    } else {
      const r = Math.round(Math.round((s - d.s0) / step) * step * 1e6) / 1e6;
      if (r === d.last) return;
      d.last = r;
      const res = applyQuick({ k: "move", by: d.axis.map((c) => c * r) as Vec3, target: d.block }, { src: d.base, model: d.model, target: d.block });
      if (!res.ok) return;
      d.next = { src: res.src, title: res.title };
      setLive({ key: d.key, text: `${r >= 0 ? "+" : "−"}${fmtNum(Math.abs(r), 2)} mm ${d.axis[0] ? "X" : d.axis[1] ? "Y" : "Z"}` });
      schedule(res.src);
    }
  };

  const onUp = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setLive(null);
    window.clearTimeout(timer.current);
    timer.current = 0;
    pending.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    if (d.kind === "size") {
      if (!d.moved) {
        endPreview(PREVIEW);
        const hd = d.handle;
        if (!hd.write) {
          revealSpan(hd.field.span);
          return toast({ kind: "info", title: `${part.label}: the ${hd.name} is ${hd.why ?? "set in the design file"}` }, 4000);
        }
        const r = (e.currentTarget as Element).getBoundingClientRect();
        return setEdit({ key: hd.key, text: fmtNum(hd.value, 3), x: r.left + r.width / 2 - v.vp.left, y: r.top + r.height / 2 - v.vp.top });
      }
      if (d.last === d.handle.value) return endPreview(PREVIEW);
      commitSource(d.write(d.base, d.last), "you", `${part.label}: ${d.handle.name} ${mm(d.handle.value)} → ${mm(d.last)}${d.handle.via ? ` (parameter ${d.handle.via})` : ""}`);
    } else {
      if (!d.moved || !d.last || !d.next) return endPreview(PREVIEW);
      commitSource(d.next.src, "you", d.next.title);
    }
  };

  const typed = () => {
    if (!edit) return;
    const hd = handles.find((q) => q.key === edit.key);
    setEdit(null);
    const val = Number(edit.text.replace(/mm\s*$/i, "").trim());
    if (!hd || !Number.isFinite(val)) return;
    if (val < hd.min || (hd.max !== undefined && val > hd.max)) return toast({ kind: "warn", title: `The ${hd.name} must be ${hd.max !== undefined ? `between ${fmtNum(hd.min, 2)} and ${fmtNum(hd.max, 2)}` : `more than ${fmtNum(hd.min, 2)}`} mm` });
    if (val === hd.value) return;
    const base = realSource();
    const m = base === source && model ? model : evaluateOnly(base);
    const bp = m.parts.find((p) => p.id === part.id);
    const bh = bp && sizeHandles(base, m, bp).find((q) => q.key === hd.key);
    if (!bh?.write) return;
    commitSource(bh.write(base, val), "you", `${part.label}: ${bh.name} ${mm(bh.value)} → ${mm(val)}${bh.via ? ` (parameter ${bh.via})` : ""}`);
  };

  // the part's size on screen: small parts get only the move arrows
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox!;
  const c1 = v.screen(bb.min.clone().applyMatrix4(mesh.matrixWorld));
  const c2 = v.screen(bb.max.clone().applyMatrix4(mesh.matrixWorld));
  const roomy = Math.hypot(c1[0] - c2[0], c1[1] - c2[1]) > 90;

  const arrowPath = (a: [number, number, boolean], t: [number, number, boolean], head = 7) => {
    const dx = t[0] - a[0];
    const dy = t[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    const ux = dx / l;
    const uy = dy / l;
    const tipX = t[0] + ux * head;
    const tipY = t[1] + uy * head;
    return {
      shaft: `M${a[0].toFixed(1)},${a[1].toFixed(1)}L${t[0].toFixed(1)},${t[1].toFixed(1)}`,
      head: `M${tipX.toFixed(1)},${tipY.toFixed(1)}L${(t[0] - uy * 5).toFixed(1)},${(t[1] + ux * 5).toFixed(1)}L${(t[0] + uy * 5).toFixed(1)},${(t[1] - ux * 5).toFixed(1)}Z`,
      label: [tipX + ux * 14, tipY + uy * 14] as [number, number],
    };
  };
  const pill = (x: number, y: number, text: string, cls: string) => {
    const w = text.length * 6.7 + 12;
    return (
      <g className={`hd-label ${cls}`} transform={`translate(${(x - w / 2).toFixed(1)},${(y - 10).toFixed(1)})`}>
        <rect width={w} height={20} rx={5} />
        <text x={w / 2} y={14}>
          {text}
        </text>
      </g>
    );
  };

  const sizes = roomy
    ? handles.map((hd) => {
        const { A, D } = worldArrow(mesh, hd, v.camPos);
        const T = A.clone().addScaledVector(D, 40 * v.mmPerPx(A));
        const a = v.screen(A);
        const t = v.screen(T);
        if (!a[2] || !t[2]) return null;
        const flat = Math.hypot(t[0] - a[0], t[1] - a[1]) < 14;
        const p = arrowPath(a, t);
        const at = flat ? ([a[0] + 16, a[1] - 16] as [number, number]) : p.label;
        const busy = live?.key === hd.key;
        const text = busy ? live.text : `${hd.label} ${fmtNum(hd.value, 2)}`;
        const tip = hd.write ? `Drag to change the ${hd.name}${hd.via ? ` (moves the parameter ${hd.via})` : ""}; click the value to type it. Shift: finer steps.` : `The ${hd.name} is ${hd.why}. Click to see it in the design file.`;
        return (
          <g key={hd.key} className={`hd-size ${hd.write ? "" : "fixed"} ${busy ? "busy" : ""}`}>
            {!flat && hd.write && (
              <g className="hd-grip" onPointerDown={(e) => startSize(e, hd)} onPointerMove={onMove} onPointerUp={onUp}>
                <title>{tip}</title>
                <path className="hd-hit" d={p.shaft} />
                <path className="hd-shaft" d={p.shaft} />
                <path className="hd-head" d={p.head} />
              </g>
            )}
            <g className="hd-grip" onPointerDown={(e) => startSize(e, hd)} onPointerMove={onMove} onPointerUp={onUp}>
              <title>{tip}</title>
              {pill(at[0], at[1], text, hd.write ? "" : "fixed")}
            </g>
          </g>
        );
      })
    : [];

  const mid = middleOf(mesh);
  const m0 = v.screen(mid);
  const triad = m0[2]
    ? AXES.map((ax) => {
        const D = new THREE.Vector3(...ax.v);
        const L = 30 * v.mmPerPx(mid);
        const a = v.screen(mid.clone().addScaledVector(D, 8 * v.mmPerPx(mid)));
        const t = v.screen(mid.clone().addScaledVector(D, L));
        if (!a[2] || !t[2] || Math.hypot(t[0] - m0[0], t[1] - m0[1]) < 12) return null;
        const p = arrowPath(a, t, 6);
        const key = `move:${ax.key}`;
        const busy = live?.key === key;
        return (
          <g key={key} className={`hd-move hd-${ax.key} ${busy ? "busy" : ""}`}>
            <g className="hd-grip" onPointerDown={(e) => startMove(e, ax.v, key)} onPointerMove={onMove} onPointerUp={onUp}>
              <title>{`Drag to slide ${part.label} along ${ax.key.toUpperCase()}. Shift: finer steps.`}</title>
              <path className="hd-hit" d={p.shaft} />
              <path className="hd-shaft" d={p.shaft} />
              <path className="hd-head" d={p.head} />
            </g>
            {busy && pill(p.label[0], p.label[1], live.text, "move")}
          </g>
        );
      })
    : [];

  return (
    <>
      <svg className="measure-svg hd-svg">
        {sizes}
        {m0[2] && <circle className="hd-hub" cx={m0[0]} cy={m0[1]} r={3.5} />}
        {triad}
      </svg>
      {edit && (
        <input
          className="input mono hd-edit"
          style={{ left: edit.x, top: edit.y }}
          autoFocus
          value={edit.text}
          onChange={(e) => setEdit({ ...edit, text: e.target.value })}
          onFocus={(e) => e.target.select()}
          onBlur={() => setEdit(null)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") typed();
            if (e.key === "Escape") setEdit(null);
          }}
          aria-label="New value in mm"
        />
      )}
    </>
  );
}
