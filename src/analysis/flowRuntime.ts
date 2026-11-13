// Runs the design's flow and cooling analyses and feeds their results into the check report. A run starts a few
// seconds after the parts it covers last changed (a newer change stops an older run), in a worker of its own. It
// sets the run up from the design: the parts' shapes and materials, the fans placed among them on their curves, the
// heat each electronic part makes, and what each part can take.

import { create } from "zustand";
import { meshes, refreshReport, useDesign } from "../core/engine";
import type { CheckItem } from "../core/checks";
import { registerReportPass, type ReportContext } from "../core/reportPasses";
import type { EvalPart, Model } from "../core/model";
import { xformMatrix } from "../kernel/recipe";
import type { MeshData } from "../kernel/build";
import { fmtNum } from "../lang/values";
import { catalogPart } from "../machine/catalog";
import type { CatalogPart } from "../machine/types";
import { componentLosses } from "../machine/heat";
import { thermalMaterial } from "./thermalMaterials";
import { fanCurve } from "./flow/fans";
import { airFluid, waterFluid } from "./flow/fluids";
import type { FlowOpening, FlowSpec, V3 } from "./spec";
import type { FlowBody, FlowDrive, FlowFan, FlowInput, FlowSection } from "./flow/types";
import type { FlowRequest, FlowResponse } from "./flow/protocol";
import { CFM, cfm, degC, flowHottest, setFlowRuns, type FlowRun } from "./flowSummary";

export type { FlowRun };

export type FlowColour = "temperature" | "speed";

interface FlowState {
  runs: Map<string, FlowRun>;
  /** the analysis drawn on the model */
  shown: string | null;
  /** parts coloured by temperature, a case or duct round them drawn see-through, streamlines through the air (coloured by
   * speed or temperature), a cut through it */
  surface: boolean;
  xray: boolean;
  lines: boolean;
  colour: FlowColour;
  slice: "off" | "x" | "y" | "z";
  sliceAt: number;
}

export const useFlow = create<FlowState>(() => ({ runs: new Map(), shown: null, surface: true, xray: true, lines: true, colour: "temperature", slice: "off", sliceAt: 0.5 }));

const fGet = useFlow.getState;
const fSet = useFlow.setState;

/** each quality's time limit, minutes (the analysis can set its own with time:), and the cells it aims for */
const TIME_LIMIT = { draft: 3, standard: 8, fine: 25 };
const CELLS = { draft: 150_000, standard: 450_000, fine: 1_500_000 };
/** the most cells a run may have whatever its cell size */
const MAX_CELLS = 4_000_000;
/** wait this long after the last change before starting a run */
const SETTLE_MS = 2500;
const ROOM_C = 25;

function patchRun(label: string, patch: Partial<FlowRun>) {
  const r = fGet().runs.get(label);
  if (!r) return;
  fSet({ runs: new Map(fGet().runs).set(label, { ...r, ...patch }) });
}

// ---------- worker ----------

interface Job {
  id: number;
  label: string;
  key: string;
  input: FlowInput;
}
let worker: Worker | null = null;
let current: Job | null = null;
let queue: Job[] = [];
let nextId = 0;
let startTimer: ReturnType<typeof setTimeout> | null = null;

function stopWorker() {
  worker?.terminate();
  worker = null;
  current = null;
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./flow.worker.ts", import.meta.url), { type: "module", name: "kerf-flow" });
  w.onmessage = (ev: MessageEvent<FlowResponse>) => {
    const msg = ev.data;
    if (!current || msg.id !== current.id) return;
    const job = current;
    if (msg.type === "progress") {
      patchRun(job.label, { stage: msg.progress.stage, frac: msg.progress.frac, progress: msg.progress });
      return;
    }
    current = null;
    if (msg.type === "error") patchRun(job.label, { status: "error", error: msg.message, setup: msg.setup, stale: false });
    else patchRun(job.label, { status: "done", result: msg.result, stale: false, error: undefined, frac: 1, stage: "Done" });
    refreshReport();
    pump();
  };
  w.onerror = (ev) => {
    ev.preventDefault();
    const job = current;
    stopWorker();
    if (job) patchRun(job.label, { status: "error", error: 'The flow run stopped unexpectedly, most likely out of memory. Try resolution: "draft".', stale: false });
    refreshReport();
    pump();
  };
  worker = w;
  return w;
}

