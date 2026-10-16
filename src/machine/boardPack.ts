// What a circuit board needs outside Kerf: its problems in one list, the parts
// that go on it (grouped for buying, staged for soldering), and the folder the
// build pack writes for it: Gerbers (loose and zipped, the way board houses
// take them), previews of both sides, a parts list and a soldering guide.
// Pure functions of the design, so they run in Node and in the Board view.

import { fmtNum } from "../lang/values";
import { catalogPart } from "./catalog";
import { resistorBands } from "./catalog/values";
import { boardSpecs } from "./boards";
import { boardHash, boardRules, boardSvg, checkPlacement, gerberFiles, placedPads, routeBoard, type BoardSpec, type DrcItem, type Footprint, type PlacedPart, type RoutedBoard } from "./pcb";
import { safeName } from "./pcb/gerber";
import { bodyShape, padShape, partXf, shapeBox, type BBox } from "./pcb/geom";
import type { BoardDef, CatalogPart, MachineComponent, MachineData } from "./types";
import { csvCell } from "./wiring";
import { zip } from "./zip";

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const listJoin = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const mm = (v: number) => fmtNum(v, 2);

/** "the Preamp board", but not "the Main Board board". */
export const boardWord = (title: string, noun = "board") => (/\bboard$/i.test(title.trim()) ? title.trim() : `${title.trim()} ${noun}`);

/** R2 before R10: letters, then the number. */
export function refOrder(a: string, b: string): number {
  const ma = /^([A-Za-z]*)(\d*)(.*)$/.exec(a)!;
  const mb = /^([A-Za-z]*)(\d*)(.*)$/.exec(b)!;
  return ma[1].localeCompare(mb[1]) || (Number(ma[2] || 0) - Number(mb[2] || 0)) || ma[3].localeCompare(mb[3]);
}

// ---------------------------------------------------------------- routing

/** A board with no copper yet: what the Board view draws while the first route runs. */
export function bareBoard(spec: BoardSpec): RoutedBoard {
  return { spec, rules: boardRules(spec), tracks: [], vias: [], pours: [], unrouted: [], drc: [], stats: { connections: 0, routed: 0, vias: 0, trackLength: 0, ms: 0 } };
}

export interface BoardBuild {
  def: BoardDef;
  spec: BoardSpec;
  routed?: RoutedBoard;
  /** why there is no routed board */
  error?: string;
}

/**
 * Every board of the design, routed: a finished route handed in (matched by
 * the copper hash, with the current spec swapped in for the silkscreen), else
 * routed here, synchronously.
 */
