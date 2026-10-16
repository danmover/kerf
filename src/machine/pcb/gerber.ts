// Files for the board house: RS-274X Gerbers (millimetres, 4.6 format) for
// copper, solder mask, silkscreen and outline, Excellon drill files for
// plated and non-plated holes, and a README that walks a beginner through
// the order. Names follow the Protel convention JLCPCB and PCBWay recognise.
//
// Pours are written as G36/G37 regions. Their holes are joined to the outline
// by cut-ins (a zero-width slit out and back along the same line), so every
// region is one dark contour and no layer needs clear polarity.

import { holeShape, placedHoles, placedPads, type PlacedPad } from "./board";
import { normDeg, padShape, type Pt } from "./geom";
import { pourGroups } from "./pour";
import { boardSilk, type SilkLayer } from "./silk";
import type { BoardFile, Layer, RoutedBoard } from "./types";

/** Mask openings are this much bigger than the copper on every side. */
export const MASK_EXPAND = 0.05;

const fmtCoord = (v: number) => Math.round(v * 1e6).toString();
const fmtDim = (v: number) => (Math.round(v * 1e6) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, ".0");

/** A design's text made safe for a Gerber or drill comment: `*` and `%` end Gerber commands, and a line break would start a new one. */
export const commentText = (s: string) => s.replace(/[*%]|[^\x20-\x7e]/g, " ");

class Gerber {
  private apertures = new Map<string, number>();
  private defs: string[] = [];
  private body: string[] = [];
  private current = -1;
  private readonly title: string;
  constructor(
    title: string,
    private readonly fn: string,
    private readonly polarity = "Positive",
  ) {
    this.title = commentText(title);
  }
  ap(kind: "C" | "R" | "O", ...dims: number[]): number {
    const key = `${kind},${dims.map(fmtDim).join("X")}`;
    let d = this.apertures.get(key);
    if (d === undefined) {
      d = 10 + this.apertures.size;
      this.apertures.set(key, d);
      this.defs.push(`%ADD${d}${key}*%`);
    }
    return d;
  }
  private use(d: number) {
    if (this.current !== d) {
      this.body.push(`D${d}*`);
      this.current = d;
    }
  }
  flash(d: number, x: number, y: number) {
    this.use(d);
    this.body.push(`X${fmtCoord(x)}Y${fmtCoord(y)}D03*`);
  }
  stroke(d: number, pts: Pt[]) {
    if (pts.length < 2) return;
    this.use(d);
    this.body.push(`X${fmtCoord(pts[0][0])}Y${fmtCoord(pts[0][1])}D02*`);
    for (let k = 1; k < pts.length; k++) this.body.push(`X${fmtCoord(pts[k][0])}Y${fmtCoord(pts[k][1])}D01*`);
  }
  region(ring: Pt[]) {
    if (ring.length < 3) return;
    this.body.push("G36*", `X${fmtCoord(ring[0][0])}Y${fmtCoord(ring[0][1])}D02*`);
    for (let k = 1; k < ring.length; k++) this.body.push(`X${fmtCoord(ring[k][0])}Y${fmtCoord(ring[k][1])}D01*`);
    this.body.push(`X${fmtCoord(ring[0][0])}Y${fmtCoord(ring[0][1])}D01*`, "G37*");
  }
  raw(s: string) {
    this.body.push(s);
  }
  toString(): string {
    return [
      `G04 ${this.title}*`,
      "%TF.GenerationSoftware,Kerf,Kerf,1*%",
      `%TF.FileFunction,${this.fn}*%`,
      `%TF.FilePolarity,${this.polarity}*%`,
      "%FSLAX46Y46*%",
      "%MOMM*%",
      "%LPD*%",
      "G01*",
      ...this.defs,
      ...this.body,
      "M02*",
      "",
    ].join("\n");
  }
}

