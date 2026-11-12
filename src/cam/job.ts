// A CNC job for one part and one setup, as the toolpaths panel and Claude's tool set it up: which way the tool
// comes from, how the stock is held and how much there is round the part, the end mills and the machine (from
// the part's process and its machine profile when it has one), and the controller the G-code is for.

import { create } from "zustand";
import type { EvalPart, Model } from "../core/model";
import { meshes, useDesign, whenRefined } from "../core/engine";
import { useView } from "../app/view";
import { errorText, toast } from "../app/ui";
import { download } from "../persist/files";
import { zip } from "../persist/zip";
import { resolveRules, resolvedSettings } from "../mfg/profiles";
import { specOnMachine } from "../mfg/machines";
import { userMachines } from "../mfg/userMachines";
import type { CamTool, Hold } from "./plan";
import { DEFAULT_SETTINGS } from "./plan";
import type { Frame } from "./feeds";
import { writeGcode, type GcodeFile, type Post } from "./gcode";
import type { CamRequest, CamResult } from "./compute";
import type { CamWorkerRequest, CamWorkerResponse } from "./cam.worker";

type V3 = [number, number, number];

export interface CamJob {
  /** the part's id */
  part: string;
  /** the way the tool comes from, in the part's own frame */
  setup: V3;
  hold: Hold;
  margin: number;
  above: number;
  below: number;
  tools: CamTool[];
  frame: Frame;
  rpm: number;
  material: string;
  post: Post;
  allowance: number;
  stepover: number;
  tabs: { count: number; width: number; height: number };
  climb: boolean;
}

/** The directions a setup can come from, as the panel offers them. */
export const SETUPS: { dir: V3; label: string; up: string }[] = [
  { dir: [0, 0, 1], label: "Top (+Z)", up: "top" },
  { dir: [0, 0, -1], label: "Bottom (−Z)", up: "bottom" },
  { dir: [1, 0, 0], label: "Right (+X)", up: "right side" },
  { dir: [-1, 0, 0], label: "Left (−X)", up: "left side" },
  { dir: [0, 1, 0], label: "Back (+Y)", up: "back" },
  { dir: [0, -1, 0], label: "Front (−Y)", up: "front" },
];

