// Runs the design's analyses and feeds their results into the check report.
// Drivetrain checks are formulas and run at once; structural analyses run in
// their own worker after each build, only when their inputs (set-up, part
// geometry, placement, material) changed, and a newer change cancels an
// older run. Results join the report as check items through a report pass,
// which the engine re-composes whenever a run finishes.

import { create } from "zustand";
import { meshes, refreshReport, useDesign } from "../core/engine";
import type { CheckItem } from "../core/checks";
import { registerReportPass, type ReportContext } from "../core/reportPasses";
import type { EvalPart, Model } from "../core/model";
import { xformMatrix } from "../kernel/recipe";
import type { MeshData } from "../kernel/build";
import { fmtNum } from "../lang/values";
import { mechMaterial, type MechMaterial } from "./materials";
import { thermalMaterial, type ThermalMaterial } from "./thermalMaterials";
import { electricMaterial, type ElectricMaterial } from "./electricMaterials";
import { componentLosses } from "../machine/heat";
import { runDrivetrain, type DrivetrainResult } from "./drivetrain";
import { RESOLUTION_TARGET, type DrivetrainSpec, type HeatLoadSpec, type StructuralSpec } from "./spec";
import type { FeaPart, PartPrint, StructuralInput, StructuralResult, TopologyPreview } from "./fe/structural";
import type { ShellPart } from "./fe/shells";
import { resolvedSettings } from "../mfg/profiles";
import type { BoltWant } from "./fe/bolts";
import { GRADES, gradeFrom, headDims, type HeadType } from "../library/fasteners";
import { threadSpec } from "../library/standards";
import { fdmPrint, printWords } from "../mfg/infill";
import { printUp } from "../mfg/printOrientation";
import type { Finish } from "./fe/fatigue";
import { boltText, contactVerdicts, modeText, printingText, staticSafety, stiffnessVerdict, strengthVerdict, touchingText } from "./summary";
import { fatigueText, fatigueVerdict } from "./fatigueSummary";
import { accuracyText, bucklingText, bucklingVerdict, heatOnlySpec, temperatureText, temperatureVerdict } from "./thermalSummary";
import { dynamicItems } from "./dynamics";
import { topologyNext, topologyText } from "./topologySummary";
import type { FeaRequest, FeaResponse } from "./protocol";

export type ResultField = "stress" | "safety" | "disp" | "strain" | "temp" | "life" | "current";

export interface StructuralRun {
  label: string;
  /** identity of the inputs: a run with the same key gives the same answer */
  key: string;
  fine: boolean;
  /** idle: set up but not run (topology runs only when asked) */
  status: "idle" | "waiting" | "running" | "done" | "error";
  stage: string;
  frac: number;
  iter?: number;
  residual?: number;
  /** residual per iteration while solving, for the convergence trace */
  trace: number[];
  /** the latest result; while a newer run is under way this is the previous one */
  result?: StructuralResult;
  stale: boolean;
  error?: string;
  /** the set-up cannot be solved as written (as opposed to a crash) */
  setup?: boolean;
  /** element count target or size used */
  resolution: string;
  startedAt: number;
  /** an accuracy check: solved twice, the second time with smaller elements */
  check?: boolean;
  /** topology optimisation: the shape so far, while it runs */
  preview?: TopologyPreview;
}

interface AnalysisState {
  /** keyed by analysis label (labels are the user's text, so a Map rather than an object) */
  runs: Map<string, StructuralRun>;
  drivetrain: Map<string, DrivetrainResult>;
  /** analysis whose results are drawn on the model */
  shown: string | null;
  /** analysis open in the analysis tab */
  selected: string | null;
  field: ResultField;
  /** deformation: 0 = undeformed shape, 1 = automatic exaggeration, otherwise a multiple of it */
  deform: number;
  /** show deflection at its real size */
  trueScale: boolean;
  /** oscillate between the unloaded and loaded shape */
  animate: boolean;
  /** natural frequency whose mode shape is drawn on the model (index), null: the static result (or the first mode when there is nothing else) */
  mode: number | null;
}

export const useAnalysis = create<AnalysisState>(() => ({
  runs: new Map(),
  drivetrain: new Map(),
  shown: null,
  selected: null,
  field: "stress",
  deform: 1,
  trueScale: false,
  animate: true,
  mode: null,
}));

const aGet = useAnalysis.getState;
const aSet = useAnalysis.setState;

// ---------- worker ----------

interface Job {
  id: number;
  label: string;
  key: string;
  input: StructuralInput;
}
let worker: Worker | null = null;
let current: Job | null = null;
let queue: Job[] = [];
let nextId = 0;
let deadline: ReturnType<typeof setTimeout> | null = null;
/** a run that takes longer than this is stopped, so one runaway analysis cannot hold up the others */
export const RUN_TIME_LIMIT_MS = 180_000;
const fineWanted = new Map<string, string>(); // label -> base key the fine run was asked for
const checkWanted = new Map<string, string>(); // label -> base key the accuracy check was asked for
const topoWanted = new Map<string, string>(); // label -> base key a topology run was asked for
/** topology runs take many solves: they may run this many times longer than a plain analysis */
const TOPOLOGY_TIME_FACTOR = 4;

function patchRun(label: string, patch: Partial<StructuralRun>) {
  const r = aGet().runs.get(label);
  if (!r) return;
  aSet({ runs: new Map(aGet().runs).set(label, { ...r, ...patch }) });
}

