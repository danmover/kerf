// Heat inside the box: electronics closed in a body warm the air around them,
// and every part's rating falls as that air gets hotter. This finds the
// closed spaces that hold electronics from the made parts' boxes (a hollow
// body, or walls on every side), adds up what the parts inside lose as heat
// at the design's working currents (the same budget the wiring check uses),
// and works out the air temperature from the walls, any openings and fans:
// steady state, and after the longest simulated run when there is one.
// Lumped and steady: one air temperature per space, textbook film
// coefficients, and catalog ratings derated linearly to their limit.

import type { CheckItem } from "../core/checks";
import type { EvalPart, Model } from "../core/model";
import { applyXforms, applyXformsToDir, xformMatrix, type V3 } from "../kernel/recipe";
import { MATERIAL_DB, materialRecord } from "../library/materialDb";
import { fmtNum } from "../lang/values";
import { catalogPart } from "./catalog";
import { motorCurrentFor } from "./checks";
import { buildNetlist, motorSupplies, supplyFacts } from "./erc";
import type { CatalogPart, MachineComponent } from "./types";

type Box = [V3, V3];

/** What the caller knows about one solid (by part id): placed box in assembly mm, volume mm³. */
export interface HeatFacts {
  geometry: (id: string) => { box: Box; volume?: number } | undefined;
}

/** Film coefficients, W/(m²·K): still air inside, still air outside (with radiation), dry sand outside. */
export const HEAT_FILM = { inside: 5, insideStirred: 12, outside: 10, sand: 6 } as const;
/** Air exchange through an opening with no fan, per m² of opening (W/(m²·K)). */
const OPEN_W_M2K = 25;
/** Room temperature when the brief gives none (°C). */
const ROOM_C = 25;

/** Parts that dissipate inside an electronics space. Motors only count when they share it. */
const ELECTRONICS = new Set(["controller", "host", "motor_driver", "stepper_driver", "regulator", "battery", "psu", "amplifier", "circuit_board"]);
const OTHER_SOURCES = new Set(["sensor", "display", "gearmotor", "stepper", "fan"]);

export interface HeatSource {
  /** component instance id ("drv_f", "fans#2") */
  id: string;
  comp: string;
  label: string;
  kind: string;
  watts: number;
  /** how the loss was worked out */
  why: string;
}

export interface HeatLimit {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  /** one line: what was compared */
  text: string;
  /** how close to the limit: 1 at the limit, under 1 with room to spare */
  use: number;
}

export interface HeatSpace {
  /** stable id: the wall parts' names */
  id: string;
  /** what to call it: the main wall's label, or the walls' shared group */
  name: string;
  box: Box;
  /** wall part ids, main wall first */
  walls: string[];
  sources: HeatSource[];
  watts: number;
  /** wall area that sheds heat, m² */
  area: number;
  /** open area to the outside, m² */
  open: number;
  /** fans that move air through it */
  fans: { id: string; comp: string; cfm: number }[];
  /** total conductance to the room, W/K, and its parts */
  g: number;
  gWalls: number;
  gOpen: number;
  gFans: number;
  /** heat capacity, J/K, and time constant, s */
  heatCap: number;
  tau: number;
  ambient: number;
  ambientAssumed: boolean;
  /** outside is sand (a buried machine) */
  buried: boolean;
  /** steady air temperature, °C */
  steady: number;
  /** length of the longest simulated run, s; undefined when the design has no simulation */
  duty?: number;
  /** air temperature at the end of that run (or steady), °C */
  air: number;
  limits: HeatLimit[];
  status: "pass" | "warn" | "fail";
  /** what to change, when it is not a pass */
  fix?: string;
}

// ---------------------------------------------------------------- geometry

const inBox = (p: V3, b: Box, tol = 0) => [0, 1, 2].every((k) => p[k] >= b[0][k] - tol && p[k] <= b[1][k] + tol);
const dims = (b: Box): V3 => [b[1][0] - b[0][0], b[1][1] - b[0][1], b[1][2] - b[0][2]];
const boxVol = (b: Box) => dims(b).reduce((a, x) => a * x, 1);
const boxArea = (b: Box) => {
  const [x, y, z] = dims(b);
  return 2 * (x * y + y * z + z * x);
};
const center = (b: Box): V3 => [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2, (b[0][2] + b[1][2]) / 2];
const union = (a: Box, b: Box): Box => [
  [Math.min(a[0][0], b[0][0]), Math.min(a[0][1], b[0][1]), Math.min(a[0][2], b[0][2])],
  [Math.max(a[1][0], b[1][0]), Math.max(a[1][1], b[1][1]), Math.max(a[1][2], b[1][2])],
];
const mainAxis = (d: V3) => {
  const a = d.map(Math.abs);
  const k = a.indexOf(Math.max(...a));
  return a[k] > 0.99 * Math.hypot(...d) ? k : undefined;
};
const faceKey = (axis: number, side: 0 | 1) => `${axis}${side}`;

