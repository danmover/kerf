// Checks that a design is complete the way it would be built and run, not
// just shaped like it: every joint drawn with the hardware that makes it
// (a held: note never stands in for screws, nuts, T-nuts or brackets), every
// bought electronic part, motor and battery a catalogue part with pins and
// mounting holes rather than a stand-in block, the electronics wired, profile
// frames joined at every joint, no screw holes left empty, and a machine with
// firmware something the simulator can run. Each finding says what to add, so
// a quick model (or place_fasteners) can finish it in one go.

import type { EvalPart, Model } from "./model";
import type { CheckItem } from "./checks";
import type { ChecksResult } from "../kernel/protocol";
import { vdot, vsub, type V3 } from "../kernel/recipe";
import { fmtNum } from "../lang/values";
import { boxNearSegment, cylsOf, isFastener, isProfile, worldBox, type Holds } from "./holds";
import { cylEnd, cylMid, lineDistance } from "../analysis/fits/geometry";
import { CATALOG, catalogPart } from "../machine/catalog";
import { THREADS, type ThreadSpec } from "../library/standards";
import type { CatalogKind, CatalogPart } from "../machine/types";

const instanceOf = (p: EvalPart) => p.id.split(".")[0];
const listOf = (names: string[]) => {
  const a = [...new Set(names)];
  return a.length <= 3 ? a.join(", ").replace(/, ([^,]*)$/, " and $1") : `${a.slice(0, 3).join(", ")} and ${a.length - 3} more`;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const an = (w: string) => `${/^(?:[aeiou]|ESC|LED|NTC|HX)/i.test(w) ? "an" : "a"} ${w}`;

// ---------- hardware a held: note names but the model does not draw ----------

/** Words in a held: note that name the parts that should be drawn. */
const HARDWARE: { re: RegExp; what: string }[] = [
  { re: /\bt-?\s?nuts?\b|\btee\s?nuts?\b|\bhammer\s?nuts?\b/i, what: "T-nuts" },
  { re: /\b(?:corner|angle|cast|l|right-?angle)[\s-]+brackets?\b|\bbrackets\b/i, what: "brackets" },
  { re: /\bbolts?\b/i, what: "bolts" },
  { re: /\bscrews?\b|\bM\d+(?:\.\d+)?\s*[x×]\s*\d+/i, what: "screws" },
  { re: /\bnyloc\b|\bnuts?\b|\block\s?nuts?\b/i, what: "nuts" },
  { re: /\b(?:heat-?set\s+)?inserts?\b/i, what: "inserts" },
  { re: /\brivets?\b/i, what: "rivets" },
  { re: /\bstandoffs?\b|\bspacers?\b/i, what: "standoffs" },
  { re: /\bstuds?\b|\bthreaded\s+rod\b/i, what: "studs" },
];
/** Phrases that look like hardware but are not drawn hardware: a bike's bottom bracket, a switch's own panel nut. */
const NOT_HARDWARE = [/\bbottom\s+brackets?\b/gi, /\b(?:its|their)\s+own\s+(?:panel\s+|mounting\s+)?nuts?\b/gi, /\bpanel\s+nuts?\b/gi, /\bspoke\s+nipples?\b/gi, /\bnut\s+clip\b/gi];

/** A held: note saying the hardware comes with the bought part. */
const SUPPLIED = /\bsupplied\b|\bincluded\b|\bcomes?\s+with\b/i;

/** The hardware a held: note names, or [] when it names none (glue, tape, a strap, a press fit). */
export function heldHardware(text: string): string[] {
  let t = text;
  for (const re of NOT_HARDWARE) t = t.replace(re, " ");
  const out: string[] = [];
  for (const h of HARDWARE) {
    if (!h.re.test(t)) continue;
    out.push(h.what);
    // "T-nuts" are not also "nuts"
    t = t.replace(new RegExp(h.re.source, "gi"), " ");
  }
  return out;
}

function undrawnItems(model: Model, holds: Holds): CheckItem[] {
  // instances joined by a drawn fastener that really clamps (a loose screw holds nothing)
  const fastened = new Set<string>();
  for (const j of holds.joins) {
    if (j.kind !== "screw" && j.kind !== "pivot" && j.kind !== "thread" && j.kind !== "insert") continue;
    if (isFastener(j.a) && !isFastener(j.b)) fastened.add(instanceOf(j.b));
    if (isFastener(j.b) && !isFastener(j.a)) fastened.add(instanceOf(j.a));
  }
  const comps = new Map((model.machine?.components ?? []).map((c) => [c.name, c]));
  const groups = new Map<string, { text: string; parts: EvalPart[]; what: string[] }>();
  const seen = new Set<string>();
  for (const p of model.parts) {
    if (p.hidden || isFastener(p) || seen.has(instanceOf(p))) continue;
    const text = p.held ?? comps.get(p.name)?.held;
    if (!text) continue;
    const what = heldHardware(text);
    if (!what.length) continue;
    seen.add(instanceOf(p));
    // a bought assembly that comes with its own bolts (a derailleur, a brake caliper, a crankset's chainring bolts):
    // the parts list has them in the part. Catalogue parts (motors, boards, sensors) still need their screws drawn.
    if (SUPPLIED.test(text) && (p.kind === "component" ? !p.bom?.catalogId : p.processNone)) continue;
    if (fastened.has(instanceOf(p))) continue;
    const g = groups.get(text) ?? { text, parts: [], what };
    g.parts.push(p);
    groups.set(text, g);
  }
  const out: CheckItem[] = [];
  for (const g of groups.values()) {
    const names = listOf(g.parts.map((p) => p.name));
    const one = new Set(g.parts.map((p) => p.name)).size === 1;
    const what = listOf(g.what);
    const holes = g.parts.some((p) => cylsOf(p).some((c) => c.side === "hole" && clearanceSize(c.d)));
    const profiles = g.parts.some(isProfile);
    out.push({
      id: `complete:undrawn:${g.parts[0].name}`,
      category: "assembly",
      status: "fail",
      title: `${names} ${one ? "is" : "are"} not fastened: held: says "${g.text}" but no ${what} are drawn`,
      detail: `held: only stands in for what the model cannot show (glue, tape, a strap, cable ties, a press fit). ${what.replace(/^./, (c) => c.toUpperCase())} are real parts: until they are drawn nothing fastens ${names}, the parts list and the drawings leave them out, and the screw, tool-access and strength checks cannot see them.`,
      fix: `${profiles ? `Join the profiles with corner brackets (lib.corner_bracket("2020")), each held by M5 screws into T-nuts (lib.nut(M5, type: "tslot20")) in the slots. ` : ""}${holes ? `Call place_fasteners on ${names}: it puts a screw through each of ${one ? "its" : "their"} holes with the right nut, T-nut or insert behind it${profiles ? ", and brackets on the profile joints" : ""}. ` : `Cut the screw holes first (cut hole(M5, through: true, at: ..., dir: ...)), then call place_fasteners on ${names}. `}Or draw them yourself with lib.screw and lib.nut (calc.fastener picks the length). Then take the hardware out of held:.`,
      parts: g.parts.map((p) => p.id),
      span: g.parts[0].span,
      basis: "geometry",
    });
  }
  return out;
}

// ---------- bought electronics, motors and batteries modelled as plain blocks ----------

interface StandInKind {
  kinds: CatalogKind[];
  re: RegExp;
  what: string;
  lib: string;
}
/** Most specific first: an ESC before a motor, a ducted fan before a fan, a limit switch before a switch. */
const STAND_IN: StandInKind[] = [
  { kinds: ["esc"], re: /\besc\b|\bspeed\s+controller\b/i, what: "ESC", lib: "lib.esc" },
  { kinds: ["motor_driver", "stepper_driver"], re: /\bmotor\s+driver\b|\bstepper\s+driver\b|\bh-?bridge\b|\bl298n?\b|\btb6612\w*|\bdrv88\d\d\b|\ba4988\b|\btmc2\d{3}\b|\bbts7960\b/i, what: "motor driver", lib: "lib.motor_driver" },
  { kinds: ["controller", "host"], re: /\barduino\b|\besp32\b|\besp8266\b|\bfeather\b|\braspberry\s+pi\b|\brpi\b|\bpico\b|\bteensy\b|\bstm32\b|\bmicrocontroller\b|\bmcu\b|\bdev(?:elopment)?\s+board\b|\bcontroller\s+board\b|\bflight\s+controller\b|\bmainboard\b/i, what: "controller board", lib: "lib.controller" },
  { kinds: ["battery"], re: /\bli-?po\b|\bli-?ion\b|\blifepo4\b|\bnimh\b|\bbattery\b|\b18650\b|\b\d{3,5}\s*mah\b/i, what: "battery", lib: "lib.battery" },
  { kinds: ["psu", "regulator"], re: /\bpower\s+supply\b|\bpsu\b|\bbuck\b|\bboost\s+converter\b|\bregulator\b|\bbec\b|\bdc-?dc\b/i, what: "power supply or regulator", lib: "lib.regulator" },
  { kinds: ["sensor"], re: /\bimu\b|\bgyro\w*|\baccelerometer\b|\bmpu-?6050\b|\bbno0?55\b|\blsm6\w*|\bicm-?\d+|\bhx711\b|\bload\s+cell\b|\bstrain\s+gauge\b|\bultrasonic\b|\bhc-?sr04\b|\bhall\s+(?:effect\s+)?sensor\b|\bencoder\b|\bendstop\b|\blimit\s+switch\b|\blidar\b|\bthermistor\b|\bsensor\b|\bamplifier\s+board\b/i, what: "sensor", lib: "lib.sensor" },
  { kinds: ["servo"], re: /\bservo\b/i, what: "servo", lib: "lib.servo" },
  { kinds: ["stepper"], re: /\bstepper\b|\bnema\s?\d+\b/i, what: "stepper motor", lib: "lib.stepper" },
  { kinds: ["bldc"], re: /\bbrushless\b|\bbldc\b|\boutrunner\b|\bedf\b|\bducted\s+fan\b/i, what: "brushless motor or ducted fan", lib: "lib.bldc" },
  { kinds: ["actuator"], re: /\blinear\s+actuator\b/i, what: "linear actuator", lib: "lib.actuator" },
  { kinds: ["gearmotor"], re: /\bgear\s?motor\b|\bdc\s+motor\b|\bmotor\b/i, what: "motor", lib: "lib.gearmotor" },
  { kinds: ["switch"], re: /\be-?stop\b|\bemergency\s+stop\b|\bpush\s?button\b|\btoggle\b|\brocker\s+switch\b|\bswitch\b/i, what: "switch", lib: "lib.switch" },
  { kinds: ["fuse"], re: /\bfuse\b/i, what: "fuse", lib: "lib.fuse" },
  { kinds: ["connector"], re: /\bxt\d{2}\b|\bconnector\b/i, what: "connector", lib: "lib.connector" },
  { kinds: ["display"], re: /\boled\b|\blcd\b|\bdisplay\b/i, what: "display", lib: "lib.display" },
  { kinds: ["led"], re: /\bneopixel\b|\bws2812\w*|\bled\s+(?:strip|ring|stick)\b/i, what: "LED board", lib: "lib.led" },
  { kinds: ["fan"], re: /\bfan\b/i, what: "fan", lib: "lib.fan" },
];
/** Words too common to tell two catalogue parts apart. */
const GENERIC = new Set(
  "the a an and or of for with to in on by at mm v a w g kg bought board module breakout motor sensor controller driver switch supply power unit kit pack set mount mounting holder digital super speed high low mini micro small large new pcb with headers header pins pin type style generic standard blade inline".split(" "),
);
const tokens = (s: string) => new Set(s.toLowerCase().replace(/_/g, " ").split(/[^a-z0-9.]+/).filter((w) => w.length >= 2 && !GENERIC.has(w)));

/** The catalogue part of these kinds that shares the most specific words with the label, if any shares one. */
export function closestCatalog(label: string, kinds: CatalogKind[]): { part: CatalogPart; score: number } | undefined {
  const want = tokens(label);
  let best: { part: CatalogPart; score: number } | undefined;
  for (const c of CATALOG) {
    if (!kinds.includes(c.kind)) continue;
    const have = tokens(`${c.id} ${c.name} ${c.mpn ?? ""} ${c.maker ?? ""}`);
    let score = 0;
    for (const w of want) if (have.has(w)) score += /\d/.test(w) && !/^\d+$/.test(w) ? 2 : 1;
    if (score && (!best || score > best.score)) best = { part: c, score };
  }
  return best;
}

/** What a plain part stands in for, when it is a bought electronic part, motor or battery. */
export function standInKind(p: EvalPart): StandInKind | undefined {
  if (p.kind !== "part" || !p.processNone || p.imported || p.hidden) return undefined;
  const text = `${p.name.replace(/_/g, " ")} ${p.label}`;
  const k = STAND_IN.find((s) => s.re.test(text));
  if (k) return k;
  if (/^fr-?4$/i.test(p.material ?? "")) return STAND_IN.find((s) => s.kinds.includes("controller"));
  return undefined;
}

function standInItems(model: Model): CheckItem[] {
  const out: CheckItem[] = [];
  const done = new Set<string>();
  for (const p of model.parts) {
    const k = standInKind(p);
    if (!k || done.has(p.name)) continue;
    done.add(p.name);
    const near = closestCatalog(`${p.name} ${p.label}`, k.kinds);
    const lib = near ? `${k.lib}("${near.part.id}")` : k.lib;
    const why = `It is modelled as a plain shape, not a catalogue part, so it has no pins, ratings or mounting holes: the wiring, power, mounting and simulation checks cannot see it, it cannot be wired or driven by firmware, and the build pack treats it as a block.`;
    if (near)
      out.push({
        id: `complete:stand-in:${p.name}`,
        category: "electrical",
        status: "fail",
        title: `${p.name} is a stand-in block for ${an(k.what)}`,
        detail: `${p.label}: ${why}`,
        fix: `Use the catalogue part: component ${p.name} = ${lib} { at: ..., ${near.part.kind === "controller" || near.part.kind === "sensor" || near.part.kind === "battery" || near.part.kind === "esc" ? "" : "axis: ..., "}... } (${near.part.name}${near.part.id ? `; catalog_lookup("${near.part.id}") gives its size, pins and holes` : ""}). If the real product differs, keep the catalogue part with the same pins as a variant and give it buy: and price: for the real one. Then mount it with screws through its holes (place_fasteners) and wire its pins.`,
        parts: [p.id],
        span: p.span,
        basis: "electrical rules",
      });
    else
      out.push({
        id: `complete:stand-in:${p.name}`,
        category: "electrical",
        status: "warn",
        title: `${p.name} is a stand-in block for ${an(k.what)} Kerf's catalogue does not have`,
        detail: `${p.label}: ${why}`,
        fix: `Look for ${an(`catalogue ${k.what}`).replace(/^an catalogue/, "a catalogue")} with the same pins and ratings (catalog_lookup) and use it as a variant with buy: and price: for the real product. If none is close, keep the block, draw its real outline and mounting holes, fasten it with screws (place_fasteners), and tell the user plainly that it could not be wired, checked or simulated.`,
        parts: [p.id],
        span: p.span,
        basis: "electrical rules",
      });
  }
  return out;
}

// ---------- wiring, firmware and a simulation to run ----------

const ELECTRIC = new Set<CatalogKind>(["controller", "host", "motor_driver", "esc", "stepper_driver", "sensor", "battery", "psu", "regulator", "gearmotor", "stepper", "servo", "bldc", "actuator", "fan", "led", "display", "amplifier", "speaker", "hotend", "heated_bed"]);
const MOVERS = new Set<CatalogKind>(["gearmotor", "stepper", "servo", "bldc", "actuator"]);

function runItems(model: Model): CheckItem[] {
  const m = model.machine;
  if (!m) return [];
  const out: CheckItem[] = [];
  const cat = (c: { catalogId: string }) => catalogPart(c.catalogId);
  const electric = m.components.filter((c) => {
    const p = cat(c);
    return !!p && ELECTRIC.has(p.kind) && p.pins.length > 0 && !c.pcb;
  });
  if (electric.length && !m.wires.length && !m.nets.length && !m.boards.length) {
    out.push({
      id: "complete:unwired",
      category: "electrical",
      status: "fail",
      title: `Nothing is wired: ${plural(electric.length, "electrical part")} and no wires`,
      detail: `${listOf(electric.map((c) => c.name))} ${electric.length === 1 ? "has" : "have"} pins but the design has no wire or net lines, so nothing is powered or connected: the electrical checks, the 3D cables, the build pack's wiring list and the simulation all have nothing to work on.`,
      fix: "Wire every pin that matters (power through a fuse and switch, ground, every control, feedback and sensor signal) with wire and net lines, each power and motor wire with a gauge for its current and a colour.",
      parts: electric.map((c) => c.name),
      span: electric[0].span,
      basis: "electrical rules",
    });
  }
  const controllers = m.components.filter((c) => {
    const p = cat(c);
    return p?.kind === "controller" || p?.kind === "host";
  });
  if (!controllers.length) return out;
  const printer = m.components.some((c) => cat(c)?.kind === "hotend");
  const movers = m.components.filter((c) => MOVERS.has(cat(c)?.kind as CatalogKind));
  const scenarios = model.scenarios ?? [];
  if (printer || scenarios.length) return out;
  if (!m.firmware.length)
    out.push({
      id: "complete:no-sim",
      category: "electrical",
      status: movers.length ? "warn" : "info",
      title: "It cannot be run in the simulator yet: no firmware and no scenario",
      detail: `${listOf(controllers.map((c) => c.name))} has no firmware block, so Kerf cannot generate its code or run the design${movers.length ? `, and ${listOf(movers.map((c) => c.name))} never ${movers.length === 1 ? "moves" : "move"}` : ""}.`,
      fix: "Add a firmware block for the controller with the behaviour the brief asks for, then a scenario block that runs it (the world, the inputs and what should happen), and call run_scenario.",
      parts: controllers.map((c) => c.name),
      basis: "electrical rules",
    });
  else
    out.push({
      id: "complete:no-sim",
      category: "electrical",
      status: movers.length ? "warn" : "info",
      title: "It cannot be run in the simulator yet: no scenario",
      detail: `The firmware is there, but no scenario block says what to run it against, so the Simulate tab has nothing to run${movers.length ? ` and nothing shows ${listOf(movers.map((c) => c.name))} doing ${movers.length === 1 ? "its" : "their"} job` : ""}.`,
      fix: "Add a scenario block for the job the brief describes (the world, the inputs, the run time and the expected results) and call run_scenario; fix the design or the firmware settings until it passes.",
      parts: controllers.map((c) => c.name),
      basis: "electrical rules",
    });
  return out;
}

// ---------- screw holes with nothing in them ----------

const METRIC = Object.values(THREADS).filter((t) => /^M\d/.test(t.name) && t.d >= 2 && t.d <= 12);
/** The metric size a round hole is a screw clearance for, if it is one. */
export function clearanceSize(d: number): ThreadSpec | undefined {
  const fits = METRIC.filter((t) => d >= t.d + 0.15 && d <= t.d + Math.max(0.9, 0.12 * t.d));
  return fits.sort((a, b) => Math.abs(d - a.clearance) - Math.abs(d - b.clearance))[0];
}

function emptyHoleItems(model: Model, kernel?: ChecksResult | null): CheckItem[] {
  const out: CheckItem[] = [];
  const parts = model.parts.filter((p) => !p.hidden && !(p.imported && p.imported.kind !== "solid"));
  const box = (p: EvalPart) => (kernel?.boxes?.[p.id] as [V3, V3] | undefined) ?? worldBox(p);
  // round things that could be in a hole: shanks, pins, shafts, bosses, studs
  const fillers = parts.flatMap((p) => cylsOf(p).filter((c) => c.side === "shaft" || c.role === "screw").map((c) => ({ p, c })));
  for (const p of parts) {
    if (p.kind !== "part" || p.processNone) continue;
    const empty: { d: number; t: ThreadSpec }[] = [];
    for (const h of cylsOf(p)) {
      if (h.side !== "hole" || h.holeFit === "cbore" || h.role !== "plain") continue;
      const t = clearanceSize(h.d);
      if (!t) continue;
      const lo = Math.min(0, h.length);
      const filled = fillers.some(({ p: q, c }) => {
        if (q === p) return false;
        if (Math.abs(vdot(c.axis, h.axis)) < 0.995) return false;
        if (lineDistance(cylMid(c), h.at, h.axis) > Math.max(0.4, 0.1 * h.d)) return false;
        const a = vdot(vsub(c.at, h.at), h.axis);
        const b = vdot(vsub(cylEnd(c), h.at), h.axis);
        return Math.max(a, b) > lo - 1 && Math.min(a, b) < Math.max(0, h.length) + 1;
      });
      if (filled) continue;
      // only holes that line up with another part: one that opens to the outside world (a wall, the bench) is for the user
      const reach = 4;
      const from: V3 = [h.at[0] - h.axis[0] * reach, h.at[1] - h.axis[1] * reach, h.at[2] - h.axis[2] * reach];
      const meets = parts.some((q) => {
        if (q === p || isFastener(q)) return false;
        const b = box(q);
        return !!b && boxNearSegment(b, from, h.axis, h.length + 2 * reach, -0.05);
      });
      if (!meets) continue;
      empty.push({ d: h.d, t });
    }
    if (!empty.length) continue;
    const sizes = [...new Set(empty.map((e) => e.t.name))];
    out.push({
      id: `complete:empty-holes:${p.name}`,
      category: "assembly",
      status: "warn",
      title: `${p.name} has ${plural(empty.length, "screw hole")} with nothing in ${empty.length === 1 ? "it" : "them"}`,
      detail: `${plural(empty.length, `${sizes.join("/")} clearance hole`)} (Ø${[...new Set(empty.map((e) => fmtNum(e.d, 2)))].join(", Ø")}) line up with another part but no screw, pin or shaft goes through ${empty.length === 1 ? "it" : "them"}, so the joint they are for is not made and the parts list has no hardware for ${empty.length === 1 ? "it" : "them"}.`,
      fix: `Call place_fasteners on ${p.name} to put the screws in with their nuts, T-nuts or inserts, or fill the holes if they are not needed.`,
      parts: [p.id],
      span: p.span,
      basis: "geometry",
    });
  }
  return out;
}

// ---------- profile frames: every joint joined ----------

/** Joins as a graph: part id to the ids it is fastened or fitted to (bands left out: a band is no structural joint). */
export function joinGraph(holds: Holds): Map<string, Set<string>> {
  const g = new Map<string, Set<string>>();
  const add = (a: string, b: string) => (g.get(a) ?? g.set(a, new Set()).get(a)!).add(b);
  for (const j of holds.joins) {
    if (j.kind === "band") continue;
    add(j.a.id, j.b.id);
    add(j.b.id, j.a.id);
  }
  return g;
}

/**
 * Are two profiles joined to each other, not just to the same frame: a path of at most four joins between them that
 * passes only through hardware, brackets, gussets and plates (never through another profile). A screw into both, a
 * corner bracket with its two screws, or a plate screwed to both all count.
 */
export function joinedDirect(g: Map<string, Set<string>>, byId: Map<string, EvalPart>, a: string, b: string): boolean {
  let frontier = [a];
  const seen = new Set([a]);
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    const next: string[] = [];
    for (const x of frontier)
      for (const y of g.get(x) ?? []) {
        if (y === b) return true;
        if (seen.has(y)) continue;
        seen.add(y);
        const p = byId.get(y);
        if (p && isProfile(p)) continue;
        next.push(y);
      }
    frontier = next;
  }
  return false;
}