function pump() {
  if (current || !queue.length) return;
  const job = queue.shift()!;
  current = job;
  patchRun(job.label, { status: "running", startedAt: performance.now(), stage: "Building the grid", frac: 0 });
  const transfer = job.input.bodies.flatMap((b) => [b.positions.buffer, b.indices.buffer]) as ArrayBuffer[];
  ensureWorker().postMessage({ id: job.id, type: "run", input: job.input } satisfies FlowRequest, transfer);
}

function cancel(label: string) {
  queue = queue.filter((j) => j.label !== label);
  if (current?.label === label) stopWorker();
}

/** Stop a run (the user pressed stop): it keeps its previous result. */
export function stopFlow(label: string) {
  cancel(label);
  patchRun(label, { status: "error", error: "Stopped.", stale: false });
  refreshReport();
  pump();
}

// ---------- preparing a run ----------

const shownMesh = (hash: string) => meshes.get(hash)?.preview ?? meshes.get(hash)?.final;

/** The parts a flow analysis covers: the ones it names, or every part shown. */
export function flowParts(spec: FlowSpec, model: Model): EvalPart[] {
  return spec.parts.length ? model.parts.filter((p) => spec.parts.includes(p.name)) : model.parts.filter((p) => !p.hidden);
}

function catalogOf(p: EvalPart, model: Model): CatalogPart | undefined {
  if (p.kind !== "component") return undefined;
  const mc = model.machine?.components.find((c) => c.name === p.name);
  return mc ? catalogPart(mc.catalogId) : undefined;
}

function worldMesh(p: EvalPart, data: MeshData): { positions: Float32Array; indices: Uint32Array } {
  const m = xformMatrix(p.xf);
  const P = data.positions;
  const pos = new Float32Array(P.length);
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i];
    const y = P[i + 1];
    const z = P[i + 2];
    pos[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    pos[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    pos[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return { positions: pos, indices: Uint32Array.from(data.indices) };
}

/** The placed instance a body belongs to: "pcb.parts" → "pcb", "fans#2.blades" → "fans#2". */
const instanceOf = (id: string) => id.split(".")[0];

/** A closed mesh's volume (mm³), by the divergence theorem. */
function meshVolume(data: MeshData): number {
  const P = data.positions;
  const I = data.indices;
  if (P.length < 3) return 0;
  const [ox, oy, oz] = [P[0], P[1], P[2]];
  let v = 0;
  for (let i = 0; i + 2 < I.length; i += 3) {
    const a = I[i] * 3;
    const b = I[i + 1] * 3;
    const c = I[i + 2] * 3;
    const ax = P[a] - ox, ay = P[a + 1] - oy, az = P[a + 2] - oz;
    const bx = P[b] - ox, by = P[b + 1] - oy, bz = P[b + 2] - oz;
    const cx = P[c] - ox, cy = P[c + 1] - oy, cz = P[c + 2] - oz;
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return Math.abs(v) / 6;
}

const unit = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** How hot a bought part's case may get, by what it is. */
function componentLimit(cat: CatalogPart | undefined): { maxC: number; why: string } {
  switch (cat?.kind) {
    case "battery":
      return { maxC: 60, why: "a lithium cell must stay under 60 °C, and ages fast above 45 °C" };
    case "psu":
      return { maxC: 70, why: "a power supply gives full power to about 50 °C and 70 °C at most" };
    case "motor_driver":
    case "stepper_driver":
      return { maxC: 100, why: "a driver chip's case near 100 °C means its junction is near the 125 °C where it shuts down" };
    case "gearmotor":
    case "stepper":
      return { maxC: 80, why: "a motor's case above about 80 °C means its windings are near their insulation's limit" };
    case "fan":
      return { maxC: 70, why: "fan bearings are rated to about 70 °C" };
    case "sensor":
    case "display":
      return { maxC: 70, why: "rated to about 70 °C" };
    default:
      return { maxC: 85, why: "electronics rated to 85 °C" };
  }
}

/** The faces of a part's mesh that point along a direction: the plane they lie on, their box and middle. */
function faceOf(P: Float32Array, d: V3): { at: V3; lo: V3; hi: V3; plane: number } {
  let top = -Infinity;
  for (let i = 0; i < P.length; i += 3) top = Math.max(top, P[i] * d[0] + P[i + 1] * d[1] + P[i + 2] * d[2]);
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) {
    if (P[i] * d[0] + P[i + 1] * d[1] + P[i + 2] * d[2] < top - 0.5) continue;
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], P[i + a]);
      hi[a] = Math.max(hi[a], P[i + a]);
    }
  }
  return { at: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], lo, hi, plane: top };
}

