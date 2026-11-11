// Picking faces, edges and corners in the 3D view, and dragging a box to
// pick many at once. The selection filter (Q, or the pointer menu in the
// toolbar) says what a click picks; with box select on (B) a drag draws a
// box instead of turning the view: dragged left to right it takes what is
// wholly inside, right to left whatever it touches. Picked edges can be
// filleted or chamfered in one go, a flat face sketched on, and any
// selection kept as a named set. Claude is told what is picked, as
// selectors it can use.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { create } from "zustand";
import { meshes, useDesign } from "../../core/engine";
import type { EvalPart } from "../../core/model";
import { kernel } from "../../kernel/client";
import type { EntityInfo } from "../../kernel/drawing";
import type { MeshData } from "../../kernel/build";
import type { V3 } from "../../kernel/recipe";
import { fmtNum } from "../../lang/values";
import { FILTERS, FILTER_WORD, addPicks, anchorOf, clearPicks, countText, cycleFilter, deleteSet, picksByBlock, resolvePick, savedSets, saveSet, selectorFor, setFilter, setPicks, toggleBox, usePicks, useSets, type Pick, type PickFilter, type SelectionSet } from "../../app/picks";
import { roundPicked } from "../../app/quickRun";
import { select, useView } from "../../app/view";
import { toast, useUi } from "../../app/ui";
import { useChatDraft } from "../chatDraft";
import { Menu, MenuItem } from "../common";
import { Icon } from "../icons";
import { createSketch, useSketch } from "../sketch/session";
import { planeForFace } from "../sketch/SketchPanels";
import { useMarkup } from "../Markup";
import { measuring, meshData, partMeshes, pickRef, snapAt, useMeasure, type MeasureHost, type Snap } from "./MeasureTool";

export interface PickHost extends MeasureHost {
  /** the view's orbit controls, held still while a box is dragged */
  orbit?: { enabled: boolean };
}

const LABEL: Record<PickFilter, string> = { part: "Parts", face: "Faces", edge: "Edges", vertex: "Corners" };
const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable || !!el.closest?.(".cm-editor"));
};

/** A pointer with what the filter picks beside it. */
export function FilterIcon({ filter, box, size = 16 }: { filter: PickFilter; box: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 3l9 5-4 1-2 4z" />
      {box && <rect x="11" y="11" width="10" height="10" rx="1" strokeDasharray="2.2 2" />}
      {!box && filter === "part" && <path d="M14 14h7v7h-7z" />}
      {!box && filter === "face" && <path d="M13 15l5-3 4 3-5 3z" fill="currentColor" fillOpacity={0.35} />}
      {!box && filter === "edge" && <path d="M13 20l8-8" strokeWidth={2.4} />}
      {!box && filter === "vertex" && <rect x="15.5" y="14.5" width="4.5" height="4.5" fill="currentColor" />}
    </svg>
  );
}

// ---------- the toolbar menu ----------