interface Solid {
  part: EvalPart;
  box: Box;
  volume: number;
  /** a closed or tubular shell big enough to hold parts */
  hollow: boolean;
  /** axis of a tube body (0, 1, 2) and its outside diameter */
  tube?: { axis: number; od: number };
  /** faces the part leaves open itself: a tube's uncapped ends, a shell's open side */
  open: Set<string>;
  /** wall thickness, when the recipe says (shell, tube) */
  wallT?: number;
}

/** What a part's own recipe says about its walls: tube ends and caps, shell openings. */
function shellFacts(p: EvalPart, box: Box): Pick<Solid, "tube" | "open" | "wallT"> {
  const open = new Set<string>();
  const b = p.recipe.base;
  const side = (k: number, x: number): 0 | 1 => (Math.abs(x - box[0][k]) <= Math.abs(x - box[1][k]) ? 0 : 1);
  let tube: Solid["tube"];
  let wallT: number | undefined;
  if (b?.t === "tube") {
    const k = mainAxis(applyXformsToDir(b.dir, p.xf));
    if (k !== undefined) {
      tube = { axis: k, od: b.od };
      wallT = (b.od - b.id) / 2;
      const len = Math.hypot(...b.dir);
      const ends = [applyXforms(b.at, p.xf)[k], applyXforms(b.at.map((x, i) => x + (b.dir[i] / len) * b.h) as V3, p.xf)[k]];
      // an end wall added on the tube (`add cylinder` across its bore at an end) closes that end
      const caps = p.recipe.ops.flatMap((o) => {
        if (o.op !== "add" || o.shape.t !== "cyl") return [];
        const c = o.shape;
        if (c.d < b.id - 1 || mainAxis(applyXformsToDir(c.dir, p.xf)) !== k) return [];
        const l = Math.hypot(...c.dir);
        const a0 = applyXforms(c.at, p.xf)[k];
        const a1 = applyXforms(c.at.map((x, i) => x + (c.dir[i] / l) * c.h) as V3, p.xf)[k];
        return [[Math.min(a0, a1) - 1.5, Math.max(a0, a1) + 1.5]];
      });
      for (const e of ends) if (!caps.some(([lo, hi]) => e >= lo && e <= hi)) open.add(faceKey(k, side(k, e)));
    }
  }
  for (const o of p.recipe.ops) {
    if (o.op !== "shell") continue;
    wallT = o.t;
    const dirs = Array.isArray(o.open) ? (o.open as { dir?: V3 }[]).flatMap((s) => (s.dir ? [s.dir] : [])) : [o.open as V3];
    for (const d of dirs) {
      const w = applyXformsToDir(d, p.xf);
      const k = mainAxis(w);
      if (k !== undefined) open.add(faceKey(k, w[k] > 0 ? 1 : 0));
    }
  }
  return { tube, open, wallT };
}

/** Sample points just outside one face of a box. */
function faceSamples(b: Box, axis: number, side: 0 | 1, out: number, n = 4): V3[] {
  const [u, v] = [0, 1, 2].filter((k) => k !== axis);
  const pts: V3[] = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const p: V3 = [0, 0, 0];
      p[axis] = b[side][axis] + (side ? out : -out);
      p[u] = b[0][u] + ((i + 0.5) / n) * (b[1][u] - b[0][u]);
      p[v] = b[0][v] + ((j + 0.5) / n) * (b[1][v] - b[0][v]);
      pts.push(p);
    }
  return pts;
}

const faceArea = (b: Box, axis: number) => dims(b).reduce((a, x, k) => (k === axis ? a : a * x), 1);

/**
 * The nearest solid box along an axis from a point, and how far. Boxes
 * around the point are skipped (the point is in a pocket of that part), or
 * count at distance 0 with `around`.
 */
function rayHit(p: V3, axis: number, sign: 1 | -1, solids: Solid[], max = 800, around = false): { d: number; s: Solid } | undefined {
  const [u, v] = [0, 1, 2].filter((k) => k !== axis);
  let best: { d: number; s: Solid } | undefined;
  for (const s of solids) {
    if (inBox(p, s.box, around ? 0.5 : 0)) {
      if (around) return { d: 0, s };
      continue;
    }
    if (p[u] < s.box[0][u] || p[u] > s.box[1][u] || p[v] < s.box[0][v] || p[v] > s.box[1][v]) continue;
    const d = sign > 0 ? s.box[0][axis] - p[axis] : p[axis] - s.box[1][axis];
    if (d >= 0 && d <= max && (!best || d < best.d)) best = { d, s };
  }
  return best;
}

interface Space {
  box: Box;
  /** the solids that close it, with how many face samples each closes */
  walls: Map<Solid, number>;
  /** hollow bodies it is made of (empty for a space closed by separate walls) */
  shells: Solid[];
  /** wall and open area, mm² */
  area: number;
  open: number;
}

/**
 * Sample every face of a space: closed by one of its own shells, by another
 * solid a little way out (a lid, a panel set back), or open. A tube of the
 * same size running on from an open end is the same space (body sections
 * joined by a spigot): it is returned to be joined.
 */