/** Where an opening is in the grid: a point in its cross-section, the way the air goes, and a box to keep to. */
function placeOpening(o: FlowOpening, inlet: boolean, model: Model, meshOf: (hash: string) => MeshData | undefined, h: number): { at: V3; dir: V3; bounds?: { lo: V3; hi: V3 } } | string | null {
  const r = o.region;
  if (r.t === "face") {
    const p = model.parts.find((q) => q.name === r.part);
    if (!p) return `${o.label}: there is no part called ${r.part}`;
    const data = meshOf(p.hash);
    if (!data) return null;
    const w = worldMesh(p, data);
    const d = unit(r.dir);
    const f = faceOf(w.positions, d);
    // a cell and a half inside the part's end, in the air it holds
    const at: V3 = [f.at[0] - d[0] * 1.5 * h, f.at[1] - d[1] * 1.5 * h, f.at[2] - d[2] * 1.5 * h];
    const dir = o.toward ? unit(o.toward) : inlet ? ([-d[0], -d[1], -d[2]] as V3) : d;
    return { at, dir, bounds: { lo: f.lo, hi: f.hi } };
  }
  if (!o.toward) return `${o.label}: say which way the air goes through it with toward:`;
  if (r.t === "sphere") {
    if (r.r <= 0) return { at: r.at, dir: unit(o.toward) };
    return { at: r.at, dir: unit(o.toward), bounds: { lo: [r.at[0] - r.r, r.at[1] - r.r, r.at[2] - r.r], hi: [r.at[0] + r.r, r.at[1] + r.r, r.at[2] + r.r] } };
  }
  if (r.t === "box") return { at: r.at, dir: unit(o.toward), bounds: { lo: [r.at[0] - r.size[0] / 2, r.at[1] - r.size[1] / 2, r.at[2] - r.size[2] / 2], hi: [r.at[0] + r.size[0] / 2, r.at[1] + r.size[1] / 2, r.at[2] + r.size[2] / 2] } };
  if (r.t === "cyl") {
    const mid: V3 = [r.at[0] + (r.axis[0] * r.length) / 2, r.at[1] + (r.axis[1] * r.length) / 2, r.at[2] + (r.axis[2] * r.length) / 2];
    const e = r.d / 2 + r.length / 2;
    return { at: mid, dir: unit(o.toward), bounds: { lo: [mid[0] - e, mid[1] - e, mid[2] - e], hi: [mid[0] + e, mid[1] + e, mid[2] + e] } };
  }
  return `${o.label}: give a face of a part or a zone`;
}

/** A tidy cell size near h: 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10 mm… */
function niceCell(h: number): number {
  const steps = [0.25, 0.3, 0.4, 0.5, 0.6, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50];
  return steps.find((s) => s >= h * 0.97) ?? Math.ceil(h / 10) * 10;
}

/** The ambient a flow analysis uses and why. */
export function flowAmbient(spec: FlowSpec, model: Model): { c: number; why: string } {
  if (spec.ambient !== undefined) return { c: spec.ambient, why: "the analysis's ambient:" };
  const brief = model.brief?.temp;
  if (brief) return { c: brief[1], why: `the brief's hottest service temperature${model.brief?.assumed.includes("temp") ? ", assumed" : ""}` };
  return { c: ROOM_C, why: "a warm room" };
}

