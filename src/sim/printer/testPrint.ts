// Test prints without a slicer: slicer-style G-code for a few simple objects
// (a calibration cube, a cylinder, a first-layer square and an open-top box),
// written the way PrusaSlicer writes it. Walls are closed loops that start
// at a fixed seam, infill is rectilinear at ±45° clipped inside the innermost
// wall and joined along its edge, travels retract, and the start and end code
// suit the firmware: Klipper's START_PRINT/END_PRINT macros, or heating,
// homing, meshing and a prime line. The printer simulation runs the result
// through each firmware's motion planner, so the moves are the ones a real
// slicer would send: long straight walls with sharp corners, round walls of
// many short segments, and short zig-zags of solid infill.

export type TestShape = "cube" | "cylinder" | "first_layer" | "box";
export type PrintMaterial = "PLA" | "PETG" | "ABS";

export interface TestPrintSpec {
  shape: TestShape;
  /** mm: cube edge, cylinder diameter, first_layer square side, box outer side */
  size: number;
  /** mm; cube: size, cylinder: size, box: 40, first_layer: one layer */
  height?: number;
  /** layer height, mm (0.2) */
  layer: number;
  /** first layer height, mm (same as layer when left out) */
  firstLayer?: number;
  /** walls (perimeters) per layer (2; box: 2) */
  walls: number;
  /** sparse infill share 0..1 (0.15; values above 1 are read as percent); box and vase have none */
  infill: number;
  /** solid layers at the bottom and top (4) */
  solid: number;
  /** mm/s: inner walls and infill; outer wall at 0.6×, solid infill at 0.8×, first layer at `firstSpeed` */
  speed: number;
  /** mm/s, everything on the first layer (25) */
  firstSpeed: number;
  /** mm/s, travel moves (150) */
  travel: number;
  material: PrintMaterial;
  /** °C; from the material when left out (PLA 210/60, PETG 240/80, ABS 250/100) */
  hotend?: number;
  bed?: number;
  /** printed as one continuous spiral wall after the solid bottom (vase mode): cylinder, cube or box */
  vase?: boolean;
  /** centre on the bed, printer coordinates (the bed centre when left out) */
  center?: [number, number];
}

export interface PrinterTarget {
  flavor: "klipper" | "marlin" | "reprapfirmware";
  /** the firmware config has a START_PRINT/END_PRINT macro pair (Klipper configs Kerf writes do) */
  startMacro: boolean;
  /** a bed probe: mesh the bed in the start code */
  probe: boolean;
  /** printable size, mm */
  size: { x: number; y: number; z: number };
  /** nozzle diameter, mm (0.4) */
  nozzle: number;
  /** filament diameter, mm (1.75) */
  filament: number;
}

export interface TestPrint {
  gcode: string;
  /** what was made, in one sentence for people ("20 mm calibration cube in PLA, 0.2 mm layers, 2 walls, 15 % infill") */
  title: string;
  layers: number;
  /** filament used, mm */
  filament: number;
  /** extruding moves */
  moves: number;
}

/** One line on each shape, for docs and the assistant. */
export const TEST_SHAPES: Record<TestShape, string> = {
  cube: "Calibration cube: walls, sparse infill and solid bottom and top layers; checks dimensions, steps/mm and extrusion.",
  cylinder:
    "Cylinder: round walls of many 0.5–1 mm segments, which works the planner's cornering and lookahead; `vase: true` prints it as one spiral wall.",
  first_layer: "First-layer square: one layer of skirt, walls and solid fill; checks bed level, Z offset and first-layer squish.",
  box: "Open-top box: a solid bottom, then walls only; checks wall thickness, layer adhesion and ringing on long straight walls.",
};

/** What each material prints with: temperatures, part fan from the second layer (0..255), retraction, g/cm³, mm/s. */
const MATERIAL: Record<PrintMaterial, { hotend: number; bed: number; fan: number; retract: number; density: number; speed: number }> = {
  PLA: { hotend: 210, bed: 60, fan: 255, retract: 0.8, density: 1.24, speed: 60 },
  PETG: { hotend: 240, bed: 80, fan: 77, retract: 1.0, density: 1.27, speed: 50 },
  ABS: { hotend: 250, bed: 100, fan: 0, retract: 0.8, density: 1.04, speed: 60 },
};

