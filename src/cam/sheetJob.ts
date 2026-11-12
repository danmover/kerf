// Cutting the design's flat parts out of sheet on a laser, plasma table or waterjet, as the sheet cutting panel and
// Claude's sheet_layout tool set it up: which parts (plates, and sheet-metal parts by their flat patterns), grouped
// by material and thickness since each group is its own stock; how many of each; the cutter and its settings (from
// the parts' laser_cut process and the machine it names, or the one set in Settings → Making); and the nested
// sheets with their cuts, worked out in a worker.

import { create } from "zustand";
import type { EvalPart, Model } from "../core/model";
import { meshes, useDesign, whenRefined } from "../core/engine";
import { kernel } from "../kernel/client";
import { flatPart } from "../drawing/flat";
import { copiesOf } from "../drawing/copies";
import { useView } from "../app/view";
import { errorText, toast } from "../app/ui";
import { download, safeFileName } from "../persist/files";
import { zip } from "../persist/zip";
import { resolveRules, resolvedSettings } from "../mfg/profiles";
import { specOnMachine } from "../mfg/machines";
import { userMachines } from "../mfg/userMachines";
import { cutterFit, materialInfo } from "../mfg/materials";
import type { ProcessSpec } from "../mfg/types";
import { area, bounds, type Region } from "./clip";
import type { CamMesh } from "./slice";
import {
  CUTTERS,
  computeSheets,
  cutStats,
  cutTimeline,
  cutterDefaults,
  isLaser,
  profilesOf,
  sheetDxf,
  sheetGcode,
  sheetSvg,
  type Cutter,
  type CutterSettings,
  type FlatProfile,
  type ProfileItem,
  type SheetRequest,
  type SheetResult,
} from "./sheet";
import type { SheetWorkerRequest, SheetWorkerResponse } from "./sheet.worker";
import { useCam } from "./job";

type V3 = [number, number, number];

/** One shape to cut: a part and its copies. */
export interface SheetItem {
  /** the shape's hash (copies share it) */
  key: string;
  label: string;
  /** the design's parts of this shape */
  ids: string[];
  names: string[];
  /** how many the design uses */
  count: number;
  /** the outline and holes, in the plate's own plane */
  region: Region;
  /** not the same all the way through (pockets, steps, chamfers): only the outline and through holes are cut */
  stepped: boolean;
  /** made by laser_cut, a sheet-metal part's flat pattern, or just a flat part made some other way */
  how: "laser" | "sheet" | "flat";
}

/** The shapes cut from one stock: a material in one thickness. */
export interface SheetGroup {
  key: string;
  material: string;
  thickness: number;
  items: SheetItem[];
}

export interface SheetJob {
  /** the group's key */
  group: string;
  /** how many of each shape a set has, by key; left out: as many as the design uses */
  qty: Record<string, number>;
  sets: number;
  cutter: Cutter;
  /** the sheet, x by y, mm */
  sheet: [number, number];
  gap: number;
  margin: number;
  rotate: boolean;
  kerf: number;
  lead: number;
  overcut: number;
  speed: number;
  power: number;
  passes: number;
  pierceDelay: number;
}

/** A plate is no thicker than this, mm, and than this share of its next size. */
const PLATE_T = 30;
const PLATE_RATIO = 0.4;

const madePart = (p: EvalPart) => p.kind === "part" && !p.imported && !p.hidden;

/** The way through the plate its laser_cut process gives, if it gives one. */
function processNormal(p: EvalPart): V3 | null {
  if (p.process?.id !== "laser_cut") return null;
  const { spec } = specOnMachine(p.process, userMachines());
  return resolveRules(spec, p.material).profile?.normal ?? null;
}

function plateLike(b: [V3, V3]): boolean {
  const s = [b[1][0] - b[0][0], b[1][1] - b[0][1], b[1][2] - b[0][2]].sort((x, y) => x - y);
  return s[0] > 1e-6 && s[0] <= PLATE_T && s[0] <= PLATE_RATIO * s[1];
}

