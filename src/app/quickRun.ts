// Runs the plain commands of core/quickCommands on the open design: works out
// which part and which spot on it a command means (the spot pointed at, the
// selection, the part it names, or the only part there is), applies it as one
// undoable change, and says what happened. Nothing here calls Claude.

import { evaluateOnly, meshOf, useDesign, whenChecked } from "../core/engine";
import { applyQuick, parseQuick, vocabOf, type QuickCommand, type QuickSpot, type Vec3 } from "../core/quickCommands";
import type { Model } from "../core/model";
import type { Xform } from "../kernel/recipe";
import { materialRecord } from "../library/materialDb";
import { blockPart, withMaterial } from "../materials/apply";
import { adviseFor } from "../materials/context";
import { commitSource, realSource, redo, undo } from "./project";
import type { SpotRef } from "./spot";
import { useView } from "./view";
import { viewport } from "./viewportApi";

export type QuickOutcome =
  | {
      ok: true;
      kind: QuickCommand["k"];
      title: string;
      detail?: string;
      before: string;
      after: string;
      /** the parts the command changed, by block name */
      targets: string[];
      /** resolves to why a changed part no longer builds, once the build has run; null when it builds */
      built: Promise<string | null>;
    }
  | { ok: false; why: string; ai: boolean };

/** The design as it really is (not a preview), with its model. */
function current(): { src: string; model: Model } {
  const src = realSource();
  const s = useDesign.getState();
  return { src, model: src === s.source && s.model ? s.model : evaluateOnly(src) };
}

/** Whether some text is a plain command for this design (without running it). */
export function quickCommandOf(text: string): QuickCommand | null {
  return parseQuick(text, vocabOf(current().model));
}

/**
 * Run a message as a plain command. Returns null when it is not one (it goes
 * to Claude), the result when it ran, or why it could not run, and whether
 * Claude could do it instead.
 */
export function runQuick(text: string, spot?: SpotRef | null): QuickOutcome | null {
  const cmd = parseQuick(text, vocabOf(current().model));
  return cmd ? runQuickCommand(cmd, spot) : null;
}

export function runQuickCommand(cmd: QuickCommand, spot?: SpotRef | null): QuickOutcome {
  const { src, model } = current();
  if (cmd.k === "undo" || cmd.k === "redo") {
    const did = cmd.k === "undo" ? undo() : redo();
    const after = realSource();
    if (!did) return { ok: false, why: cmd.k === "undo" ? "There is nothing to undo." : "There is nothing to redo.", ai: false };
    return { ok: true, kind: cmd.k, title: cmd.k === "undo" ? "Undid the last change" : "Redid the change", before: src, after, targets: [], built: Promise.resolve(null) };
  }
  const spotPart = spot ? model.parts.find((p) => p.id === spot.partId) : undefined;
  const targets = targetsFor(cmd, model, spotPart?.name);
  const qspot = spot && spotPart ? spotFor(spot, spotPart) : undefined;
  const bounds = viewport()?.bounds();
  const box = (block: string) => {
    const p = blockPart(model, block) ?? model.parts.find((q) => q.name === block);
    return p ? boxOf(p.hash) : undefined;
  };

  let next = src;
  let nextModel = model;
  let title = "";
  let detail: string | undefined;
  const changed: string[] = [];
  if (cmd.k === "material") {
    const r = applyMaterial(cmd.material, cmd.target ? [cmd.target] : targets, src, model);
    if (!r.ok) return r;
    next = r.src;
    title = r.title;
    changed.push(...r.targets);
  } else {
    // a command for several selected parts runs on each in turn; a new shape goes on the part pointed at
    const named = "target" in cmd ? cmd.target : undefined;
    const list: (string | undefined)[] = cmd.k === "param" ? [undefined] : cmd.k === "new" ? [spotPart?.name] : named ? [named] : targets.length ? targets : [undefined];
    const titles: string[] = [];
    for (const target of list) {
      const r = applyQuick(cmd, { src: next, model: nextModel, target, spot: target && target === spotPart?.name ? qspot : undefined, box, bounds });
      if (!r.ok) {
        if (!changed.length) return r;
        break;
      }
      next = r.src;
      titles.push(r.title);
      detail ??= r.detail;
      if (r.target) changed.push(r.target);
      if (list.length > 1) nextModel = evaluateOnly(next);
    }
    title = titles.length > 2 ? `${titles[0]}, and ${titles.length - 1} more` : titles.join("; ");
  }
  if (next === src) return { ok: false, why: "Nothing to change: it is already like that.", ai: false };
  // a change that breaks the source is not made
  const errorsIn = (m: Model) => m.diagnostics.filter((d) => d.severity === "error");
  const broke = errorsIn(evaluateOnly(next)).filter((e) => !errorsIn(model).some((o) => o.message === e.message));
  if (broke.length) return { ok: false, why: `That would break the design: ${broke[0].message}`, ai: true };
  commitSource(next, "you", title);
  return { ok: true, kind: cmd.k, title, detail, before: src, after: next, targets: changed, built: buildError(changed) };
}

