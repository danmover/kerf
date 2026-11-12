// A print job for the design's printed parts: each copy turned the way it prints, the supports it needs, its
// filament and time, and the copies packed onto as few plates as the printer takes. Plain data in, plain data out,
// so the Make panel, the 3MF export and the tests share it.

import { orientForPrint } from "../machine/pack";
import { materialRecord } from "../library/materialDb";
import { materialDensity } from "../library/standards";
import type { MeshData } from "../kernel/build";
import { FDM_DEFAULTS, type FdmPrint } from "./infill";
import type { MachineProfile } from "./machines";
import { packPlates, type Plate } from "./plates";
import { supportEstimate, type SupportEstimate } from "./supports";

export interface PrintPart {
  /** one entry per different part, with how many the design uses */
  name: string;
  material: string;
  color: string;
  qty: number;
  mesh: MeshData;
  /** each copy's name (the first part, then its copies); "name 1", "name 2"... without */
  names?: string[];
  /** the process's build direction, when it sets one */
  build?: [number, number, number];
  /** the process's overhang limit, degrees from vertical, and widest bridge, mm */
  maxAngle?: number;
  bridge?: number;
  /** the slicer settings it prints with (Kerf's own advice without) */
  print?: Pick<FdmPrint, "walls" | "top" | "infill" | "layer" | "line">;
  /** false when its process turns supports off: the overhangs print in the air */
  supports?: boolean;
}

export interface Printer {
  name: string;
  bed: [number, number];
  /** materials one plate can print */
  nozzles: number;
}

export interface PrintCopy {
  /** index into the parts, and which copy of it (from 0) */
  part: number;
  copy: number;
  name: string;
  material: string;
  color: string;
  /** turned to print, resting on z = 0 and centred on x = y = 0 */
  positions: Float32Array;
  indices: Uint32Array;
  size: [number, number, number];
  /** which face it lies on, in words */
  face: string;
}

export interface PartEstimate {
  /** the part's own plastic, g, and the supports', g */
  grams: number;
  supportGrams: number;
  /** printing time, h, the supports' share in it */
  hours: number;
  supportHours: number;
  supports: SupportEstimate;
  /** the process turns supports off, so the overhangs in `supports` print in the air (and add nothing) */
  supportsOff?: boolean;
  /** where the part covers the bed, cells of the supports' grid (for drawing its outline from above) */
  footprint: { cell: number; x0: number; y0: number; nx: number; ny: number; on: Uint8Array };
}

export interface PrintPlan {
  printer: Printer;
  parts: PrintPart[];
  estimates: PartEstimate[];
  copies: PrintCopy[];
  plates: (Plate & { grams: number; supportGrams: number; hours: number })[];
  tooBig: number[];
  grams: number;
  supportGrams: number;
  hours: number;
}

/** volume printed per second, mm³/s, as the cost estimate takes it */
const RATE = 8;
/** heating and levelling before each plate, h */
const START = 0.15;

const KERF_PRINT = { walls: FDM_DEFAULTS.walls, top: FDM_DEFAULTS.top, infill: FDM_DEFAULTS.infill, layer: FDM_DEFAULTS.layer, line: 1.1 * FDM_DEFAULTS.nozzle };

/**
 * The part's plastic, supports, time and footprint, from its mesh turned to print. The plastic is a slicer's: walls
 * round the sides, solid layers over the tops and under the bottoms, and the infill share of what is left inside.
 */
export function estimatePart(
  positions: Float32Array,
  indices: Uint32Array,
  material: string,
  opts: { maxAngle?: number; bridge?: number; print?: PrintPart["print"]; supports?: boolean } = {},
): PartEstimate {
  const P = positions;
  const I = indices;
  const pr = opts.print ?? KERF_PRINT;
  const wall = pr.walls * pr.line;
  const skin = pr.top * pr.layer;
  let volume = 0;
  // the shell: each face's area times the depth of solid plastic behind it
  let shellIn = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3;
    const b = I[t + 1] * 3;
    const c = I[t + 2] * 3;
    volume += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
    const ux = P[b] - P[a];
    const uy = P[b + 1] - P[a + 1];
    const uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a];
    const vy = P[c + 1] - P[a + 1];
    const vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const a2 = Math.hypot(nx, ny, nz);
    // tops and bottoms (within 45° of flat) get the solid layers, the rest the walls
    shellIn += (a2 / 2) * (Math.abs(nz) > 0.7071 * a2 ? skin : wall);
  }
  volume = Math.abs(volume);
  const shell = Math.min(volume, shellIn);
  const printed = shell + pr.infill * (volume - shell);
  const supports = supportEstimate(P, I, { maxAngle: opts.maxAngle, bridge: opts.bridge });
  const rho = materialRecord(material)?.density ?? materialDensity(material);
  const g = (mm3: number) => (mm3 / 1000) * rho;
  const off = opts.supports === false;
  const held = off ? 0 : supports.volume;
  return {
    grams: g(printed),
    supportGrams: g(held),
    hours: (printed + held) / RATE / 3600,
    supportHours: held / RATE / 3600,
    supports,
    ...(off && supports.cells.length ? { supportsOff: true } : {}),
    footprint: footprint(P, I, supports.cell),
  };
}