/** Whether the design has anything to cut from sheet, by a quick look (for showing menu entries). */
export function hasSheetParts(model: Model | null | undefined): boolean {
  return !!model?.parts.some((p) => {
    if (!madePart(p)) return false;
    if (p.sheet || p.process?.id === "laser_cut") return true;
    const b = meshes.get(p.hash)?.bbox;
    return !!b && plateLike(b);
  });
}

// ---------- the worker ----------

/** a layout dropped for a newer one */
const SUPERSEDED = "superseded";

type Pending = { kind: SheetWorkerRequest["kind"]; resolve: (r: unknown) => void; reject: (e: Error) => void };
let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, Pending>();

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./sheet.worker.ts", import.meta.url), { type: "module", name: "kerf-sheet" });
  w.onmessage = (ev: MessageEvent<SheetWorkerResponse>) => {
    const msg = ev.data;
    const p = waiting.get(msg.id);
    if (!p) return;
    waiting.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  };
  w.onerror = (e) => {
    for (const p of waiting.values()) p.reject(new Error(e.message || "The sheet nester stopped"));
    waiting.clear();
    worker?.terminate();
    worker = null;
  };
  worker = w;
  return w;
}

type Call = { kind: "profiles"; items: ProfileItem[] } | { kind: "sheets"; req: SheetRequest };

function call<R>(m: Call): Promise<R> {
  if (typeof Worker === "undefined") return Promise.resolve((m.kind === "profiles" ? profilesOf(m.items) : computeSheets(m.req)) as R);
  // a newer layout replaces one still nesting: start the worker afresh rather than wait for it
  if (m.kind === "sheets" && worker && waiting.size && [...waiting.values()].every((p) => p.kind === "sheets")) {
    for (const p of waiting.values()) p.reject(new Error(SUPERSEDED));
    waiting.clear();
    worker.terminate();
    worker = null;
  }
  const id = nextId++;
  const w = ensureWorker();
  return new Promise<R>((resolve, reject) => {
    waiting.set(id, { kind: m.kind, resolve: resolve as (r: unknown) => void, reject });
    w.postMessage({ id, ...m } as SheetWorkerRequest);
  });
}

// ---------- the parts ----------

/** profiles by shape and the way through, so an edit only slices the parts it changed */
const profiles = new Map<string, FlatProfile | null>();
/** flat patterns' triangles, by their hash */
const flatMeshes = new Map<string, CamMesh>();

async function flatMesh(p: EvalPart): Promise<CamMesh | null> {
  const f = flatPart(p);
  const hit = flatMeshes.get(f.hash);
  if (hit) return hit;
  let mesh = null as CamMesh | null;
  await kernel.build([{ hash: f.hash, recipe: f.recipe, label: `${p.label} flat pattern` }], "final", (r) => (mesh = { positions: r.mesh.positions, indices: r.mesh.indices }), () => undefined).done;
  if (mesh) {
    flatMeshes.set(f.hash, mesh);
    while (flatMeshes.size > 64) flatMeshes.delete(flatMeshes.keys().next().value!);
  }
  return mesh;
}

/**
 * The design's parts that can be cut from sheet, by material and thickness: laser_cut parts, sheet-metal parts (by
 * their flat patterns) and any other plate of the same thickness all through. Groups with parts made by cutting come
 * first.
 */