/** Which parts a command means: the one it names, the one pointed at, the selected ones, or the only part. */
function targetsFor(cmd: QuickCommand, model: Model, spotBlock: string | undefined): string[] {
  if ("target" in cmd && cmd.target) return [cmd.target];
  if (spotBlock) return [spotBlock];
  const selected = useView.getState().selected;
  const blocks = [...new Set(selected.map((id) => model.parts.find((p) => p.id === id)?.name).filter((n): n is string => !!n))];
  if (blocks.length) return blocks;
  const own = [...new Set(model.parts.filter((p) => p.kind === "part").map((p) => p.name))];
  return own.length === 1 ? own : [];
}

function applyMaterial(name: string, blocks: string[], src: string, model: Model): { ok: true; src: string; title: string; targets: string[] } | { ok: false; why: string; ai: boolean } {
  const rec = materialRecord(name);
  if (!rec) return { ok: false, why: `Kerf doesn't know the material ${name}.`, ai: true };
  if (!blocks.length) return { ok: false, why: `Click a part first, then say “${name}” again.`, ai: true };
  const locked = blocks.filter((b) => blockPart(model, b)?.locked);
  if (locked.length) return { ok: false, why: `${locked.join(", ")} ${locked.length > 1 ? "are" : "is"} locked. Unlock ${locked.length > 1 ? "them" : "it"} in the parts list first.`, ai: false };
  // later blocks first, so the earlier ones' spans still match the text
  const ordered = [...blocks].filter((b) => blockPart(model, b)).sort((a, b) => blockPart(model, b)!.span.start - blockPart(model, a)!.span.start);
  let out = src;
  for (const b of ordered) {
    const opt = adviseFor(b, { candidates: [rec.name], keepProcess: false, model })?.options.find((o) => o.name === rec.name);
    out = withMaterial(out, model, b, { material: rec.name, finish: opt?.finish ?? rec.finishes[0], color: opt?.color ?? rec.color, process: opt?.processChange?.to }).src;
  }
  const labels = ordered.map((b) => blockPart(model, b)!.label);
  return { ok: true, src: out, title: `Made ${labels.length > 2 ? `${labels.length} parts` : labels.join(" and ")} in ${rec.label}`, targets: ordered };
}

/** Why one of these parts fails to build once the build has run, or null. */
async function buildError(blocks: string[]): Promise<string | null> {
  if (!blocks.length) return null;
  const s = await whenChecked();
  for (const b of blocks) {
    const p = s.model?.parts.find((q) => q.name === b);
    const err = p && s.buildErrors.get(p.hash);
    if (err) return err;
  }
  return null;
}

// --- the spot, in the part's own frame

function spotFor(spot: SpotRef, part: Model["parts"][number]): QuickSpot | undefined {
  if (!spot.local) return undefined;
  const normal = spot.localNormal ?? (spot.normal ? unrotate(part.xf, spot.normal) : undefined);
  const mesh = meshOf(part.hash);
  const edge = mesh ? nearestEdge(mesh.edges, mesh.edgeGroups, spot.local) : undefined;
  return { local: spot.local, normal, edge, point: spot.point, worldNormal: spot.normal };
}