/** World-space bodies, fans and settings for a flow analysis; null while geometry is still building. */
export function flowInput(spec: FlowSpec, model: Model, buildErrors: Map<string, string>, meshOf: (hash: string) => MeshData | undefined = shownMesh): { input?: FlowInput; error?: string } | null {
  const parts = flowParts(spec, model);
  if (!parts.length) return { error: spec.parts.length ? `None of ${spec.parts.join(", ")} has geometry for the flow.` : "There are no parts for the flow." };
  const broken = parts.find((p) => buildErrors.has(p.hash));
  if (broken) return { error: `${broken.label} did not build, so the flow cannot run yet.` };

  // heat made in each part instance: the sources given, and every electronic part's own loss. Each instance makes
  // the watts once, spread over its bodies by volume, so a board's 2.5 W goes partly into the board and partly into
  // the parts on it rather than 2.5 W into each
  const byInst = new Map<string, EvalPart[]>();
  for (const p of parts) {
    const k = instanceOf(p.id);
    const g = byInst.get(k);
    if (g) g.push(p);
    else byInst.set(k, [p]);
  }
  const heat = new Map<string, { w: number; why: string[] }>();
  const instHeat = new Map<string, { w: number; why: string[] }>();
  const add = (m: Map<string, { w: number; why: string[] }>, id: string, w: number, why: string) => {
    const h = m.get(id) ?? { w: 0, why: [] };
    h.w += w;
    h.why.push(why);
    m.set(id, h);
  };
  /** false while a body's geometry is still building */
  const spread = (bodiesOf: EvalPart[], w: number, why: string): boolean => {
    if (bodiesOf.length === 1) {
      add(heat, bodiesOf[0].id, w, why);
      return true;
    }
    const vol: number[] = [];
    for (const b of bodiesOf) {
      const data = meshOf(b.hash);
      if (!data) return false;
      vol.push(meshVolume(data));
    }
    const total = vol.reduce((s, v) => s + v, 0);
    bodiesOf.forEach((b, i) => {
      const share = total > 0 ? (w * vol[i]) / total : w / bodiesOf.length;
      if (share > 0) add(heat, b.id, share, `${fmtNum((100 * share) / w, 0)} % of ${why}, by volume`);
    });
    return true;
  };
  const own = new Set<string>();
  for (const h of spec.heat) {
    const why = h.why ?? `${fmtNum(h.watts, 2)} W given (${h.label})`;
    // one body ("pcb.parts"), one instance ("fans#2") or every instance of a part
    const exact = h.id?.includes(".") ? parts.filter((p) => p.id === h.id) : [];
    const keys = exact.length ? [] : [...byInst.keys()].filter((k) => (h.id ? k === h.id : byInst.get(k)![0].name === h.part));
    if (exact.length && !spread(exact, h.watts, why)) return null;
    for (const k of keys) if (!spread(byInst.get(k)!, h.watts, why)) return null;
    for (const k of exact.length ? [instanceOf(exact[0].id)] : keys) {
      add(instHeat, k, h.watts, why);
      own.add(byInst.get(k)![0].name);
    }
  }
  if (spec.auto)
    for (const l of componentLosses(model)) {
      const k = instanceOf(l.id);
      const g = byInst.get(k);
      if (own.has(l.comp) || !(l.watts > 0) || !g) continue;
      const why = `${fmtNum(l.watts, 2)} W from ${l.why}`;
      if (!spread(g, l.watts, why)) return null;
      add(instHeat, k, l.watts, why);
    }

  const bodies: FlowBody[] = [];
  const fans: FlowFan[] = [];
  const fanInst = new Set<string>();
  for (const p of parts) {
    const cat = catalogOf(p, model);
    const hp = heat.get(p.id);
    if (cat?.kind === "fan" && spec.drive === "fans" && (!spec.fans || spec.fans.includes(p.name))) {
      // one fan per placed fan, however many bodies draw it, making all of that fan's heat
      const k = instanceOf(p.id);
      if (!fanInst.has(k)) fans.push(fanOf(p, cat, instHeat.get(k)));
      fanInst.add(k);
      continue;
    }
    const data = meshOf(p.hash);
    if (!data) return null;
    const w = worldMesh(p, data);
    const comp = p.kind === "component";
    const mat = thermalMaterial(p.material, comp);
    const lim = comp ? componentLimit(cat) : { maxC: mat.maxC, why: `${mat.name} ${mat.softens ? "softens" : "is at its long-use limit"} at about ${fmtNum(mat.maxC, 0)} °C` };
    const maxC = spec.maxTemp !== undefined && spec.maxTemp < lim.maxC ? spec.maxTemp : lim.maxC;
    bodies.push({
      id: p.id,
      name: p.label || p.name,
      ...w,
      k: mat.k,
      watts: hp?.w ?? 0,
      ...(hp ? { heatWhy: hp.why.join("; ") } : {}),
      // bare metal is shiny; plastics, boards and painted cases radiate well; water stops it all
      emissivity: spec.fluid === "water" ? 0 : comp || mat.softens || mat.assumed ? 0.9 : 0.15,
      maxC,
      limitWhy: maxC === spec.maxTemp && maxC < lim.maxC ? "the analysis's max_temp:" : lim.why,
      material: comp ? (cat?.name ?? "component") : mat.name,
      component: comp,
    });
  }
  if (spec.drive === "fans" && !fans.length)
    return { error: spec.fans ? `None of ${spec.fans.join(", ")} is a fan among the parts.` : 'flow: "fans", but there is no fan among the parts. Place a fan (a catalogue fan component), or use flow: "natural" for warm air rising on its own.' };

  // the grid: a box round everything with a margin of still air, cells sized for the quality
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const b of bodies)
    for (let i = 0; i < b.positions.length; i += 3)
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], b.positions[i + a]);
        hi[a] = Math.max(hi[a], b.positions[i + a]);
      }
  for (const f of fans)
    for (let a = 0; a < 3; a++) {
      const e = [f.at[a] - f.size * 0.75, f.at[a] + f.size * 0.75, f.at[a] + f.axis[a] * f.depth];
      lo[a] = Math.min(lo[a], ...e);
      hi[a] = Math.max(hi[a], ...e);
    }
  const ext = [0, 1, 2].map((a) => Math.max(1, hi[a] - lo[a]));
  const quality = typeof spec.resolution === "string" ? spec.resolution : "standard";
  const target = CELLS[quality];
  const marginFor = (h: number) => Math.max(4 * h, 6, 0.1 * Math.max(...ext));
  let h = typeof spec.resolution === "string" ? 0 : spec.resolution.h;
  if (!h) {
    h = Math.cbrt(ext.reduce((v, e) => v * (e + 2 * marginFor(Math.cbrt((ext[0] * ext[1] * ext[2]) / target))), 1) / target);
    h = niceCell(Math.max(0.25, h));
  }
  const margin = marginFor(h);
  const cells = ext.reduce((v, e) => v * (Math.ceil((e + 2 * margin) / h) + 2), 1);
  if (cells > MAX_CELLS) return { error: `A ${fmtNum(h, 2)} mm cell makes ${fmtNum(cells / 1e6, 1)} million cells round these parts; the most is ${MAX_CELLS / 1e6} million. Use a bigger resolution:, or fewer parts:.` };

  const drives: FlowDrive[] = [];
  if (spec.drive === "set" && spec.inlet && spec.flow) {
    const at = placeOpening(spec.inlet, true, model, meshOf, h);
    if (at === null) return null;
    if (typeof at === "string") return { error: at };
    drives.push({ label: `inlet (${spec.inlet.label})`, flow: spec.flow / 1e9, ...at });
  }
  const sections: FlowSection[] = [];
  for (const o of spec.outlets) {
    const at = placeOpening(o, false, model, meshOf, h);
    if (at === null) return null;
    if (typeof at === "string") return { error: at };
    sections.push({ label: o.label, ...at });
  }

  const amb = flowAmbient(spec, model);
  const watts = bodies.reduce((s, b) => s + b.watts, 0) + fans.reduce((s, f) => s + (f.watts ?? 0), 0);
  return {
    input: {
      label: spec.label,
      bodies,
      fans,
      drives,
      sections,
      fluid: spec.fluid === "water" ? waterFluid(amb.c) : airFluid(amb.c),
      ambient: amb.c,
      gravity: spec.gravity ? [-9.81 * spec.up[0], -9.81 * spec.up[1], -9.81 * spec.up[2]] : null,
      h,
      margin,
      heat: watts > 0,
      maxMinutes: spec.time ? spec.time / 60 : TIME_LIMIT[quality],
      ...(spec.fluid === "water" ? { notes: ["Water at the inlet's temperature fills the passages and stands still round the parts, so their outsides are cooled as if under water: for a manifold in air, the pressure and the share between the outlets hold, but outside surfaces run cooler than they would. Nothing is radiated through water."] } : {}),
    },
  };
}