export async function gatherSheets(model: Model | null | undefined = useDesign.getState().model): Promise<SheetGroup[]> {
  if (!model) return [];
  await whenRefined(60_000).catch(() => undefined);
  const shapes = new Map<string, { parts: EvalPart[]; how: SheetItem["how"]; normal: V3 | null }>();
  const made = model.parts.filter(madePart);
  // parts that are another part moved or turned (six feet typed out one by one) are that part again
  const copy = copiesOf(
    made.filter((p) => !p.sheet),
    (p) => meshes.get(p.hash)?.final ?? meshes.get(p.hash)?.preview,
  );
  const byName = new Map(made.map((p) => [p.name, p]));
  for (const p of made) {
    const src = p.sheet ? undefined : byName.get(copy.get(p.name) ?? "");
    const key = p.sheet ? p.sheet.flatHash : (src ?? p).hash;
    const hit = shapes.get(key);
    if (hit) hit.parts.push(p);
    else shapes.set(key, { parts: [p], how: p.sheet ? "sheet" : p.process?.id === "laser_cut" ? "laser" : "flat", normal: p.sheet ? [0, 0, 1] : processNormal(p) });
  }
  const cacheKey = (key: string, normal: V3 | null) => `${key}|${normal?.join(",") ?? ""}`;
  const todo: ProfileItem[] = [];
  for (const [key, s] of shapes) {
    const ck = cacheKey(key, s.normal);
    if (profiles.has(ck)) continue;
    const p = s.parts[0];
    if (s.how === "sheet") {
      const mesh = await flatMesh(p);
      if (mesh) todo.push({ key: ck, mesh, normal: s.normal });
      continue;
    }
    const m = meshes.get(p.hash);
    const data = m?.final ?? m?.preview;
    if (!m || !data) continue;
    if (s.how === "flat" && !plateLike(m.bbox)) {
      profiles.set(ck, null);
      continue;
    }
    todo.push({ key: ck, mesh: { positions: data.positions, indices: data.indices }, normal: s.normal });
  }
  if (todo.length) {
    const got = await call<{ key: string; profile: FlatProfile | null }[]>({ kind: "profiles", items: todo });
    for (const g of got) profiles.set(g.key, g.profile);
    while (profiles.size > 600) profiles.delete(profiles.keys().next().value!);
  }
  const groups = new Map<string, SheetGroup>();
  for (const [key, s] of shapes) {
    const prof = profiles.get(cacheKey(key, s.normal));
    if (!prof || (s.how === "flat" && prof.stepped)) continue;
    const p = s.parts[0];
    const thickness = Math.round((s.how === "sheet" ? p.sheet!.t : prof.thickness) * 100) / 100;
    const material = p.material?.trim() || "Unspecified material";
    const gk = `${material.toLowerCase()}|${thickness}`;
    const g = groups.get(gk) ?? { key: gk, material, thickness, items: [] };
    g.items.push({ key, label: p.label, ids: s.parts.map((x) => x.id), names: [...new Set(s.parts.map((x) => x.name))], count: s.parts.length, region: prof.region, stepped: s.how !== "sheet" && prof.stepped, how: s.how });
    groups.set(gk, g);
  }
  const cut = (g: SheetGroup) => (g.items.some((i) => i.how !== "flat") ? 0 : 1);
  for (const g of groups.values()) g.items.sort((a, b) => area(b.region) - area(a.region) || a.label.localeCompare(b.label));
  return [...groups.values()].sort((a, b) => cut(a) - cut(b) || b.items.length - a.items.length || a.key.localeCompare(b.key));
}

/** How many of an item the job cuts in all: per set (what the panel set, else the design's count; none of the
 *  merely flat parts when the group has parts made by cutting), times the sets. */
export function qtyOf(job: SheetJob, g: SheetGroup, it: SheetItem): number {
  return perSet(job, g, it) * job.sets;
}

export function perSet(job: SheetJob, g: SheetGroup, it: SheetItem): number {
  const set = job.qty[it.key];
  return set ?? (it.how === "flat" && g.items.some((i) => i.how !== "flat") ? 0 : it.count);
}

// ---------- the cutter ----------

/** The cutter that suits a material best: one that cuts it cleanly, else one that cuts it at all. */
export function pickCutter(material: string, t: number): Cutter {
  const metal = materialInfo(material).family === "metal";
  const order: Cutter[] = metal ? (t > 12 ? ["plasma", "waterjet", "fiber"] : ["fiber", "plasma", "waterjet"]) : ["co2", "waterjet", "diode"];
  return order.find((c) => cutterFit(c, material).status === "pass") ?? order.find((c) => cutterFit(c, material).status === "warn") ?? "waterjet";
}

/** Common sheet sizes, mm. */
export const SHEET_SIZES: [number, number][] = [
  [400, 400],
  [600, 400],
  [800, 600],
  [1220, 610],
  [1220, 1220],
  [2440, 1220],
  [2500, 1250],
  [3000, 1500],
];