/** Flashes a pad, grown by `grow`: an aperture when it sits square, a region or a stroke when turned. */
function padOut(g: Gerber, p: PlacedPad, grow: number) {
  const rot = normDeg(p.rot);
  const square = rot % 90 === 0;
  const swap = rot % 180 === 90;
  const w = (swap ? p.h : p.w) + 2 * grow;
  const h = (swap ? p.w : p.h) + 2 * grow;
  if (p.shape === "circle") return g.flash(g.ap("C", Math.max(p.w, p.h) + 2 * grow), p.x, p.y);
  if (square) return g.flash(g.ap(p.shape === "rect" ? "R" : "O", w, h), p.x, p.y);
  const s = padShape(p, grow);
  if (s.k === "cap") return g.stroke(g.ap("C", 2 * s.r), [
    [s.ax, s.ay],
    [s.bx, s.by],
  ]);
  const ring: Pt[] = [];
  for (let k = 0; k < s.p.length; k += 2) ring.push([s.p[k], s.p[k + 1]]);
  g.region(ring);
}

function copper(b: RoutedBoard, layer: Layer, title: string): string {
  const g = new Gerber(title, layer === "F" ? "Copper,L1,Top" : "Copper,L2,Bot");
  for (const p of b.pours) if (p.layer === layer) for (const grp of pourGroups(p.polys)) g.region(fracture(grp[0], grp.slice(1)));
  for (const t of b.tracks) if (t.layer === layer) g.stroke(g.ap("C", t.w), t.pts);
  for (const p of placedPads(b.spec)) padOut(g, p, 0);
  for (const v of b.vias) g.flash(g.ap("C", v.pad), v.x, v.y);
  return g.toString();
}

function mask(b: RoutedBoard, layer: Layer, title: string): string {
  const g = new Gerber(title, layer === "F" ? "Soldermask,Top" : "Soldermask,Bot", "Negative");
  for (const p of placedPads(b.spec)) padOut(g, p, MASK_EXPAND);
  for (const h of placedHoles(b.spec)) g.flash(g.ap("C", h.d + 2 * MASK_EXPAND), h.x, h.y);
  return g.toString();
}

function silkscreen(s: SilkLayer, layer: Layer, title: string): string {
  const g = new Gerber(title, layer === "F" ? "Legend,Top" : "Legend,Bot");
  for (const l of s.lines) g.stroke(g.ap("C", l.w), l.pts);
  for (const d of s.dots) g.flash(g.ap("C", d.d), d.x, d.y);
  return g.toString();
}

function outline(b: RoutedBoard, title: string): string {
  const g = new Gerber(title, "Profile,NP");
  const { w, h } = b.spec;
  const r = Math.max(0, Math.min(b.spec.corner ?? 0, w / 2, h / 2));
  const d = g.ap("C", 0.1);
  const P = (x: number, y: number) => `X${fmtCoord(x)}Y${fmtCoord(y)}`;
  const IJ = (i: number, j: number) => `I${fmtCoord(i)}J${fmtCoord(j)}`;
  if (r <= 0) {
    g.stroke(d, [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
      [0, 0],
    ]);
    return g.toString();
  }
  g.stroke(d, [
    [r, 0],
    [w - r, 0],
  ]);
  // counter-clockwise quarter circles, centre given relative to the start
  g.raw("G75*");
  g.raw(`G03${P(w, r)}${IJ(0, r)}D01*`);
  g.raw(`G01${P(w, h - r)}D01*`);
  g.raw(`G03${P(w - r, h)}${IJ(-r, 0)}D01*`);
  g.raw(`G01${P(r, h)}D01*`);
  g.raw(`G03${P(0, h - r)}${IJ(0, -r)}D01*`);
  g.raw(`G01${P(0, r)}D01*`);
  g.raw(`G03${P(r, 0)}${IJ(r, 0)}D01*`);
  g.raw("G01*");
  return g.toString();
}