/** A placed fan: where it is and which way it blows, its size and its curve. */
function fanOf(p: EvalPart, cat: CatalogPart, heat: { w: number; why: string[] } | undefined): FlowFan {
  const m = xformMatrix(p.xf);
  const tr = (v: V3): V3 => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];
  const rot = (v: V3): V3 => unit([m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2]]);
  const s = cat.specs ?? {};
  const dims = (cat.geom?.dims ?? {}) as Record<string, number>;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
  const flowM3s = num(s.flow_m3h) !== undefined ? num(s.flow_m3h)! / 3600 : num(s.cfm) !== undefined ? num(s.cfm)! * 0.000471947443 : undefined;
  const pressure = num(s.pressure_pa);
  const lim = componentLimit(cat);
  const common = { id: p.id, name: p.label || p.name, ...(heat ? { watts: heat.w, heatWhy: heat.why.join("; ") } : {}), maxC: lim.maxC, limitWhy: lim.why };
  if (cat.geom?.g === "fan") {
    const size = num(dims.size) ?? num(s.size) ?? 40;
    const t = num(dims.t) ?? 10;
    const c = fanCurve({ size, flow: flowM3s, pressure });
    return { ...common, at: tr([0, 0, 0]), axis: rot([0, 0, 1]), side: rot([1, 0, 0]), size, depth: t, bore: num(dims.bore_d) ?? size * 0.96, hub: num(dims.hub_d) ?? size * 0.5, curve: c.curve, curveWhy: c.why };
  }
  // a radial blower drawn as a box: it blows out of its +X side through a mouth about 40 % of its size
  const w = num(dims.w) ?? num(s.size) ?? 50;
  const hgt = num(dims.h) ?? 15;
  const size = num(s.size) ?? w;
  const c = fanCurve({ size, blower: true, flow: flowM3s, pressure });
  const mouth = Math.min(hgt, 0.4 * w);
  return { ...common, at: tr([w / 2, 0, hgt / 2]), axis: rot([1, 0, 0]), side: rot([0, 1, 0]), size: mouth, depth: Math.max(2, 0.2 * mouth), bore: mouth, hub: 0, curve: c.curve, curveWhy: `${c.why}; it blows out of its +X side`, blower: true };
}