/**
 * The sheet a job starts on when no machine says: the smallest common sheet that takes every part at once, up to
 * the size the cutter usually works (a desktop laser's bed, a full sheet of metal); else that size; else a bigger
 * one the largest part fits.
 */
function defaultSheet(cutter: Cutter, g: SheetGroup, margin: number, gap: number): [number, number] {
  const usual: [number, number] = cutter === "diode" ? [400, 400] : cutter === "co2" ? [600, 400] : cutter === "plasma" ? [1250, 1250] : [2500, 1250];
  const start = { qty: {}, sets: 1 } as unknown as SheetJob;
  const boxes = g.items.flatMap((it) => {
    const b = bounds(it.region);
    const n = perSet(start, g, it);
    return b && n > 0 ? [{ size: [b.hi[0] - b.lo[0], b.hi[1] - b.lo[1]].sort((x, y) => y - x), n }] : [];
  });
  const fits = ([w, h]: [number, number]) => boxes.every(({ size: [a, b] }) => a + 2 * margin <= Math.max(w, h) && b + 2 * margin <= Math.min(w, h));
  // the parts' boxes with the gaps, packed about three quarters full
  const need = boxes.reduce((s, { size: [a, b], n }) => s + (a + gap) * (b + gap) * n, 0) / 0.75;
  const area = (s: [number, number]) => (s[0] - 2 * margin) * (s[1] - 2 * margin);
  const small = SHEET_SIZES.find((s) => s[0] * s[1] <= usual[0] * usual[1] && fits(s) && area(s) >= need);
  if (small) return [small[0], small[1]];
  if (fits(usual)) return usual;
  const found = SHEET_SIZES.find((s) => fits(s));
  if (found) return [found[0], found[1]];
  const big = boxes.reduce((m, { size }) => [Math.max(m[0], size[0]), Math.max(m[1], size[1])], [0, 0]);
  return [Math.ceil(big[0] + 2 * margin + 10), Math.ceil(big[1] + 2 * margin + 10)];
}

/** What the cutter's settings start at for a material and thickness. */
export function cutterStart(cutter: Cutter, material: string, t: number): Pick<SheetJob, "cutter" | "speed" | "power" | "passes" | "pierceDelay" | "kerf" | "lead" | "gap" | "overcut"> {
  const fam = materialInfo(material).family;
  const d = cutterDefaults(cutter, fam === "metal", fam === "wood", t);
  return { cutter, speed: d.speed, power: d.power, passes: d.passes, pierceDelay: d.pierceDelay, kerf: d.kerf, lead: d.lead, gap: d.gap, overcut: cutter === "plasma" ? 1 : cutter === "waterjet" ? 0.5 : 0 };
}

/** The machine and process settings a group's job starts from: the first laser_cut part's, else Settings → Making's laser. */
function processFor(g: SheetGroup, model?: Model | null): { spec: ProcessSpec; machine?: string } {
  const parts = model?.parts ?? [];
  const own = g.items
    .flatMap((it) => it.ids)
    .map((id) => parts.find((p) => p.id === id))
    .find((p) => p?.process?.id === "laser_cut");
  return specOnMachine(own?.process ?? { id: "laser_cut", settings: {} }, userMachines());
}

/** A job for a group as its parts' process and machine describe it, with every part at the design's count. */
export function jobForGroup(g: SheetGroup, model: Model | null | undefined = useDesign.getState().model): SheetJob {
  const { spec, machine } = processFor(g, model);
  const set = resolvedSettings(spec);
  const source = typeof set.source === "string" ? set.source : "any";
  const cutter: Cutter = CUTTERS.some((c) => c.id === source) ? (source as Cutter) : pickCutter(g.material, g.thickness);
  const c = cutterStart(cutter, g.material, g.thickness);
  if (typeof spec.settings.kerf === "number") c.kerf = spec.settings.kerf;
  const margin = Math.max(5, c.gap);
  const bed = machine && Array.isArray(set.bed) && typeof set.bed[0] === "number" ? ([set.bed[0], set.bed[1]] as [number, number]) : null;
  return { group: g.key, qty: {}, sets: 1, sheet: bed ?? defaultSheet(cutter, g, margin, c.gap), margin, rotate: true, ...c };
}