/** Stop the worker and whatever it is running. */
function stopWorker() {
  if (deadline) clearTimeout(deadline);
  deadline = null;
  worker?.terminate();
  worker = null;
  current = null;
}

/** The current run ended without a result: drop any older result too, since it no longer matches the design. */
function failCurrent(error: string, setup = false) {
  const job = current;
  stopWorker();
  if (job) patchRun(job.label, { status: "error", error, setup, result: undefined, stale: false, preview: undefined });
  refreshReport();
  pump();
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./fea.worker.ts", import.meta.url), { type: "module", name: "kerf-analysis" });
  w.onmessage = (ev: MessageEvent<FeaResponse>) => {
    const msg = ev.data;
    if (!current || msg.id !== current.id) return;
    const { label } = current;
    if (msg.type === "progress") {
      const r = aGet().runs.get(label);
      if (!r) return;
      if (msg.preview) {
        patchRun(label, { stage: msg.stage, frac: msg.frac, preview: msg.preview });
        return;
      }
      const trace = msg.iter !== undefined && msg.residual !== undefined ? [...r.trace.slice(0, msg.iter - 1), msg.residual] : r.trace;
      patchRun(label, { stage: msg.stage, frac: msg.frac, iter: msg.iter, residual: msg.residual, trace });
      return;
    }
    if (msg.type === "error") return failCurrent(msg.message, !!msg.setup);
    if (deadline) clearTimeout(deadline);
    deadline = null;
    current = null;
    patchRun(label, { status: "done", result: msg.result, stale: false, error: undefined, setup: undefined, frac: 1, stage: "Done", trace: msg.result.solve.history, preview: undefined });
    refreshReport();
    pump();
  };
  w.onerror = (ev) => {
    ev.preventDefault();
    failCurrent('The analysis stopped unexpectedly, most likely out of memory. Try a coarser resolution: "draft".');
  };
  worker = w;
  return w;
}

function pump() {
  if (current || !queue.length) return;
  const job = queue.shift()!;
  current = job;
  patchRun(job.label, { status: "running", startedAt: performance.now(), stage: "Meshing", frac: 0, trace: [] });
  const transfer = job.input.parts.flatMap((p) => [p.mesh.positions.buffer, p.mesh.indices.buffer, ...(p.normals ? [p.normals.buffer] : [])]) as ArrayBuffer[];
  ensureWorker().postMessage({ id: job.id, input: job.input } satisfies FeaRequest, transfer);
  // an accuracy check solves twice, the second time with about three times the elements; a topology run solves once
  // per design step
  const limit = RUN_TIME_LIMIT_MS * (job.input.topology ? TOPOLOGY_TIME_FACTOR : job.input.converge ? 2 : 1) * (job.input.large ? 1.5 : 1);
  deadline = setTimeout(() => {
    if (current === job)
      failCurrent(
        job.input.topology
          ? `Finding the shape took longer than ${limit / 60_000} minutes and was stopped. Try resolution: "draft" for a first shape, or fewer iterations:.`
          : `The analysis took longer than ${limit / 60_000} minutes and was stopped. Try a coarser resolution, such as "draft", or analyse fewer parts at once.`,
      );
  }, limit);
}

/**
 * Solve one structural input in a worker of its own, away from the design's runs (for comparing alternatives that are
 * not the design). Rejects on an error, a crash, a stop or the time limit.
 */