function inputKey(spec: FlowSpec, parts: EvalPart[], model: Model): string {
  const { span: _span, ...rest } = spec;
  void _span;
  const losses = spec.auto ? componentLosses(model).map((l) => [l.id, Math.round(l.watts * 1000)]) : [];
  return JSON.stringify({ rest, parts: parts.map((p) => [p.id, p.hash, p.xf, p.material]), losses, brief: model.brief?.temp });
}

// ---------- scheduling ----------

let scheduledRev = -1;
let pendingStart = false;
/** an analysis whose parts had no geometry yet: look again when the report is next put together */
let awaitingGeometry = false;

function schedule(state: Pick<ReportContext, "model" | "rev" | "buildErrors">) {
  const model = state.model;
  scheduledRev = state.rev;
  awaitingGeometry = false;
  const specs = model.analyses.filter((a): a is FlowSpec => a.kind === "flow");
  const labels = new Set(specs.map((s) => s.label));
  const runs = new Map(fGet().runs);
  let shown = fGet().shown;
  for (const label of runs.keys()) {
    if (labels.has(label)) continue;
    cancel(label);
    runs.delete(label);
    if (shown === label) shown = null;
  }
  const fresh: Job[] = [];
  for (const spec of specs) {
    const parts = flowParts(spec, model);
    const key = inputKey(spec, parts, model);
    const run = runs.get(spec.label);
    if (run && run.key === key) continue;
    const prep = flowInput(spec, model, state.buildErrors);
    if (!prep) {
      awaitingGeometry = true;
      continue;
    }
    cancel(spec.label);
    const base: FlowRun = { label: spec.label, key, status: "waiting", stage: "Waiting for the design to settle", frac: 0, stale: !!run?.result, result: run?.result, startedAt: performance.now() };
    if (prep.error) runs.set(spec.label, { ...base, status: "error", error: prep.error, setup: true, result: undefined, stale: false });
    else {
      runs.set(spec.label, base);
      fresh.push({ id: ++nextId, label: spec.label, key, input: prep.input! });
    }
  }
  fSet({ runs, shown });
  if (!fresh.length) return;
  queue.push(...fresh);
  if (startTimer) clearTimeout(startTimer);
  pendingStart = true;
  startTimer = setTimeout(() => {
    startTimer = null;
    pendingStart = false;
    pump();
  }, SETTLE_MS);
}

// ---------- check items and words ----------