export function cutterOf(job: SheetJob): CutterSettings {
  return { cutter: job.cutter, speed: job.speed, power: job.power, passes: job.passes, pierceDelay: job.pierceDelay, kerf: job.kerf, lead: job.lead, gap: job.gap, rapid: cutterDefaults(job.cutter, false, false, 3).rapid };
}

/** Whether the cutter cuts the group's material, and why not. */
export const fitOf = (job: SheetJob, g: SheetGroup) => cutterFit(job.cutter, g.material);

export function requestFor(job: SheetJob, g: SheetGroup): SheetRequest {
  return {
    items: g.items.map((it) => ({ key: it.key, label: it.label, region: it.region, qty: qtyOf(job, g, it) })).filter((it) => it.qty > 0),
    nest: { sheet: job.sheet, gap: job.gap, margin: job.margin, rotate: job.rotate, maxSheets: 50 },
    cut: { kerf: job.kerf, lead: job.lead, overcut: job.overcut },
  };
}

export async function layOut(job: SheetJob, g: SheetGroup): Promise<SheetResult> {
  return call<SheetResult>({ kind: "sheets", req: requestFor(job, g) });
}

/** Cutting length, pierces and time over every sheet. */
export function totals(job: SheetJob, r: SheetResult): { cut: number; pierces: number; seconds: number; perSheet: number[] } {
  const c = cutterOf(job);
  const perSheet = r.paths.map((p) => cutTimeline(p, c).total);
  const st = r.paths.map(cutStats);
  return { cut: st.reduce((a, s) => a + s.cut * Math.max(1, job.passes), 0), pierces: st.reduce((a, s) => a + s.pierces * Math.max(1, job.passes), 0), seconds: perSheet.reduce((a, s) => a + s, 0), perSheet };
}

// ---------- the panel's state ----------

export const useSheets = create<{
  open: boolean;
  gathering: boolean;
  groups: SheetGroup[];
  job: SheetJob | null;
  result: SheetResult | null;
  /** the job and shapes the result was laid out for */
  planned: string;
  busy: boolean;
  error: string;
  /** the sheet the view shows */
  sheet: number;
  /** 0..1 through the shown sheet's cutting, for the preview */
  t: number;
  show: { paths: boolean; order: boolean };
}>(() => ({ open: false, gathering: false, groups: [], job: null, result: null, planned: "", busy: false, error: "", sheet: 0, t: 1, show: { paths: true, order: false } }));

export const planKey = (job: SheetJob | null, g: SheetGroup | undefined) => (job && g ? `${JSON.stringify(job)}|${g.items.map((i) => i.key).join(",")}` : "");

export const groupOf = (job: SheetJob | null, groups: SheetGroup[]) => groups.find((g) => g.key === job?.group);

/** A short name for a group: "Birch plywood 6 mm". */
export const groupName = (g: SheetGroup) => `${g.material} ${+g.thickness.toFixed(2)} mm`;

let gatherGen = 0;

/** Look through the design again (after an edit): keep the job if its group is still there. */
export async function regather(prefer?: string): Promise<SheetGroup[]> {
  const my = ++gatherGen;
  useSheets.setState({ gathering: true });
  try {
    const model = useDesign.getState().model;
    const groups = await gatherSheets(model);
    if (my !== gatherGen) return useSheets.getState().groups;
    const cur = useSheets.getState().job;
    const want = (prefer && groups.find((g) => g.items.some((i) => i.ids.includes(prefer)))) || (cur && groups.find((g) => g.key === cur.group)) || groups[0];
    const job = !want ? null : cur && cur.group === want.key ? cur : jobForGroup(want, model);
    useSheets.setState({ groups, job, gathering: false, error: "" });
    return groups;
  } catch (e) {
    if (my === gatherGen) useSheets.setState({ gathering: false, error: errorText(e) });
    return [];
  }
}