/** Defaults for a shape and material, merged under what the user gave. */
export function testPrintDefaults(shape: TestShape, material: PrintMaterial = "PLA"): TestPrintSpec {
  return {
    shape,
    size: shape === "first_layer" ? 50 : shape === "box" ? 40 : 20,
    layer: 0.2,
    walls: 2,
    infill: shape === "box" ? 0 : 0.15,
    solid: 4,
    speed: MATERIAL[material].speed,
    firstSpeed: 25,
    travel: 150,
    material,
  };
}

/** Round walls are polygons with segments about this long, mm. */
const SEG = 0.75;
/** Where round walls start and end: rear left. */
const SEAM = (135 * Math.PI) / 180;
/** Gap between the object and its skirt, mm. */
const SKIRT_GAP = 3;
/** Travels longer than this retract first, mm. */
const RETRACT_MIN = 2;
/** mm/min: retraction, Z moves, the prime line. */
const RETRACT_F = 2100;
const Z_F = 720;
const PRIME_F = 1000;

type Pt = [number, number];

/** A number as slicers write it: fixed decimals, trailing zeros dropped, never "-0". */
function num(v: number, digits: number): string {
  const s = v.toFixed(digits).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

const mod = (v: number, m: number) => {
  const r = ((v % m) + m) % m;
  return r > m - 1e-9 ? 0 : r;
};

/** Centre-to-centre spacing of neighbouring walls of width w and height h, as slicers space them. */
const spacing = (w: number, h: number) => w - h * (1 - Math.PI / 4);

/** The object's outline: a square (half its side) or a circle (its radius) about a centre. */
interface Footprint {
  round: boolean;
  half: number;
  c: Pt;
}

/** A wall loop `inset` mm inside the outline, counter-clockwise from the seam, not repeating its first point. */
function ring(f: Footprint, inset: number): Pt[] {
  const a = f.half - inset;
  const [cx, cy] = f.c;
  if (!f.round) {
    return [
      [cx - a, cy + a],
      [cx - a, cy - a],
      [cx + a, cy - a],
      [cx + a, cy + a],
    ];
  }
  const n = Math.max(12, Math.ceil((2 * Math.PI * a) / SEG));
  const pts: Pt[] = [];
  for (let k = 0; k < n; k++) {
    const t = SEAM + (2 * Math.PI * k) / n;
    pts.push([cx + a * Math.cos(t), cy + a * Math.sin(t)]);
  }
  return pts;
}

/** The skirt: the outline grown by d, with rounded corners on a square as a slicer's offset makes them. */
function skirtRing(f: Footprint, d: number): Pt[] {
  if (f.round) return ring(f, -d);
  const [cx, cy] = f.c;
  const a = f.half;
  const n = Math.max(2, Math.ceil(((Math.PI / 2) * d) / SEG));
  const pts: Pt[] = [];
  const corners: [number, number, number][] = [
    [-1, -1, 180],
    [1, -1, 270],
    [1, 1, 0],
    [-1, 1, 90],
  ];
  for (const [sx, sy, from] of corners) {
    for (let k = 0; k <= n; k++) {
      const t = ((from + (90 * k) / n) * Math.PI) / 180;
      pts.push([cx + sx * a + d * Math.cos(t), cy + sy * a + d * Math.sin(t)]);
    }
  }
  return pts;
}

/** Where a fill line meets the fill boundary: the point, the edge it is on and how far along it (0..1). */
interface Hit {
  p: Pt;
  edge: number;
  u: number;
}

/** The convex area infill goes in, as a polygon: clips fill lines and joins their ends along its edge. */
class Boundary {
  private cum: number[] = [];
  private len: number[] = [];
  private total = 0;

  constructor(readonly poly: Pt[]) {
    for (let i = 0; i < poly.length; i++) {
      const [p, q] = [poly[i], poly[(i + 1) % poly.length]];
      this.cum.push(this.total);
      this.len.push(Math.hypot(q[0] - p[0], q[1] - p[1]));
      this.total += this.len[i];
    }
  }

  private pos(h: Hit) {
    return this.cum[h.edge] + h.u * this.len[h.edge];
  }

  /** The part of the line through o along d inside the polygon, its ends in the order of d. */
  clip(o: Pt, d: Pt): [Hit, Hit] | null {
    let a: Hit | null = null;
    let b: Hit | null = null;
    let ta = Infinity;
    let tb = -Infinity;
    const n = this.poly.length;
    for (let i = 0; i < n; i++) {
      const [p, q] = [this.poly[i], this.poly[(i + 1) % n]];
      const ex = q[0] - p[0];
      const ey = q[1] - p[1];
      const den = d[0] * ey - d[1] * ex;
      if (Math.abs(den) < 1e-12) continue;
      const wx = p[0] - o[0];
      const wy = p[1] - o[1];
      const t = (wx * ey - wy * ex) / den;
      const u = (wx * d[1] - wy * d[0]) / den;
      if (u < -1e-9 || u > 1 + 1e-9) continue;
      const uu = Math.min(1, Math.max(0, u));
      const hit: Hit = { p: [p[0] + uu * ex, p[1] + uu * ey], edge: i, u: uu };
      if (t < ta) [ta, a] = [t, hit];
      if (t > tb) [tb, b] = [t, hit];
    }
    return a && b && tb - ta > 1e-9 ? [a, b] : null;
  }

  /** The shorter way round the edge from one hit to another: the corners passed, then the end. */
  path(a: Hit, b: Hit): { pts: Pt[]; length: number } {
    const n = this.poly.length;
    const sa = this.pos(a);
    const fwd = mod(this.pos(b) - sa, this.total);
    const back = this.total - fwd;
    const pts: Pt[] = [];
    for (let k = 0; k < n; k++) {
      const v = fwd <= back ? (a.edge + 1 + k) % n : (a.edge - k + n) % n;
      const dv = fwd <= back ? mod(this.cum[v] - sa, this.total) : mod(sa - this.cum[v], this.total);
      if (dv >= Math.min(fwd, back) - 1e-9) break;
      if (dv > 1e-9) pts.push(this.poly[v]);
    }
    pts.push(b.p);
    return { pts, length: Math.min(fwd, back) };
  }
}

/** Collects the G-code and keeps track of the nozzle, the feed rate, retraction and the filament used. */
class Writer {
  readonly out: string[] = [];
  x = NaN;
  y = NaN;
  z = NaN;
  filament = 0;
  moves = 0;
  private f = NaN;
  private retracted = false;
  private role = "";
  private width = NaN;

  constructor(
    private area: number,
    private retractLen: number,
    private travelF: number,
  ) {}

  line(s: string) {
    this.out.push(s);
  }

  /** " F<mm/min>" when the feed rate changes, "" when it stays. */
  private feed(mmPerMin: number) {
    const f = Math.round(mmPerMin);
    if (f === this.f) return "";
    this.f = f;
    return ` F${f}`;
  }

  /** A new layer names its features again. */
  newLayer() {
    this.role = "";
    this.width = NaN;
  }

  retract() {
    if (this.retracted) return;
    this.retracted = true;
    this.f = RETRACT_F;
    this.line(`G1 E-${num(this.retractLen, 5)} F${RETRACT_F}`);
  }

  private unretract() {
    if (!this.retracted) return;
    this.retracted = false;
    this.f = RETRACT_F;
    this.line(`G1 E${num(this.retractLen, 5)} F${RETRACT_F}`);
  }

  lift(z: number, note = "") {
    this.z = z;
    this.line(`G1 Z${num(z, 3)}${this.feed(Z_F)}${note}`);
  }

  /** A move without extruding, retracting first when it is long (or from somewhere unknown). */
  travel(p: Pt, retract = true) {
    const [X, Y] = [num(p[0], 3), num(p[1], 3)];
    if (X === num(this.x, 3) && Y === num(this.y, 3)) return;
    if (retract && !(Math.hypot(p[0] - this.x, p[1] - this.y) <= RETRACT_MIN)) this.retract();
    this.line(`G1 X${X} Y${Y}${this.feed(this.travelF)}`);
    [this.x, this.y] = p;
  }

  /** An extruding move to p laying a w × h line (times `flow`), rising to z when given. */
  extrude(p: Pt, role: string, w: number, h: number, mmPerS: number, z?: number, flow = 1) {
    const [X, Y] = [num(p[0], 3), num(p[1], 3)];
    const Z = z === undefined || num(z, 3) === num(this.z, 3) ? "" : num(z, 3);
    if (X === num(this.x, 3) && Y === num(this.y, 3) && !Z) return;
    this.unretract();
    if (role !== this.role) this.line(`;TYPE:${role}`);
    if (w !== this.width) this.line(`;WIDTH:${num(w, 3)}`);
    [this.role, this.width] = [role, w];
    const e = Number(num((Math.hypot(p[0] - this.x, p[1] - this.y) * w * h * flow) / this.area, 5));
    this.line(`G1 X${X} Y${Y}${Z ? ` Z${Z}` : ""}${e > 0 ? ` E${num(e, 5)}` : ""}${this.feed(mmPerS * 60)}`);
    [this.x, this.y] = p;
    if (z !== undefined) this.z = z;
    if (e > 0) {
      this.filament += e;
      this.moves++;
    }
  }

  /** A start-code extrusion with its E given, like a printer profile's prime line. */
  prime(p: Pt, e: number) {
    const E = Number(num(e, 5));
    this.line(`G1 X${num(p[0], 3)} Y${num(p[1], 3)} E${num(E, 5)}${this.feed(PRIME_F)} ; prime line`);
    [this.x, this.y] = p;
    this.filament += E;
    this.moves++;
  }
}

/** Slicer-style G-code for a test object on a printer. Throws when it does not fit or cannot be printed. */
export function testPrintGcode(spec: TestPrintSpec, target: PrinterTarget): TestPrint {
  const mat = MATERIAL[spec.material];
  if (!mat) throw new Error(`unknown material "${spec.material}": PLA, PETG or ABS`);
  if (!TEST_SHAPES[spec.shape]) throw new Error(`unknown test shape "${spec.shape}": ${Object.keys(TEST_SHAPES).join(", ")}`);
  const h = spec.layer;
  const h1 = spec.firstLayer ?? h;
  const nozzle = target.nozzle;
  const positive: [string, number][] = [
    ["size", spec.size],
    ["layer", h],
    ["firstLayer", h1],
    ["speed", spec.speed],
    ["firstSpeed", spec.firstSpeed],
    ["travel", spec.travel],
    ["nozzle", nozzle],
    ["filament", target.filament],
  ];
  for (const [k, v] of positive) if (!(v > 0)) throw new Error(`${k} should be more than 0 (got ${v})`);
  if (Math.max(h, h1) > 0.8 * nozzle) throw new Error(`${num(Math.max(h, h1), 3)} mm layers are too thick for a ${num(nozzle, 2)} mm nozzle (at most ${num(0.8 * nozzle, 2)} mm)`);
  const shape = spec.shape;
  const vase = !!spec.vase;
  if (vase && shape === "first_layer") throw new Error("a first-layer square is one layer: vase mode needs a cylinder, cube or box");

  const wN = 1.125 * nozzle;
  const w1 = 1.2 * nozzle;
  const height = shape === "first_layer" ? h1 : (spec.height ?? (shape === "box" ? 40 : spec.size));
  const n = shape === "first_layer" ? 1 : Math.max(1, Math.round((height - h1) / h + 1e-9) + 1);
  const zAt = (i: number) => Math.round((h1 + i * h) * 1e6) / 1e6;
  const walls = vase ? 1 : Math.max(1, Math.round(spec.walls));
  const solid = Math.max(0, Math.round(spec.solid));
  const bottom = vase ? Math.max(1, solid) : solid;
  const share = spec.infill > 1 ? spec.infill / 100 : spec.infill;
  const sparse = shape === "box" || vase ? 0 : Math.min(1, Math.max(0, share || 0));
  const hotend = spec.hotend ?? mat.hotend;
  const bed = spec.bed ?? mat.bed;
  const size = target.size;
  const c: Pt = spec.center ?? [size.x / 2, size.y / 2];
  const foot: Footprint = { round: shape === "cylinder", half: spec.size / 2, c };
  const skirtD = SKIRT_GAP + w1 / 2;
  const macro = target.flavor === "klipper" && target.startMacro;

  // It has to fit: the skirt on the bed, the top under the gantry, walls inside the outline.
  const reach = foot.half + skirtD + w1 / 2;
  if (c[0] - reach < 0 || c[0] + reach > size.x || c[1] - reach < 0 || c[1] + reach > size.y) {
    throw new Error(
      `the ${num(spec.size, 2)} mm ${shape.replace("_", " ")} and its skirt reach X ${num(c[0] - reach, 1)}..${num(c[0] + reach, 1)}, Y ${num(c[1] - reach, 1)}..${num(c[1] + reach, 1)}: outside the ${num(size.x, 1)} × ${num(size.y, 1)} mm bed`,
    );
  }
  if (zAt(n - 1) > size.z) throw new Error(`${num(zAt(n - 1), 2)} mm is taller than the printer's ${num(size.z, 1)} mm of Z`);
  if (foot.half <= 2 * w1) throw new Error(`${num(spec.size, 2)} mm is too small: it needs at least ${num(4 * w1, 2)} mm for walls`);

  const title = titleOf(spec, shape, height, h, h1, walls, sparse, vase);
  const area = Math.PI * (target.filament / 2) ** 2;
  const o = new Writer(area, mat.retract, spec.travel * 60);

  // ---------- header and start code ----------
  const object =
    shape === "cube" ? `calibration_cube_${num(spec.size, 2)}mm` : shape === "cylinder" ? `cylinder_${num(spec.size, 2)}x${num(height, 2)}mm` : shape === "box" ? `open_box_${num(spec.size, 2)}x${num(height, 2)}mm` : `first_layer_${num(spec.size, 2)}mm`;
  const flavorName = { klipper: "klipper", marlin: "marlin2", reprapfirmware: "reprapfirmware" }[target.flavor];
  o.line("; generated by Kerf test print");
  o.line(`; ${title}`);
  o.line(";");
  const settings: [string, string][] = [
    ["object", object],
    ["external perimeters extrusion width", `${num(wN, 3)}mm`],
    ["perimeters extrusion width", `${num(wN, 3)}mm`],
    ["infill extrusion width", `${num(wN, 3)}mm`],
    ["solid infill extrusion width", `${num(wN, 3)}mm`],
    ["first layer extrusion width", `${num(w1, 3)}mm`],
    ["layer_height", num(h, 3)],
    ["first_layer_height", num(h1, 3)],
    ["perimeters", String(walls)],
    ["fill_density", `${num(sparse * 100, 1)}%`],
    ["fill_pattern", "rectilinear"],
    ["bottom_solid_layers", String(bottom)],
    ["top_solid_layers", String(shape === "box" || vase ? 0 : solid)],
    ["spiral_vase", vase ? "1" : "0"],
    ["skirts", "1"],
    ["skirt_distance", num(SKIRT_GAP, 2)],
    ["filament_type", spec.material],
    ["filament_diameter", num(target.filament, 3)],
    ["nozzle_diameter", num(nozzle, 3)],
    ["temperature", num(hotend, 1)],
    ["bed_temperature", num(bed, 1)],
    ["retract_length", num(mat.retract, 2)],
    ["retract_before_travel", num(RETRACT_MIN, 2)],
    ["travel_speed", num(spec.travel, 1)],
    ["gcode_flavor", flavorName],
    ["bed_shape", `0x0,${num(size.x, 1)}x0,${num(size.x, 1)}x${num(size.y, 1)},0x${num(size.y, 1)}`],
    ["max_print_height", num(size.z, 1)],
  ];
  for (const [k, v] of settings) o.line(`; ${k} = ${v}`);
  o.line("");
  if (target.flavor === "reprapfirmware") o.line("T0 ; select the tool before heating it");
  o.line("M107");
  o.line(";TYPE:Custom");
  o.line("G21 ; set units to millimeters");
  o.line("G90 ; use absolute coordinates");
  o.line("M83 ; use relative distances for extrusion");
  if (macro) {
    o.line(`START_PRINT BED_TEMP=${num(bed, 1)} EXTRUDER_TEMP=${num(hotend, 1)}`);
    o.line("G90 ; the macro may change modes: absolute XYZ");
    o.line("M83 ; and relative E");
  } else {
    o.line(`M140 S${num(bed, 1)} ; set bed temperature`);
    o.line("M104 S150 ; warm the hotend without oozing while homing");
    o.line("G28 ; home all axes");
    o.line(`M190 S${num(bed, 1)} ; wait for the bed`);
    if (target.probe) o.line(target.flavor === "klipper" ? "BED_MESH_CALIBRATE ; probe a bed mesh" : "G29 ; probe a bed mesh");
    o.line(`M109 S${num(hotend, 1)} ; wait for the hotend`);
    // Two lines along the front-left edge, like Prusa's intro line: 0.36 mm²
    // of plastic per mm, then a fatter 0.75 mm² to finish priming the nozzle.
    const run = size.x - 10;
    const [x1, x2, yp] = [5 + Math.min(60, 0.5 * run), 5 + Math.min(100, 0.85 * run), Math.min(3, size.y / 2)];
    o.lift(Math.min(2, size.z), " ; lift off the bed");
    o.travel([5, yp], false);
    o.lift(h1);
    o.prime([x1, yp], ((x1 - 5) * 0.36) / area);
    o.prime([x2, yp], ((x2 - x1) * 0.75) / area);
  }

  // ---------- layers ----------
  for (let i = 0; i < n; i++) {
    const first = i === 0;
    const lh = first ? h1 : h;
    const z = zAt(i);
    const w = first ? w1 : wN;
    const s = spacing(w, lh);
    o.line(";LAYER_CHANGE");
    o.line(`;Z:${num(z, 3)}`);
    o.line(`;HEIGHT:${num(lh, 3)}`);
    o.newLayer();
    if (i === 1) o.line(`M106 S${mat.fan}`);
    const speedOf = (role: string) =>
      first ? spec.firstSpeed : role === "External perimeter" ? 0.6 * spec.speed : role === "Solid infill" ? 0.8 * spec.speed : spec.speed;

    if (vase && i >= bottom) {
      // One loop per layer, rising from the last layer's height to this one's
      // as it goes round; the first loop ramps its flow up from nothing.
      const pts = ring(foot, wN / 2);
      const zFrom = zAt(i - 1);
      if (i === bottom) {
        o.retract();
        o.travel(pts[0]);
      }
      let total = 0;
      const cum = [0];
      for (let j = 1; j <= pts.length; j++) {
        const [p, q] = [pts[j - 1], pts[j % pts.length]];
        cum.push((total += Math.hypot(q[0] - p[0], q[1] - p[1])));
      }
      for (let j = 1; j <= pts.length; j++) {
        const flow = i === bottom ? (cum[j - 1] + cum[j]) / 2 / total : 1;
        const zj = j === pts.length ? z : zFrom + (cum[j] / total) * h;
        o.extrude(pts[j % pts.length], "External perimeter", wN, h, speedOf("External perimeter"), zj, flow);
      }
      continue;
    }

    // Walls that fit, then the fill area where one more wall would go.
    let loops = 0;
    while (loops < walls && foot.half - (w / 2 + loops * s) > w / 2) loops++;
    const fillInset = w / 2 + loops * s;
    const solidLayer = shape === "first_layer" || i < bottom || (shape !== "box" && !vase && i >= n - solid);
    const fillShare = solidLayer ? 1 : sparse;
    const skirt = first ? skirtRing(foot, skirtD) : null;

    // Retract for the layer change; the first layer travels before it comes down.
    o.retract();
    if (skirt) o.travel(skirt[0]);
    o.lift(z);

    if (skirt) loop(o, skirt, "Skirt", w, lh, speedOf("Skirt"));
    for (let k = loops - 1; k >= 0; k--) {
      const role = k === 0 ? "External perimeter" : "Perimeter";
      loop(o, ring(foot, w / 2 + k * s), role, w, lh, speedOf(role));
    }
    if (fillShare > 0 && foot.half - fillInset > w / 2) {
      const role = solidLayer ? "Solid infill" : "Internal infill";
      fill(o, new Boundary(ring(foot, fillInset)), c, i % 2 === 0 ? 45 : -45, w / fillShare, role, w, lh, speedOf(role));
    }
  }

  // ---------- end code ----------
  o.retract();
  o.line(";TYPE:Custom");
  if (macro) o.line("END_PRINT");
  else {
    o.lift(Math.min(o.z + 10, size.z), " ; lift the nozzle");
    o.line(`G1 X0 Y${num(size.y, 3)} F${Math.round(spec.travel * 60)} ; park at the back`);
    o.line("M104 S0 ; hotend off");
    o.line("M140 S0 ; bed off");
    o.line("M107 ; fan off");
    o.line("M84 ; motors off");
  }
  const filament = Math.round(o.filament * 100) / 100;
  const cm3 = (filament * area) / 1000;
  o.line("");
  o.line(`; filament used [mm] = ${num(filament, 2)}`);
  o.line(`; filament used [cm3] = ${num(cm3, 2)}`);
  o.line(`; filament used [g] = ${num(cm3 * mat.density, 2)}`);
  o.line(`; total layers count = ${n}`);
  o.line(`; extruding moves = ${o.moves}`);
  return { gcode: o.out.join("\n") + "\n", title, layers: n, filament, moves: o.moves };
}

/** A closed loop from its first point round to its first point again. */
function loop(o: Writer, pts: Pt[], role: string, w: number, h: number, speed: number) {
  o.travel(pts[0]);
  for (let j = 1; j <= pts.length; j++) o.extrude(pts[j % pts.length], role, w, h, speed);
}

/**
 * Rectilinear fill at `angle` degrees: parallel lines `gap` apart on a grid
 * through the object's centre, clipped to the boundary, printed back and
 * forth from the end nearest the nozzle. Neighbouring ends are joined along
 * the boundary when that is short, as slicers anchor their infill.
 */
function fill(o: Writer, b: Boundary, c: Pt, angle: number, gap: number, role: string, w: number, h: number, speed: number) {
  const a = (angle * Math.PI) / 180;
  const d: Pt = [Math.cos(a), Math.sin(a)];
  const nrm: Pt = [-d[1], d[0]];
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of b.poly) {
    const off = (p[0] - c[0]) * nrm[0] + (p[1] - c[1]) * nrm[1];
    [lo, hi] = [Math.min(lo, off), Math.max(hi, off)];
  }
  const lines: [Hit, Hit][] = [];
  for (let k = Math.ceil(lo / gap - 1e-9); k * gap <= hi + 1e-9; k++) {
    const l = b.clip([c[0] + nrm[0] * k * gap, c[1] + nrm[1] * k * gap], d);
    if (l && Math.hypot(l[1].p[0] - l[0].p[0], l[1].p[1] - l[0].p[1]) >= w) lines.push(l);
  }
  if (!lines.length) return;
  const ends = [lines[0][0], lines[0][1], lines[lines.length - 1][0], lines[lines.length - 1][1]];
  let best = 0;
  ends.forEach((e, j) => {
    if (Math.hypot(e.p[0] - o.x, e.p[1] - o.y) < Math.hypot(ends[best].p[0] - o.x, ends[best].p[1] - o.y)) best = j;
  });
  const order = best < 2 ? lines : lines.slice().reverse();
  let forward = best % 2 === 0;
  let prev: Hit | null = null;
  for (const l of order) {
    const [from, to] = forward ? l : [l[1], l[0]];
    const link = prev ? b.path(prev, from) : null;
    if (link && link.length <= 3 * gap) for (const p of link.pts) o.extrude(p, role, w, h, speed);
    else o.travel(from.p);
    o.extrude(to.p, role, w, h, speed);
    prev = to;
    forward = !forward;
  }
}