/** The check items a flow result gives (or its state while it runs). */
export function flowItems(spec: FlowSpec, run: FlowRun | undefined, model: Model): CheckItem[] {
  const parts = flowParts(spec, model).map((p) => p.id);
  const base = { category: "analysis" as const, basis: "simulation" as const, span: spec.span, parts };
  const id = (s: string) => `flow:${spec.label}:${s}`;
  if (!run || run.status === "waiting" || run.status === "running") {
    const pct = run?.status === "running" ? ` ${Math.round(100 * run.frac)} %` : "";
    return [{ ...base, id: id("temps"), status: "pending", title: `Cooling: ${spec.label}`, detail: `${run?.result ? "Re-running the flow for the latest change" : "Running the flow"}${pct}${run?.stage ? ` (${run.stage.toLowerCase()})` : ""}…` }];
  }
  const stopped = run.status === "error" && run.error === "Stopped.";
  if (stopped && !run.result) return [{ ...base, id: id("setup"), status: "info", title: `Flow analysis: ${spec.label}`, detail: "Stopped before it finished. It runs again when the parts it covers change, or with run again in the Analysis tab." }];
  if ((run.status === "error" && !stopped) || !run.result) return [{ ...base, id: id("setup"), status: "fail", title: `Flow analysis: ${spec.label}`, detail: run.error ?? "The flow run did not finish." }];
  const r = run.result;
  const out: CheckItem[] = [];
  if (stopped) out.push({ ...base, id: id("setup"), status: "warn", title: `Flow analysis stopped: ${spec.label}`, detail: "Stopped before it finished: the results here are from the last run that did, which may be from before the latest change." });
  const unsure = !r.converged || Math.abs(r.balance) > 0.05;
  const hot = flowHottest(r);
  const over = hot.filter((p) => p.limit !== undefined && p.max > p.limit);
  const close = hot.filter((p) => p.limit !== undefined && p.max <= p.limit && p.max > p.limit - 5);
  const made = r.parts.filter((p) => p.watts > 0);
  const line = (p: (typeof hot)[number]) => `${p.name} ${degC(p.max)}${p.limit !== undefined ? ` (limit ${degC(p.limit)}: ${p.limitWhy ?? ""})` : ""}`;
  if (r.heatIn > 0) {
    const status: CheckItem["status"] = over.length ? "fail" : close.length || unsure ? "warn" : "pass";
    const worst = hot[0];
    const margin = worst?.limit !== undefined ? worst.limit - worst.max : undefined;
    out.push({
      ...base,
      id: id("temps"),
      status,
      ...(margin !== undefined ? { margin } : {}),
      title: `Temperatures: ${spec.label}`,
      detail:
        `${fmtNum(r.heatIn, 2)} W made in ${made.length} part${made.length === 1 ? "" : "s"} at ${degC(r.ambient)} ambient. ` +
        (over.length ? `Over the limit: ${over.map(line).join("; ")}. ` : "") +
        `Nearest their limits: ${hot.slice(0, 4).map(line).join("; ")}. ` +
        `The ${r.fluid} leaves ${fmtNum(r.airRise, 1)} K warmer on average (hottest ${r.fluid} ${degC(r.maxAir)}); ${fmtNum(r.heatAir, 2)} W goes with the ${r.fluid}, ${fmtNum(r.heatRadiated, 2)} W is radiated.`,
      ...(status === "fail"
        ? { fix: "Move more air past the hot parts (a bigger or second fan, vents in line with the fan so the air goes through rather than round), give the hot parts a heatsink or a path into a metal wall, or spread them apart. Ask the assistant to look at where the air goes in the Analysis tab." }
        : {}),
    });
  }
  if (r.fans.length) {
    const bad = r.fans.filter((f) => f.reversed || f.stalled);
    out.push({
      ...base,
      id: id("fans"),
      status: bad.some((f) => f.reversed) ? "fail" : bad.length || unsure ? "warn" : "pass",
      title: `Fans: ${spec.label}`,
      detail: r.fans
        .map((f) => `${f.name}: ${f.reversed ? "air going backwards" : `${cfm(f.flow)}, ${fmtNum((100 * f.flow) / f.freeFlow, 0)} % of its free flow, against ${fmtNum(f.rise, 1)} Pa`}${f.stalled ? " (on the stalling part of its curve)" : ""}`)
        .join("; ")
        .concat(`. ${fmtNum(r.throughFlow / CFM, 1)} CFM goes through to the surroundings.`),
      ...(bad.length ? { fix: "Open up the vents (about twice the fan's own area in, the same out), keep them clear of the fan's hub, and point every fan the same way through the box." } : {}),
    });
  }
  for (const d of r.drives) {
    const pa = d.rise;
    const limit = spec.maxPressure !== undefined ? spec.maxPressure * 1e6 : undefined;
    out.push({
      ...base,
      id: id("pressure"),
      status: limit !== undefined ? (pa > limit ? "fail" : unsure ? "warn" : "pass") : "info",
      ...(limit !== undefined ? { margin: (limit - pa) / 1e6 } : {}),
      title: `Pressure to push the flow: ${spec.label}`,
      detail:
        `${fmtNum(pa, 1)} Pa pushes ${cfm(d.flow)} (${fmtNum(d.flow * 60000, 2)} L/min) in at the ${d.label}, ${fmtNum(d.speed, 2)} m/s through its ${fmtNum(d.area * 1e6, 0)} mm²: a loss of ${fmtNum(d.lossCoefficient, 1)} times its dynamic pressure.` +
        (limit !== undefined ? ` Limit ${fmtNum(limit, 0)} Pa.` : ""),
      ...(limit !== undefined && pa > limit ? { fix: "Widen the narrowest passages, round sharp bends and entries, and shorten the route; pressure falls with the square of the speed." } : {}),
    });
  }
  if (r.sections.length) {
    const total = r.drives.reduce((s, d) => s + d.flow, 0) || r.throughFlow || 1;
    out.push({
      ...base,
      id: id("outlets"),
      status: "info",
      title: `Flow through the openings: ${spec.label}`,
      detail: r.sections.map((s) => `${s.label}: ${cfm(s.flow)} (${fmtNum((100 * s.flow) / total, 0)} %), air at ${degC(s.temp)}`).join("; ") + ".",
    });
  }
  const notes = [...r.warnings, ...r.assumptions];
  notes.push(`${r.converged ? "Settled" : "Not fully settled"} after ${r.iterations} iterations in ${fmtNum(r.ms / 1000, 0)} s; heat balance within ${fmtNum(Math.abs(r.balance) * 100, 1)} %.`);
  out.push({ ...base, id: id("notes"), status: "info", title: `Accuracy notes: ${spec.label}`, detail: notes.join(" ") });
  return out;
}