function coverage(box: Box, shells: Solid[], solids: Solid[]): { walls: Map<Solid, number>; area: number; open: number; join?: Solid } {
  const walls = new Map<Solid, number>();
  const round = shells.length > 0 && shells.every((s) => s.tube);
  // how far out a wall still closes a face: near a hollow body's opening, or anywhere within the space's own size
  const reach = shells.length ? 25 : Math.max(...dims(box));
  const others = solids.filter((s) => !shells.includes(s));
  let area = 0;
  let open = 0;
  for (let axis = 0; axis < 3; axis++)
    for (const side of [0, 1] as const) {
      const pts = faceSamples(box, axis, side, 1.5);
      // round bodies: a circle in its square box, and the side walls a cylinder
      const fa = faceArea(box, axis) * (round ? Math.PI / 4 : 1);
      let covered = 0;
      for (const p of pts) {
        const own = shells.find((s) => !s.open.has(faceKey(axis, side)) && inBox(p, s.box, 2));
        const other = own ? undefined : rayHit(p, axis, side ? 1 : -1, others, reach, true)?.s;
        if (other?.tube && other.tube.axis === axis && shells.some((s) => s.tube && s.tube.axis === axis && Math.abs(s.tube.od - other.tube!.od) <= 0.1 * s.tube.od)) return { walls, area, open, join: other };
        const wall = own ?? other;
        if (!wall) continue;
        covered++;
        walls.set(wall, (walls.get(wall) ?? 0) + 1);
      }
      area += (fa * covered) / pts.length;
      open += (fa * (pts.length - covered)) / pts.length;
    }
  return { walls, area, open };
}

/** The closed space around a point, or undefined when it sits in the open. */
function spaceAround(p: V3, solids: Solid[]): Space | undefined {
  // inside a hollow body: the smallest one, joined with same-size tubes that run on from its open ends
  const shell = solids.filter((s) => s.hollow && inBox(p, s.box, -1)).sort((a, b) => boxVol(a.box) - boxVol(b.box))[0];
  if (shell) {
    const shells = [shell];
    let box = shell.box;
    for (let i = 0; i < 8; i++) {
      const c = coverage(box, shells, solids);
      if (!c.join) return c.open > 0.3 * (c.open + c.area) ? undefined : { box, walls: c.walls, shells, area: c.area, open: c.open };
      shells.push(c.join);
      box = union(box, c.join.box);
    }
    return undefined;
  }
  // walls on every side: the nearest solid along each axis, one side may be open
  const lo: V3 = [0, 0, 0];
  const hi: V3 = [0, 0, 0];
  let misses = 0;
  for (let k = 0; k < 3; k++) {
    const a = rayHit(p, k, -1, solids)?.d;
    const b = rayHit(p, k, 1, solids)?.d;
    misses += (a === undefined ? 1 : 0) + (b === undefined ? 1 : 0);
    if (a === undefined && b === undefined) return undefined;
    lo[k] = p[k] - (a ?? b!);
    hi[k] = p[k] + (b ?? a!);
  }
  if (misses > 1) return undefined;
  const box: Box = [lo, hi];
  const c = coverage(box, [], solids);
  // mostly open: air moves freely, nothing to check
  if (c.open > 0.3 * (c.open + c.area)) return undefined;
  return { box, walls: c.walls, shells: [], area: c.area, open: c.open };
}

// ---------------------------------------------------------------- losses

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Free-air flow of an axial fan by frame size (CFM), typical 12–24 V parts. */
export function fanCfm(size: number): number {
  const table: [number, number][] = [
    [25, 2.5],
    [30, 4],
    [40, 7],
    [50, 10],
    [60, 15],
    [80, 30],
    [92, 40],
    [120, 70],
  ];
  if (size <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [s1, c1] = table[i];
    const [s0, c0] = table[i - 1];
    if (size <= s1) return c0 + ((size - s0) / (s1 - s0)) * (c1 - c0);
  }
  return table[table.length - 1][1];
}

/** W/K a fan adds: air's ρ·cp times half its free-air flow (vents and the box push back). */
export const fanConductance = (cfm: number) => 1.2 * 1005 * cfm * 0.5 * 0.000472;

/** Rated loss of a board driver at its continuous current (W); scaled by (I/Icont)². */
const DC_DRIVER_W = 1.5;
const STEP_DRIVER_W = 2.4;

interface Ctx {
  model: Model;
  current: (comp: string) => number | undefined;
  supply: ReturnType<typeof supplyFacts>;
  /** current through each driver channel by component name */
  driverAmps: Map<string, number[]>;
  /** stepper currents on a board's stepper ports */
  portAmps: Map<string, number[]>;
}

function motorAmps(mc: MachineComponent, part: CatalogPart, current: (comp: string) => number | undefined): number {
  const s = part.specs;
  const known = current(mc.name);
  if (known !== undefined) return known;
  const i0 = num(s.i_free) ?? 0.2;
  const is = num(s.i_stall);
  // no load: given 30 % of stall, a hard-working default
  return is !== undefined ? i0 + (is - i0) * 0.3 : i0;
}