const fmtDrill = (v: number) => {
  const s = (Math.round(v * 1e4) / 1e4).toFixed(4).replace(/0+$/, "");
  return s.endsWith(".") ? s + "0" : s;
};

interface DrillHit {
  d: number;
  x: number;
  y: number;
  /** slot: the far end of the slot's centre line */
  x2?: number;
  y2?: number;
}

function excellon(hits: DrillHit[], plated: boolean, title: string): string {
  const tools: { d: number; slot: boolean; hits: DrillHit[] }[] = [];
  for (const h of hits) {
    const slot = h.x2 !== undefined;
    let t = tools.find((t) => Math.abs(t.d - h.d) < 1e-6 && t.slot === slot);
    if (!t) tools.push((t = { d: h.d, slot, hits: [] }));
    t.hits.push(h);
  }
  tools.sort((a, b) => a.d - b.d || Number(a.slot) - Number(b.slot));
  const lines = ["M48", `; ${commentText(title)}`, "; FORMAT={-:-/ absolute / metric / decimal}", `; #@! TF.FileFunction,${plated ? "Plated,1,2,PTH" : "NonPlated,1,2,NPTH"}`, "FMAT,2", "METRIC"];
  tools.forEach((t, i) => lines.push(`T${i + 1}C${fmtDrill(t.d)}`));
  lines.push("%", "G90", "G05");
  tools.forEach((t, i) => {
    lines.push(`T${i + 1}`);
    for (const h of t.hits)
      lines.push(h.x2 !== undefined ? `X${fmtDrill(h.x)}Y${fmtDrill(h.y)}G85X${fmtDrill(h.x2)}Y${fmtDrill(h.y2!)}` : `X${fmtDrill(h.x)}Y${fmtDrill(h.y)}`);
  });
  lines.push("M30", "");
  return lines.join("\n");
}

/** Plated holes (pads, slots, vias) and non-plated holes as drill hits. */
export function drillHits(b: RoutedBoard): { pth: DrillHit[]; npth: DrillHit[] } {
  const pth: DrillHit[] = [];
  for (const p of placedPads(b.spec)) {
    const s = holeShape(p);
    if (s.k === "cap" && (s.ax !== s.bx || s.ay !== s.by)) pth.push({ d: p.drill, x: s.ax, y: s.ay, x2: s.bx, y2: s.by });
    else pth.push({ d: p.drill, x: p.x, y: p.y });
  }
  for (const v of b.vias) pth.push({ d: v.drill, x: v.x, y: v.y });
  const npth = placedHoles(b.spec).map((h) => ({ d: h.d, x: h.x, y: h.y }));
  return { pth, npth };
}

export const safeName = (s: string) => s.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "board";

export function gerberFiles(b: RoutedBoard): BoardFile[] {
  const name = safeName(b.spec.name);
  const silk = boardSilk(b.spec);
  const t = (what: string) => `Kerf ${b.spec.name} ${what}`;
  const { pth, npth } = drillHits(b);
  const files: BoardFile[] = [
    { path: `${name}.GTL`, content: copper(b, "F", t("top copper")) },
    { path: `${name}.GBL`, content: copper(b, "B", t("bottom copper")) },
    { path: `${name}.GTS`, content: mask(b, "F", t("top solder mask")) },
    { path: `${name}.GBS`, content: mask(b, "B", t("bottom solder mask")) },
    { path: `${name}.GTO`, content: silkscreen(silk.F, "F", t("top silkscreen")) },
    { path: `${name}.GBO`, content: silkscreen(silk.B, "B", t("bottom silkscreen")) },
    { path: `${name}.GKO`, content: outline(b, t("board outline")) },
    { path: `${name}-PTH.DRL`, content: excellon(pth, true, t("plated holes")) },
    { path: `${name}-NPTH.DRL`, content: excellon(npth, false, t("non-plated holes")) },
  ];
  files.push({ path: "README.txt", content: readme(b, name, pth, npth) });
  return files;
}