/** Where a part covers the bed, on a grid: every triangle's shadow filled in. */
function footprint(P: ArrayLike<number>, I: ArrayLike<number>, cell: number): PartEstimate["footprint"] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < P.length; i += 3) (x0 = Math.min(x0, P[i])), (x1 = Math.max(x1, P[i])), (y0 = Math.min(y0, P[i + 1])), (y1 = Math.max(y1, P[i + 1]));
  // a hair under (a float mesh's sizes are a little off), so a part a whole number of cells wide gets no extra row
  // of cells past its edge
  const nx = Math.max(1, Math.ceil((x1 - x0) / cell - 1e-3));
  const ny = Math.max(1, Math.ceil((y1 - y0) / cell - 1e-3));
  const on = new Uint8Array(nx * ny);
  // each triangle's cells: the centres inside its shadow, and at least the cell its centre is in (a sliver too thin
  // to cover a centre still shows)
  for (let t = 0; t < I.length; t += 3) {
    const ax = P[I[t] * 3], ay = P[I[t] * 3 + 1];
    const bx = P[I[t + 1] * 3], by = P[I[t + 1] * 3 + 1];
    const cx = P[I[t + 2] * 3], cy = P[I[t + 2] * 3 + 1];
    const d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / cell));
    const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - x0) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - y0) / cell));
    const j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - y0) / cell));
    // a wall seen from above is a line: it covers nothing of its own (and its centre is on the edge)
    if (Math.abs(d) < 1e-9) continue;
    on[Math.min(ny - 1, Math.floor(((ay + by + cy) / 3 - y0) / cell)) * nx + Math.min(nx - 1, Math.floor(((ax + bx + cx) / 3 - x0) / cell))] = 1;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) * cell;
        const py = y0 + (j + 0.5) * cell;
        const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / d;
        const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / d;
        const w2 = 1 - w0 - w1;
        if (w0 >= -1e-9 && w1 >= -1e-9 && w2 >= -1e-9) on[j * nx + i] = 1;
      }
  }
  return { cell, x0, y0, nx, ny, on };
}

/** The whole job: each part turned to print and estimated once, its copies packed onto plates. */
export function planPrint(parts: PrintPart[], printer: Printer): PrintPlan {
  const copies: PrintCopy[] = [];
  const estimates: PartEstimate[] = [];
  parts.forEach((p, k) => {
    const o = orientForPrint(p.mesh, p.build);
    estimates.push(estimatePart(o.positions, o.indices, p.material, { maxAngle: p.maxAngle, bridge: p.bridge, print: p.print, supports: p.supports }));
    for (let n = 0; n < p.qty; n++)
      copies.push({ part: k, copy: n, name: p.names?.[n] ?? (p.qty > 1 ? `${p.name} ${n + 1}` : p.name), material: p.material, color: p.color, positions: o.positions, indices: o.indices, size: o.size, face: o.face });
  });
  const { plates, tooBig } = packPlates(
    copies.map((c) => ({ name: c.name, w: c.size[0], d: c.size[1], material: c.material })),
    printer.bed,
    { nozzles: printer.nozzles },
  );
  const withTotals = plates.map((pl) => {
    let grams = 0;
    let supportGrams = 0;
    let hours = START;
    for (const q of pl.places) {
      const e = estimates[copies[q.item].part];
      grams += e.grams + e.supportGrams;
      supportGrams += e.supportGrams;
      hours += e.hours;
    }
    return { ...pl, grams, supportGrams, hours };
  });
  return {
    printer,
    parts,
    estimates,
    copies,
    plates: withTotals,
    tooBig,
    grams: withTotals.reduce((a, p) => a + p.grams, 0),
    supportGrams: withTotals.reduce((a, p) => a + p.supportGrams, 0),
    hours: withTotals.reduce((a, p) => a + p.hours, 0),
  };
}

/** A copy's placement on its plate as a 3MF build matrix (column-major): a quarter turn if packed so, then moved. */
export function plateMatrix(c: PrintCopy, q: { x: number; y: number; turned: boolean }): number[] {
  const [w, d] = c.size;
  // the mesh is centred on x = y = 0; its footprint's corner goes to (x, y)
  if (!q.turned) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, q.x + w / 2, q.y + d / 2, 0, 1];
  return [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, q.x + d / 2, q.y + w / 2, 0, 1];
}

/**
 * How many materials a printer lays on one plate: its tool heads or nozzles where its name or note counts them
 * ("5 toolheads", "two nozzles"), two for the dual-nozzle and IDEX machines, else one. A single nozzle with a
 * filament changer still prints one material a plate here: colours change, the plastic stays.
 */
export function nozzlesOf(m: Pick<MachineProfile, "name" | "note"> | undefined): number {
  if (!m) return 1;
  const words = `${m.name} ${m.note ?? ""}`;
  const counted = /(\d+|two|three|four|five)\s*(?:tool\s*heads?|toolheads?|nozzles?|extruders?|heads?)/i.exec(words);
  if (counted) {
    const n = Number(counted[1]) || ["two", "three", "four", "five"].indexOf(counted[1].toLowerCase()) + 2;
    return Math.max(1, Math.min(8, n));
  }
  return /\b(dual|IDEX|H2D|X2D)\b/i.test(words) ? 2 : 1;
}

/** Grams of filament as a slicer shows them: 0.4, 9.7, 38, 162. */
export const fmtGrams = (g: number) => (g >= 10 ? `${Math.round(g)}` : g.toFixed(1));

/** A print time: 7 min, 1 h 5 min, 12 h. */
export function fmtPrintTime(h: number): string {
  const min = Math.max(1, Math.round(h * 60));
  if (min < 60) return `${min} min`;
  const m = min % 60;
  return m ? `${Math.floor(min / 60)} h ${m} min` : `${min / 60} h`;
}

