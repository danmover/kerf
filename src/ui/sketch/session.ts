// Sketch editing session: which sketch is open, the active tool, the
// selection and live drag positions. Every change to the sketch itself is
// a source edit committed through the project history (one undo stack for
// chat, code, panels and the sketch editor).

import { create } from "zustand";
import { commitSource } from "../../app/project";
import { setSource, useDesign } from "../../core/engine";
import { evaluate } from "../../lang/evaluator";
import type { V2 } from "../../kernel/recipe";
import { addSketch, writePositions } from "../../sketch/edits";
import type { EvalSketch } from "../../sketch/types";
import { revealSpan } from "../../app/view";

export type SketchTool = "select" | "line" | "rect" | "circle" | "arc" | "slot" | "point" | "dimension";

export interface LiveSolve {
  points: Record<string, V2>;
  radii: Record<string, number>;
  ok: boolean;
}

interface SketchSession {
  /** name of the sketch being edited */
  active: string | null;
  /** choosing a plane or face for a new sketch */
  picking: boolean;
  tool: SketchTool;
  /** new geometry is construction (reference) geometry */
  construction: boolean;
  /** geometry ids, and constraints as "#index" */
  selection: string[];
  hover: string | null;
  /** solved positions while dragging, before the drag is written to the source */
  live: LiveSolve | null;
  /** constraint index whose value is being typed */
  editDim: number | null;
  /** the extrude / revolve panel */
  feature: boolean;
  /** a short hint shown in the sketch header */
  hint: string;
}

export const useSketch = create<SketchSession>(() => ({
  active: null,
  picking: false,
  tool: "select",
  construction: false,
  selection: [],
  hover: null,
  live: null,
  editDim: null,
  feature: false,
  hint: "",
}));

const set = useSketch.setState;

export function activeSketch(): EvalSketch | null {
  const name = useSketch.getState().active;
  if (!name) return null;
  return useDesign.getState().model?.sketches.find((s) => s.name === name) ?? null;
}

export function enterSketch(name: string) {
  set({ active: name, picking: false, tool: "select", selection: [], hover: null, live: null, editDim: null, feature: false, hint: "" });
  const sk = useDesign.getState().model?.sketches.find((s) => s.name === name);
  if (sk) revealSpan(sk.span);
}

export function exitSketch() {
  set({ active: null, picking: false, tool: "select", selection: [], hover: null, live: null, editDim: null, feature: false, hint: "" });
}

export function startPicking() {
  set({ picking: true, active: null, feature: false });
}

export function setTool(tool: SketchTool) {
  set({ tool, hint: "", editDim: null });
}

export function setSelection(selection: string[]) {
  set({ selection });
  const sk = activeSketch();
  if (!sk || selection.length !== 1) return;
  const id = selection[0];
  const span = id.startsWith("#") ? sk.constraints.find((c) => `#${c.index}` === id)?.span : (sk.curves.find((c) => c.id === id)?.span ?? sk.points.find((p) => p.id === id)?.span);
  if (span) revealSpan(span);
}

export function flash(hint: string) {
  set({ hint });
}

/** Create a sketch on a plane and open it. */
export function createSketch(plane: string, offset?: number, origin?: string) {
  const { source, model } = useDesign.getState();
  const r = addSketch(source, model, { plane, offset, origin });
  commitSource(r.src, "you", `New sketch ${r.name} on ${plane}${offset ? ` + ${offset}` : ""}`);
  enterSketch(r.name);
  set({ tool: "line", hint: "Click to start a line. Type a length while drawing for an exact size." });
}

/**
 * Apply an edit to the open sketch and commit it as one undoable change.
 * When the edited sketch still solves, solved positions are written back to
 * plain-number coordinates so the text matches the drawing. With `live`,
 * the edit is only previewed (no version); the caller commits at the end.
 */
export function editSketch(fn: (src: string, sk: EvalSketch) => string, message: string, opts: { live?: boolean; name?: string } = {}): EvalSketch | null {
  const name = opts.name ?? useSketch.getState().active;
  const { source, model } = useDesign.getState();
  const sk = model?.sketches.find((s) => s.name === name);
  if (!sk || !name) return null;
  let next = fn(source, sk);
  if (next === source) return sk;
  const m2 = evaluate(next);
  const sk2 = m2.sketches.find((s) => s.name === name);
  if (sk2?.solved) next = writePositions(next, sk2);
  const m3 = opts.live ? setSource(next) : commitSource(next, "you", `Sketch ${name}: ${message}`);
  return m3?.sketches.find((s) => s.name === name) ?? null;
}