/** Heat a component instance loses (W) and how that was worked out. */
function loss(mc: MachineComponent, part: CatalogPart, index: number, cx: Ctx): { w: number; why: string } {
  const s = part.specs;
  const vin = cx.supply.vin(mc.name, index);
  const draw = part.pins.reduce((a, p) => a + (p.type === "pwr_in" ? (p.draw ?? 0) : 0), 0);
  const self = draw * (vin ?? 5);
  switch (part.kind) {
    case "motor_driver": {
      const amps = cx.driverAmps.get(mc.name) ?? [];
      const icont = num(s.i_cont) ?? 2;
      const drop = num(s.v_drop);
      const w = amps.reduce((a, i) => a + (drop !== undefined ? drop * i : DC_DRIVER_W * (i / icont) ** 2), 0) + 0.05;
      return { w, why: amps.length ? `${amps.map((i) => `${fmtNum(i, 1)} A`).join(" + ")} through it${drop !== undefined ? `, ${fmtNum(drop)} V lost across it` : ""}` : "idle" };
    }
    case "stepper_driver": {
      const amps = cx.driverAmps.get(mc.name) ?? [];
      const icont = num(s.i_cont) ?? 1.5;
      const i = amps[0] ?? icont * 0.7;
      return { w: STEP_DRIVER_W * (i / icont) ** 2 + 0.05, why: `${fmtNum(i, 1)} A per phase` };
    }
    case "controller": {
      const base = self || (/ESP32/i.test(String(s.mcu)) ? 0.6 : /STM32|RP2040/i.test(String(s.mcu)) ? 0.4 : 0.25);
      const ports = cx.portAmps.get(mc.name) ?? [];
      const w = base + ports.reduce((a, i) => a + STEP_DRIVER_W * (i / 2) ** 2 + 0.05, 0);
      return { w, why: ports.length ? `the board and its ${ports.length} stepper drivers at ${ports.map((i) => fmtNum(i, 1)).join(", ")} A` : "the board itself" };
    }
    case "regulator": {
      const iout = cx.supply.out(mc.name, index);
      const vout = num(s.v_out) ?? 5;
      const eff = num(s.efficiency);
      if (eff !== undefined) return { w: vout * iout * (1 / eff - 1) + 0.02, why: `${fmtNum(iout, 2)} A out at ${fmtNum(eff * 100, 0)} % efficiency` };
      const vi = vin ?? vout + (num(s.dropout) ?? 2);
      return { w: Math.max(0, vi - vout) * iout + vi * (num(s.iq) ?? 0.005), why: `${fmtNum(iout, 2)} A dropped from ${fmtNum(vi)} V to ${fmtNum(vout)} V` };
    }
    case "psu": {
      const vout = num(s.v_out) ?? 24;
      const iout = cx.supply.out(mc.name, index) || (num(s.power_w) ?? 50) / vout / 2;
      return { w: vout * iout * (1 / 0.88 - 1) + 0.5, why: `${fmtNum(vout * iout, 0)} W out at about 88 % efficiency` };
    }
    case "battery": {
      const iout = cx.supply.out(mc.name, index);
      const cells = num(s.cells) ?? 3;
      const ah = (num(s.capacity_mah) ?? 2000) / 1000;
      // LiPo cells: about 25 mΩ·Ah each
      const r = (cells * 0.025) / ah;
      return { w: iout * iout * r, why: `${fmtNum(iout, 1)} A through about ${fmtNum(r * 1000, 0)} mΩ inside it` };
    }
    case "amplifier": {
      const rated = num(s.p_8ohm_24v) ?? num(s.p_out) ?? 10;
      const eff = num(s.efficiency) ?? 0.85;
      // music averages about an eighth of rated power when played loud
      return { w: (rated / 8) * (1 / eff - 1) + 0.5, why: `loud music (about ${fmtNum(rated / 8, 1)} W out) plus idle` };
    }
    case "gearmotor": {
      const i = motorAmps(mc, part, cx.current);
      const v = motorSupplies(cx.model.machine!).get(mc.name) ?? num(s.v_rated) ?? 12;
      const ts = (num(s.t_stall) ?? 0) * (v / (num(s.v_rated) ?? v));
      const nf = (num(s.rpm_free) ?? 0) * (v / (num(s.v_rated) ?? v));
      const load = mc.load ?? ts * 0.3;
      const out = ts > 0 ? (load / 1000) * ((nf * Math.max(0, 1 - load / ts) * 2 * Math.PI) / 60) : 0;
      return { w: Math.max(0, v * i - out), why: `${fmtNum(i, 1)} A at ${fmtNum(v)} V, less the work it does` };
    }
    case "stepper": {
      const i = (num(s.i_rated) ?? 1) * 0.8;
      const r = num(s.r_phase) ?? 2;
      return { w: 2 * i * i * r, why: `two phases at ${fmtNum(i, 1)} A` };
    }
    case "fan":
      return { w: 0.5 * (num(s.v) ?? 12) * (num(s.i) ?? 0.1), why: "its motor" };
    case "host":
      return { w: self || 2.5, why: "the computer itself" };
    default:
      return { w: self || 0.05, why: "the part itself" };
  }
}