const FLOW_ITEM = /^flow:/;

export function flowReportItems(items: CheckItem[], ctx: ReportContext): CheckItem[] {
  const { model } = ctx;
  if (ctx.live && (ctx.rev !== scheduledRev || awaitingGeometry)) schedule(ctx);
  const out = items.filter((i) => !FLOW_ITEM.test(i.id));
  for (const a of model.analyses) {
    if (a.kind !== "flow") continue;
    if (ctx.live) out.push(...flowItems(a, fGet().runs.get(a.label), model));
    else out.push({ id: `flow:${a.label}:temps`, category: "analysis", basis: "simulation", span: a.span, status: "info", title: `Cooling: ${a.label}`, detail: "The flow analysis runs once this work is merged into the design." });
  }
  return out;
}

// ---------- start-up and waiting ----------

let started = false;

export function startFlowRuntime() {
  if (started) return;
  started = true;
  setFlowRuns((label) => fGet().runs.get(label));
  registerReportPass("flow", flowReportItems, 22);
  refreshReport();
}

/** Resolves when every flow analysis of the current design has a result or an error (or the time runs out). */
export function whenFlowDone(timeoutMs = 30 * 60_000): Promise<void> {
  const done = () => {
    const d = useDesign.getState();
    if (!d.model || d.reportRev < d.rev || scheduledRev < d.reportRev || pendingStart) return false;
    return d.model.analyses.every((a) => a.kind !== "flow" || ["done", "error"].includes(fGet().runs.get(a.label)?.status ?? ""));
  };
  return new Promise((resolve) => {
    if (done()) return resolve();
    const finish = () => {
      clearTimeout(timer);
      clearInterval(poll);
      u1();
      u2();
      resolve();
    };
    const check = () => done() && finish();
    const u1 = useFlow.subscribe(check);
    const u2 = useDesign.subscribe(check);
    const poll = setInterval(check, 1000);
    const timer = setTimeout(finish, timeoutMs);
  });
}

/** Run one flow analysis again from the design as it is now (after it was stopped, say). */
export function rerunFlow(label: string) {
  const d = useDesign.getState();
  if (!d.model || !fGet().runs.has(label)) return;
  patchRun(label, { key: "" });
  schedule({ model: d.model, rev: scheduledRev, buildErrors: d.buildErrors });
  startFlowNow();
  refreshReport();
}

/** Run every flow analysis now, skipping the wait for the design to settle. */
export function startFlowNow() {
  if (startTimer) clearTimeout(startTimer);
  startTimer = null;
  pendingStart = false;
  pump();
}

export function showFlow(label: string | null) {
  fSet({ shown: label });
}