/** A direction in assembly coordinates brought back into the part's own frame (its rotations undone). */
function unrotate(xf: Xform[], n: Vec3): Vec3 {
  let v: Vec3 = [...n];
  for (let i = xf.length - 1; i >= 0; i--) {
    const x = xf[i];
    if (x.op !== "rotate") continue;
    v = rotateVec(v, x.axis, -x.angle);
  }
  return v;
}

function rotateVec(v: Vec3, axis: Vec3, deg: number): Vec3 {
  const len = Math.hypot(...axis) || 1;
  const k: Vec3 = [axis[0] / len, axis[1] / len, axis[2] / len];
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dot = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  const cross: Vec3 = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
  return [0, 1, 2].map((i) => v[i] * c + cross[i] * s + k[i] * dot * (1 - c)) as Vec3;
}

/**
 * The model edge nearest a spot: the middle of that edge (a point on it, so
 * near(mid, 0.2) picks it and not its neighbours) and how far the spot is.
 */
export function nearestEdge(edges: Float32Array, groups: Int32Array | undefined, p: Vec3): { mid: Vec3; dist: number } | undefined {
  const segs = Math.floor(edges.length / 6);
  if (!segs) return undefined;
  let best = Infinity;
  let bestSeg = -1;
  for (let s = 0; s < segs; s++) {
    const d = segDist(edges, s, p);
    if (d < best) {
      best = d;
      bestSeg = s;
    }
  }
  // the whole model edge the nearest segment belongs to
  let from = bestSeg;
  let to = bestSeg;
  if (groups) {
    for (let g = 0; g + 2 < groups.length; g += 3) {
      const first = groups[g] / 2;
      const count = groups[g + 1] / 2;
      if (bestSeg >= first && bestSeg < first + count) {
        from = first;
        to = first + count - 1;
        break;
      }
    }
  }
  const pts: Vec3[] = [];
  for (let s = from; s <= to; s++) {
    if (s === from) pts.push(pt(edges, s * 2));
    pts.push(pt(edges, s * 2 + 1));
  }
  // the vertex nearest half way along: on the edge itself, away from its ends
  const lens = pts.slice(1).map((q, i) => Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1], q[2] - pts[i][2]));
  const total = lens.reduce((a, b) => a + b, 0);
  let mid: Vec3;
  if (pts.length <= 2) mid = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2, (pts[0][2] + pts[1][2]) / 2];
  else {
    let run = 0;
    let k = 0;
    while (k < lens.length && run + lens[k] < total / 2) run += lens[k++];
    mid = pts[Math.min(pts.length - 1, Math.max(1, run + lens[k] / 2 < total / 2 ? k + 1 : k))];
  }
  return { mid: mid.map((v) => Math.round(v * 1000) / 1000) as Vec3, dist: best };
}

const pt = (a: Float32Array, i: number): Vec3 => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];

function segDist(a: Float32Array, s: number, p: Vec3): number {
  const o = s * 6;
  const ax = a[o];
  const ay = a[o + 1];
  const az = a[o + 2];
  const dx = a[o + 3] - ax;
  const dy = a[o + 4] - ay;
  const dz = a[o + 5] - az;
  const l2 = dx * dx + dy * dy + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy + (p[2] - az) * dz) / l2)) : 0;
  return Math.hypot(ax + dx * t - p[0], ay + dy * t - p[1], az + dz * t - p[2]);
}

const boxes = new Map<string, [Vec3, Vec3]>();
/** A part's bounding box in its own frame, from its mesh. */
function boxOf(hash: string): [Vec3, Vec3] | undefined {
  const hit = boxes.get(hash);
  if (hit) return hit;
  const m = meshOf(hash);
  if (!m || !m.positions.length) return undefined;
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = m.positions[i + k];
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
  }
  const b: [Vec3, Vec3] = [lo, hi];
  if (boxes.size > 200) boxes.clear();
  boxes.set(hash, b);
  return b;
}