function driverCurrents(model: Model, current: (comp: string) => number | undefined): Pick<Ctx, "driverAmps" | "portAmps"> {
  const m = model.machine!;
  const driverAmps = new Map<string, number[]>();
  const portAmps = new Map<string, number[]>();
  if (!m.wires.length && !m.nets.length) return { driverAmps, portAmps };
  const nl = buildNetlist(m);
  for (const n of nl.nets) {
    const outs = n.pins.filter((p) => p.pin.type === "motor_out");
    const motors = n.pins.filter((p) => p.pin.type === "motor" && p.pin.id === "M_PLUS");
    for (const d of outs) {
      const a = motors.reduce((x, mp) => x + motorAmps(mp.mc, mp.part, current), 0);
      if (a > 0) driverAmps.set(d.comp, [...(driverAmps.get(d.comp) ?? []), a]);
    }
  }
  // ports that share a step pin (Z A/B headers in parallel) are one driver
  const counted = new Set<string>();
  for (const cab of nl.cables) {
    for (const [src, dev] of [
      [cab.a, cab.b],
      [cab.b, cab.a],
    ]) {
      if (src.pin.port !== "stepper4" || src.pin.side !== "source" || !dev.pin.need_a) continue;
      const step = /step=([^,]+)/.exec(src.pin.mcu ?? "")?.[1];
      if (step) {
        const k = `${src.comp}[${src.index}]:${step}`;
        if (counted.has(k)) continue;
        counted.add(k);
      }
      const i = Math.min(dev.pin.need_a * 0.8, src.pin.imax ?? dev.pin.need_a);
      const map = src.part.kind === "stepper_driver" ? driverAmps : portAmps;
      map.set(src.comp, [...(map.get(src.comp) ?? []), i]);
    }
  }
  return { driverAmps, portAmps };
}

// ---------------------------------------------------------------- limits

const CP: Record<string, number> = { plastic: 1.4, metal: 0.6, composite: 1.1, other: 1.6 };

function wallMaterial(p: EvalPart) {
  const r = materialRecord(p.material);
  if (r) return { k: r.conductivity, maxC: r.maxC, density: r.density, cp: /alumin/i.test(r.name) ? 0.9 : CP[r.category] ?? 1.4, name: r.label };
  const wood = /wood|ply|mdf|oak|pine|birch/i.test(p.material);
  return { k: wood ? 0.13 : 0.2, maxC: wood ? 120 : 60, density: wood ? 0.65 : 1.2, cp: wood ? 1.7 : 1.4, name: p.material };
}

function limitsFor(src: HeatSource, mc: MachineComponent, part: CatalogPart, air: number, amps: number[]): HeatLimit[] {
  const s = part.specs;
  const lim = (status: HeatLimit["status"], text: string, use: number): HeatLimit => ({ id: src.id, label: src.label, status, text, use });
  const band = (limit: number, warn: number, what: string) => lim(air > limit ? "fail" : air > warn ? "warn" : "pass", what, (air - 25) / (limit - 25));
  switch (part.kind) {
    case "motor_driver":
    case "stepper_driver": {
      const icont = num(s.i_cont);
      const i = Math.max(0, ...amps);
      if (!icont || !i) return [];
      // rated at 25 °C air; the current it can carry falls to nothing at a 125 °C junction
      const allow = icont * Math.sqrt(Math.max(0, (125 - air) / 100));
      return [lim(i > allow ? "fail" : i > 0.8 * allow ? "warn" : "pass", `carries ${fmtNum(i, 1)} A; ${fmtNum(allow, 1)} A at this air (${fmtNum(icont)} A at 25 °C)`, i / Math.max(allow, 1e-6))];
    }
    case "regulator": {
      if (num(s.theta_ja) !== undefined) {
        const tj = air + src.watts * num(s.theta_ja)!;
        return [lim(tj > 125 ? "fail" : tj > 110 ? "warn" : "pass", `chip at about ${fmtNum(tj, 0)} °C (shuts down near 125 °C)`, (tj - 25) / 100)];
      }
      return [band(85, 70, "a module rated to 85 °C air that gives less current above about 70 °C")];
    }
    case "controller":
    case "host":
      return [band(85, 70, "rated to 85 °C air; above about 70 °C it runs close to its limit")];
    case "battery":
      return [band(60, 45, "a LiPo must stay under 60 °C, and ages fast above 45 °C")];
    case "psu":
      return [band(70, 50, "full power up to 50 °C air, less above, 70 °C at most")];
    case "amplifier":
      return [band(85, 70, "rated to 85 °C air; above about 70 °C it turns itself down when played loud")];
    case "gearmotor":
    case "stepper":
      return [band(60, 40, "rated for 40 °C air; hotter air takes torque and life, above 60 °C the windings overheat")];
    default:
      void mc;
      return [];
  }
}

// ---------------------------------------------------------------- the report