const sameDir = (a: readonly number[], b: readonly number[]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 1e-6;

/** The setups the part's process names (cnc_mill setups:), in order. */
export function processSetups(part: EvalPart): V3[] {
  if (part.process?.id !== "cnc_mill") return [];
  const { spec } = specOnMachine(part.process, userMachines());
  const s = resolvedSettings(spec).setups;
  return Array.isArray(s) ? (s.filter((d) => Array.isArray(d) && d.length === 3 && d.every((x) => Number.isFinite(x))) as V3[]) : [];
}

/** The directions the panel offers for a part: its process's setups first, then the rest. */
export function setupChoices(part: EvalPart): { dir: V3; label: string }[] {
  const own = processSetups(part);
  const name = (d: V3) => SETUPS.find((s) => sameDir(s.dir, d))?.label ?? `(${d.map((x) => +x.toFixed(3)).join(", ")})`;
  return [
    ...own.map((d, i) => ({ dir: d, label: `Setup ${i + 1} of ${own.length}: ${name(d)}` })),
    ...SETUPS.filter((s) => !own.some((d) => sameDir(d, s.dir))).map((s) => ({ dir: s.dir, label: `From the ${s.label.replace(/^[A-Z]/, (c) => c.toLowerCase())}` })),
  ];
}

/** How the G-code names the setup: "setup 1 of 2: top up" for the process's own, "setup right side up" for another. */
export function setupName(job: CamJob, part: EvalPart): string {
  const own = processSetups(part);
  const up = SETUPS.find((s) => sameDir(s.dir, job.setup))?.up ?? "tilted";
  const i = own.findIndex((d) => sameDir(d, job.setup));
  return i >= 0 ? `setup ${i + 1} of ${own.length}: ${up} up` : `setup ${up} up`;
}

const DEFAULT_TOOLS: CamTool[] = [
  { d: 6, reach: 22 },
  { d: 3, reach: 12 },
];

/** A job for a part as its process (and the machine it names, or the one set in Settings → Making) describes it. */
export function jobFor(part: EvalPart): CamJob {
  let tools = DEFAULT_TOOLS;
  let frame: Frame = "router";
  let rpm = 24000;
  let setup: V3 = [0, 0, 1];
  if (part.process?.id === "cnc_mill") {
    const { spec } = specOnMachine(part.process, userMachines());
    const mc = resolveRules(spec, part.material).machining;
    if (mc) {
      // largest first, so T1 is the one that cuts first
      tools = mc.tools.map(([d, reach]) => ({ d, reach })).sort((a, b) => b.d - a.d);
      frame = mc.frame.name === "router" || mc.frame.name === "benchtop" ? mc.frame.name : "vmc";
      rpm = mc.rpm;
    }
    const own = processSetups(part);
    if (own.length) setup = own[0];
  }
  const sheet = frame === "router";
  return {
    part: part.id,
    setup,
    hold: sheet ? "tabs" : "base",
    margin: sheet ? 6 : 3,
    above: sheet ? 0 : 1,
    below: sheet ? 0 : 5,
    tools,
    frame,
    rpm,
    material: part.material,
    post: "grbl",
    allowance: DEFAULT_SETTINGS.allowance,
    stepover: DEFAULT_SETTINGS.stepover,
    tabs: { ...DEFAULT_SETTINGS.tabs },
    climb: true,
  };
}

/** The request the planner takes, with the part's triangles. */
export function requestFor(job: CamJob, mesh: CamRequest["mesh"]): CamRequest {
  return {
    mesh,
    setup: job.setup,
    margin: job.margin,
    above: job.above,
    below: job.hold === "base" ? Math.max(job.below, 0.5) : 0,
    settings: {
      tools: job.tools,
      material: job.material,
      frame: job.frame,
      rpmMax: job.rpm,
      hold: job.hold,
      allowance: job.allowance,
      stepover: job.stepover,
      tabs: job.tabs,
      through: DEFAULT_SETTINGS.through,
      safe: DEFAULT_SETTINGS.safe,
      climb: job.climb,
    },
  };
}

/** a plan dropped for a newer one */
const SUPERSEDED = "superseded";

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, { resolve: (r: CamResult) => void; reject: (e: Error) => void }>();

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./cam.worker.ts", import.meta.url), { type: "module", name: "kerf-cam" });
  w.onmessage = (ev: MessageEvent<CamWorkerResponse>) => {
    const msg = ev.data;
    const p = waiting.get(msg.id);
    if (!p) return;
    waiting.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  };
  w.onerror = (e) => {
    for (const p of waiting.values()) p.reject(new Error(e.message || "The toolpath planner stopped"));
    waiting.clear();
    worker?.terminate();
    worker = null;
  };
  worker = w;
  return w;
}

/** The part's finest triangles (once the design has refined them). */
export async function partMesh(part: EvalPart): Promise<CamRequest["mesh"] | null> {
  await whenRefined(60_000).catch(() => undefined);
  const m = meshes.get(part.hash);
  const data = m?.final ?? m?.preview;
  return data ? { positions: data.positions, indices: data.indices } : null;
}

/** Plan a job's toolpaths in the worker (or here, where there are no workers). A plan still running is dropped. */
export async function planJob(job: CamJob, part: EvalPart): Promise<CamResult> {
  const mesh = await partMesh(part);
  if (!mesh) throw new Error(`${part.label} has not built yet`);
  const req = requestFor(job, { positions: new Float32Array(mesh.positions), indices: new Uint32Array(mesh.indices) });
  if (typeof Worker === "undefined") {
    const { computeCam } = await import("./compute");
    return computeCam(req);
  }
  if (waiting.size && worker) {
    // a newer job replaces the one still planning: start the worker afresh rather than wait for it
    for (const p of waiting.values()) p.reject(new Error(SUPERSEDED));
    waiting.clear();
    worker.terminate();
    worker = null;
  }
  const id = nextId++;
  const w = ensureWorker();
  return new Promise<CamResult>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    const msg: CamWorkerRequest = { id, req };
    w.postMessage(msg);
  });
}