function readme(b: RoutedBoard, name: string, pth: DrillHit[], npth: DrillHit[]): string {
  const { spec, rules } = b;
  const bottom = spec.parts.filter((p) => p.side === "bottom").map((p) => p.ref);
  const smallest = Math.min(...pth.map((h) => h.d), ...npth.map((h) => h.d));
  const slots = pth.filter((h) => h.x2 !== undefined).length;
  const lines = [
    `${spec.name}: circuit board files`,
    "Made with Kerf.",
    "",
    `Board: ${r1(spec.w)} x ${r1(spec.h)} mm, 2 layers, ${spec.parts.length} parts, all through-hole.`,
    `Holes: ${pth.length} plated (${b.vias.length} of them vias${slots ? `, ${slots} slots` : ""}), ${npth.length} not plated. Smallest hole ${r2(smallest)} mm.`,
    `Tracks ${r2(rules.track)} mm wide or wider, ${r2(rules.clearance)} mm apart or more.`,
    "",
    "HOW TO ORDER",
    "1. Put every file in this folder into one zip file (if you downloaded a zip from Kerf, use that zip as it is).",
    "2. Go to jlcpcb.com (\"Order now\") or pcbway.com (\"Quick-order PCB\") and upload the zip where it says \"Add gerber file\".",
    `3. The site reads the board size (${r1(spec.w)} x ${r1(spec.h)} mm) and shows a picture of both sides. Check it looks like the preview in Kerf.`,
    "4. Choose these options and leave everything else as it is:",
    "     Base material: FR-4",
    "     Layers: 2",
    "     PCB thickness: 1.6 mm",
    "     Surface finish: HASL lead-free (\"LeadFree HASL\")",
    "     Outer copper weight: 1 oz",
    "     Solder mask colour: any (green is usually cheapest and quickest)",
    "     Silkscreen: white",
    "     Quantity: 5 (the minimum; ten often costs the same)",
    "     No stencil: every part is through-hole.",
    "5. Add to cart and pay. Boards usually arrive in one to three weeks, depending on the shipping you pick.",
    "",
    "WHAT EACH FILE IS",
    `${name}.GTL        top copper (tracks, pads and the ground pour on the component side)`,
    `${name}.GBL        bottom copper`,
    `${name}.GTS        top solder mask (the openings over the pads)`,
    `${name}.GBS        bottom solder mask`,
    `${name}.GTO        top silkscreen (white printing: outlines, R1 10k labels, the board name)`,
    `${name}.GBO        bottom silkscreen (outlines and labels of parts that go on the bottom)`,
    `${name}.GKO        board outline (where the board is cut)`,
    `${name}-PTH.DRL    plated holes: pads, vias${slots ? " and slots (slots as G85)" : ""}`,
    `${name}-NPTH.DRL   holes without copper (mounting holes)`,
    "README.txt          this file; the board house ignores it",
    "",
    "NOTES FOR THE BOARD HOUSE",
    `- Units mm, Gerber RS-274X 4.6 format, Excellon drill files in mm with decimal points.`,
    `- Solder mask openings are ${MASK_EXPAND} mm larger than each pad on every side. Vias are tented (covered by solder mask).`,
    "- Ground pours connect to pads through thermal reliefs (four spokes) so they solder with a small iron.",
    "",
    "WHEN THE BOARDS ARRIVE",
    "- Solder the lowest parts first (resistors and diodes), then sockets, capacitors, regulators and connectors.",
    "- Check the marks: the band on a diode, the + on an electrolytic capacitor, the dot or notch at pin 1 of a chip.",
  ];
  if (bottom.length)
    lines.push(`- ${bottom.join(", ")} go on the BOTTOM side (their outlines are printed there). Push them in from the bottom and solder them on the top.`);
  lines.push("");
  return lines.join("\n");
}

const r1 = (v: number) => (Math.round(v * 10) / 10).toString();
const r2 = (v: number) => (Math.round(v * 100) / 100).toString();