/** The longest simulated run (s), the time the parts stay on in one go. */
function dutyOf(model: Model): number | undefined {
  const d = (model.scenarios ?? []).map((s) => s.spec.duration).filter((x): x is number => typeof x === "number" && x > 0);
  return d.length ? Math.max(...d) : undefined;
}

function isBuried(model: Model): boolean {
  const b = model.brief;
  if (!b) return false;
  return /\b(buried|underground|in (dry |wet )?sand|in soil)\b/i.test([b.setting, b.purpose, ...b.exposure].join(" "));
}

const instanceIndex = (id: string) => {
  const m = id.match(/#(\d+)$/);
  return m ? Number(m[1]) - 1 : 0;
};

/** Every closed space that holds electronics, with its heat balance. */
export function heatSpaces(model: Model, facts: HeatFacts): HeatSpace[] {
  const m = model.machine;
  if (!m?.components.length) return [];
  const comps = new Map(m.components.map((c) => [c.name, c]));
  const solids: Solid[] = [];
  for (const p of model.parts) {
    if (p.kind !== "part") continue;
    const g = facts.geometry(p.id);
    if (!g) continue;
    const d = dims(g.box);
    const vol = g.volume ?? boxVol(g.box);
    solids.push({ part: p, box: g.box, volume: vol, hollow: Math.min(...d) >= 15 && vol < 0.5 * boxVol(g.box), ...shellFacts(p, g.box) });
  }
  if (!solids.length) return [];

  type Placed = { part: EvalPart; mc: MachineComponent; cat: CatalogPart; at: V3 };
  const placed: Placed[] = [];
  for (const p of model.parts) {
    if (p.kind !== "component" || !p.bom) continue;
    const mc = comps.get(p.name);
    const cat = mc && catalogPart(mc.catalogId);
    if (!mc || !cat || !(ELECTRONICS.has(cat.kind) || OTHER_SOURCES.has(cat.kind))) continue;
    const g = facts.geometry(p.id);
    const o = xformMatrix(p.xf);
    placed.push({ part: p, mc, cat, at: g ? center(g.box) : [o[12], o[13], o[14]] });
  }

  // group the parts by the space around them; spaces with no electronics are left to the motors' own thermal model
  const spaces: { s: Space; members: Placed[] }[] = [];
  for (const pl of placed) {
    if (!ELECTRONICS.has(pl.cat.kind) || spaces.some((x) => inBox(pl.at, x.s.box, 1))) continue;
    const s = spaceAround(pl.at, solids);
    if (s) spaces.push({ s, members: [] });
  }
  for (const pl of placed) {
    if (pl.cat.kind === "fan") continue;
    const home = spaces.filter((x) => inBox(pl.at, x.s.box, 1)).sort((a, b) => boxVol(a.s.box) - boxVol(b.s.box))[0];
    home?.members.push(pl);
  }

  const supplies = motorSupplies(m);
  const current = motorCurrentFor(m, supplies);
  const cx: Ctx = { model, current, supply: supplyFacts(m, current), ...driverCurrents(model, current) };
  const brief = model.brief;
  const ambient = brief?.temp ? brief.temp[1] : ROOM_C;
  const ambientAssumed = !brief?.temp || brief.assumed.includes("temp");
  const buried = isBuried(model);
  const duty = dutyOf(model);
  const exposed = !!brief && (brief.outdoor || buried || brief.exposure.some((e) => /dust|sand|water|wet|rain|mud|splash/i.test(e)));

  const out: HeatSpace[] = [];
  for (const { s, members } of spaces) {
    if (!members.some((x) => ELECTRONICS.has(x.cat.kind))) continue;
    const sources: HeatSource[] = members.map((x) => {
      const l = loss(x.mc, x.cat, instanceIndex(x.part.id), cx);
      const label = x.mc.role ? `${x.mc.name} (${x.mc.role})` : x.mc.name;
      return { id: x.part.id, comp: x.mc.name, label, kind: x.cat.kind, watts: l.w, why: l.why };
    });
    const watts = sources.reduce((a, x) => a + x.watts, 0);

    // fans inside or on the walls (within 15 mm)
    const fans = placed
      .filter((x) => x.cat.kind === "fan" && inBox(x.at, s.box, 15))
      .map((x) => ({ id: x.part.id, comp: x.mc.name, cfm: fanCfm(num(x.cat.specs.size) ?? 40), inside: inBox(x.at, s.box, -2) }));
    const blowing = fans.filter((f) => !f.inside || s.open > 100);

    // walls: the main one sets the material, every one adds mass
    const walls = [...s.walls.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w);
    const main = walls[0] ?? s.shells[0];
    if (!main) continue;
    const mat = wallMaterial(main.part);
    const t = Math.min(10, Math.max(0.8, main.wallT ?? (main.hollow ? main.volume / (0.8 * boxArea(main.box)) : Math.min(...dims(main.box)))));
    const hIn = fans.some((f) => f.inside) ? HEAT_FILM.insideStirred : HEAT_FILM.inside;
    const hOut = buried ? HEAT_FILM.sand : HEAT_FILM.outside;
    const u = 1 / (1 / hIn + t / 1000 / mat.k + 1 / hOut);
    const area = s.area / 1e6;
    const open = s.open / 1e6;
    const gWalls = u * area;
    const gOpen = blowing.length ? 0 : OPEN_W_M2K * open;
    const gFans = blowing.reduce((a, f) => a + fanConductance(f.cfm), 0);
    const g = Math.max(1e-6, gWalls + gOpen + gFans);
    const wallParts = [...new Set([...s.shells, ...walls])];
    const heatCap =
      wallParts.reduce((a, w) => {
        const wm = wallMaterial(w.part);
        return a + (w.volume / 1000) * wm.density * wm.cp;
      }, 0) + members.reduce((a, x) => a + (num(x.cat.specs.mass_g) ?? 30) * 0.9, 0);
    const tau = heatCap / g;
    const rise = watts / g;
    const steady = ambient + rise;
    const air = duty !== undefined ? ambient + rise * (1 - Math.exp(-duty / tau)) : steady;

    const limits: HeatLimit[] = [];
    for (const src of sources) {
      const x = members.find((y) => y.part.id === src.id)!;
      limits.push(...limitsFor(src, x.mc, x.cat, air, cx.driverAmps.get(x.mc.name) ?? []));
    }
    const wallIds = wallParts.map((w) => w.part.id);
    for (const w of wallParts.filter((w, i, a) => a.findIndex((y) => y.part.material === w.part.material) === i)) {
      const wm = wallMaterial(w.part);
      limits.push({ id: w.part.id, label: w.part.label, status: air > wm.maxC ? "fail" : air > wm.maxC - 10 ? "warn" : "pass", text: `${wm.name} walls soften at ${fmtNum(wm.maxC)} °C`, use: (air - 25) / (wm.maxC - 25) });
    }
    const status = limits.some((l) => l.status === "fail") ? "fail" : limits.some((l) => l.status === "warn") ? "warn" : "pass";

    // a hollow body is named by its parts; separate walls by the group most of them are in (the cabinet)
    const byGroup = new Map<string, number>();
    for (const [w, n] of s.walls) if (w.part.group) byGroup.set(w.part.group, (byGroup.get(w.part.group) ?? 0) + n);
    const [group, n] = [...byGroup.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
    const samples = [...s.walls.values()].reduce((a, x) => a + x, 0);
    const name = s.shells.length ? s.shells.map((x) => x.part.label).join(" and ") : group && n >= 0.5 * samples ? group : main.part.label;
    const sp: HeatSpace = { id: wallParts.map((w) => w.part.name).sort().join("+"), name, box: s.box, walls: [main.part.id, ...wallIds.filter((x) => x !== main.part.id)], sources, watts, area, open, fans: fans.map(({ id, comp, cfm }) => ({ id, comp, cfm })), g, gWalls, gOpen, gFans, heatCap, tau, ambient, ambientAssumed, buried, steady, duty, air, limits, status };
    if (status !== "pass") sp.fix = advice(sp, exposed, mat.maxC);
    out.push(sp);
  }
  return out;
}

function airAt(sp: HeatSpace, g: number, heatCap = sp.heatCap): number {
  const tau = heatCap / g;
  const rise = sp.watts / g;
  return sp.duty !== undefined ? sp.ambient + rise * (1 - Math.exp(-sp.duty / tau)) : sp.ambient + rise;
}

function advice(sp: HeatSpace, exposed: boolean, wallMax: number): string {
  const hottest = [...sp.sources].sort((a, b) => b.watts - a.watts)[0];
  const tips: string[] = [];
  const worst = [...sp.limits].sort((a, b) => b.use - a.use)[0];
  if (sp.duty !== undefined && sp.duty < sp.tau / 2) {
    // still warming when the run ends: the heat made and the mass that soaks it up matter more than the walls
    const al = 300;
    tips.push(`it is still warming up when the ${mins(sp.duty)} run ends, so the heat made and the mass soaking it up matter more than the walls: a ${al} g aluminium plate under ${hottest.comp} as a heat sink brings the air to about ${fmtNum(airAt(sp, sp.g, sp.heatCap + al * 0.9), 0)} °C, and resting between runs lets it cool`);
  } else if (!exposed && !sp.gFans) {
    const g40 = fanConductance(fanCfm(40));
    tips.push(`add a 40 mm fan on a wall with a vent on the far side: about ${fmtNum(g40, 1)} W/K more, which brings the air to about ${fmtNum(airAt(sp, sp.g + g40), 0)} °C`);
  } else if (!sp.gFans) {
    // sealed against sand, dust or water: spread the heat into the wall instead
    const g2 = sp.g * 2;
    tips.push(`keep it sealed and spread the heat: mount ${hottest.comp} on an aluminium plate pressed against the wall, or make the box bigger (twice the wall area brings the air to about ${fmtNum(airAt(sp, g2), 0)} °C)`);
  } else {
    tips.push(`use a bigger fan, or a second one: twice the airflow brings the air to about ${fmtNum(airAt(sp, sp.g + sp.gFans), 0)} °C`);
  }
  if (hottest && hottest.watts > 0.4 * sp.watts && sp.sources.length > 1) tips.push(`${hottest.comp} makes ${fmtNum((hottest.watts / sp.watts) * 100, 0)} % of the heat, so cooling it first helps most (a heat sink on it, less current through it, or moving it out of the box)`);
  if (worst && /walls soften/.test(worst.text) && worst.status !== "pass") {
    const better = MATERIAL_DB.filter((r) => r.printed && r.maxC >= sp.air + 15).sort((a, b) => a.maxC - b.maxC)[0];
    if (better) tips.push(`print the walls in ${better.label} (takes ${fmtNum(better.maxC)} °C) instead`);
  }
  void wallMax;
  const s = tips.join("; ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

const mins = (s: number) => (s >= 5400 ? `${fmtNum(s / 3600, 1)} h` : `${fmtNum(s / 60, 0)} min`);

/** One check per closed space with electronics in it. */
export function heatItems(spaces: HeatSpace[]): CheckItem[] {
  return spaces.map((sp) => {
    const top = [...sp.sources].sort((a, b) => b.watts - a.watts);
    const list = top
      .slice(0, 4)
      .map((x) => `${x.comp} ${fmtNum(x.watts, x.watts < 1 ? 2 : 1)} W`)
      .join(", ");
    const rest = top.length > 4 ? ` and ${top.length - 4} more` : "";
    const ways = [sp.gWalls > 0 && "walls", sp.gOpen > 0 && "openings", sp.gFans > 0 && sp.fans.map((f) => f.comp).join(" and ")].filter((x): x is string => !!x);
    const how = ways.length > 1 ? `${ways.slice(0, -1).join(", ")} and ${ways[ways.length - 1]}` : ways[0];
    const room = `${fmtNum(sp.ambient)} °C ${sp.buried ? "sand" : "room"}${sp.ambientAssumed ? " (assumed)" : ""}`;
    const when = sp.duty !== undefined ? `after the ${mins(sp.duty)} run` : "when it has warmed through";
    const worst = [...sp.limits].sort((a, b) => b.use - a.use)[0];
    const bad = sp.limits.filter((l) => l.status !== "pass");
    const detail = [
      `${fmtNum(sp.watts, 1)} W of heat from ${list}${rest}.`,
      `The ${how} shed ${fmtNum(sp.g, sp.g < 1 ? 2 : 1)} W/K to the ${room}, so the air inside is about ${fmtNum(sp.air, 0)} °C ${when}${sp.duty !== undefined && sp.steady - sp.air > 3 ? ` (${fmtNum(sp.steady, 0)} °C if it ran on for hours)` : ""}.`,
      bad.length ? bad.map((l) => `${l.label}: ${l.text}.`).join(" ") : worst ? `Closest to its limit: ${worst.label}, ${worst.text}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const title = sp.status === "fail" ? `${sp.name} gets too hot inside: ${fmtNum(sp.air, 0)} °C` : sp.status === "warn" ? `${sp.name} gets warm inside: ${fmtNum(sp.air, 0)} °C` : `Heat inside ${sp.name}: ${fmtNum(sp.air, 0)} °C`;
    return {
      id: `heat:${sp.id}`,
      category: "engineering",
      status: sp.status,
      title,
      detail,
      parts: [...sp.walls, ...sp.sources.map((x) => x.id)],
      basis: "calculation",
      margin: worst ? 1 / Math.max(worst.use, 1e-6) : undefined,
      fix: sp.fix,
    } satisfies CheckItem;
  });
}

/** Plain-text summary for Claude and the build pack. */
export function heatText(spaces: HeatSpace[]): string {
  if (!spaces.length) return "No closed space holds electronics (or the parts are not built yet).";
  return spaces
    .map((sp) => {
      const lines = [
        `${sp.name} (${sp.status}): air ${fmtNum(sp.air, 0)} °C${sp.duty !== undefined ? ` after ${mins(sp.duty)}` : ""}, ${fmtNum(sp.steady, 0)} °C steady, room ${fmtNum(sp.ambient)} °C${sp.buried ? " (sand outside)" : ""}`,
        `  ${fmtNum(sp.watts, 2)} W: ${sp.sources.map((x) => `${x.comp} ${fmtNum(x.watts, 2)} W (${x.why})`).join("; ")}`,
        `  sheds ${fmtNum(sp.g, 3)} W/K: walls ${fmtNum(sp.gWalls, 3)} (${fmtNum(sp.area * 1e4, 0)} cm²), openings ${fmtNum(sp.gOpen, 3)} (${fmtNum(sp.open * 1e4, 0)} cm²), fans ${fmtNum(sp.gFans, 3)}; warms with a ${mins(sp.tau)} time constant`,
        ...sp.limits.map((l) => `  ${l.status} ${l.label}: ${l.text}`),
      ];
      if (sp.fix) lines.push(`  fix: ${sp.fix}`);
      return lines.join("\n");
    })
    .join("\n");
}