export function PickFilterMenu() {
  const filter = usePicks((s) => s.filter);
  const box = usePicks((s) => s.box);
  const picks = usePicks((s) => s.picks);
  const selected = useView((s) => s.selected);
  const model = useDesign((s) => s.model);
  useSets((s) => s.version);
  const sets = model ? savedSets(model.name) : [];
  const something = picks.length > 0 || selected.length > 0;
  return (
    <Menu
      className="vp-pick"
      width={262}
      trigger={(open, toggle) => (
        <button className={`icon-btn ${open || filter !== "part" || box ? "active" : ""}`} onClick={toggle} data-tip={`Click picks ${FILTER_WORD[filter]}${box ? "; dragging draws a box" : ""} (Q to change, B for box select)`} aria-label="Selection filter">
          <FilterIcon filter={filter} box={box} />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="menu-label">Click picks</div>
          {FILTERS.map((f) => (
            <MenuItem
              key={f}
              icon={filter === f ? <Icon.Check size={13} /> : undefined}
              onClick={() => {
                setFilter(f);
                close();
              }}
            >
              {LABEL[f]}
            </MenuItem>
          ))}
          <div className="menu-sep" />
          <MenuItem
            icon={box ? <Icon.Check size={13} /> : undefined}
            hint="B"
            onClick={() => {
              toggleBox();
              close();
            }}
          >
            Box select: drag to pick
          </MenuItem>
          <div className="menu-sep" />
          <div className="menu-label">Selection sets</div>
          {sets.map((set) => (
            <div key={set.name} className="row pick-set">
              <MenuItem
                onClick={() => {
                  recallSet(set);
                  close();
                }}
                hint={setCount(set)}
              >
                {set.name}
              </MenuItem>
              <button className="icon-btn sm" onClick={() => model && deleteSet(model.name, set.name)} aria-label={`Delete the set ${set.name}`} data-tip="Delete this set">
                <Icon.X size={12} />
              </button>
            </div>
          ))}
          <MenuItem
            icon={<Icon.Plus size={13} />}
            disabled={!something}
            onClick={() => {
              useNaming.setState({ on: true });
              close();
            }}
          >
            {something ? "Save the selection as a set…" : "Select something to save it as a set"}
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

const setCount = (s: SelectionSet) => (s.parts?.length ? `${s.parts.length} part${s.parts.length === 1 ? "" : "s"}` : countText((s.picks ?? []).map((p) => ({ ...p }))));

/** the set name box is open */
const useNaming = create<{ on: boolean }>(() => ({ on: false }));

/** Open the box that names the selection as a set. */
export const openSetNamer = () => useNaming.setState({ on: true });

/** Bring a saved set back: its parts, or its faces, edges and corners found again on the parts as they are now. */
export function recallSet(set: SelectionSet) {
  const model = useDesign.getState().model;
  if (!model) return;
  if (set.parts?.length) {
    const ids = set.parts.filter((id) => model.parts.some((p) => p.id === id));
    setFilter("part");
    select(ids);
    if (ids.length < set.parts.length) toast({ kind: "warn", title: `${set.parts.length - ids.length} of the parts in “${set.name}” are no longer in the design` });
    return;
  }
  const found: Pick[] = [];
  for (const q of set.picks ?? []) {
    const part = model.parts.find((p) => p.id === q.partId);
    const data = part && currentMesh(part);
    const p = data && resolvePick(q.partId, q.kind, q.at, data);
    if (p) found.push(p);
  }
  const kinds = new Set(found.map((p) => p.kind));
  usePicks.setState({ filter: kinds.size === 1 ? [...kinds][0] : usePicks.getState().filter === "part" ? found[0]?.kind ?? "part" : usePicks.getState().filter, picks: found });
  const lost = (set.picks?.length ?? 0) - found.length;
  if (lost) toast({ kind: "warn", title: `${lost} of the picks in “${set.name}” could not be found`, detail: "The parts changed shape since the set was saved." });
}

function currentMesh(part: EvalPart): MeshData | undefined {
  const e = meshes.get(part.hash);
  return e?.final ?? e?.preview;
}

// ---------- picking in the view ----------

export function PickLayer({ host }: { host: () => PickHost | null }) {
  const filter = usePicks((s) => s.filter);
  const box = usePicks((s) => s.box);
  const picks = usePicks((s) => s.picks);
  const measureOn = useMeasure((s) => s.on);
  const sketching = useSketch((s) => !!s.active || s.picking);
  const meshVersion = useDesign((s) => s.meshVersion);
  const [hover, setHover] = useState<Pick | null>(null);
  const [rect, setRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [, setFrame] = useState(0);
  const active = (filter !== "part" || box) && !measureOn && !sketching;

  // Q steps through the filters (Shift+Q back), B turns box select on and off, Esc lets go of the picks
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const ui = useUi.getState();
      const sk = useSketch.getState();
      if (ui.settingsOpen || ui.shortcutsOpen || ui.findOpen || ui.confirm || sk.active || sk.picking || useMarkup.getState().on || document.querySelector(".drawing-shell")) return;
      if (e.key === "q" || e.key === "Q") {
        cycleFilter(e.shiftKey);
        toast({ kind: "info", title: `Click picks ${FILTER_WORD[usePicks.getState().filter]}` }, 1600);
      } else if (e.key === "b" || e.key === "B") {
        toggleBox();
        toast({ kind: "info", title: usePicks.getState().box ? "Box select: drag to pick (left to right: wholly inside; right to left: touching)" : "Box select off: dragging turns the view" }, 2400);
      } else if (e.key === "Escape" && usePicks.getState().picks.length && !measuring()) clearPicks();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // after a rebuild, find each pick again on the new mesh (by where it was); drop the ones that went
  useEffect(() => {
    const model = useDesign.getState().model;
    const cur = usePicks.getState().picks;
    if (!model || !cur.length) return;
    let changed = false;
    const next: Pick[] = [];
    for (const p of cur) {
      const part = model.parts.find((q) => q.id === p.partId);
      const data = part && currentMesh(part);
      if (data && data === p.data) next.push(p);
      else {
        changed = true;
        const r = data && resolvePick(p.partId, p.kind, p.at, data);
        if (r) next.push(r);
      }
    }
    if (changed) setPicks(next);
  }, [meshVersion]);

  // pointer handling on the canvas: hover and click pick with the filter, or drag a box
  useEffect(() => {
    const h = host();
    if (!active || !h) {
      setHover(null);
      return;
    }
    const el = h.canvas;
    const parent = el.parentElement ?? el;
    let down: { x: number; y: number } | null = null;
    let drag: { x0: number; y0: number; x1: number; y1: number } | null = null;
    let pending: PointerEvent | null = null;
    let raf = 0;
    const prevCursor = el.style.cursor;
    el.style.cursor = usePicks.getState().box ? "crosshair" : "pointer";
    const kindNow = () => {
      const f = usePicks.getState().filter;
      return f === "part" ? null : f;
    };
    const move = (e: PointerEvent) => {
      if (drag) {
        drag = { ...drag, x1: e.clientX, y1: e.clientY };
        setRect(drag);
        return;
      }
      if (e.buttons) return setHover(null);
      const kind = kindNow();
      if (!kind) return;
      pending = e;
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (!pending) return;
          const s = snapAt(h, pending.clientX, pending.clientY, kind);
          setHover(s ? toPick(s) : null);
        });
    };
    const pd = (e: PointerEvent) => {
      if (e.button !== 0 || e.altKey || e.target !== el) return;
      down = { x: e.clientX, y: e.clientY };
      if (usePicks.getState().box) {
        drag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
        if (h.orbit) h.orbit.enabled = false;
        setHover(null);
      }
    };
    const pu = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      if (drag) {
        const d = drag;
        drag = null;
        if (h.orbit) h.orbit.enabled = true;
        setRect(null);
        if (Math.hypot(d.x1 - d.x0, d.y1 - d.y0) >= 5) {
          down = null;
          return finishBox(h, d, additive);
        }
      }
      const kind = kindNow();
      if (!down || !kind || Math.hypot(e.clientX - down.x, e.clientY - down.y) >= 5) return;
      down = null;
      const s = snapAt(h, e.clientX, e.clientY, kind);
      if (!s) {
        if (!additive) clearPicks();
        return;
      }
      if (additive) addPicks([toPick(s)], true);
      else setPicks([toPick(s)]);
    };
    const leave = () => setHover(null);
    parent.addEventListener("pointerdown", pd, true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", pu);
    el.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(raf);
      if (h.orbit) h.orbit.enabled = true;
      el.style.cursor = prevCursor;
      parent.removeEventListener("pointerdown", pd, true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", pu);
      el.removeEventListener("pointerleave", leave);
    };
  }, [active, host, box]);

  // follow the camera, the viewport's size and parts easing apart while picks are shown
  useEffect(() => {
    const h = host();
    if (!h || (!picks.length && !hover)) return;
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
  }, [host, picks, hover]);

  const h = host();
  const shapes = h && !sketching ? drawPicks(h, picks, active ? hover : null) : null;
  const vp = h?.canvas.closest(".viewport")?.getBoundingClientRect();
  return (
    <>
      {shapes && (
        <svg className="measure-svg pick-svg">
          {shapes.hover}
          {shapes.picks}
        </svg>
      )}
      {rect && vp && (
        <div
          className={`vp-boxsel ${rect.x1 < rect.x0 ? "crossing" : "window"}`}
          style={{ left: Math.min(rect.x0, rect.x1) - vp.left, top: Math.min(rect.y0, rect.y1) - vp.top, width: Math.abs(rect.x1 - rect.x0), height: Math.abs(rect.y1 - rect.y0) }}
        />
      )}
      <AnimatePresence>{picks.length > 0 && !sketching && !measureOn && <PickCard key="picks" picks={picks} />}</AnimatePresence>
      <SetNamer />
    </>
  );
}

function toPick(s: Snap): Pick {
  return { partId: s.partId, kind: s.kind, id: s.id, at: [s.local.x, s.local.y, s.local.z].map((v) => Math.round(v * 1e4) / 1e4) as V3, range: s.range, data: s.data };
}

function toSnap(p: Pick): Snap | null {
  if (!p.data) return null;
  return { partId: p.partId, kind: p.kind, id: p.id, local: new THREE.Vector3(...p.at), data: p.data, range: p.range };
}

// ---------- box select ----------

function shownMesh(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  const m = (o as THREE.Mesh).material as THREE.Material;
  return !(m.transparent && m.opacity <= 0.5);
}

/**
 * Whether a triangle (its first index at i in data.indices) turns toward the
 * camera, judged by the mesh's own normals, so it holds whichever way the
 * mesher wound it. Worked out in the part's coordinates, where the sign comes
 * out the same as in the world's.
 */
function facingTest(h: PickHost, mesh: THREE.Mesh, data: MeshData): (i: number) => boolean {
  const N = data.normals;
  const P = data.positions;
  const I = data.indices;
  if (!N || N.length < P.length) return () => true;
  const inv = mesh.matrixWorld.clone().invert();
  const ortho = (h.camera as THREE.OrthographicCamera).isOrthographicCamera;
  const eye = new THREE.Vector3().setFromMatrixPosition(h.camera.matrixWorld).applyMatrix4(inv);
  const look = ortho ? new THREE.Vector3(0, 0, -1).transformDirection(h.camera.matrixWorld).transformDirection(inv) : null;
  return (i) => {
    const k = I[i] * 3;
    if (look) return N[k] * look.x + N[k + 1] * look.y + N[k + 2] * look.z < 0;
    return N[k] * (eye.x - P[k]) + N[k + 1] * (eye.y - P[k + 1]) + N[k + 2] * (eye.z - P[k + 2]) > 0;
  };
}

/** Screen tests for a dragged box: points inside it, and segments and triangles that touch it. */
function boxTests(X0: number, X1: number, Y0: number, Y1: number) {
  const inside = (x: number, y: number) => x >= X0 && x <= X1 && y >= Y0 && y <= Y1;
  /** a segment touches the box: an end inside it, or the segment clipped to it is not empty (Liang–Barsky) */
  const segment = (ax: number, ay: number, bx: number, by: number) => {
    if (Number.isNaN(ax) || Number.isNaN(bx)) return false;
    if (inside(ax, ay) || inside(bx, by)) return true;
    const dx = bx - ax;
    const dy = by - ay;
    let t0 = 0;
    let t1 = 1;
    for (const [p, q] of [
      [-dx, ax - X0],
      [dx, X1 - ax],
      [-dy, ay - Y0],
      [dy, Y1 - ay],
    ]) {
      if (p === 0) {
        if (q < 0) return false;
        continue;
      }
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      if (t0 > t1) return false;
    }
    return true;
  };
  const cx = (X0 + X1) / 2;
  const cy = (Y0 + Y1) / 2;
  /** a triangle touches the box: a side does, or the box lies inside the triangle */
  const triangle = (S: Float32Array, i: number, j: number, k: number) => {
    const [ax, ay, bx, by, qx, qy] = [S[i * 2], S[i * 2 + 1], S[j * 2], S[j * 2 + 1], S[k * 2], S[k * 2 + 1]];
    if (Number.isNaN(ax) || Number.isNaN(bx) || Number.isNaN(qx)) return false;
    if (segment(ax, ay, bx, by) || segment(bx, by, qx, qy) || segment(qx, qy, ax, ay)) return true;
    const side = (px: number, py: number, ux: number, uy: number, vx: number, vy: number) => (vx - ux) * (py - uy) - (vy - uy) * (px - ux);
    const s1 = side(cx, cy, ax, ay, bx, by);
    const s2 = side(cx, cy, bx, by, qx, qy);
    const s3 = side(cx, cy, qx, qy, ax, ay);
    return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
  };
  return { inside, segment, triangle };
}

/**
 * What a dragged box takes: dragged left to right, what lies wholly inside;
 * right to left, whatever it touches. Faces count when they face the
 * viewer; edges and corners when nothing hides them.
 */
function finishBox(h: PickHost, d: { x0: number; y0: number; x1: number; y1: number }, additive: boolean) {
  const filter = usePicks.getState().filter;
  const model = useDesign.getState().model;
  if (!model) return;
  const crossing = d.x1 < d.x0;
  const box = boxTests(Math.min(d.x0, d.x1), Math.max(d.x0, d.x1), Math.min(d.y0, d.y1), Math.max(d.y0, d.y1));
  const rect = h.canvas.getBoundingClientRect();
  const v = new THREE.Vector3();
  const camPos = new THREE.Vector3().setFromMatrixPosition(h.camera.matrixWorld);
  /** every point of a list on the screen (NaN behind the camera) */
  const project = (mesh: THREE.Mesh, arr: ArrayLike<number>) => {
    const n = Math.floor(arr.length / 3);
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      v.set(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]).applyMatrix4(mesh.matrixWorld).project(h.camera);
      const behind = v.z > 1 || v.z < -1;
      out[i * 2] = behind ? NaN : (v.x * 0.5 + 0.5) * rect.width + rect.left;
      out[i * 2 + 1] = behind ? NaN : (-v.y * 0.5 + 0.5) * rect.height + rect.top;
    }
    return out;
  };
  const pointIn = (S: Float32Array, i: number) => !Number.isNaN(S[i * 2]) && box.inside(S[i * 2], S[i * 2 + 1]);
  /** every point of a run (by index) lies inside the box */
  const allIn = (S: Float32Array, idx: (k: number) => number, count: number) => {
    for (let k = 0; k < count; k++) if (!pointIn(S, idx(k))) return false;
    return count > 0;
  };
  const list = [...partMeshes(h.scene)].filter(([, m]) => shownMesh(m));
  const visibleMeshes = list.map(([, m]) => m);
  const ray = new THREE.Raycaster();
  let rays = 0;
  /** nothing in front of a point (a part's own surface it lies on doesn't count) */
  const seen = (mesh: THREE.Mesh, local: V3) => {
    if (rays++ > 400) return true;
    const w = new THREE.Vector3(...local).applyMatrix4(mesh.matrixWorld);
    const dist = w.distanceTo(camPos);
    ray.set(camPos, w.clone().sub(camPos).normalize());
    ray.far = dist;
    const hit = ray.intersectObjects(visibleMeshes, false)[0];
    return !hit || hit.distance >= dist - Math.max(0.05, dist * 0.003);
  };

  if (filter === "part") {
    const ids = list
      .filter(([, mesh]) => {
        const pos = mesh.geometry.getAttribute("position");
        const S = project(mesh, pos.array as ArrayLike<number>);
        if (!crossing) return allIn(S, (k) => k, pos.count);
        const index = mesh.geometry.index;
        if (!index) {
          for (let k = 0; k < pos.count; k++) if (pointIn(S, k)) return true;
          return false;
        }
        const I = index.array;
        for (let i = 0; i + 2 < I.length; i += 3) if (box.triangle(S, I[i], I[i + 1], I[i + 2])) return true;
        return false;
      })
      .map(([id]) => id);
    const cur = useView.getState().selected;
    select(additive ? [...new Set([...cur, ...ids])] : ids);
    if (!ids.length) toast({ kind: "info", title: crossing ? "The box touched no parts" : "No part was wholly inside the box", detail: crossing ? undefined : "Drag right to left to take parts the box only touches." }, 2600);
    return;
  }
  const found: Pick[] = [];
  for (const [id, mesh] of list) {
    const part = model.parts.find((p) => p.id === id);
    const data = part && meshData(part, mesh);
    if (!part || !data) continue;
    if (filter === "face") {
      const fg = data.faceGroups;
      if (!fg) continue;
      const I = data.indices;
      const S = project(mesh, data.positions);
      const front = facingTest(h, mesh, data);
      for (let g = 0; g < fg.length; g += 3) {
        const [start, count] = [fg[g], fg[g + 1]];
        // turned to the viewer somewhere, and in (or touching) the box
        let facing = false;
        let touch = false;
        for (let i = start; i + 2 < start + count && !(facing && touch); i += 3) {
          if (!front(i)) continue;
          facing = true;
          if (crossing && !touch) touch = box.triangle(S, I[i], I[i + 1], I[i + 2]);
        }
        if (!facing || !(crossing ? touch : allIn(S, (k) => I[start + k], count))) continue;
        const at = anchorOf("face", [0, 0, 0], [start, count], data);
        found.push({ partId: id, kind: "face", id: fg[g + 2], at, range: [start, count], data });
      }
    } else {
      const eg = data.edgeGroups;
      if (!eg) continue;
      const E = data.edges;
      const S = project(mesh, E);
      const corners = new Set<string>();
      for (let g = 0; g < eg.length; g += 3) {
        const [start, count] = [eg[g], eg[g + 1]];
        if (filter === "edge") {
          let take = !crossing && allIn(S, (k) => start + k, count);
          for (let k = start; crossing && !take && k + 1 < start + count; k += 2) take = box.segment(S[k * 2], S[k * 2 + 1], S[(k + 1) * 2], S[(k + 1) * 2 + 1]);
          if (!take) continue;
          const at = anchorOf("edge", [E[start * 3], E[start * 3 + 1], E[start * 3 + 2]], [start, count], data);
          if (seen(mesh, at)) found.push({ partId: id, kind: "edge", id: eg[g + 2], at, range: [start, count], data });
        } else {
          for (const k of [start, start + count - 1]) {
            const at: V3 = [E[k * 3], E[k * 3 + 1], E[k * 3 + 2]].map((x) => Math.round(x * 1e4) / 1e4) as V3;
            const key = at.join(",");
            if (corners.has(key) || !pointIn(S, k)) continue;
            corners.add(key);
            if (seen(mesh, at)) found.push({ partId: id, kind: "vertex", at, range: [start, count], data });
          }
        }
      }
    }
  }
  if (additive) addPicks(found, false);
  else setPicks(found);
  if (!found.length) toast({ kind: "info", title: `No ${FILTER_WORD[filter]} ${crossing ? "touched by" : "wholly inside"} the box` }, 2400);
}

// ---------- drawing the picks ----------

function drawPicks(h: PickHost, picks: Pick[], hover: Pick | null) {
  if (!picks.length && !hover) return null;
  const rect = h.canvas.getBoundingClientRect();
  const parent = h.canvas.closest(".viewport")?.getBoundingClientRect() ?? rect;
  const ox = rect.left - parent.left;
  const oy = rect.top - parent.top;
  const byId = partMeshes(h.scene);
  const v = new THREE.Vector3();
  const screen = (mesh: THREE.Mesh, x: number, y: number, z: number): [number, number] => {
    v.set(x, y, z).applyMatrix4(mesh.matrixWorld).project(h.camera);
    return [ox + (v.x * 0.5 + 0.5) * rect.width, oy + (-v.y * 0.5 + 0.5) * rect.height];
  };
  const shape = (p: Pick, cls: string, key: string) => {
    const mesh = byId.get(p.partId);
    if (!mesh || !shownMesh(mesh)) return null;
    let path = "";
    const d = p.data;
    if (d && p.range && p.kind === "face" && p.range[1] <= 30000) {
      // the side turned to the viewer (the far side of a round face would show through it and cancel its fill); a face turned away is drawn whole
      const I = d.indices;
      const P = d.positions;
      const front = facingTest(h, mesh, d);
      const tris = (all: boolean) => {
        let out = "";
        for (let i = p.range![0]; i + 2 < p.range![0] + p.range![1]; i += 3) {
          if (!all && !front(i)) continue;
          const t = [I[i], I[i + 1], I[i + 2]].map((k) => screen(mesh, P[k * 3], P[k * 3 + 1], P[k * 3 + 2]));
          out += `M${t.map((q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join("L")}Z`;
        }
        return out;
      };
      path = tris(false) || tris(true);
    } else if (d && p.range && p.kind === "edge") {
      const E = d.edges;
      for (let k = p.range[0]; k + 1 < p.range[0] + p.range[1]; k += 2) {
        const a = screen(mesh, E[k * 3], E[k * 3 + 1], E[k * 3 + 2]);
        const b = screen(mesh, E[(k + 1) * 3], E[(k + 1) * 3 + 1], E[(k + 1) * 3 + 2]);
        path += `M${a[0].toFixed(1)},${a[1].toFixed(1)}L${b[0].toFixed(1)},${b[1].toFixed(1)}`;
      }
    }
    const [x, y] = screen(mesh, ...p.at);
    return (
      <g key={key} className={`measure-${cls} ${p.kind}`}>
        {path && <path d={path} />}
        {p.kind === "vertex" && <rect x={x - 4} y={y - 4} width={8} height={8} />}
      </g>
    );
  };
  const same = (a: Pick, b: Pick) => a.partId === b.partId && a.kind === b.kind && (a.kind === "vertex" ? Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1], a.at[2] - b.at[2]) < 1e-4 : !!a.range && !!b.range && a.range[0] === b.range[0]);
  return {
    hover: hover && !picks.some((p) => same(p, hover)) ? shape(hover, "hover", "hover") : null,
    picks: picks.slice(0, 400).map((p, i) => shape(p, "pick", `p${i}`)),
  };
}