/** The toolpaths panel's state: open, its job, the last plan and how far through it the preview shows. */
export const useCam = create<{
  open: boolean;
  job: CamJob | null;
  result: CamResult | null;
  /** the job the result was planned for */
  planned: string;
  busy: boolean;
  error: string;
  /** 0..1 of the way through the cutting, for the preview */
  t: number;
  show: { paths: boolean; stock: boolean };
}>(() => ({ open: false, job: null, result: null, planned: "", busy: false, error: "", t: 1, show: { paths: true, stock: true } }));

export const jobKey = (j: CamJob | null) => (j ? JSON.stringify(j) : "");

/** The parts Kerf can plan toolpaths for: the design's own, CNC-milled ones first. */
export function camParts(model: Model | null | undefined): EvalPart[] {
  const own = (model?.parts ?? []).filter((p) => p.kind === "part");
  const mill = (p: EvalPart) => (p.process?.id === "cnc_mill" ? 0 : 1);
  return own.slice().sort((a, b) => mill(a) - mill(b) || a.label.localeCompare(b.label));
}

export function camPart(id: string | undefined): EvalPart | undefined {
  return id ? useDesign.getState().model?.parts.find((p) => p.id === id) : undefined;
}

/** Open the toolpaths panel on a part: the one named, else a selected one, else the last, else the first milled. */
export function openCam(partId?: string): boolean {
  const list = camParts(useDesign.getState().model);
  const sel = useView.getState().selected;
  const cur = useCam.getState().job;
  const want = partId ?? sel.find((id) => list.some((p) => p.id === id)) ?? (cur && list.some((p) => p.id === cur.part) ? cur.part : undefined) ?? list[0]?.id;
  const part = list.find((p) => p.id === want);
  if (!part) {
    toast({ kind: "info", title: "No parts to machine", detail: "Toolpaths are for the design's own parts: bought parts come made." });
    return false;
  }
  useCam.setState({ open: true, job: cur && cur.part === part.id ? cur : jobFor(part), error: "" });
  return true;
}

export const closeCam = () => useCam.setState({ open: false });

let gen = 0;

/** Plan the panel's job, unless the last plan was for this very job and part. */
export async function replan(force = false): Promise<CamResult | null> {
  const { job } = useCam.getState();
  const part = camPart(job?.part);
  if (!job || !part) return null;
  const key = `${jobKey(job)}|${part.hash}`;
  const st = useCam.getState();
  if (!force && st.planned === key && st.result) return st.result;
  const my = ++gen;
  useCam.setState({ busy: true, error: "" });
  try {
    const result = await planJob(job, part);
    if (my !== gen) return null;
    useCam.setState({ result, planned: key, busy: false, t: 1 });
    return result;
  } catch (e) {
    if (my !== gen) return null;
    const msg = errorText(e);
    useCam.setState({ busy: false, error: msg === SUPERSEDED ? "" : msg });
    return null;
  }
}

/** A file name's worth of a label. */
const stemOf = (s: string) => s.replace(/[^A-Za-z0-9 _.-]+/g, "").replace(/\s+/g, " ").trim().slice(0, 60) || "part";

/** The panel's plan as G-code files for its controller. */
export function gcodeFiles(job: CamJob, result: CamResult, part: EvalPart): GcodeFile[] {
  return writeGcode(result.plan, job.post, stemOf(part.label), setupName(job, part));
}

/** Save the panel's plan as G-code: one file, or a zip of a file per tool. */
export async function saveGcode(): Promise<GcodeFile[] | null> {
  const { job, result } = useCam.getState();
  const part = camPart(job?.part);
  if (!job || !result || !part || !result.plan.ops.length) return null;
  const files = gcodeFiles(job, result, part);
  if (files.length === 1) download(files[0].text, files[0].name, "text/plain");
  else {
    const bytes = await zip(files.map((f) => ({ name: f.name, data: f.text })));
    download(bytes, `${stemOf(part.label)} ${setupName(job, part).split(":")[0]} G-code.zip`, "application/zip");
  }
  toast({
    kind: "success",
    title: files.length === 1 ? `Saved ${files[0].name}` : `Saved ${files.length} G-code files`,
    detail: files.length === 1 ? "Zero X and Y on the stock's front left corner and Z on its top." : "A file per tool: fit the next tool and zero Z on the stock top before each one.",
  });
  return files;
}
