// The sketch editor's drawing surface: an SVG layer over the 3D view that
// draws the open sketch on its plane (following the camera), and turns
// clicks and drags into sketch edits. Geometry is coloured by how
// constrained it is; dimensions and relations sit next to what they act on.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SceneController } from "../viewport/scene";
import { useDesign } from "../../core/engine";
import type { V2 } from "../../kernel/recipe";
import { solveSketch } from "../../sketch/solver";
import { buildProfile } from "../../sketch/regions";
import { addStatements, consId, deleteSelection, dimensionFor, fmt, fmtPt, nextName, setConstraintValue, suggestionsFor, takenNames, toggleConstruction, writePositions } from "../../sketch/edits";
import type { EvalSketch, SkConstraint } from "../../sketch/types";
import { activeSketch, editSketch, exitSketch, flash, setSelection, setTool, useSketch, type LiveSolve } from "./session";
import { Projector, add, arcPoints, ccwThrough, circlePoints, circleThrough, closestOnSeg, curvePoints, dist, len, mul, niceStep, positionsOf, pxDist, radiusOf, roundTo, snapAt, sub, type Positions, type Px, type Snap } from "./geom";
import { labelWidth, layoutDims, layoutGlyphs, type DimGfx } from "./dims";
import { commitSource } from "../../app/project";
import { useView } from "../../app/view";
import { evaluate } from "../../lang/evaluator";

type Draft =
  | { t: "line"; start: Snap }
  | { t: "rect"; a: Snap }
  | { t: "circle"; c: Snap }
  | { t: "arc"; a: Snap; b?: Snap }
  | { t: "slot"; a: Snap; b?: Snap }
  | { t: "dim"; first: string }
  | { t: "box"; from: Px; to: Px; additive: boolean }
  | { t: "drag"; ids: string[]; circle?: string; from: V2; base: Positions; moved: boolean }
  | { t: "scrub"; index: number; fromX: number; start: number; moved: boolean; step: number; angle: boolean };

const HIDDEN_POINTS = new Set(["x_axis.end", "y_axis.end"]);