/** Open the sheet cutting panel: on the group holding the part named, else a selected part's, else the last. */
export async function openSheets(partId?: string): Promise<boolean> {
  const sel = useView.getState().selected;
  useCam.setState({ open: false });
  useSheets.setState({ open: true, error: "" });
  const groups = await regather(partId ?? sel[0]);
  if (!groups.length && useSheets.getState().open) {
    useSheets.setState({ open: false });
    toast({ kind: "info", title: "No flat parts to cut", detail: "Sheet cutting is for plates and sheet-metal parts: give a plate process: laser_cut, or make a sheet() part." });
    return false;
  }
  return true;
}

export const closeSheets = () => useSheets.setState({ open: false });

/** Pick another material and thickness: a fresh job for it. */
export function chooseGroup(key: string) {
  const g = useSheets.getState().groups.find((x) => x.key === key);
  if (g) useSheets.setState({ job: jobForGroup(g), sheet: 0 });
}

let planGen = 0;

/** Lay out the panel's job, unless the last layout was for this very job and these shapes. */
export async function renest(force = false): Promise<SheetResult | null> {
  const { job, groups } = useSheets.getState();
  const g = groupOf(job, groups);
  if (!job || !g) return null;
  const key = planKey(job, g);
  const st = useSheets.getState();
  if (!force && st.planned === key && st.result) return st.result;
  const my = ++planGen;
  useSheets.setState({ busy: true, error: "" });
  try {
    const result = await layOut(job, g);
    if (my !== planGen) return null;
    useSheets.setState({ result, planned: key, busy: false, sheet: Math.min(useSheets.getState().sheet, Math.max(0, result.nest.sheets.length - 1)), t: 1 });
    return result;
  } catch (e) {
    if (my !== planGen) return null;
    const msg = errorText(e);
    useSheets.setState({ busy: false, error: msg === SUPERSEDED ? "" : msg });
    return null;
  }
}

// ---------- files ----------

export type SheetFormat = "dxf" | "svg" | "gcode";

export const FORMAT_INFO: Record<SheetFormat, { label: string; ext: string; mime: string; tip: string }> = {
  dxf: { label: "DXF", ext: "dxf", mime: "application/dxf", tip: "Each sheet at 1:1 in mm, the parts' true outlines on layer CUT: LightBurn, RDWorks, LaserGRBL and SheetCam add the kerf and lead-ins themselves" },
  svg: { label: "SVG", ext: "svg", mime: "image/svg+xml", tip: "Each sheet at 1:1 in mm, red hairline outlines: for LightBurn, xTool Creative Space, Glowforge or a cutting service" },
  gcode: { label: "G-code", ext: "nc", mime: "text/plain", tip: "Ready to run: kerf offset, lead-ins and the cut order done here. GRBL laser mode (M4) for lasers; torch or jet on with pierce waits for plasma and waterjet" },
};

const designName = () => useDesign.getState().model?.name || "design";

/** Each sheet as a file in a format. */
export function sheetFiles(job: SheetJob, g: SheetGroup, r: SheetResult, format: SheetFormat): { name: string; text: string }[] {
  const n = r.nest.sheets.length;
  const title = `${designName()} ${groupName(g)}`;
  return r.nest.sheets.map((parts, i) => {
    const note = `sheet ${i + 1} of ${n}, ${r.nest.sheet[0]} x ${r.nest.sheet[1]} mm`;
    const text = format === "dxf" ? sheetDxf(parts) : format === "svg" ? sheetSvg(parts, r.nest.sheet) : sheetGcode(r.paths[i], cutterOf(job), title, note);
    return { name: safeFileName(n > 1 ? `${title} sheet ${i + 1} of ${n}` : title, FORMAT_INFO[format].ext), text };
  });
}