export function solveOnce(input: StructuralInput, timeoutMs = RUN_TIME_LIMIT_MS, signal?: AbortSignal): Promise<StructuralResult> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./fea.worker.ts", import.meta.url), { type: "module", name: "kerf-analysis-compare" });
    const end = (e?: Error, r?: StructuralResult) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      w.terminate();
      if (e) reject(e);
      else resolve(r!);
    };
    const stop = () => end(new Error("Stopped"));
    const timer = setTimeout(() => end(new Error(`it took longer than ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    w.onmessage = (ev: MessageEvent<FeaResponse>) => {
      const msg = ev.data;
      if (msg.type === "error") end(new Error(msg.message));
      else if (msg.type !== "progress") end(undefined, msg.result);
    };
    w.onerror = (ev) => {
      ev.preventDefault();
      end(new Error("the analysis stopped unexpectedly, most likely out of memory"));
    };
    const transfer = input.parts.flatMap((p) => [p.mesh.positions.buffer, p.mesh.indices.buffer, ...(p.normals ? [p.normals.buffer] : [])]) as ArrayBuffer[];
    w.postMessage({ id: 1, input } satisfies FeaRequest, transfer);
  });
}

function cancel(label: string) {
  queue = queue.filter((j) => j.label !== label);
  if (current?.label === label) stopWorker();
}

// ---------- preparing a run ----------

/** The design's own meshes, as the main view built them. */
const shownMesh = (hash: string) => meshes.get(hash)?.preview ?? meshes.get(hash)?.final;

/** Room temperature when neither the analysis nor the brief gives one, °C. */
const ROOM_C = 25;

/**
 * A heat analysis with what the model decides filled in: heat: "auto" becomes each analysed electronic part's
 * own loss at its working current (from the machine's power budget), and an unset ambient: the brief's hottest
 * service temperature. A component that has its own source() keeps that instead of its worked-out loss.
 */
export function resolveThermal(spec: StructuralSpec, model: Model): StructuralSpec {
  const t = spec.thermal;
  if (!t) return spec;
  let heat = t.heat;
  if (t.auto) {
    const ids = new Set(model.parts.filter((p) => spec.parts.includes(p.name)).map((p) => p.id));
    const own = new Set(t.heat.flatMap((h) => (h.part ? [h.part] : [])));
    const auto: HeatLoadSpec[] = componentLosses(model)
      .filter((l) => ids.has(l.id) && !own.has(l.comp) && l.watts > 0)
      .map((l) => ({ id: l.id, watts: l.watts, label: l.label, why: l.why }));
    heat = [...t.heat, ...auto];
  }
  const brief = model.brief?.temp;
  const ambient = t.ambient ?? (brief ? brief[1] : ROOM_C);
  const ambientWhy =
    t.ambient !== undefined ? "the analysis's ambient:" : brief ? `the brief's hottest service temperature${model.brief?.assumed.includes("temp") ? ", assumed" : ""}` : "room temperature on a warm day";
  return { ...spec, thermal: { ...t, heat, ambient, ambientWhy } };
}

/**
 * The surface a part is made with, for its fatigue strength: machined, cast, rolled sheet or printed, from its process.
 * Bought parts (no process) count as machined.
 */
export function partFinish(p: EvalPart): Finish {
  switch (p.process?.id) {
    case "die_cast":
    case "sand_cast":
    case "investment_cast":
      return "cast";
    case "metal_print":
    case "fdm":
    case "sla":
    case "sls":
      return "printed";
    default:
      return "machined";
  }
}

/**
 * How a part is printed for an analysis, or undefined when it is not printed in layers: an fdm process, or no process
 * and a filament material (any plastic with printed:, none with printed: false). Walls, skins and infill come from its
 * process settings (Kerf's defaults otherwise); its layers stack the way the analysis's build: says, else its process's
 * build:, else the way the build pack lays it on the bed. rot turns a direction from the part's frame to the world.
 */
export function partPrint(spec: StructuralSpec, p: EvalPart, m: MechMaterial, mesh: MeshData, rot: (v: [number, number, number]) => [number, number, number]): PartPrint | undefined {
  if (spec.printed === false) return undefined;
  const proc = p.process?.id;
  const fdm = proc === "fdm" || (!proc && (m.printedByDefault || (spec.printed === true && m.layerFactor < 1)));
  if (!fdm) return undefined;
  const fp = fdmPrint(p.process);
  const given = p.process?.settings.build;
  const own = Array.isArray(given) && typeof given[0] === "number" ? (given as [number, number, number]) : undefined;
  const unit = (v: [number, number, number]): [number, number, number] => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const build = spec.buildGiven ? unit(spec.buildDir) : unit(rot(own ?? printUp(mesh.positions, mesh.indices)));
  return {
    build,
    wall: fp.walls * fp.line,
    skin: fp.top * fp.layer,
    infill: fp.infill,
    pattern: fp.pattern,
    words: printWords(fp),
    from: spec.buildGiven ? "analysis" : own ? "process" : "bed",
  };
}

const numberOr = (v: unknown, d: number) => (typeof v === "number" && v > 0 ? v : d);

/** What an analysis asks for that thin-wall shells do not solve, in words. */
function shellsCannot(spec: StructuralSpec): string {
  if (spec.modal) return "modal: (vibration modes)";
  if (spec.drop) return "drop:";
  if (spec.thermal || spec.uniformTemp !== undefined) return "heat";
  if (spec.fatigue) return "fatigue:";
  if (spec.topology) return "topology:";
  if (spec.touching) return "touching:";
  if (spec.preload) return "preload:";
  return "large:";
}

/** Library parts that join others (and stay glued to them under touching: "all"). */
const JOINING_KINDS = new Set(["screw", "bolt", "nut", "insert", "washer", "standoff", "rivet"]);

/** World-space meshes and properties of the parts an analysis names; null while geometry is still building. */
export function structuralInput(
  spec: StructuralSpec,
  parts: EvalPart[],
  fine: boolean,
  buildErrors: Map<string, string>,
  meshOf: (hash: string) => MeshData | undefined = shownMesh,
): { input?: StructuralInput; error?: string } | null {
  if (!parts.length) return { error: `None of ${spec.parts.join(", ")} has geometry to analyse.` };
  const broken = parts.find((p) => buildErrors.has(p.hash));
  if (broken) return { error: `${broken.label} did not build, so it cannot be analysed yet.` };
  const th = spec.thermal;
  if (th && !th.heat.length && !th.currents?.length && !th.fixed.length)
    return { error: `heat: "auto" found no electronics that use power among ${spec.parts.join(", ")}, so nothing makes heat. Add source(part, watts) for what gets hot.` };
  const temps = !!th || spec.uniformTemp !== undefined;
  // a frame on its own is analysed as beams through its joints, unless asked for solids or for what beams cannot follow
  const beamsCan = !spec.modal && !spec.drop && !temps && !spec.fatigue && !spec.topology && !spec.touching && !spec.preload && !spec.large;
  const notBeam = parts.find((p) => !p.beam);
  if (spec.elements === "beams" && notBeam)
    return { error: `elements: "beams" analyses frame members, and ${notBeam.label} is not one. Analyse the frame on its own, or use elements: "solid" to analyse it with the other parts.` };
  const beams = spec.elements === "beams" || (spec.elements === undefined && !notBeam && beamsCan);
  // a carbon layup is a laminate under its outer surface and a sheet() part a sheet of its thickness: both are analysed as shells
  // when everything analysed is one, unless asked for solids or for what shells cannot follow (the same list as beams)
  const shellOf = (p: EvalPart): ShellPart | undefined =>
    p.process?.id === "carbon_layup"
      ? { kind: "laminate", t: numberOr(resolvedSettings(p.process).wall, 1.2) }
      : p.sheet
        ? { kind: "sheet", t: p.sheet.t }
        : spec.elements === "shells"
          ? { kind: "wall" }
          : undefined;
  const shellsAuto = spec.elements === undefined && !beams && beamsCan && parts.every((p) => shellOf(p));
  const shells = spec.elements === "shells" || shellsAuto;
  // a carbon layup solved as solid looks far stiffer and stronger than its laminate: say so, and how to see it as one
  const solidLayups = shells ? [] : parts.filter((p) => p.process?.id === "carbon_layup");
  const layupWarning = solidLayups.length
    ? `${solidLayups.map((p) => p.label).join(", ")} ${solidLayups.length > 1 ? "are carbon layups" : "is a carbon layup"}, solved here as if solid carbon, which looks far stiffer and stronger than its ${fmtNum(numberOr(resolvedSettings(solidLayups[0].process!).wall, 1.2))} mm laminate: ${
        spec.elements === "solid" ? "leave elements: out to analyse it as a laminate shell" : !beamsCan ? `${shellsCannot(spec)} needs solid elements, so check its strength in an analysis without it` : "analyse it on its own (or with other layups and sheet parts) to see it as a laminate shell"
      }.`
    : undefined;
  if (spec.elements === "shells" && !beamsCan)
    return { error: `elements: "shells" solves strength, stiffness and buckling of thin walls; ${shellsCannot(spec)} needs solid elements. Use elements: "solid", or leave elements: out.` };
  const fea: FeaPart[] = [];
  const mats: MechMaterial[] = [];
  const thermalMats: ThermalMaterial[] = [];
  const electricMats: ElectricMaterial[] = [];
  const currents = !!th?.currents?.length;
  const finishes: Finish[] = [];
  const matIndex = new Map<string, number>();
  for (const p of parts) {
    const data = meshOf(p.hash);
    if (!data) return null;
    const name = spec.material ?? p.material;
    // with heat, a bought component of an unknown material is its own insides (copper, board and plastic), not a plastic
    const component = p.kind === "component";
    // with fatigue, the same material machined and cast has two S-N curves
    const finish = spec.fatigue ? (spec.fatigue.finish ?? partFinish(p)) : undefined;
    // a screw or bolt of a known grade is as strong as that grade says (an 8.8 bolt is not mild steel)
    const grade = !spec.material && p.fastener ? gradeFrom(p.fastener.grade) : undefined;
    const key = (temps ? `${name}|${component}` : name) + (finish ? `|${finish}` : "") + (grade ? `|${grade}` : "");
    let mi = matIndex.get(key);
    if (mi === undefined) {
      mi = mats.length;
      const mm = mechMaterial(name);
      mats.push(grade ? { ...mm, name: `${mm.name}, grade ${grade}`, yield: GRADES[grade].proof, uts: Math.max(GRADES[grade].uts, GRADES[grade].proof), assumed: false } : mm);
      if (temps) thermalMats.push(thermalMaterial(name, component));
      if (currents) electricMats.push(electricMaterial(name));
      if (finish) finishes.push(finish);
      matIndex.set(key, mi);
    }
    const m = xformMatrix(p.xf);
    const P = data.positions;
    const N = data.normals;
    const pos = new Float32Array(P.length);
    const nrm = new Float32Array(N.length);
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i],
        y = P[i + 1],
        z = P[i + 2];
      pos[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
      pos[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      pos[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      const a = N[i],
        b = N[i + 1],
        c = N[i + 2];
      nrm[i] = m[0] * a + m[4] * b + m[8] * c;
      nrm[i + 1] = m[1] * a + m[5] * b + m[9] * c;
      nrm[i + 2] = m[2] * a + m[6] * b + m[10] * c;
    }
    const print = partPrint(spec, p, mats[mi], data, (v) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2]]);
    // fasteners, nuts and inserts stay glued under touching: "all" (bolts are modelled bonded)
    const joining = !!p.fastener || JOINING_KINDS.has(p.libKind ?? "");
    // a screw or bolt can be tightened (preload:); a nut, insert or standoff is what its thread holds in
    const fi = p.fastener;
    const ts = fi ? threadSpec(fi.size) : undefined;
    const headH = fi?.head && ts ? headDims(fi.head as HeadType, ts)?.h : undefined;
    const bolt = fi && fi.head !== "set" ? { headTop: fi.headTop, outward: fi.outward, size: fi.size, headD: fi.headD, ...(headH !== undefined ? { headH } : {}), ...(fi.grade ? { grade: fi.grade } : {}) } : undefined;
    const threads = p.libKind === "nut" || p.libKind === "standoff" ? ("nut" as const) : p.libKind === "insert" ? ("insert" as const) : undefined;
    const beam = beams && p.beam ? { a: p.beam.a, b: p.beam.b, u: p.beam.u, v: p.beam.v, section: p.beam.section } : undefined;
    const shell = shells ? shellOf(p) : undefined;
    fea.push({ id: p.id, name: p.name, ...(p.frame ? { group: p.frame } : {}), ...(beam ? { beam } : {}), ...(shell ? { shell } : {}), mesh: { positions: pos, indices: Uint32Array.from(data.indices) }, normals: nrm, material: mi, ...(print ? { print } : {}), ...(joining ? { joining } : {}), ...(bolt ? { bolt } : {}), ...(threads ? { threads } : {}) });
  }
  // bolts tightened before the loads: the ones named, and with all every other screw and bolt analysed
  let preload: BoltWant[] | undefined;
  if (spec.preload) {
    const want = new Map<string, BoltWant>();
    for (const b of spec.preload.bolts) want.set(b.part, { ...b });
    if (spec.preload.all) for (const p of parts) if (p.fastener && p.fastener.head !== "set" && !want.has(p.name)) want.set(p.name, { part: p.name, ...spec.preload.all });
    if (!want.size) return { error: 'preload: "all" tightens every screw and bolt the analysis has, and it has none: name them in parts:, or list them, like preload: [screw_1, screw_2].' };
    preload = [...want.values()];
  }
  const res = fine ? "fine" : spec.resolution;
  const input: StructuralInput = {
    label: spec.label,
    parts: fea,
    materials: mats,
    supports: spec.supports,
    loads: spec.loads,
    accel: spec.accel,
    target: typeof res === "string" ? RESOLUTION_TARGET[res] : RESOLUTION_TARGET.standard,
    h: typeof res === "string" ? undefined : res.h,
    // each printed part carries its own print; the whole-analysis flag is only for callers that give none
    printed: fea.some((p) => !!p.print),
    buildDir: spec.buildDir,
    cycles: spec.cycles,
    safety: spec.safety,
    maxDeflection: spec.maxDeflection,
    masses: spec.masses,
    modes: spec.modal?.modes,
    drop: spec.drop,
    ...(th
      ? {
          thermal: {
            heat: th.heat,
            ...(th.currents?.length ? { currents: th.currents } : {}),
            fixed: th.fixed,
            cooling: th.cooling,
            coolingText: th.coolingText,
            films: th.films,
            ambient: th.ambient ?? ROOM_C,
            ...(th.ambientWhy ? { ambientWhy: th.ambientWhy } : {}),
            ...(th.emissivity !== undefined ? { emissivity: th.emissivity } : {}),
            ...(th.time !== undefined ? { time: th.time } : {}),
            ...(th.start !== undefined ? { start: th.start } : {}),
            ...(th.maxTemp !== undefined ? { maxTemp: th.maxTemp } : {}),
          },
        }
      : {}),
    ...(spec.uniformTemp !== undefined ? { uniformTemp: spec.uniformTemp } : {}),
    ...(spec.refTemp !== undefined ? { refTemp: spec.refTemp } : {}),
    ...(temps ? { thermalMaterials: thermalMats } : {}),
    ...(currents ? { electricMaterials: electricMats } : {}),
    ...(spec.buckling ? { buckling: { modes: spec.buckling.modes } } : {}),
    ...(spec.converge ? { converge: true } : {}),
    ...(spec.large !== undefined ? { large: spec.large } : {}),
    ...(beams ? { elements: "beams" as const } : {}),
    ...(shells ? { elements: "shells" as const, ...(shellsAuto ? { elementsAuto: true } : {}) } : {}),
    ...(layupWarning ? { inputWarnings: [layupWarning] } : {}),
    ...(spec.topology ? { topology: spec.topology } : {}),
    ...(spec.touching ? { touching: spec.touching } : {}),
    ...(preload ? { preload } : {}),
    ...(spec.fatigue
      ? {
          fatigue: {
            cycles: spec.fatigue.cycles,
            repeats: spec.fatigue.repeats,
            unit: spec.fatigue.unit,
            meanStress: spec.fatigue.meanStress,
            finishes,
            reliability: spec.fatigue.reliability,
            loading: spec.fatigue.loading,
          },
        }
      : {}),
  };
  return { input };
}

function inputKey(spec: StructuralSpec, parts: EvalPart[], fine: boolean, check = false): string {
  const { span: _span, ...rest } = spec;
  void _span;
  // how a part is made sets its print (walls, infill, layers) and its fatigue finish
  return JSON.stringify({ rest, fine, check, parts: parts.map((p) => [p.id, p.hash, p.xf, p.material, p.process ?? null]) });
}

const baseKey = (key: string) => key.replace(/"fine":(true|false)/, "").replace(/"check":(true|false)/, "");

// ---------- scheduling ----------

let scheduledRev = -1;

/** Queue runs for the analyses whose inputs changed in this revision. */
function schedule(state: Pick<ReportContext, "model" | "rev" | "buildErrors">) {
  const model = state.model;
  scheduledRev = state.rev;
  const specs = model.analyses.filter((a): a is StructuralSpec => a.kind === "structural");
  const labels = new Set(specs.map((s) => s.label));
  const runs = new Map(aGet().runs);
  let shown = aGet().shown;
  for (const label of runs.keys()) {
    if (labels.has(label)) continue;
    cancel(label);
    runs.delete(label);
    if (shown === label) shown = null;
  }
  for (const written of specs) {
    // heat: "auto" and the ambient come from the model, so a change to the wiring or the brief re-runs a heat analysis
    const spec = resolveThermal(written, model);
    // compare input keys first: meshes are only copied into world space when something changed
    const parts = model.parts.filter((p) => spec.parts.includes(p.name));
    const plainKey = inputKey(spec, parts, false);
    // a fine run (or an accuracy check) stays so until the inputs change
    const fine = fineWanted.get(spec.label) === baseKey(plainKey);
    if (!fine) fineWanted.delete(spec.label);
    const check = !!spec.converge || checkWanted.get(spec.label) === baseKey(plainKey);
    if (!check) checkWanted.delete(spec.label);
    const key = fine || check ? inputKey(spec, parts, fine, check) : plainKey;
    const run = runs.get(spec.label);
    if (run && run.key === key) continue;
    // a topology run takes many solves, so it runs only when asked; a change to the design leaves the last shape
    // found as it was, marked out of date, until it is asked for again
    if (spec.topology && topoWanted.get(spec.label) !== baseKey(plainKey)) {
      topoWanted.delete(spec.label);
      cancel(spec.label);
      const resolution = fine ? "fine" : typeof spec.resolution === "string" ? spec.resolution : `${fmtNum(spec.resolution.h)} mm`;
      runs.set(spec.label, { label: spec.label, key, fine, status: "idle", stage: "Ready to run", frac: 0, trace: [], stale: !!run?.result, result: run?.result, resolution, startedAt: performance.now() });
      continue;
    }
    const prep = structuralInput(spec, parts, fine, state.buildErrors);
    if (!prep) continue;
    if (prep.input && check) prep.input.converge = true;
    cancel(spec.label);
    const resolution = (fine ? "fine" : typeof spec.resolution === "string" ? spec.resolution : `${fmtNum(spec.resolution.h)} mm`) + (check ? ", accuracy check" : "");
    const base: StructuralRun = { label: spec.label, key, fine, check, status: "waiting", stage: "Waiting", frac: 0, trace: [], stale: !!run?.result, result: run?.result, resolution, startedAt: performance.now() };
    if (prep.error) runs.set(spec.label, { ...base, status: "error", error: prep.error, setup: true, result: undefined, stale: false });
    else {
      runs.set(spec.label, base);
      queue.push({ id: ++nextId, label: spec.label, key, input: prep.input! });
    }
  }
  aSet({ runs, shown });
  pump();
}

/** Solve one analysis twice, the second time with smaller elements, to see how far the answers move. */
export function runAccuracyCheck(label: string) {
  const run = aGet().runs.get(label);
  if (!run) return;
  checkWanted.set(label, baseKey(run.key));
  const s = useDesign.getState();
  aSet({ runs: new Map(aGet().runs).set(label, { ...run, key: "" }) });
  if (s.model) schedule({ model: s.model, rev: s.reportRev, buildErrors: s.buildErrors });
  refreshReport();
}

/** Re-run one analysis at the fine resolution. */
export function runFine(label: string) {
  const run = aGet().runs.get(label);
  if (!run) return;
  fineWanted.set(label, baseKey(run.key));
  const s = useDesign.getState();
  // force a fresh key comparison
  aSet({ runs: new Map(aGet().runs).set(label, { ...run, key: "" }) });
  if (s.model) schedule({ model: s.model, rev: s.reportRev, buildErrors: s.buildErrors });
  refreshReport();
}

/** Find the shape of a topology analysis (it runs only when asked, as it takes many solves). */
export function runTopology(label: string) {
  const run = aGet().runs.get(label);
  if (!run) return;
  topoWanted.set(label, baseKey(run.key));
  const s = useDesign.getState();
  aSet({ runs: new Map(aGet().runs).set(label, { ...run, key: "" }) });
  if (s.model) schedule({ model: s.model, rev: s.reportRev, buildErrors: s.buildErrors });
  refreshReport();
}

/** Stop a topology run (or one waiting to start): it goes back to ready, keeping any earlier shape. */
export function stopTopology(label: string) {
  const run = aGet().runs.get(label);
  if (!run || (run.status !== "running" && run.status !== "waiting")) return;
  topoWanted.delete(label);
  const wasCurrent = current?.label === label;
  cancel(label);
  patchRun(label, { status: "idle", stage: "Stopped", frac: 0, preview: undefined, stale: !!run.result });
  refreshReport();
  if (wasCurrent) pump();
}

/** Whether a topology analysis would run now, or is waiting to be asked. */
export const topologyIdle = (label: string) => aGet().runs.get(label)?.status === "idle";

// ---------- check items ----------

const ANALYSIS_ITEM = /^(fea|drive):/;
let drivetrainCache: { model: Model; results: Map<string, DrivetrainResult> } | null = null;

/** Drivetrain checks are formulas: worked out once per model. Only the live design's results go to the panel. */
function drivetrainResults(model: Model, live: boolean): Map<string, DrivetrainResult> {
  if (drivetrainCache?.model === model) return drivetrainCache.results;
  const results = new Map<string, DrivetrainResult>();
  for (const a of model.analyses) if (a.kind === "drivetrain") results.set(a.label, runDrivetrain(model, a as DrivetrainSpec));
  if (!live) return results;
  drivetrainCache = { model, results };
  aSet({ drivetrain: results });
  return results;
}

/**
 * The report pass: schedules runs for a new revision, then adds drivetrain
 * checks and the state of every structural analysis. A sub-agent's isolated
 * build gets the drivetrain checks; its stress analyses run after it merges.
 */
export function analysisItems(items: CheckItem[], ctx: ReportContext): CheckItem[] {
  const { model } = ctx;
  if (ctx.live && ctx.rev !== scheduledRev) schedule(ctx);
  let out = items.filter((i) => !ANALYSIS_ITEM.test(i.id));
  const dt = drivetrainResults(model, ctx.live);
  if (dt.size) out = out.filter((i) => i.id !== "analysis:loads");
  for (const r of dt.values()) out.push(...r.items);
  for (const a of model.analyses) {
    if (a.kind !== "structural") continue;
    if (ctx.live) out.push(...structuralItems(a, aGet().runs.get(a.label), model));
    else out.push({ id: `fea:${a.label}:strength`, category: "analysis", basis: "simulation", span: a.span, status: "info", title: `Strength: ${a.label}`, detail: "The stress analysis runs once this work is merged into the design." });
  }
  return out;
}

const fmtP = (p: number[]) => `(${p.map((v) => fmtNum(v, 1)).join(", ")})`;

/** The check items one structural result gives (or its error), for a model that is not the design (an alternative). */
export function structuralChecks(spec: StructuralSpec, model: Model, outcome: { result?: StructuralResult; error?: string }): CheckItem[] {
  const run: StructuralRun = { label: spec.label, key: "", fine: false, status: outcome.result ? "done" : "error", stage: "", frac: 1, trace: [], result: outcome.result, stale: false, error: outcome.error, resolution: "draft", startedAt: 0 };
  return structuralItems(spec, run, model);
}

function structuralItems(spec: StructuralSpec, run: StructuralRun | undefined, model: Model): CheckItem[] {
  const parts = model.parts.filter((p) => spec.parts.includes(p.name)).map((p) => p.id);
  const base = { category: "analysis" as const, basis: "simulation" as const, span: spec.span, parts };
  const id = (s: string) => `fea:${spec.label}:${s}`;
  if (spec.topology) return topologyItems(spec, run, base, id);
  const heatOnly = heatOnlySpec(spec);
  const what = spec.modal ? "vibration" : spec.drop ? "drop" : heatOnly ? "heat" : "stress";
  const category = spec.modal ? ("vibration" as const) : spec.drop ? ("knocks" as const) : ("analysis" as const);
  if (!run || run.status === "waiting" || run.status === "running") {
    return [{ ...base, category, id: id(heatOnly ? "temperature" : "strength"), status: "pending", title: `${spec.modal ? "Vibration" : spec.drop ? "Drop" : heatOnly ? "Temperature" : "Strength"}: ${spec.label}`, detail: run?.result ? `Re-running the ${what} analysis for the latest change…` : `Running the ${what} analysis…` }];
  }
  if (run.status === "error" || !run.result) {
    return [{ ...base, category, id: id("setup"), status: "fail", title: `${what[0].toUpperCase()}${what.slice(1)} analysis: ${spec.label}`, detail: run.error ?? "The analysis did not finish." }];
  }
  const r = run.result;
  const out: CheckItem[] = [];
  // temperatures: every heat analysis, and a set temperature: that takes a part past its limit
  const tv = temperatureVerdict(r);
  const tt = temperatureText(r);
  if (tv && tt && (spec.thermal || tv.status !== "pass"))
    out.push({ ...base, id: id("temperature"), status: tv.status, margin: tv.margin, title: `Temperature: ${spec.label}`, detail: tt.detail, ...(tt.fix ? { fix: tt.fix } : {}) });
  const acc = accuracyText(r);
  const accuracy = acc ? [{ ...base, id: id("accuracy"), status: acc.status, title: `Accuracy check: ${spec.label}`, detail: acc.detail }] : [];
  if (heatOnly) {
    out.push(...accuracy);
    if (r.warnings.length) out.push({ ...base, id: id("notes"), status: "info", title: `Accuracy notes: ${spec.label}`, detail: r.warnings.join(" ") });
    return out;
  }
  const st = staticSafety(r);
  const sf = st.value;
  const { status, note } = strengthVerdict(spec, r);
  out.push(...dynamicItems(spec, r, base, { status, note }));
  // modal and drop analyses report through their own items; a static strength line only when there are loads
  if (spec.drop || (spec.modal && !spec.loads.length && !spec.accel)) {
    if (r.warnings.length) out.push({ ...base, id: id("notes"), status: "info", title: `Accuracy notes: ${spec.label}`, detail: r.warnings.join(" ") });
    return out;
  }
  out.push({
    ...base,
    id: id("strength"),
    status,
    margin: sf - spec.safety,
    title: `Strength: ${spec.label}`,
    detail:
      `Peak ${fmtNum(r.maxStress.value, 1)} MPa (von Mises) near ${fmtP(r.maxStress.at)}${r.fatigue && Math.abs(r.fatigue.peak - 1) > 1e-6 ? ` under the loads as written; the history peaks at ${fmtNum(r.fatigue.peak, 2)}× them` : ""}. Lowest ${r.fatigue ? "static " : ""}safety factor ${fmtNum(sf, 2)} against the ${modeText(r, spec.cycles, st)}, target ${fmtNum(spec.safety, 2)}.` +
      ` Largest deflection ${fmtNum(r.maxDisp.value, 3)} mm.` +
      (r.thermal ? ` Includes thermal expansion from ${fmtNum(r.thermal.refTemp ?? 20, 0)} °C (no stress there) and plastics weakened where they are hot.` : "") +
      (r.printing?.length ? ` ${printingText(r)}` : "") +
      note,
  });
  const fv = fatigueVerdict(spec, r);
  const ft = fatigueText(spec, r);
  if (fv && ft) out.push({ ...base, id: id("fatigue"), status: fv.status, margin: fv.margin, title: `Fatigue: ${spec.label}`, detail: ft.detail, ...(ft.fix ? { fix: ft.fix } : {}) });
  const bv = bucklingVerdict(spec, r);
  const bt = bucklingText(spec, r);
  if (bv && bt)
    out.push({ ...base, id: id("buckling"), status: bv.status, ...(Number.isFinite(bv.margin) ? { margin: bv.margin } : {}), title: `Buckling: ${spec.label}`, detail: bt.detail, ...(bt.fix ? { fix: bt.fix } : {}) });
  out.push(...accuracy);
  if (spec.maxDeflection !== undefined) {
    const status = stiffnessVerdict(spec, r)!;
    out.push({
      ...base,
      id: id("stiffness"),
      status,
      margin: spec.maxDeflection - r.maxDisp.value,
      title: `Stiffness: ${spec.label}`,
      detail: `Largest deflection ${fmtNum(r.maxDisp.value, 3)} mm at ${fmtP(r.maxDisp.at)}, limit ${fmtNum(spec.maxDeflection, 3)} mm.${status === "warn" ? " The result is in doubt; the strength check says why." : ""}`,
    });
  }
  for (const c of contactVerdicts(spec, r)) out.push({ ...base, id: id(`contact${c.i}`), status: c.status, margin: c.margin, title: c.title, detail: c.detail, ...(c.fix ? { fix: c.fix } : {}) });
  const tc = touchingText(spec, r);
  if (tc) out.push({ ...base, id: id("touching"), status: tc.status, title: `Touching parts: ${spec.label}`, detail: tc.detail, ...(tc.fix ? { fix: tc.fix } : {}) });
  const tb = boltText(spec, r);
  if (tb) out.push({ ...base, id: id("bolts"), status: tb.status, title: `Tightened bolts: ${spec.label}`, detail: tb.detail, ...(tb.fix ? { fix: tb.fix } : {}) });
  if (r.warnings.length) out.push({ ...base, id: id("notes"), status: "info", title: `Accuracy notes: ${spec.label}`, detail: r.warnings.join(" ") });
  return out;
}

/**
 * A topology optimisation is a suggestion, not the design: its items say what shape it found and how that shape holds
 * up, as information. Only a set-up that cannot be solved fails.
 */
function topologyItems(spec: StructuralSpec, run: StructuralRun | undefined, base: Omit<CheckItem, "id" | "status" | "title" | "detail">, id: (s: string) => string): CheckItem[] {
  const title = `Topology: ${spec.label}`;
  if (!run || run.status === "idle") {
    if (run?.result?.topology) return [{ ...base, id: id("topology"), status: "info", title, detail: `Out of date: the design changed since this shape was found; run it again to update it. ${topologyText(spec, run.result).detail}` }];
    return [{ ...base, id: id("topology"), status: "info", title, detail: "Ready to find the shape: press Run in the Analysis tab, or ask Claude to run it. It runs only when asked, as it takes many solves." }];
  }
  if (run.status === "waiting" || run.status === "running") return [{ ...base, id: id("topology"), status: "info", title, detail: "Finding the shape; the Analysis tab shows it as it forms." }];
  if (run.status === "error" || !run.result?.topology) return [{ ...base, id: id("setup"), status: "fail", title: `Topology optimisation: ${spec.label}`, detail: run.error ?? "Finding the shape did not finish." }];
  const tx = topologyText(spec, run.result);
  return [{ ...base, id: id("topology"), status: "info", title, detail: `${tx.detail} ${topologyNext(run.result.topology)}`, ...(tx.fix ? { fix: tx.fix } : {}) }];
}

// ---------- start-up and waiting ----------

let started = false;

/** Hook the runtime to the design engine: its report pass schedules runs and adds their results to every report. */
export function startAnalysisRuntime() {
  if (started) return;
  started = true;
  registerReportPass("analyses", analysisItems, 20);
  // a report composed before the runtime started has no analysis items yet
  refreshReport();
}

/**
 * Resolves when every structural analysis of the current design has a result or an error. A topology run counts only
 * when it is one of the labels given to wait for: it takes long and runs only when asked.
 */
export function whenAnalyzed(timeoutMs = 180_000, topology: string[] = []): Promise<void> {
  const done = () => {
    const d = useDesign.getState();
    if (!d.model || d.reportRev < d.rev) return false;
    if (scheduledRev < d.reportRev) return false;
    return d.model.analyses.every((a) => {
      if (a.kind !== "structural") return true;
      const st = aGet().runs.get(a.label)?.status ?? "";
      if (a.topology && !topology.includes(a.label)) return st !== "";
      return ["done", "error", "idle"].includes(st) && !(a.topology && st === "idle" && topoWanted.has(a.label));
    });
  };
  return new Promise((resolve) => {
    if (done()) return resolve();
    const finish = () => {
      clearTimeout(timer);
      u1();
      u2();
      resolve();
    };
    const check = () => done() && finish();
    const u1 = useAnalysis.subscribe(check);
    const u2 = useDesign.subscribe(check);
    const timer = setTimeout(finish, timeoutMs);
  });
}

/** Choose which analysis is drawn on the model (null hides results). */
export function showResults(label: string | null) {
  if (label !== aGet().shown) aSet({ mode: null });
  aSet({ shown: label });
}