function titleOf(spec: TestPrintSpec, shape: TestShape, height: number, h: number, h1: number, walls: number, sparse: number, vase: boolean): string {
  const mm = (v: number) => `${num(v, 2)} mm`;
  const mat = `in ${spec.material}`;
  const layers = `${mm(h)} layers`;
  const wallText = `${walls} wall${walls === 1 ? "" : "s"}`;
  const infill = `${num(sparse * 100, 1)} % infill`;
  if (shape === "first_layer") return `${mm(spec.size)} first-layer square ${mat}, one ${mm(h1)} layer`;
  if (vase) {
    const what = shape === "cylinder" ? "vase-mode cylinder" : shape === "box" ? "vase-mode box" : "vase-mode square";
    return `${mm(spec.size)} ${what}, ${mm(height)} tall, ${mat}, ${layers}, one spiral wall`;
  }
  if (shape === "box") return `${mm(spec.size)} open-top box, ${mm(height)} tall, ${mat}, ${layers}, ${wallText}`;
  if (shape === "cylinder") return `${mm(spec.size)} cylinder, ${mm(height)} tall, ${mat}, ${layers}, ${wallText}, ${infill}`;
  const what = Math.abs(height - spec.size) < 1e-6 ? `${mm(spec.size)} calibration cube` : `${num(spec.size, 2)} × ${num(spec.size, 2)} × ${mm(height)} block`;
  return `${what} ${mat}, ${layers}, ${wallText}, ${infill}`;
}