/** Save the panel's sheets: one file, or a zip of a file per sheet. */
export async function saveSheets(format: SheetFormat): Promise<number> {
  const { job, result, groups } = useSheets.getState();
  const g = groupOf(job, groups);
  if (!job || !g || !result || !result.nest.sheets.length) return 0;
  const files = sheetFiles(job, g, result, format);
  const info = FORMAT_INFO[format];
  if (files.length === 1) download(files[0].text, files[0].name, info.mime);
  else download(await zip(files.map((f) => ({ name: f.name, data: f.text }))), safeFileName(`${designName()} ${groupName(g)} ${info.label} sheets`, "zip"), "application/zip");
  toast({
    kind: "success",
    title: files.length === 1 ? `Saved ${files[0].name}` : `Saved ${files.length} sheets as ${info.label}`,
    detail: format === "gcode" ? (isLaser(job.cutter) ? "Zero X and Y on the sheet's front left corner and focus on its top. Test the speed and power on scrap first." : "Zero X and Y on the sheet's front left corner. Test the speed and pierce on scrap first.") : "At 1:1 in millimetres: set the kerf offset in the cutting software.",
  });
  return files.length;
}

// ---------- in words ----------

const num = (x: number, d = 1) => String(+x.toFixed(d));
const clock = (s: number) => (s < 90 ? `${Math.max(1, Math.round(s))} s` : s < 5400 ? `${num(s / 60, 1)} min` : `${num(s / 3600, 1)} h`);

/** The layout in words, for the assistant. */
export function sheetSummary(job: SheetJob, g: SheetGroup, r: SheetResult, groups: SheetGroup[]): string {
  const lines: string[] = [];
  const cutter = CUTTERS.find((c) => c.id === job.cutter)?.label ?? job.cutter;
  lines.push(`Sheet cutting for ${groupName(g)} on a ${cutter.toLowerCase()}: sheets of ${num(job.sheet[0])} × ${num(job.sheet[1])} mm, ${num(job.gap)} mm between parts, ${num(job.margin)} mm margin, parts ${job.rotate ? "turned to fit" : "kept the way they are drawn (grain)"}.`);
  const items = g.items.map((it) => `${it.label} × ${qtyOf(job, g, it)}${it.how === "sheet" ? " (flat pattern)" : ""}${it.stepped ? " (stepped: only its outline and through holes are cut)" : ""}`);
  lines.push(`Parts${job.sets > 1 ? ` (${job.sets} sets)` : ""}: ${items.join(", ")}.`);
  const n = r.nest.sheets.length;
  if (!n) lines.push("Nothing laid out.");
  else {
    const t = totals(job, r);
    lines.push(`${n} sheet${n > 1 ? "s" : ""}, ${Math.round(r.nest.used * 100)}% used: ${r.nest.sheets.map((s, i) => `sheet ${i + 1} holds ${s.length}`).join(", ")}.`);
    lines.push(`${num(t.cut / 1000, 2)} m of cutting, ${t.pierces} pierces, about ${clock(t.seconds)} at ${job.speed} mm/min${isLaser(job.cutter) ? ` and ${job.power}% power` : ""}${job.passes > 1 ? ` in ${job.passes} passes` : ""}. Kerf ${num(job.kerf, 2)} mm, lead-ins ${num(job.lead)} mm.`);
  }
  if (r.nest.unplaced.length) lines.push(`Did not fit on a sheet: ${r.nest.unplaced.map((u) => `${u.label} × ${u.count}`).join(", ")}. Use a bigger sheet or a smaller margin.`);
  const fit = fitOf(job, g);
  if (fit.status !== "pass") lines.push(`${fit.status === "fail" ? "Cannot cut" : "Warning"}: ${fit.why}.`);
  const others = groups.filter((x) => x.key !== g.key);
  if (others.length) lines.push(`Other materials and thicknesses: ${others.map((x) => `${groupName(x)} (${x.items.map((i) => i.label).join(", ")})`).join("; ")}.`);
  if (n) lines.push(`Files: DXF or SVG at 1:1 for laser software, or G-code for ${isLaser(job.cutter) ? "a GRBL laser" : "the table"}, ${n > 1 ? "a file per sheet in a zip" : "one file"}.`);
  return lines.join("\n");
}