// ---------- the card: what is picked, and what can be done with it ----------

const pickKey = (p: Pick) => `${p.partId}|${p.kind}|${p.at.join(",")}`;

function infoText(e: EntityInfo | undefined, kind: Pick["kind"]): string {
  if (!e) return kind === "vertex" ? "corner" : kind;
  if (e.kind === "vertex") return `corner (${e.point.map((x) => fmtNum(x, 1)).join(", ")})`;
  const type = e.type === "surface" || e.type === "curve" ? "" : `${e.type} `;
  if (e.radius !== undefined && (e.type === "cylinder" || e.type === "circle" || e.type === "sphere")) return `${type}${e.kind} · Ø${fmtNum(e.radius * 2, 2)}`;
  if (e.kind === "edge" && e.length !== undefined) return `${type}edge · ${fmtNum(e.length, 2)} mm`;
  if (e.area !== undefined) return `${type}face · ${fmtNum(e.area, 1)} mm²`;
  return `${type}${e.kind}`;
}

function PickCard({ picks }: { picks: Pick[] }) {
  const model = useDesign((s) => s.model);
  const setDraft = useChatDraft((s) => s.set);
  const [size, setSize] = useState("1");
  const [infos, setInfos] = useState<Map<string, EntityInfo>>(new Map());
  const groups = useMemo(() => picksByBlock(model, picks), [model, picks]);
  const edges = picks.filter((p) => p.kind === "edge");
  const edgeGroups = groups.map((g) => ({ ...g, picks: g.picks.filter((p) => p.kind === "edge") })).filter((g) => g.picks.length);
  const roundable = edgeGroups.length > 0 && edgeGroups.every((g) => g.local);

  // what each pick is, from the exact geometry (the first few)
  useEffect(() => {
    let alive = true;
    void (async () => {
      for (const p of picks.slice(0, 6)) {
        const key = pickKey(p);
        if (infos.has(key)) continue;
        const part = model?.parts.find((q) => q.id === p.partId);
        const s = toSnap(p);
        const ref = s && pickRef(s, part);
        if (!ref) continue;
        try {
          const r = await kernel.measurePick(ref);
          if (!alive) return;
          setInfos((m) => new Map(m).set(key, r.a));
        } catch {
          // still building, or nothing there: the line stays plain
        }
      }
    })();
    return () => {
      alive = false;
    };
    // infos is read, not watched: it only grows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picks, model]);

  const face = picks.length === 1 && picks[0].kind === "face" ? infos.get(pickKey(picks[0])) : undefined;
  const round = (k: "fillet" | "chamfer") => {
    const r = Number(size);
    if (!(r > 0)) return toast({ kind: "warn", title: `Give the ${k} a size in mm` });
    const res = roundPicked(
      k,
      r,
      edgeGroups.map((g) => ({ block: g.block, edges: g.picks.map((p) => anchorOf("edge", p.at, p.range, p.data)) })),
    );
    if (!res.ok) return toast({ kind: "warn", title: res.why });
    toast({ kind: "success", title: res.title });
    clearPicks();
    void res.built.then((err) => err && toast({ kind: "warn", title: `The ${k} doesn't build`, detail: err }, 9000));
  };
  const code = groups.map((g) => `${g.block}: ${selectorFor(g.picks)}`).join("\n");
  const ask = () => setDraft(`About ${groups.map((g) => `${countText(g.picks)} of ${g.block} (${selectorFor(g.picks)})`).join(" and ")}: `);

  return (
    <motion.div className="vp-float vp-selection pick-card" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 12 }} transition={{ type: "spring", stiffness: 420, damping: 36 }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <span style={{ color: "var(--cyan)", display: "inline-flex" }}>
          <FilterIcon filter={picks[0].kind} box={false} size={15} />
        </span>
        <div className="grow" style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {countText(picks)}
          <span className="muted" style={{ fontWeight: 400 }}>
            {" "}
            of {groups.length === 1 ? groups[0].label : `${groups.length} parts`}
          </span>
        </div>
        <button className="icon-btn sm" onClick={clearPicks} aria-label="Clear the picks" data-tip="Clear (Esc)">
          <Icon.X size={14} />
        </button>
      </div>
      <div className="mono" style={{ fontSize: 11, color: "var(--text-3)", lineHeight: 1.75 }}>
        {picks.slice(0, 6).map((p) => (
          <div key={pickKey(p)}>{infoText(infos.get(pickKey(p)), p.kind)}</div>
        ))}
        {picks.length > 6 && <div>and {picks.length - 6} more</div>}
      </div>
      {edges.length > 0 && (
        <div className="row" style={{ marginTop: 10, gap: 6, flexWrap: "wrap" }}>
          <label className="row" style={{ gap: 4 }} data-tip="Fillet radius or chamfer size, in mm">
            <input className="input mono" style={{ width: 40 }} value={size} onChange={(e) => setSize(e.target.value)} onKeyDown={(e) => e.key === "Enter" && roundable && round("fillet")} aria-label="Fillet or chamfer size" />
            <span className="muted">mm</span>
          </label>
          <button className="btn sm" disabled={!roundable} onClick={() => round("fillet")} data-tip={roundable ? `Round the ${edges.length === 1 ? "edge" : `${edges.length} edges`}` : "Only parts made in this design can be rounded"}>
            <Icon.Fillet size={13} /> Fillet
          </button>
          <button className="btn sm" disabled={!roundable} onClick={() => round("chamfer")} data-tip={roundable ? `Bevel the ${edges.length === 1 ? "edge" : `${edges.length} edges`}` : "Only parts made in this design can be chamfered"}>
            <Icon.Chamfer size={13} /> Chamfer
          </button>
        </div>
      )}
      <div className="row" style={{ marginTop: 10, gap: 6, flexWrap: "wrap" }}>
        {face?.type === "plane" && face.normal && (
          <button
            className="btn sm"
            onClick={() => {
              const f = planeForFace(face.point, face.normal!);
              clearPicks();
              createSketch(f.plane, f.offset);
            }}
            data-tip="Start a sketch on this face"
          >
            <Icon.Edit size={13} /> Sketch on it
          </button>
        )}
        <button className="btn sm" onClick={ask} data-tip="Ask Claude about these">
          <Icon.Sparkle size={13} /> Ask
        </button>
        <button
          className="btn sm"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(
              () => toast({ kind: "success", title: "Copied the selector", detail: code.length > 120 ? `${code.slice(0, 117)}…` : code }),
              () => toast({ kind: "warn", title: "Could not copy", detail: code }),
            );
          }}
          data-tip="Copy as code: near() selectors to use in fillet(edges: …), shell(open: …) and the like"
        >
          <Icon.Code size={13} /> Copy as code
        </button>
        <button className="btn sm" onClick={() => useNaming.setState({ on: true })} data-tip="Keep this selection under a name, to pick it again later">
          <Icon.Plus size={13} /> Save set
        </button>
      </div>
    </motion.div>
  );
}