export function SketchOverlay({ ctl }: { ctl: SceneController }) {
  const s = useSketch();
  const model = useDesign((d) => d.model);
  const sk = s.active ? (model?.sketches.find((x) => x.name === s.active) ?? null) : null;
  const root = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0);
  const [cursor, setCursor] = useState<{ px: Px; snap: Snap | null } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [typed, setTyped] = useState("");
  const [hoverDim, setHoverDim] = useState<number | null>(null);

  // follow the camera: redraw when the view matrix changes
  useEffect(() => {
    let last = "";
    ctl.onRendered = () => {
      const k = ctl.camera.matrixWorld.elements.join(",") + ctl.camera.projectionMatrix.elements[0] + ":" + ctl.renderer.domElement.clientWidth + "x" + ctl.renderer.domElement.clientHeight;
      if (k !== last) {
        last = k;
        setTick((t) => t + 1);
      }
    };
    return () => {
      ctl.onRendered = () => undefined;
    };
  }, [ctl]);

  // leave the session if the sketch disappears (undo, rename, deleted in code)
  useEffect(() => {
    if (s.active && model && !sk) exitSketch();
  }, [s.active, model, sk]);

  // on entry the parts turn see-through and the camera faces the sketch; both go back on exit
  const enteredFor = useRef<string | null>(null);
  useEffect(() => {
    const camera = ctl.cameraState();
    const xray = useView.getState().xray;
    useView.setState({ xray: true });
    return () => {
      enteredFor.current = null;
      ctl.restoreCamera(camera);
      useView.setState({ xray });
    };
  }, [ctl]);
  useEffect(() => {
    if (sk && enteredFor.current !== sk.name) {
      enteredFor.current = sk.name;
      faceSketch(ctl, sk);
    }
  }, [sk, ctl]);

  useEffect(() => {
    ctl.setSketchMode(!!s.active);
    return () => ctl.setSketchMode(false);
  }, [ctl, s.active]);

  useEffect(() => {
    setDraft(null);
    setTyped("");
  }, [s.tool, s.active]);

  const proj = useMemo(() => (sk ? new Projector(ctl, sk.frame) : null), [ctl, sk]);
  const P: Positions = useMemo(() => {
    if (!sk) return {};
    const base = positionsOf(sk);
    return s.live ? { ...base, ...s.live.points } : base;
  }, [sk, s.live]);
  const radii = s.live?.radii ?? {};

  // ---------------- pointer and keyboard handling ----------------

  const state = useRef({ sk, s, draft, typed, P, proj, cursor });
  state.current = { sk, s, draft, typed, P, proj, cursor };

  const local = (e: { clientX: number; clientY: number }): Px => {
    const r = root.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const hitTest = useCallback((px: Px): string | null => {
    const { sk, P, proj } = state.current;
    if (!sk || !proj) return null;
    let best: { d: number; id: string } | null = null;
    for (const p of sk.points) {
      if (HIDDEN_POINTS.has(p.id)) continue;
      const d = pxDist(proj.S(P[p.id]), px);
      if (d < 9 && (!best || d < best.d)) best = { d, id: p.id };
    }
    if (best) return best.id;
    for (const c of sk.curves) {
      const pts = curvePoints(sk, c, P, state.current.s.live?.radii).map(proj.S);
      for (let i = 0; i + 1 < pts.length; i++) {
        const d = segDist(px, pts[i], pts[i + 1]);
        if (d < 7 && (!best || d < best.d)) best = { d, id: c.id };
      }
    }
    return best?.id ?? null;
  }, []);

  useEffect(() => {
    if (!s.active) return;
    const host = root.current?.parentElement;
    if (!host) return;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (t.closest(".sk-ui, .vp-toolbar, .vp-float, input, button")) return;
      e.stopPropagation();
      e.preventDefault();
      host.setPointerCapture?.(e.pointerId);
      pointerDown(e);
    };
    const onMove = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest?.(".sk-ui")) return;
      pointerMove(e);
    };
    const onUp = (e: PointerEvent) => {
      if (e.button !== 0) return;
      pointerUp(e);
    };
    const onDbl = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest(".sk-ui, .vp-toolbar, .vp-float")) return;
      e.stopPropagation();
      const { draft } = state.current;
      if (draft?.t === "line") setDraft(null);
    };
    host.addEventListener("pointerdown", onDown, true);
    host.addEventListener("pointermove", onMove, true);
    host.addEventListener("pointerup", onUp, true);
    host.addEventListener("dblclick", onDbl, true);
    const onLeave = () => setCursor(null);
    host.addEventListener("pointerleave", onLeave);
    return () => {
      host.removeEventListener("pointerleave", onLeave);
      host.removeEventListener("pointerdown", onDown, true);
      host.removeEventListener("pointermove", onMove, true);
      host.removeEventListener("pointerup", onUp, true);
      host.removeEventListener("dblclick", onDbl, true);
    };
    // handlers read the latest state through `state`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.active]);

  useEffect(() => {
    if (!s.active) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable || el.closest?.(".cm-editor"))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (keyDown(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.active]);

  function sketchAt(px: Px): V2 | null {
    return state.current.proj?.toSketch(px.x, px.y) ?? null;
  }

  function snapFor(px: Px, opts: { exclude?: Set<string>; from?: V2 } = {}): Snap | null {
    const { sk, P, proj } = state.current;
    if (!sk || !proj) return null;
    const raw = sketchAt(px);
    if (!raw) return null;
    return snapAt(sk, P, proj, px, raw, opts);
  }

  function pointerDown(e: PointerEvent) {
    const { sk, s, draft } = state.current;
    if (!sk) return;
    const px = local(e);
    const tool = s.tool;
    const dimEl = (e.target as HTMLElement).closest?.("[data-dim]") as HTMLElement | null;
    const conEl = (e.target as HTMLElement).closest?.("[data-con]") as HTMLElement | null;
    if (tool === "select" || (tool === "dimension" && dimEl)) {
      if (dimEl) {
        const index = Number(dimEl.dataset.dim);
        const c = sk.constraints.find((q) => q.index === index);
        if (!c) return;
        const literal = /^-?\d+(\.\d+)?$/.test((c.valueText ?? "").trim());
        if (literal) {
          const scale = state.current.proj!.scale();
          setDraft({ t: "scrub", index, fromX: px.x, start: c.value ?? 0, moved: false, step: c.kind === "angle" ? 0.5 : niceStep(scale * 1.5), angle: c.kind === "angle" });
        } else useSketch.setState({ editDim: index });
        setSelection([`#${index}`]);
        return;
      }
      if (conEl) {
        const id = `#${conEl.dataset.con}`;
        setSelection(e.shiftKey ? toggle(s.selection, id) : [id]);
        return;
      }
      const hit = hitTest(px);
      if (hit) {
        const sel = e.shiftKey ? toggle(s.selection, hit) : s.selection.includes(hit) ? s.selection : [hit];
        setSelection(sel);
        const raw = sketchAt(px);
        if (!raw) return;
        const curve = sk.curves.find((c) => c.id === hit);
        if (curve?.kind === "circle") setDraft({ t: "drag", ids: [], circle: curve.id, from: raw, base: state.current.P, moved: false });
        else setDraft({ t: "drag", ids: curve ? [...new Set(curve.pts)] : [hit], from: raw, base: state.current.P, moved: false });
        return;
      }
      setDraft({ t: "box", from: px, to: px, additive: e.shiftKey });
      return;
    }
    if (tool === "dimension") {
      const hit = hitTest(px);
      if (draft?.t === "dim") {
        placeDimension(hit ? [draft.first, hit] : [draft.first]);
        setDraft(null);
      } else if (hit) {
        setDraft({ t: "dim", first: hit });
        setSelection([hit]);
      }
      return;
    }
    const snap = draftSnap(px);
    if (!snap) return;
    switch (tool) {
      case "point":
        addPoint(snap);
        return;
      case "line":
        if (draft?.t === "line") finishLine(draft.start, snap);
        else setDraft({ t: "line", start: snap });
        return;
      case "rect":
        if (draft?.t === "rect") {
          addRect(draft.a, snap);
          setDraft(null);
        } else setDraft({ t: "rect", a: snap });
        return;
      case "circle":
        if (draft?.t === "circle") {
          addCircle(draft.c, dist(draft.c.p, snap.p));
          setDraft(null);
        } else setDraft({ t: "circle", c: snap });
        return;
      case "arc":
        if (draft?.t === "arc" && draft.b) {
          addArc(draft.a, draft.b, snap.p);
          setDraft(null);
        } else if (draft?.t === "arc") setDraft({ ...draft, b: snap });
        else setDraft({ t: "arc", a: snap });
        return;
      case "slot":
        if (draft?.t === "slot" && draft.b) {
          addSlot(draft.a, draft.b, snap.p);
          setDraft(null);
        } else if (draft?.t === "slot") setDraft({ ...draft, b: snap });
        else setDraft({ t: "slot", a: snap });
        return;
    }
  }

  /** Snap for drawing tools, with horizontal/vertical inference for lines. */
  function draftSnap(px: Px): Snap | null {
    const { draft } = state.current;
    const from = draft?.t === "line" ? draft.start.p : draft?.t === "rect" ? draft.a.p : undefined;
    const snap = snapFor(px, { from });
    if (!snap) return null;
    return snap;
  }

  let moveRaf = 0;
  function pointerMove(e: PointerEvent) {
    const px = local(e);
    const { draft, sk, s } = state.current;
    if (!sk) return;
    if (draft?.t === "box") {
      setDraft({ ...draft, to: px });
      return;
    }
    if (draft?.t === "scrub") {
      const dx = px.x - draft.fromX;
      if (!draft.moved && Math.abs(dx) < 3) return;
      const v = roundTo(draft.start + dx * (draft.angle ? 0.5 : draft.step / 1.5) * 0.5, draft.step);
      const c = sk.constraints.find((q) => q.index === draft.index);
      if (!c) return;
      if (!draft.moved) setDraft({ ...draft, moved: true });
      cancelAnimationFrame(moveRaf);
      moveRaf = requestAnimationFrame(() => {
        const cur = activeSketch();
        const cc = cur?.constraints.find((q) => q.index === draft.index);
        if (!cc || (cc.kind !== "angle" && v <= 0)) return;
        editSketch((src) => setConstraintValue(src, cc, v), `${cc.kind} = ${fmt(v)}`, { live: true });
      });
      return;
    }
    if (draft?.t === "drag") {
      const raw = sketchAt(px);
      if (!raw) return;
      if (!draft.moved && pxDist(state.current.proj!.S(raw), state.current.proj!.S(draft.from)) < 3) return;
      if (!draft.moved) setDraft({ ...draft, moved: true });
      // the grabbed point lands on round numbers for the zoom level, so moved coordinates stay tidy
      const step = niceStep(state.current.proj!.scale(raw));
      const anchor = draft.ids.length ? draft.base[draft.ids[0]] : undefined;
      const want = add(anchor ?? draft.from, sub(raw, draft.from));
      const d = anchor ? sub([roundTo(want[0], step), roundTo(want[1], step)], anchor) : sub(raw, draft.from);
      useSketch.setState({ live: dragSolve(sk, draft, d, raw, step) });
      return;
    }
    const hover = s.tool === "select" || s.tool === "dimension" ? hitTest(px) : null;
    if (hover !== s.hover) useSketch.setState({ hover });
    const snap = s.tool === "select" ? null : draftSnap(px);
    setCursor({ px, snap });
  }

  function pointerUp(e: PointerEvent) {
    const { draft, sk } = state.current;
    if (!sk || !draft) return;
    if (draft.t === "box") {
      const sel = boxSelect(sk, state.current.P, state.current.proj!, draft.from, draft.to);
      const moved = pxDist(draft.from, draft.to) > 4;
      setSelection(moved ? (draft.additive ? [...new Set([...state.current.s.selection, ...sel])] : sel) : draft.additive ? state.current.s.selection : []);
      setDraft(null);
      return;
    }
    if (draft.t === "scrub") {
      setDraft(null);
      if (!draft.moved) useSketch.setState({ editDim: draft.index });
      else {
        // record the scrub as one version
        commitSource(useDesign.getState().source, "you", `Sketch ${sk.name}: changed a dimension`);
      }
      return;
    }
    if (draft.t === "drag") {
      setDraft(null);
      const live = useSketch.getState().live;
      if (draft.moved && live) {
        const ids = draft.circle ? [draft.circle] : draft.ids;
        const stuck = draft.ids.filter((id) => sk.points.find((p) => p.id === id && !p.literal && p.coordSpan));
        editSketch((src, cur) => writePositions(src, cur, live.points, live.radii), `moved ${ids.join(", ")}`);
        if (stuck.length) flash(`${stuck.join(", ")} is placed by a formula; change the formula or its parameters to move it.`);
        else if (!live.ok) flash("That position does not fit the constraints; the nearest fit was kept.");
      } else if (!draft.moved && draft.ids.length === 1) {
        const p = sk.points.find((q) => q.id === draft.ids[0]);
        if (p && (p.status === "defined" || p.status === "fixed")) flash(`${p.id} is fully defined. Change a dimension to move it.`);
      }
      useSketch.setState({ live: null });
      void e;
    }
  }

  // ---------------- creating geometry ----------------

  const consPrefix = () => (useSketch.getState().construction ? "construction " : "");
  const arg = (sn: Snap) => sn.ref ?? fmtPt(sn.p);
  const extras = (sn: Snap, name: string): string[] => (sn.ref ? [] : sn.on ? [`coincident ${name}, ${sn.on}`] : sn.mid ? [`midpoint ${name}, ${sn.mid}`] : []);

  function hv(a: V2, b: V2): "h" | "v" | null {
    const d = sub(b, a);
    const ang = Math.abs(Math.atan2(d[1], d[0]) * (180 / Math.PI));
    if (len(d) < 1e-9) return null;
    if (ang < 3 || ang > 177) return "h";
    if (Math.abs(ang - 90) < 3) return "v";
    return null;
  }

  function lineEnd(start: Snap, end: Snap, typedLen?: number): { end: Snap; hv: "h" | "v" | null } {
    let e = end;
    let k = !end.ref ? hv(start.p, end.p) : null;
    if (k === "h") e = { ...e, p: [e.p[0], start.p[1]] };
    if (k === "v") e = { ...e, p: [start.p[0], e.p[1]] };
    if (typedLen && typedLen > 0) {
      const d = sub(e.p, start.p);
      const l = len(d) || 1;
      e = { p: add(start.p, mul(d, typedLen / l)), guides: [] };
      k = hv(start.p, e.p);
    }
    return { end: e, hv: k };
  }

  function finishLine(start: Snap, endIn: Snap, typedLen?: number) {
    const cur = activeSketch();
    if (!cur) return;
    const { end, hv: k } = lineEnd(start, endIn, typedLen);
    if (dist(start.p, end.p) < 1e-6) return;
    const taken = takenNames(cur);
    const n = nextName(taken, "l");
    const cons = [...extras(start, `${n}.start`), ...extras(end, `${n}.end`)];
    if (k === "h") cons.push(`horizontal ${n}`);
    if (k === "v") cons.push(`vertical ${n}`);
    if (typedLen) cons.push(`length ${n} = ${fmt(typedLen)}`);
    editSketch((src, s2) => addStatements(src, s2, { geometry: [`${consPrefix()}line ${n} = ${arg(start)} -> ${arg(end)}`], constraints: cons }), `added line ${n}`);
    // keep drawing from the new end unless the line closed onto existing geometry
    if (end.ref && end.ref !== start.ref) setDraft(null);
    else setDraft({ t: "line", start: { p: end.p, ref: `${n}.end`, guides: [] } });
  }

  function addPoint(sn: Snap) {
    const cur = activeSketch();
    if (!cur || sn.ref) return;
    const n = nextName(takenNames(cur), "p");
    editSketch((src, s2) => addStatements(src, s2, { geometry: [`point ${n} = ${fmtPt(sn.p)}`], constraints: extras(sn, n) }), `added point ${n}`);
  }

  function addRect(a: Snap, c: Snap, size?: [number, number]) {
    const cur = activeSketch();
    if (!cur) return;
    let C = c;
    if (size) C = { p: [a.p[0] + size[0] * Math.sign(c.p[0] - a.p[0] || 1), a.p[1] + size[1] * Math.sign(c.p[1] - a.p[1] || 1)], guides: [] };
    if (Math.abs(C.p[0] - a.p[0]) < 1e-6 || Math.abs(C.p[1] - a.p[1]) < 1e-6) return;
    const taken = takenNames(cur);
    const [l1, l2, l3, l4] = [nextName(taken, "l"), nextName(taken, "l"), nextName(taken, "l"), nextName(taken, "l")];
    const cp = consPrefix();
    const geometry = [
      `${cp}line ${l1} = ${arg(a)} -> ${fmtPt([C.p[0], a.p[1]])}`,
      `${cp}line ${l2} = ${l1}.end -> ${arg(C)}`,
      `${cp}line ${l3} = ${l2}.end -> ${fmtPt([a.p[0], C.p[1]])}`,
      `${cp}line ${l4} = ${l3}.end -> ${l1}.start`,
    ];
    const cons = [`horizontal ${l1}, ${l3}`, `vertical ${l2}, ${l4}`, ...extras(a, `${l1}.start`), ...extras(C, `${l2}.end`)];
    if (size) cons.push(`length ${l1} = ${fmt(size[0])}`, `length ${l2} = ${fmt(size[1])}`);
    editSketch((src, s2) => addStatements(src, s2, { geometry, constraints: cons }), `added rectangle ${l1}–${l4}`);
  }

  function addCircle(c: Snap, r: number, exact?: number) {
    const cur = activeSketch();
    const scale = state.current.proj?.scale(c.p) ?? 1;
    const rr = exact ? exact / 2 : roundTo(r, niceStep(scale));
    if (!cur || !(rr > 0)) return;
    const n = nextName(takenNames(cur), "c");
    const cons = extras(c, `${n}.center`);
    if (exact) cons.push(`diameter ${n} = ${fmt(exact)}`);
    editSketch((src, s2) => addStatements(src, s2, { geometry: [`${consPrefix()}circle ${n} = ${arg(c)}, d: ${fmt(2 * rr)}`], constraints: cons }), `added circle ${n}`);
  }

  function addArc(a: Snap, b: Snap, m: V2) {
    const cur = activeSketch();
    if (!cur) return;
    const ctr = circleThrough(a.p, b.p, m);
    if (!ctr) return flash("Those three points are in a line; move the last one off the line to make an arc.");
    const ccw = ccwThrough(ctr, a.p, b.p, m);
    const [s1, s2] = ccw ? [a, b] : [b, a];
    const n = nextName(takenNames(cur), "a");
    const cons = [...extras(s1, `${n}.start`), ...extras(s2, `${n}.end`)];
    // tangent to a line it starts from, when drawn that way
    for (const sn of [a, b]) {
      if (!sn.ref) continue;
      const line = cur.curves.find((c) => c.kind === "line" && c.pts.includes(sn.ref!));
      if (!line) continue;
      const P = state.current.P;
      const d = sub(P[line.pts[1]], P[line.pts[0]]);
      const rv = sub(sn.p, ctr);
      const c = Math.abs(d[0] * rv[0] + d[1] * rv[1]) / ((len(d) || 1) * (len(rv) || 1));
      if (c < Math.sin((6 * Math.PI) / 180)) cons.push(`tangent ${line.id}, ${n}`);
    }
    editSketch((src, sk2) => addStatements(src, sk2, { geometry: [`${consPrefix()}arc ${n} = ${arg(s1)} -> ${arg(s2)}, center: ${fmtPt(ctr)}`], constraints: cons }), `added arc ${n}`);
  }

  function addSlot(a: Snap, b: Snap, m: V2) {
    const cur = activeSketch();
    if (!cur) return;
    const d0 = sub(b.p, a.p);
    const L = len(d0);
    if (L < 1e-6) return;
    const d: V2 = [d0[0] / L, d0[1] / L];
    const nrm: V2 = [-d[1], d[0]];
    const scale = state.current.proj?.scale(a.p) ?? 1;
    const r = Math.max(roundTo(Math.abs((m[0] - a.p[0]) * nrm[0] + (m[1] - a.p[1]) * nrm[1]), niceStep(scale)), niceStep(scale));
    const taken = takenNames(cur);
    const [l1, a1, l2, a2] = [nextName(taken, "l"), nextName(taken, "a"), nextName(taken, "l"), nextName(taken, "a")];
    const cp = consPrefix();
    const at = (c: V2, k: number): V2 => add(c, mul(nrm, k * r));
    const geometry = [
      `${cp}line ${l1} = ${fmtPt(at(a.p, -1))} -> ${fmtPt(at(b.p, -1))}`,
      `${cp}arc ${a1} = ${l1}.end -> ${fmtPt(at(b.p, 1))}, center: ${arg(b)}`,
      `${cp}line ${l2} = ${a1}.end -> ${fmtPt(at(a.p, 1))}`,
      `${cp}arc ${a2} = ${l2}.end -> ${l1}.start, center: ${arg(a)}`,
    ];
    const cons = [`tangent ${l1}, ${a1}`, `tangent ${a1}, ${l2}`, `tangent ${l2}, ${a2}`, `tangent ${a2}, ${l1}`, `equal ${a1}, ${a2}`, ...extras(a, `${a2}.center`), ...extras(b, `${a1}.center`)];
    const way = hv(a.p, b.p);
    if (way) cons.push(`${way === "h" ? "horizontal" : "vertical"} ${l1}`);
    editSketch((src, s2) => addStatements(src, s2, { geometry, constraints: cons }), `added slot ${l1}, ${a1}, ${l2}, ${a2}`);
  }

  function placeDimension(ids: string[]) {
    const cur = activeSketch();
    if (!cur) return;
    const sug = dimensionFor(cur, ids);
    if (!sug) return flash("Pick a line, circle, arc, or two items to measure between.");
    applySuggestion(sug.stmt, true);
  }

  // ---------------- keyboard ----------------

  function keyDown(e: KeyboardEvent): boolean {
    const { draft, typed, s, sk, cursor } = state.current;
    if (!sk) return false;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    // typed sizes while drawing
    if (draft && ["line", "rect", "circle"].includes(draft.t) && (/^[0-9.]$/.test(key) || (key === "," && draft.t === "rect") || (key === "x" && draft.t === "rect" && typed))) {
      setTyped(typed + (key === "x" ? "," : key));
      return true;
    }
    if (key === "Backspace" && typed) {
      setTyped(typed.slice(0, -1));
      return true;
    }
    if (key === "Enter" && typed && draft) {
      const nums = typed.split(",").map(Number).filter((n) => n > 0);
      const snap = cursor?.snap ?? draft;
      if (draft.t === "line" && nums[0] && cursor?.snap) finishLine(draft.start, cursor.snap, nums[0]);
      if (draft.t === "circle" && nums[0]) {
        addCircle(draft.c, 0, nums[0]);
        setDraft(null);
      }
      if (draft.t === "rect" && nums.length === 2 && cursor?.snap) {
        addRect(draft.a, cursor.snap, [nums[0], nums[1]]);
        setDraft(null);
      }
      void snap;
      setTyped("");
      return true;
    }
    if (key === "Escape") {
      if (s.editDim !== null) useSketch.setState({ editDim: null });
      else if (draft) setDraft(null);
      else if (s.tool !== "select") setTool("select");
      else if (s.selection.length) setSelection([]);
      else exitSketch();
      setTyped("");
      return true;
    }
    if (key === "Enter") {
      if (draft) {
        setDraft(null);
        return true;
      }
      exitSketch();
      return true;
    }
    if (key === "Delete" || key === "Backspace") {
      if (s.selection.length) {
        const sel = s.selection;
        setSelection([]);
        editSketch((src, cur) => deleteSelection(src, cur, sel), `deleted ${sel.map((x) => (x.startsWith("#") ? "a constraint" : x)).join(", ")}`);
      }
      return true;
    }
    // relation shortcuts for the selection, before tool keys
    if (s.selection.length && s.tool === "select") {
      const sug = suggestionsFor(sk, s.selection).find((x) => x.key === key);
      if (sug) {
        applySuggestion(sug.stmt, sug.dimension);
        return true;
      }
    }
    const tools: Record<string, typeof s.tool> = { l: "line", r: "rect", c: "circle", a: "arc", o: "slot", p: "point", d: "dimension", v: "select" };
    if (tools[key]) {
      setTool(tools[key]);
      return true;
    }
    if (key === "g") {
      if (s.selection.length) editSketch((src, cur) => toggleConstruction(src, cur, s.selection), "toggled construction");
      else useSketch.setState({ construction: !s.construction });
      return true;
    }
    if (key === "n") {
      faceSketch(ctl, sk);
      return true;
    }
    return false;
  }

  // ---------------- render ----------------

  if (!sk || !proj) return <div ref={root} className="sk-layer" />;

  const S = proj.S;
  const center = sketchCenter(sk, P);
  const sel = new Set(s.selection);
  const hoverIds = new Set<string>();
  if (s.hover) hoverIds.add(s.hover);
  if (hoverDim !== null) for (const id of sk.constraints.find((c) => c.index === hoverDim)?.ids ?? []) hoverIds.add(id);
  for (const id of s.selection) if (id.startsWith("#")) for (const x of sk.constraints.find((c) => `#${c.index}` === id)?.ids ?? []) hoverIds.add(x);
  const conflictIds = new Set(sk.profile.error?.refs ?? []);

  const path = (pts: Px[]) => pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("");
  const fills = liveFills(sk, P, s.live);
  const dims = layoutDims(sk, P, radii, proj, center);
  const glyphs = layoutGlyphs(sk, P, proj, center);
  const W = root.current?.clientWidth ?? 800;
  const H = root.current?.clientHeight ?? 600;

  return (
    <div ref={root} className={`sk-layer on tool-${s.tool}`}>
      <svg className="sk-svg" width="100%" height="100%">
        <defs>
          <marker id="sk-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,1 L10,5 L0,9 z" fill="currentColor" />
          </marker>
        </defs>
        <SketchGrid proj={proj} w={W} h={H} />
        {/* profile fill */}
        {fills.map((f, i) => (
          <path key={i} className="sk-fill" d={[f.outer, ...f.holes].map((loop) => path(loop.map(S)) + "Z").join("")} fillRule="evenodd" />
        ))}
        {/* curves */}
        {sk.curves.map((c) => {
          const pts = curvePoints(sk, c, P, radii).map(S);
          const cls = ["sk-curve", `st-${c.status}`, c.external ? "external" : c.construction ? "construction" : "", sel.has(c.id) ? "selected" : "", hoverIds.has(c.id) ? "hover" : "", conflictIds.has(c.id) ? "problem" : ""].join(" ");
          return <path key={c.id} className={cls} d={path(pts)} />;
        })}
        {/* rounded corners from fillet / chamfer statements */}
        {sk.profile.corners.map((k, i) => {
          const seg = k.seg;
          const pts = seg.k === "a" ? arcPoints(circleThrough(seg.a, seg.b, seg.m) ?? seg.m, ...(ccwThrough(circleThrough(seg.a, seg.b, seg.m) ?? seg.m, seg.a, seg.b, seg.m) ? [seg.a, seg.b] : [seg.b, seg.a]) as [V2, V2]) : seg.k === "l" ? [seg.a, seg.b] : [];
          return <path key={`k${i}`} className="sk-corner" d={path(pts.map(S))} />;
        })}
        {/* points */}
        {sk.points.map((p) => {
          if (HIDDEN_POINTS.has(p.id)) return null;
          const q = S(P[p.id]);
          const cls = ["sk-point", `st-${p.status}`, p.id === "origin" ? "origin" : "", p.external ? "external" : "", sel.has(p.id) ? "selected" : "", hoverIds.has(p.id) ? "hover" : "", conflictIds.has(p.id) ? "problem" : ""].join(" ");
          const fr = p.freedom;
          return (
            <g key={p.id} className={cls} transform={`translate(${q.x.toFixed(1)},${q.y.toFixed(1)})`}>
              {fr.kind === "line" && !s.live && <FreeArrow dir={screenDir(proj, P[p.id], fr.dir)} />}
              {p.fixed || p.id === "origin" ? <rect x={-3.5} y={-3.5} width={7} height={7} /> : <circle r={p.status === "free" ? 3.6 : 3.2} />}
            </g>
          );
        })}
        {/* relations */}
        {glyphs.map((g, i) => (
          <g key={`g${i}`} className={`sk-glyph st-${g.status} ${sel.has(`#${g.index}`) ? "selected" : ""}`} transform={`translate(${g.at.x.toFixed(1)},${g.at.y.toFixed(1)})`} data-con={g.index} onPointerEnter={() => setHoverDim(g.index)} onPointerLeave={() => setHoverDim(null)}>
            <rect x={-7} y={-7} width={14} height={14} rx={4} />
            <text y={0.5}>{g.text}</text>
          </g>
        ))}
        {/* dimensions */}
        {dims.map((d) => (
          <Dim key={`d${d.index}`} d={d} selected={sel.has(`#${d.index}`)} editing={s.editDim === d.index} onHover={(on) => setHoverDim(on ? d.index : null)} />
        ))}
        {/* drafting preview */}
        <DraftPreview draft={draft} cursor={cursor} typed={typed} proj={proj} sk={sk} lineEnd={lineEnd} />
      </svg>
      {s.editDim !== null && <DimEditor sk={sk} index={s.editDim} dims={dims} />}
      {draft?.t === "box" && <div className="sk-box" style={{ left: Math.min(draft.from.x, draft.to.x), top: Math.min(draft.from.y, draft.to.y), width: Math.abs(draft.to.x - draft.from.x), height: Math.abs(draft.to.y - draft.from.y) }} />}
    </div>
  );

  function applySuggestion(stmt: string, dimension: boolean) {
    const cur = activeSketch();
    if (!cur) return;
    const before = cur.constraints.length;
    const next = editSketch((src, s2) => addStatements(src, s2, { constraints: [stmt] }), `added ${stmt}`);
    if (dimension && next) {
      const c = next.constraints.filter((q) => q.index >= before).pop();
      if (c) useSketch.setState({ editDim: c.index, selection: [`#${c.index}`] });
    }
  }
}

// ---------------- pieces ----------------

function Dim({ d, selected, editing, onHover }: { d: DimGfx; selected: boolean; editing: boolean; onHover: (on: boolean) => void }) {
  const path = (pts: Px[]) => pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("");
  const w = labelWidth(d.text);
  return (
    <g className={`sk-dim st-${d.status} ${d.driven ? "driven" : ""} ${selected ? "selected" : ""}`}>
      {d.lines.map((l, i) => (
        <path key={i} d={path(l)} />
      ))}
      {d.dashed.map((l, i) => (
        <path key={`x${i}`} className="dash" d={path(l)} />
      ))}
      {d.arrows.map((a, i) => (
        <path key={`a${i}`} className="arrow" d={arrowPath(a.at, a.dir)} />
      ))}
      {!editing && (
        <g className="sk-dim-label" data-dim={d.index} transform={`translate(${d.label.x.toFixed(1)},${d.label.y.toFixed(1)})`} onPointerEnter={() => onHover(true)} onPointerLeave={() => onHover(false)}>
          <rect x={-w / 2} y={-9} width={w} height={18} rx={5} />
          <text y={0.5}>{d.text}</text>
        </g>
      )}
    </g>
  );
}

function arrowPath(at: Px, dir: Px) {
  const l = 8;
  const w = 3.2;
  const bx = at.x - dir.x * l;
  const by = at.y - dir.y * l;
  return `M${at.x.toFixed(1)},${at.y.toFixed(1)}L${(bx - dir.y * w).toFixed(1)},${(by + dir.x * w).toFixed(1)}L${(bx + dir.y * w).toFixed(1)},${(by - dir.x * w).toFixed(1)}Z`;
}

function DimEditor({ sk, index, dims }: { sk: EvalSketch; index: number; dims: DimGfx[] }) {
  const c = sk.constraints.find((q) => q.index === index);
  const d = dims.find((q) => q.index === index);
  const [text, setText] = useState(c?.valueText?.trim() ?? "");
  const [err, setErr] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  if (!c || !d) return null;
  const commit = () => {
    const t = text.trim();
    if (!t) return;
    const { source, model } = useDesign.getState();
    const next = setConstraintValue(source, c, t);
    const before = model?.diagnostics.filter((x) => x.severity === "error").length ?? 0;
    const m = evaluate(next);
    const after = m.diagnostics.filter((x) => x.severity === "error");
    if (after.length > before) {
      setErr(after[after.length - 1].message);
      return;
    }
    editSketch((src, cur) => setConstraintValue(src, cur.constraints.find((q) => q.index === index) ?? c, t), `${c.kind} = ${t}`);
    useSketch.setState({ editDim: null });
  };
  return (
    <div className="sk-ui sk-dim-edit" style={{ left: d.label.x, top: d.label.y }}>
      <input
        ref={ref}
        className="input mono"
        value={text}
        spellCheck={false}
        aria-label={`${c.kind} value`}
        onChange={(e) => {
          setText(e.target.value);
          setErr("");
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") commit();
          if (e.key === "Escape") useSketch.setState({ editDim: null });
        }}
        onBlur={() => useSketch.setState({ editDim: null })}
      />
      <div className={`sk-dim-hint ${err ? "err" : ""}`}>{err || "a number, or a formula like w / 2"}</div>
    </div>
  );
}

function FreeArrow({ dir }: { dir: Px }) {
  const l = 11;
  const a = { x: dir.x * l, y: dir.y * l };
  return (
    <g className="sk-free-arrow">
      <path d={`M${-a.x},${-a.y}L${a.x},${a.y}`} />
      <path d={arrowPath(a, dir)} />
      <path d={arrowPath({ x: -a.x, y: -a.y }, { x: -dir.x, y: -dir.y })} />
    </g>
  );
}

function DraftPreview({ draft, cursor, typed, proj, sk, lineEnd }: { draft: Draft | null; cursor: { px: Px; snap: Snap | null } | null; typed: string; proj: Projector; sk: EvalSketch; lineEnd: (a: Snap, b: Snap) => { end: Snap; hv: "h" | "v" | null } }) {
  const S = proj.S;
  const snap = cursor?.snap;
  const path = (pts: V2[]) => pts.map((p, i) => `${i ? "L" : "M"}${S(p).x.toFixed(1)},${S(p).y.toFixed(1)}`).join("");
  const out: JSX.Element[] = [];
  let readout = "";
  if (snap) {
    for (const [i, g] of snap.guides.entries()) out.push(<path key={`gd${i}`} className="sk-guide" d={path(g)} />);
    if (draft?.t === "line") {
      const { end, hv } = lineEnd(draft.start, snap);
      out.push(<path key="pl" className="sk-draft" d={path([draft.start.p, end.p])} />);
      const L = dist(draft.start.p, end.p);
      const ang = (Math.atan2(end.p[1] - draft.start.p[1], end.p[0] - draft.start.p[0]) * 180) / Math.PI;
      readout = `${typed ? `length ${typed}▌` : fmt(L)}${hv ? (hv === "h" ? "  H" : "  V") : `  ${fmt(ang)}°`}`;
    } else if (draft?.t === "rect") {
      const a = draft.a.p;
      const c = snap.p;
      out.push(<path key="pr" className="sk-draft" d={path([a, [c[0], a[1]], c, [a[0], c[1]], a])} />);
      readout = typed ? `size ${typed}▌` : `${fmt(Math.abs(c[0] - a[0]))} × ${fmt(Math.abs(c[1] - a[1]))}`;
    } else if (draft?.t === "circle") {
      const r = dist(draft.c.p, snap.p);
      out.push(<path key="pc" className="sk-draft" d={path(circlePoints(draft.c.p, r))} />);
      readout = typed ? `⌀ ${typed}▌` : `⌀${fmt(2 * r)}`;
    } else if (draft?.t === "arc") {
      if (!draft.b) out.push(<path key="pa" className="sk-draft dash" d={path([draft.a.p, snap.p])} />);
      else {
        const ctr = circleThrough(draft.a.p, draft.b.p, snap.p);
        if (ctr) {
          const ccw = ccwThrough(ctr, draft.a.p, draft.b.p, snap.p);
          out.push(<path key="pa" className="sk-draft" d={path(ccw ? arcPoints(ctr, draft.a.p, draft.b.p) : arcPoints(ctr, draft.b.p, draft.a.p))} />);
          readout = `R${fmt(dist(ctr, draft.a.p))}`;
        }
      }
    } else if (draft?.t === "slot") {
      if (!draft.b) out.push(<path key="ps" className="sk-draft dash" d={path([draft.a.p, snap.p])} />);
      else {
        const d0 = sub(draft.b.p, draft.a.p);
        const L = len(d0) || 1;
        const nrm: V2 = [-d0[1] / L, d0[0] / L];
        const r = Math.abs((snap.p[0] - draft.a.p[0]) * nrm[0] + (snap.p[1] - draft.a.p[1]) * nrm[1]);
        const A1 = add(draft.a.p, mul(nrm, -r));
        const B1 = add(draft.b.p, mul(nrm, -r));
        const B2 = add(draft.b.p, mul(nrm, r));
        const A2 = add(draft.a.p, mul(nrm, r));
        out.push(<path key="ps" className="sk-draft" d={path([A1, B1, ...arcPoints(draft.b.p, B1, B2), A2, ...arcPoints(draft.a.p, A2, A1)])} />);
        readout = `width ${fmt(2 * r)}`;
      }
    }
    const q = S(snap.p);
    out.push(<circle key="snap" className={`sk-snap ${snap.ref || snap.on || snap.mid ? "hit" : ""}`} cx={q.x} cy={q.y} r={snap.ref ? 6 : 3.5} />);
    const label = [snap.label, readout].filter(Boolean).join(" · ");
    if (label)
      out.push(
        <g key="ro" className="sk-readout" transform={`translate(${(cursor!.px.x + 16).toFixed(1)},${(cursor!.px.y + 22).toFixed(1)})`}>
          <rect x={0} y={-10} width={label.length * 6.6 + 14} height={19} rx={5} />
          <text x={7} y={0.5}>
            {label}
          </text>
        </g>,
      );
  }
  if (draft?.t === "dim") {
    const c = sk.curves.find((x) => x.id === draft.first);
    void c;
  }
  return <g className="sk-drafting">{out}</g>;
}

function SketchGrid({ proj, w, h }: { proj: Projector; w: number; h: number }) {
  // visible part of the plane: unproject the corners
  const corners = [proj.toSketch(0, 0), proj.toSketch(w, 0), proj.toSketch(w, h), proj.toSketch(0, h)].filter(Boolean) as V2[];
  if (corners.length < 4) return null;
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const c0: V2 = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  const scale = proj.scale(c0);
  let step = niceStep(scale) * 5;
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  while (span / step > 120) step *= 2;
  const lines: JSX.Element[] = [];
  const x0 = Math.floor(Math.min(...xs) / step) * step;
  const y0 = Math.floor(Math.min(...ys) / step) * step;
  const S = proj.S;
  for (let x = x0; x <= Math.max(...xs); x += step) {
    const major = Math.abs(roundTo(x / step, 1) % 5) < 1e-9;
    const a = S([x, Math.min(...ys)]);
    const b = S([x, Math.max(...ys)]);
    lines.push(<line key={`x${x}`} className={Math.abs(x) < step / 2 ? "axis-y" : major ? "major" : ""} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />);
  }
  for (let y = y0; y <= Math.max(...ys); y += step) {
    const major = Math.abs(roundTo(y / step, 1) % 5) < 1e-9;
    const a = S([Math.min(...xs), y]);
    const b = S([Math.max(...xs), y]);
    lines.push(<line key={`y${y}`} className={Math.abs(y) < step / 2 ? "axis-x" : major ? "major" : ""} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />);
  }
  return <g className="sk-grid">{lines}</g>;
}

// ---------------- helpers ----------------

function toggle(list: string[], id: string) {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

function segDist(p: Px, a: Px, b: Px) {
  const { q } = closestOnSeg([p.x, p.y], [a.x, a.y], [b.x, b.y]);
  return Math.hypot(q[0] - p.x, q[1] - p.y);
}

function screenDir(proj: Projector, at: V2, d: V2): Px {
  const a = proj.S(at);
  const b = proj.S(add(at, mul(d, 1 / proj.scale(at))));
  const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
}

export function sketchCenter(sk: EvalSketch, P: Positions): V2 {
  const pts = sk.points.filter((p) => !HIDDEN_POINTS.has(p.id) && p.id !== "origin").map((p) => P[p.id]);
  if (!pts.length) return [0, 0];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

export function faceSketch(ctl: SceneController, sk: EvalSketch) {
  const P = positionsOf(sk);
  const drawn = sk.points.filter((p) => !HIDDEN_POINTS.has(p.id) && p.id !== "origin");
  if (!drawn.length) {
    // nothing drawn yet: show the plane with the model around it for reference
    const f = sk.frame;
    ctl.viewPlane(f.n, f.v, f.o, Math.max(30, Math.min(ctl.modelRadius() * 0.9, 400)));
    return;
  }
  const pts = sk.points.filter((p) => !HIDDEN_POINTS.has(p.id)).map((p) => P[p.id]);
  for (const c of sk.curves) if (c.kind === "circle") {
    const ctr = P[c.pts[0]];
    pts.push([ctr[0] - c.r!, ctr[1] - c.r!], [ctr[0] + c.r!, ctr[1] + c.r!]);
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const c: V2 = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  // fill a bit over half the view, leaving room around it for dimensions and the panels
  const r = Math.max(20, (Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2) * 1.5);
  const f = sk.frame;
  const w: [number, number, number] = [f.o[0] + f.u[0] * c[0] + f.v[0] * c[1], f.o[1] + f.u[1] * c[0] + f.v[1] * c[1], f.o[2] + f.u[2] * c[0] + f.v[2] * c[1]];
  ctl.viewPlane(f.n, f.v, w, r);
}

function dragSolve(sk: EvalSketch, draft: Extract<Draft, { t: "drag" }>, d: V2, raw: V2, step: number): LiveSolve {
  const base = draft.base;
  const moved = new Set(draft.ids);
  const def = {
    ...sk.def,
    points: sk.def.points.map((p) => {
      const b = base[p.id] ?? [p.x, p.y];
      const q = moved.has(p.id) ? add(b, d) : b;
      return { ...p, x: q[0], y: q[1] };
    }),
    circles: sk.def.circles.map((c) => (c.id === draft.circle ? { ...c, r: Math.max(step, roundTo(dist(raw, base[sk.curves.find((q) => q.id === c.id)!.pts[0]]), step)) } : { ...c, r: sk.curves.find((q) => q.id === c.id)?.r ?? c.r })),
  };
  const res = solveSketch(def, { heavy: draft.circle ? [draft.circle] : draft.ids, analyse: false, maxIter: 40 });
  return { points: res.points, radii: res.radii, ok: res.ok };
}

function liveFills(sk: EvalSketch, P: Positions, live: LiveSolve | null): { outer: V2[]; holes: V2[][] }[] {
  if (!live) return sk.profile.fills;
  const solid = sk.curves.filter((c) => !c.construction);
  const corners = sk.profile.corners.map((k) => {
    const c = sk.constraints.find((q) => q.index === k.src);
    return { at: k.at, r: c?.value ?? 1, kind: (c?.kind === "chamfer" ? "chamfer" : "fillet") as "fillet" | "chamfer", src: k.src };
  });
  const pr = buildProfile(
    P,
    solid.filter((c) => c.kind === "line").map((c) => ({ id: c.id, a: c.pts[0], b: c.pts[1] })),
    solid.filter((c) => c.kind === "arc").map((c) => ({ id: c.id, a: c.pts[0], b: c.pts[1], c: c.pts[2] })),
    solid.filter((c) => c.kind === "circle").map((c) => ({ id: c.id, c: c.pts[0], r: live.radii[c.id] ?? c.r! })),
    corners,
  );
  return pr.fills;
}

function boxSelect(sk: EvalSketch, P: Positions, proj: Projector, a: Px, b: Px): string[] {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  const inside = (p: V2) => {
    const q = proj.S(p);
    return q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1;
  };
  const out: string[] = [];
  for (const c of sk.curves) if (curvePoints(sk, c, P).every(inside)) out.push(c.id);
  for (const p of sk.points) if (!HIDDEN_POINTS.has(p.id) && p.id !== "origin" && !p.implicit && inside(P[p.id])) out.push(p.id);
  return out;
}

export type { SkConstraint };
export { consId, radiusOf };