function jointItems(model: Model, holds: Holds, kernel?: ChecksResult | null): CheckItem[] {
  const contacts = kernel?.contacts;
  if (!contacts) return [];
  const byId = new Map(model.parts.map((p) => [p.id, p]));
  const g = joinGraph(holds);
  const out: CheckItem[] = [];
  const seen = new Set<string>();
  for (const c of contacts) {
    const a = byId.get(c.a);
    const b = byId.get(c.b);
    if (!a || !b || !isProfile(a) || !isProfile(b) || instanceOf(a) === instanceOf(b)) continue;
    if (joinedDirect(g, byId, a.id, b.id)) continue;
    const key = [a.id, b.id].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `complete:joint:${a.id}:${b.id}`,
      category: "assembly",
      status: "fail",
      title: `Frame joint ${a.id} to ${b.id}: nothing joins them`,
      detail: `The profiles meet but no bracket, screw or plate fastens them, so the frame comes apart (or racks out of square) as soon as it is loaded${a.held || b.held ? `; held: "${a.held ?? b.held}" does not join them` : ""}.`,
      fix: `Call place_fasteners on ${a.name} and ${b.name}: it puts corner brackets (lib.corner_bracket("2020")) in the free inside corners of the joint, each with M5 screws into T-nuts in both profiles' slots. Or join them with a printed or metal plate screwed to both.`,
      parts: [a.id, b.id],
      span: a.span,
      basis: "geometry",
    });
  }
  return out;
}

/** The completeness checks. Contacts and boxes come from the kernel; without them the geometry-only parts are skipped. */
export function completeChecks(model: Model, holds: Holds, kernel?: ChecksResult | null): CheckItem[] {
  const items = [...undrawnItems(model, holds), ...standInItems(model), ...runItems(model), ...(kernel ? [...emptyHoleItems(model, kernel), ...jointItems(model, holds, kernel)] : [])];
  const bad = items.filter((i) => i.status === "fail");
  if (!bad.length && model.parts.length > 1)
    items.push({ id: "complete:ok", category: "assembly", status: "pass", title: "Complete: hardware drawn, real parts", detail: "Every joint a held: note names has its hardware drawn, no bought electronics, motors or batteries are stand-in blocks, and the electronics are wired.", basis: "geometry" });
  return items;
}