// ---------------------------------------------------------------- cut-ins

// Joins holes into their outline with bridges, after the hole elimination in
// Mapbox's earcut (ISC licence): each hole, leftmost first, is bridged from
// its leftmost point to a visible point of the outline to its left. The
// outline runs counter-clockwise and holes clockwise, as the pours make them.

interface N {
  x: number;
  y: number;
  prev: N;
  next: N;
}

function ringList(r: Pt[]): N {
  let first: N | undefined;
  let last: N | undefined;
  for (const [x, y] of r) {
    const n = { x, y } as N;
    if (!first) {
      first = n;
      n.prev = n.next = n;
    } else {
      n.prev = last!;
      n.next = first;
      last!.next = n;
      first.prev = n;
    }
    last = n;
  }
  return first!;
}

const area = (p: N, q: N, r: N) => (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);

function pointInTriangle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, px: number, py: number) {
  return (cx - px) * (ay - py) >= (ax - px) * (cy - py) && (ax - px) * (by - py) >= (bx - px) * (ay - py) && (bx - px) * (cy - py) >= (cx - px) * (by - py);
}

function locallyInside(a: N, b: N) {
  return area(a.prev, a, a.next) < 0 ? area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0 : area(a, b, a.prev) < 0 || area(a, a.next, b) < 0;
}

const sectorContainsSector = (m: N, p: N) => area(m.prev, m, p.prev) < 0 && area(p.next, m, m.next) < 0;

function findHoleBridge(hole: N, outer: N): N | undefined {
  let p = outer;
  const hx = hole.x;
  const hy = hole.y;
  let qx = -Infinity;
  let m: N | undefined;
  do {
    if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
      const x = p.x + ((hy - p.y) * (p.next.x - p.x)) / (p.next.y - p.y);
      if (x <= hx && x > qx) {
        qx = x;
        m = p.x < p.next.x ? p : p.next;
        if (x === hx) return m;
      }
    }
    p = p.next;
  } while (p !== outer);
  if (!m) return undefined;
  const stop = m;
  const mx = m.x;
  const my = m.y;
  let tanMin = Infinity;
  p = m;
  do {
    if (hx >= p.x && p.x >= mx && hx !== p.x && pointInTriangle(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)) {
      const tan = Math.abs(hy - p.y) / (hx - p.x);
      if (locallyInside(p, hole) && (tan < tanMin || (tan === tanMin && (p.x > m.x || (p.x === m.x && sectorContainsSector(m, p)))))) {
        m = p;
        tanMin = tan;
      }
    }
    p = p.next;
  } while (p !== stop);
  return m;
}

function splitPolygon(a: N, b: N) {
  const a2 = { x: a.x, y: a.y } as N;
  const b2 = { x: b.x, y: b.y } as N;
  const an = a.next;
  const bp = b.prev;
  a.next = b;
  b.prev = a;
  a2.next = an;
  an.prev = a2;
  b2.next = a2;
  a2.prev = b2;
  bp.next = b2;
  b2.prev = bp;
}

/** One contour covering an outline minus its holes, holes joined in by cut-ins. */
export function fracture(outer: Pt[], holes: Pt[][]): Pt[] {
  const start = ringList(outer);
  const leftmost = holes
    .filter((h) => h.length >= 3)
    .map((h) => {
      const first = ringList(h);
      let best = first;
      for (let n = first.next; n !== first; n = n.next) if (n.x < best.x || (n.x === best.x && n.y < best.y)) best = n;
      return best;
    });
  leftmost.sort((a, b) => a.x - b.x || a.y - b.y);
  for (const h of leftmost) {
    const bridge = findHoleBridge(h, start);
    if (bridge) splitPolygon(bridge, h);
  }
  const out: Pt[] = [];
  let n = start;
  do {
    out.push([n.x, n.y]);
    n = n.next;
  } while (n !== start);
  return out;
}