export function routeBoards(m: MachineData, given: RoutedBoard[] = []): BoardBuild[] {
  const byHash = new Map(given.map((b) => [boardHash(b.spec), b]));
  return boardSpecs(m).map(({ def, spec }) => {
    const hit = byHash.get(boardHash(spec));
    if (hit) return { def, spec, routed: { ...hit, spec } };
    try {
      return { def, spec, routed: routeBoard(spec) };
    } catch (e) {
      return { def, spec, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

// ---------------------------------------------------------------- problems

export interface BoardProblem {
  id: string;
  source: "placement" | "routing" | "rules";
  kind: DrcItem["kind"];
  message: string;
  /** where on the board, mm from its bottom-left corner seen from the top; undefined when the problem has no place */
  at?: [number, number];
  refs: string[];
  nets: string[];
  /** an unrouted connection: the two pads it should join */
  line?: [[number, number], [number, number]];
}

/** Placement problems of the current spec, then what the routed board still lacks or breaks. */
export function boardProblems(spec: BoardSpec, routed?: RoutedBoard): BoardProblem[] {
  const out: BoardProblem[] = [];
  const item = (source: BoardProblem["source"], d: DrcItem, i: number): BoardProblem => ({
    id: `${source}:${i}`,
    source,
    kind: d.kind,
    message: d.message,
    at: d.x === 0 && d.y === 0 && !d.refs?.length ? undefined : [d.x, d.y],
    refs: d.refs ?? [],
    nets: d.nets ?? [],
  });
  checkPlacement(spec).forEach((d, i) => out.push(item("placement", d, i)));
  if (!routed) return out;
  const pads = placedPads(routed.spec);
  const pad = (ref: string, pin: string) => pads.find((p) => p.ref === ref && p.pin === pin);
  const name = (ref: string, pin: string) => `${ref} pin ${pad(ref, pin)?.num || pin}`;
  routed.unrouted.forEach((u, i) => {
    const a = pad(u.a.ref, u.a.pin);
    const b = pad(u.b.ref, u.b.pin);
    out.push({
      id: `routing:${i}`,
      source: "routing",
      kind: "unrouted",
      message: `${u.net}: no track from ${name(u.a.ref, u.a.pin)} to ${name(u.b.ref, u.b.pin)}.`,
      at: a && b ? [(a.x + b.x) / 2, (a.y + b.y) / 2] : undefined,
      refs: [...new Set([u.a.ref, u.b.ref])],
      nets: [u.net],
      ...(a && b ? { line: [[a.x, a.y], [b.x, b.y]] as [[number, number], [number, number]] } : {}),
    });
  });
  // the rule check repeats unrouted nets as "not connected": the router's list already names them
  const missing = new Set(routed.unrouted.map((u) => u.net));
  routed.drc.forEach((d, i) => {
    if (d.kind === "unrouted" && d.nets?.every((n) => missing.has(n))) return;
    out.push(item("rules", d, i));
  });
  return out;
}

const SOURCE_HEAD: Record<BoardProblem["source"], string> = { placement: "PLACEMENT", routing: "NOT ROUTED", rules: "DESIGN RULE CHECK" };

export function problemsText(b: BoardBuild, problems: BoardProblem[]): string {
  const L = [`${b.def.title}: problems found when the board files were made`, "", "Kerf wrote the files anyway so you can look at them, but do not order this board until these are fixed in the design and the build pack is downloaded again.", ""];
  if (b.error) L.push("ROUTING FAILED", `- ${b.error}`, "");
  for (const src of ["placement", "routing", "rules"] as const) {
    const list = problems.filter((p) => p.source === src);
    if (!list.length) continue;
    L.push(`${SOURCE_HEAD[src]} (${list.length})`);
    for (const p of list) L.push(`- ${p.message}${p.at ? ` (at ${mm(p.at[0])}, ${mm(p.at[1])} mm from the board's bottom-left corner, seen from the top)` : ""}`);
    L.push("");
  }
  if (problems.some((p) => p.source === "routing")) L.push("Connections the router could not make: move the parts on those nets closer together, turn them so their pins face each other, or make the board bigger.", "");
  return L.join("\n");
}

// ---------------------------------------------------------------- parts on the board

/** Soldering order: lowest parts first, the plug-in modules last. */
export const STAGES = ["Resistors and diodes", "Small capacitors", "IC sockets", "Terminals, headers and switches", "Regulators and transistors", "Electrolytic capacitors", "Potentiometers", "Display and modules"] as const;

export interface BoardPart {
  ref: string;
  comp: MachineComponent;
  part: CatalogPart;
  placed: PlacedPart;
  /** what is printed beside the reference: 10k, 100n, TL072 */
  value: string;
  /** the package in words: "Axial, 10.16 mm pitch", "DIP-8 in a socket" */
  footprint: string;
  /** index into STAGES */
  stage: number;
}

function stageOf(p: CatalogPart): number {
  const s = p.footprint;
  switch (s?.k) {
    case "axial":
      return 0;
    case "box":
      return 1;
    case "dip":
      return 2;
    case "inline":
      return s.style === "to220" || s.style === "to92" ? 4 : 3;
    case "radial":
      return 5;
    case "pot9":
      return 6;
    default:
      return ["switch", "terminal", "header", "connector"].includes(p.kind) ? 3 : 7;
  }
}

/** The package in words, for the parts list. */
export function packageLabel(p: CatalogPart, fp: Footprint): string {
  const s = p.footprint;
  const pitch = fp.pads.length >= 2 ? Math.hypot(fp.pads[1].x - fp.pads[0].x, fp.pads[1].y - fp.pads[0].y) : 0;
  const b = fp.body;
  switch (s?.k) {
    case "axial":
      return `Axial, ${mm(s.pitch)} mm pitch`;
    case "radial":
      return `Radial Ø${mm(b.shape === "circle" ? 2 * b.r : 0)} mm, ${mm(pitch)} mm pitch`;
    case "box":
      return b.shape === "rect" ? `Box ${mm(b.x1 - b.x0)} × ${mm(b.y1 - b.y0)} mm, ${mm(s.pitch)} mm pitch` : `Box, ${mm(s.pitch)} mm pitch`;
    case "dip":
      return `DIP-${s.pins.length}${s.socket ? " in a socket" : ""}`;
    case "inline": {
      const n = s.pins.length;
      if (s.style === "to220") return "TO-220";
      if (s.style === "to92") return "TO-92";
      if (s.style === "terminal") return `Screw terminal, ${n} × ${mm(s.pitch)} mm`;
      return `${s.style === "header_f" ? "Socket header" : "Pin header"} 1 × ${n}, ${mm(s.pitch)} mm`;
    }
    case "pot9":
      return "9 mm vertical pot";
    case "pads":
      return `${p.kind === "switch" ? "Switch" : "Module"}, ${fp.pads.length} pins`;
    default:
      return fp.name;
  }
}

/** The parts on one board, joined to their components and catalog entries, in reference order. */
export function boardParts(m: MachineData, spec: BoardSpec, board: string): BoardPart[] {
  const byRef = new Map(m.components.filter((c) => c.pcb?.board === board && c.ref).map((c) => [c.ref!, c]));
  const out: BoardPart[] = [];
  for (const placed of spec.parts) {
    const comp = byRef.get(placed.ref);
    const part = comp && catalogPart(comp.catalogId);
    if (!comp || !part) continue;
    out.push({ ref: placed.ref, comp, part, placed, value: placed.value, footprint: packageLabel(part, placed.fp), stage: stageOf(part) });
  }
  return out.sort((a, b) => refOrder(a.ref, b.ref));
}

/** The value as a parts list gives it: the electrical value, or a short part number for chips; blank for parts whose name says it all. */
function listValue(bp: BoardPart): string {
  if (bp.part.valued) return bp.value;
  return bp.part.mpn ? bp.part.mpn.replace(/(CP|CV|CN|N)$/, "") : "";
}

export interface PartGroup {
  refs: string[];
  qty: number;
  value: string;
  part: CatalogPart;
  footprint: string;
  side: string;
  notes: string;
  stage: number;
  height: number;
  /** a socket or header that comes with the parts, not a part of its own */
  extra?: boolean;
}

/** Identical parts (same catalog part and value) as one line, with the sockets and headers they need. */
export function partGroups(parts: BoardPart[]): PartGroup[] {
  const groups = new Map<string, PartGroup>();
  for (const bp of parts) {
    const value = listValue(bp);
    const key = `${bp.part.id}|${value}`;
    const g = groups.get(key);
    const side = bp.placed.side;
    if (g) {
      g.refs.push(bp.ref);
      g.qty++;
      if (!g.side.split(" and ").includes(side)) g.side = `${g.side} and ${side}`;
      if (bp.comp.role) g.notes = [g.notes, `${bp.ref}: ${bp.comp.role}`].filter(Boolean).join("; ");
      g.height = Math.max(g.height, bp.placed.fp.height);
      continue;
    }
    const notes: string[] = [];
    if (bp.comp.role) notes.push(`${bp.ref}: ${bp.comp.role}`);
    const mark = bp.placed.fp.mark?.kind;
    if (mark === "plus") notes.push("polarised (+ marked)");
    if (mark === "band") notes.push("polarised (band = cathode)");
    groups.set(key, { refs: [bp.ref], qty: 1, value, part: bp.part, footprint: bp.footprint, side, notes: notes.join("; "), stage: bp.stage, height: bp.placed.fp.height });
  }
  const out: PartGroup[] = [];
  for (const g of groups.values()) {
    out.push(g);
    for (const e of g.part.extras ?? []) {
      const extraPart: CatalogPart = { ...g.part, id: `${g.part.id}:extra`, name: e.label, maker: undefined, mpn: undefined, extras: undefined };
      out.push({ refs: [...g.refs], qty: e.qty * g.qty, value: "", part: extraPart, footprint: "", side: g.side, notes: `for ${listJoin(g.refs)}`, stage: g.stage, height: 0, extra: true });
    }
  }
  return out.sort((a, b) => a.stage - b.stage || refOrder(a.refs[0], b.refs[0]) || Number(!!a.extra) - Number(!!b.extra));
}

export function partsCsv(parts: BoardPart[]): string {
  const lines = [["References", "Qty", "Value", "Part", "Maker part no.", "Footprint", "Side", "Notes"].join(",")];
  for (const g of partGroups(parts))
    lines.push([g.refs.join(" "), g.qty, g.value, g.part.name, [g.part.maker, g.part.mpn].filter(Boolean).join(" "), g.footprint, g.side, g.notes].map((v) => csvCell(v)).join(","));
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------- soldering guide

/** The three-digit code printed on small capacitors: 104 is 10 × 10⁴ pF = 100 nF. */
export function capCode(farads: number): string | undefined {
  const pf = farads * 1e12;
  if (pf < 10 - 1e-9) return undefined;
  let exp = Math.floor(Math.log10(pf) + 1e-9) - 1;
  let digits = Math.round(pf / 10 ** exp);
  if (digits >= 100) {
    digits = Math.round(digits / 10);
    exp++;
  }
  return `${digits}${exp}`;
}

/** Which way a part goes in, in words, for the parts that have a right way round (the stage note explains the marks). */
function orientation(bp: BoardPart): string {
  const s = bp.part.footprint;
  const fp = bp.placed.fp;
  switch (s?.k) {
    case "axial":
      return s.band ? "Band (cathode) toward the square pad, where the band is printed." : "";
    case "radial":
      return s.plus ? "+ lead (the longer one) in the square pad by the +." : "";
    case "dip":
      return s.socket ? "Notch toward the pin 1 dot (the square pad)." : "Pin 1 (by the notch or dot on the chip) in the square pad, by the dot printed on the board.";
    case "inline": {
      if (s.style === "to220") return "Pin 1 (IN) in the square pad, printed face toward the dot on the outline, metal tab toward the far side. Stand it about 3 mm above the board.";
      if (s.style === "to92") return "Pin 1 in the square pad, the flat face toward the dot on the outline.";
      if (s.style === "terminal") return `Wire openings toward the ${facing(bp.placed, 0, -1)} edge (as drawn in top.svg).`;
      return "Pin 1 in the square pad.";
    }
    case "pads": {
      if (bp.part.id.startsWith("tact_")) return "It fits two ways round and both work.";
      if (!fp.pads.some((p) => p.shape === "rect")) return "";
      const order = [...fp.pads].sort((a, b) => Number(a.num) - Number(b.num)).map((p) => p.pin);
      return fp.pads.length <= 8 ? `Pin 1 in the square pad: check the pins printed on the module read ${order.join(", ")} from pin 1.` : "Pin 1 in the square pad.";
    }
    default:
      return "";
  }
}

/** The board edge a footprint direction points at, seen from the top. */
function facing(part: PlacedPart, dx: number, dy: number): string {
  const xf = partXf(part);
  const [x0, y0] = xf(0, 0);
  const [x1, y1] = xf(dx, dy);
  const vx = x1 - x0;
  const vy = y1 - y0;
  return Math.abs(vx) >= Math.abs(vy) ? (vx > 0 ? "right-hand" : "left-hand") : vy > 0 ? "top" : "bottom";
}

/** The part as the soldering guide names it: the value with the colour bands or printed code to look for, or what it is. */
function describe(bp: BoardPart): string {
  const v = bp.comp.value;
  if (bp.part.kind === "resistor" && v) return `${bp.value} (${resistorBands(v).map((b) => b.name).join(", ")})`;
  if (bp.part.kind === "capacitor" && v && bp.comp.capType !== "electrolytic") {
    const code = capCode(v);
    return `${bp.value} ${bp.comp.capType ?? ""}${code ? `, marked ${code}` : ""}`.replace(/\s+,/, ",").trim();
  }
  if (bp.part.valued) return bp.value;
  const value = listValue(bp);
  return value && !bp.part.name.startsWith(value) ? `${value} ${bp.part.name}` : bp.part.name;
}

const STAGE_NOTE: string[] = [
  "They lie flat on the board, so they go in first. Bend the leads to the hole spacing, push the part down onto the board and splay the leads a little underneath so it stays put while you turn the board over. Resistors go either way round: check the colour bands (read from the end they are bunched at) or measure each one. Diodes do not: the band on the body is the cathode (K) and goes at the band printed on the board, the square pad.",
  "Film and ceramic capacitors are not polarised: either way round. Small ones are marked with a code: 104 means 10 followed by 4 zeros, in pF (100 nF).",
  "Solder the sockets now and the chips in later, so heat never reaches a chip and a wrong or failed one is a quick swap. Turn the notch in each socket toward the dot printed at pin 1, solder two opposite corner pins, check the socket sits flat, then do the rest.",
  "Hold each one flat against the board while you solder one pin, check it is square, then solder the others.",
  "The printed face of each one points toward the dot on its outline, the square pad is pin 1, and the metal tab (which is connected to a pin) must not touch anything else.",
  "Polarised: the longer lead is +, and goes in the square pad by the + printed on the board. The stripe on the can marks the − lead. Fitted the wrong way round, one can burst when the power comes on. Push each one down onto the board before soldering.",
  "Push each one fully home and solder its three pins and both bracket tabs: the tabs hold the pot when the knob is turned.",
  "These are the tallest parts and the plug-in modules, so they go in last.",
];

/** The stage heading, naming only what the board has. */
function stageTitle(s: number, parts: BoardPart[]): string {
  const kinds = new Set(parts.map((p) => p.part.kind));
  if (s === 0) return kinds.has("resistor") && kinds.has("diode") ? STAGES[0] : kinds.has("diode") ? "Diodes" : "Resistors";
  if (s === 2) return parts.every((p) => p.part.footprint?.k === "dip" && p.part.footprint.socket) ? STAGES[2] : "Chips";
  if (s === 3) {
    const names = [kinds.has("terminal") && "terminals", (kinds.has("header") || kinds.has("connector")) && "headers", kinds.has("switch") && "switches"].filter((x): x is string => !!x);
    return names.length ? cap(listJoin(names)) : STAGES[3];
  }
  if (s === 4) return kinds.size === 1 && kinds.has("regulator") ? "Regulators" : STAGES[4];
  if (s === 7) return parts.some((p) => p.part.kind === "display") ? (parts.every((p) => p.part.kind === "display") ? "Display" : STAGES[7]) : "Modules";
  return STAGES[s];
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** One checklist line's text for a part: what it is, which way round, its socket, its side. */
function partLine(bp: BoardPart): string {
  const extras = bp.part.extras ?? [];
  const many = (e: { qty: number; label: string }) => (e.qty === 1 ? e.label : `${e.qty} × ${e.label}`);
  const notes = (bp.part.notes ?? []).filter((t) => /solder it|spacer|header pins/i.test(t)).join(" ");
  const side = bp.placed.side === "bottom" ? "**Bottom side.**" : "";
  let what: string;
  if (bp.part.footprint?.k === "dip" && extras.length) what = `${listJoin(extras.map(many))} for the ${describe(bp)}, which goes in after the first power-up.`;
  else if (extras.length) what = `${listJoin(extras.map(many))} for the ${describe(bp)}: solder ${extras.length === 1 && extras[0].qty === 1 ? "it" : "them"} in, and plug the module in after the first power-up.`;
  else what = `${describe(bp)}.`;
  return [what, orientation(bp), notes, side].filter(Boolean).join(" ");
}

function supplyNets(spec: BoardSpec, parts: BoardPart[], ground: string): string[] {
  const byRef = new Map(parts.map((p) => [p.ref, p]));
  const out: string[] = [];
  for (const n of spec.nets) {
    if (n.name === ground) continue;
    const power = n.pins.some((pr) => {
      const t = byRef.get(pr.ref)?.part.pins.find((x) => x.id === pr.pin)?.type;
      return t === "pwr_in" || t === "pwr_out" || t === "pwr_rail";
    });
    if (power) out.push(n.name);
  }
  return out;
}

/** The checks with the chips out: regulator outputs, and the supply at each socket. */
function powerChecks(spec: BoardSpec, parts: BoardPart[], ground: string): string[] {
  const netOf = (ref: string, pin: string) => spec.nets.find((n) => n.pins.some((p) => p.ref === ref && p.pin === pin))?.name;
  const pinNo = (bp: BoardPart, pin: string) => bp.placed.fp.pads.find((p) => p.pin === pin)?.num ?? pin;
  const volts = new Map<string, number>();
  const out: string[] = [];
  for (const bp of parts) {
    const sim = bp.part.sim;
    if (sim?.k !== "reg") continue;
    const net = netOf(bp.ref, sim.out);
    if (net) volts.set(net, sim.vout);
    out.push(`${bp.ref} (${bp.value}): pin ${pinNo(bp, sim.out)} (OUT) to ${ground} reads about ${fmtNum(sim.vout)} V.`);
  }
  for (const bp of parts) {
    const sim = bp.part.sim;
    if (sim?.k !== "opamp" || bp.part.footprint?.k !== "dip" || !bp.part.footprint.socket) continue;
    const vp = netOf(bp.ref, sim.vpos);
    const vn = netOf(bp.ref, sim.vneg);
    const v = vp !== undefined ? volts.get(vp) : undefined;
    out.push(`${bp.ref} socket: pin ${pinNo(bp, sim.vpos)} (V+) to pin ${pinNo(bp, sim.vneg)} (V−) reads ${v !== undefined && (vn === ground || vn === undefined) ? `about ${fmtNum(v)} V` : `the ${vp ?? "supply"} voltage`}.`);
  }
  return out;
}

export function assemblyGuide(def: BoardDef, spec: BoardSpec, parts: BoardPart[], folder: string, problems: BoardProblem[]): string {
  const ground = spec.nets.find((n) => n.pour)?.name ?? spec.nets.find((n) => /^(gnd|ground|0v)$/i.test(n.name))?.name ?? "GND";
  const bottom = parts.filter((p) => p.placed.side === "bottom").map((p) => p.ref);
  const L: string[] = [`# Soldering guide: ${def.title}`, ""];
  L.push(
    `${plural(parts.length, "part")} on a ${mm(spec.w)} × ${mm(spec.h)} mm two-layer board, all through-hole. Solder them in the order below: the lowest parts first, so each one is held against the board while you solder it and the tall ones never get in the way of the iron.`,
    "",
    "The reference (R1, C4, U2 …) of every part is printed on the board beside it. `top.svg` and `bottom.svg` show the board as it will look, and `parts.csv` lists what to pick out before you start.",
    "",
  );
  if (problems.length) L.push(`> **Not ready to order.** The design still has ${plural(problems.length, "board problem")}: see \`boards/${folder}/PROBLEMS.txt\`. Fix them in Kerf and download the build pack again before ordering the board.`, "");

  L.push("## Before you start", "");
  L.push("- [ ] Check the bare board against `top.svg` and `bottom.svg`: every hole drilled, no scratches through to the copper.");
  L.push("- [ ] Tools: a temperature-controlled soldering iron (about 330 °C for leaded solder, 360 °C for lead-free), 0.7 mm rosin-core solder, flush cutters, a multimeter and some desoldering braid.");
  L.push("- [ ] Sort the parts into the stages below before heating the iron.");
  if (bottom.length) L.push(`- [ ] ${listJoin(bottom)} go on the **bottom** side, where their outlines are printed: push them in from the bottom and solder them on the top.`);
  L.push("", "For every joint: heat the pad and the lead together for a second, feed in solder until it flows round the lead, take the solder away and then the iron. A good joint is a smooth, shiny cone. Trim the leads about 1 mm above the joint.", "");

  let n = 1;
  for (let s = 0; s < STAGES.length; s++) {
    const inStage = parts.filter((p) => p.stage === s);
    if (!inStage.length) continue;
    L.push(`## ${n++}. ${stageTitle(s, inStage)}`, "");
    if (STAGE_NOTE[s]) L.push(STAGE_NOTE[s], "");
    // identical parts on one line, as they come out of the bag; parts that sit a different way get their own
    const lines = new Map<string, { refs: string[]; roles: string[]; text: string }>();
    const ordered = [...inStage].sort((a, b) => a.placed.fp.height - b.placed.fp.height || refOrder(a.ref, b.ref));
    for (const bp of ordered) {
      const text = partLine(bp);
      const key = `${bp.part.id}|${text}`;
      const e = lines.get(key) ?? { refs: [], roles: [], text };
      e.refs.push(bp.ref);
      if (bp.comp.role) e.roles.push(bp.comp.role);
      lines.set(key, e);
    }
    for (const { refs, roles, text } of lines.values()) {
      const named = roles.length === refs.length ? (refs.length === 1 ? ` (${roles[0]})` : ` (${refs.map((r, i) => `${r} ${roles[i]}`).join(", ")})`) : "";
      L.push(`- [ ] **${refs.join(", ")}**${named} ${text}`);
    }
    L.push("");
  }

  // checks before the power goes on
  L.push(`## ${n++}. Check the board`, "");
  L.push("- [ ] Look at every joint under a good light (a phone camera zoomed in works): no solder bridging two pads, no dull or balled joints, no lead left unsoldered. Look hardest at the sockets and headers, where pins are close together.");
  const supplies = supplyNets(spec, parts, ground);
  if (supplies.length) L.push(`- [ ] Set the multimeter to continuity and check there is no short from ${listJoin(supplies)} to ${ground}. A beep means a short: find it before going on.`);
  L.push("");

  const sockets = parts.filter((p) => p.part.footprint?.k === "dip" && p.part.footprint.socket);
  const plugIns = parts.filter((p) => p.part.footprint?.k === "pads" && p.part.extras?.length);
  const checks = powerChecks(spec, parts, ground);
  if (checks.length || sockets.length || plugIns.length) {
    const out = [...sockets, ...plugIns].map((p) => p.ref);
    L.push(`## ${n++}. First power-up${out.length ? `, with ${listJoin(out)} out` : ""}`, "");
    if (out.length) L.push(`- [ ] Leave ${listJoin(out)} out of ${out.length === 1 ? "its socket" : "their sockets"}, so a wiring mistake cannot damage ${out.length === 1 ? "it" : "them"}.`);
    L.push("- [ ] Connect the power, ready to disconnect at once if anything gets hot or smells.");
    for (const c of checks) L.push(`- [ ] Measure: ${c}`);
    L.push("- [ ] Disconnect the power and wait ten seconds for the capacitors to empty.");
    for (const p of sockets) L.push(`- [ ] Plug the ${p.value} into **${p.ref}**: the notch on the chip over the notch in the socket. Straighten the pins against the bench first if they splay out, and check none folded under.`);
    for (const p of plugIns) L.push(`- [ ] Plug the ${p.part.name} into **${p.ref}**, pin 1 at the square pad, every pin in its socket.`);
    L.push("");
  }
  L.push("The board is ready to mount. Go back to the build pack's `assembly.md` for the rest of the build.", "");
  return L.join("\n");
}

// ---------------------------------------------------------------- files

/** The Gerber and drill files in one zip, as board houses ask for them. */
export function gerberZip(b: RoutedBoard, date?: Date): Uint8Array<ArrayBuffer> {
  return zip(
    gerberFiles(b).map((f) => ({ path: f.path, data: f.content })),
    date,
  );
}

/** An SVG preview on the dark background its colours were made for, so it reads in any viewer. */
export function previewSvg(b: RoutedBoard, side: "top" | "bottom"): string {
  const { svg } = boardSvg(b, { side });
  const vb = /viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/.exec(svg);
  if (!vb) return svg;
  return svg.replace(/(<\/title>)/, `$1<rect x="${vb[1]}" y="${vb[2]}" width="${vb[3]}" height="${vb[4]}" fill="#0b0f0d"/>`);
}

/** Folder names for the boards, unique, safe on every file system. */
export function boardFolders(defs: BoardDef[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const d of defs) {
    let f = safeName(d.title);
    if (used.has(f.toLowerCase())) f = `${f}-${safeName(d.name)}`;
    for (let i = 2; used.has(f.toLowerCase()); i++) f = `${safeName(d.title)}-${i}`;
    used.add(f.toLowerCase());
    out.set(d.name, f);
  }
  return out;
}

export interface BoardFolder {
  def: BoardDef;
  folder: string;
  parts: number;
  problems: number;
  zip?: string;
}

/** Every file of every board, under boards/<board>/. */
export function boardPackFiles(m: MachineData, builds: BoardBuild[], date?: Date): { files: { path: string; data: string | Uint8Array }[]; folders: BoardFolder[] } {
  const names = boardFolders(builds.map((b) => b.def));
  const files: { path: string; data: string | Uint8Array }[] = [];
  const folders: BoardFolder[] = [];
  for (const b of builds) {
    const folder = names.get(b.def.name)!;
    const dir = `boards/${folder}`;
    const parts = boardParts(m, b.spec, b.def.name);
    const problems = boardProblems(b.spec, b.routed);
    const nProblems = problems.length + (b.error ? 1 : 0);
    const shown = b.routed ?? bareBoard(b.spec);
    let zipName: string | undefined;
    if (b.routed) {
      zipName = `${dir}/${safeName(b.spec.name)}-gerbers.zip`;
      files.push({ path: zipName, data: gerberZip(b.routed, date) });
      for (const f of gerberFiles(b.routed)) files.push({ path: `${dir}/gerbers/${f.path}`, data: f.content });
    }
    files.push({ path: `${dir}/top.svg`, data: previewSvg(shown, "top") });
    files.push({ path: `${dir}/bottom.svg`, data: previewSvg(shown, "bottom") });
    files.push({ path: `${dir}/parts.csv`, data: partsCsv(parts) });
    files.push({ path: `${dir}/assembly.md`, data: assemblyGuide(b.def, b.spec, parts, folder, problems) });
    if (nProblems) files.push({ path: `${dir}/PROBLEMS.txt`, data: problemsText(b, problems) });
    folders.push({ def: b.def, folder, parts: parts.length, problems: nProblems, zip: zipName });
  }
  return { files, folders };
}

/** A part's footprint and pads as one box, board coordinates seen from the top: what the Board view outlines. */
export function partBox(part: PlacedPart): BBox {
  let [x0, y0, x1, y1] = shapeBox(bodyShape(part));
  const xf = partXf(part);
  for (const pad of part.fp.pads) {
    const [x, y] = xf(pad.x, pad.y);
    const bb = shapeBox(padShape({ x, y, shape: pad.shape, w: pad.w, h: pad.h, rot: part.rot }));
    x0 = Math.min(x0, bb[0]);
    y0 = Math.min(y0, bb[1]);
    x1 = Math.max(x1, bb[2]);
    y1 = Math.max(y1, bb[3]);
  }
  return [x0, y0, x1, y1];
}