/** A small box for naming a selection set. */
function SetNamer() {
  const on = useNaming((s) => s.on);
  const [name, setName] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (on) {
      setName("");
      requestAnimationFrame(() => ref.current?.focus());
    }
  }, [on]);
  if (!on) return null;
  const save = () => {
    const model = useDesign.getState().model;
    const n = name.trim();
    if (!model || !n) return;
    const { picks } = usePicks.getState();
    const parts = useView.getState().selected;
    const set: SelectionSet = picks.length ? { name: n, picks: picks.map((p) => ({ partId: p.partId, kind: p.kind, at: p.at })) } : { name: n, parts };
    if (!set.parts?.length && !set.picks?.length) return useNaming.setState({ on: false });
    saveSet(model.name, set);
    useNaming.setState({ on: false });
    toast({ kind: "success", title: `Saved the set “${n}”`, detail: "Pick it again from the selection menu in the toolbar." }, 3000);
  };
  return (
    <motion.div className="vp-float pick-namer" style={{ left: "50%", top: 54, x: "-50%" }} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}>
      <span className="muted">Name the set</span>
      <input
        ref={ref}
        className="input"
        value={name}
        placeholder="mounting holes"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") save();
          if (e.key === "Escape") useNaming.setState({ on: false });
        }}
        aria-label="Selection set name"
      />
      <button className="btn sm primary" onClick={save} disabled={!name.trim()}>
        Save
      </button>
      <button className="icon-btn sm" onClick={() => useNaming.setState({ on: false })} aria-label="Cancel">
        <Icon.X size={13} />
      </button>
    </motion.div>
  );
}
