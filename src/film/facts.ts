// What the film maker knows about a design: its shape and parts, what it is
// made of and costs, how it moves, what has been analysed or simulated, and
// its wiring and firmware. Gathered once from the app (src/film/gather.ts);
// the timeline and the default film are written from these alone, so they can
// be tested without a viewport.

import { DEFAULT_ACCENT, sectionInfo, type FilmSection, type FilmSpec, type SectionKind } from "./spec";

export type V3 = [number, number, number];
export type Box = [V3, V3];

export interface FilmPart {
  id: string;
  /** its block name */
  name: string;
  label: string;
  kind: "part" | "component";
  /** material label, e.g. "PETG-CF" */
  material: string;
  color: string;
  /** grams, 0 when not known */
  mass: number;
  /** placed box in the assembly */
  box: Box;
  /** where its centre is with the design fully exploded */
  exploded: V3 | null;
  moving: boolean;
  /** screws, nuts and washers */
  hardware: boolean;
  group: string;
}

export interface FilmFacts {
  /** the design's name as written */
  name: string;
  /** a readable title from it */
  title: string;
  purpose?: string;
  box: Box;
  /** bounds with every part fully exploded, null when nothing comes apart */
  exploded: Box | null;
  parts: FilmPart[];
  /** assembly order (part ids), for the assembly shot */
  order: string[];
  size: V3 | null;
  /** grams */
  mass: number;
  make: number;
  buy: number;
  materials: { label: string; mass: number }[];
  cost: { total: number; unpriced: number } | null;
  bom: { qty: number; item: string; kind: "Make" | "Buy"; price?: number }[];
  checks: { pass: number; total: number } | null;
  wires: number;
  boards: number;
  firmware: { name: string; file: string; lang: string; lines: string[]; board?: string } | null;
  airflow: { label: string; cda?: number; watts?: number; speed?: number }[];
  structural: { label: string; safety?: number; stress?: number }[];
  sims: { label: string; seconds: number; box: Box | null }[];
  /** the look's backdrop is pale: graphics use dark text */
  light: boolean;
}

/** "jet_vane_rig" → "Jet vane rig" */
export function prettyName(name: string): string {
  const s = name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "Untitled design";
  return s[0].toUpperCase() + s.slice(1);
}

export function fmtMass(g: number): string {
  if (g >= 1000) return `${(g / 1000).toFixed(g >= 10000 ? 1 : 2)} kg`;
  return `${Math.round(g)} g`;
}

export function fmtSize(s: V3): string {
  const r = (v: number) => (v >= 20 ? Math.round(v) : Math.round(v * 10) / 10);
  return `${r(s[0])} × ${r(s[1])} × ${r(s[2])} mm`;
}

export function fmtMoney(n: number): string {
  return n >= 1000 ? `$${Math.round(n).toLocaleString("en")}` : `$${n.toFixed(n >= 100 ? 0 : 2)}`;
}

function list(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** Which sections this design has something to show for, and why not when it hasn't. */
export function sectionAvailable(kind: SectionKind, f: FilmFacts): string | null {
  const solid = f.parts.length > 0;
  if (!solid && kind !== "title" && kind !== "end") return "The design has no parts yet";
  switch (kind) {
    case "build":
    case "explode":
      return f.exploded && f.parts.length > 1 ? null : "Nothing in it comes apart";
    case "motion":
      return f.parts.some((p) => p.moving) ? null : "No part has a motion: to show one, give it motion: (a turning axis)";
    case "sim":
      return f.sims.length ? null : "Run a simulation first";
    case "airflow":
      return f.airflow.length ? null : "Run an airflow analysis first";
    case "results":
      return f.structural.length ? null : "Run a structural analysis first";
    case "wiring":
      return f.wires ? null : "The design has no wires";
    case "firmware":
      return f.firmware ? null : "The design has no firmware";
    case "parts":
      return f.bom.length ? null : "The design has no parts list";
    default:
      return null;
  }
}

/** The parts a detail shot visits by default: the biggest made parts and the dearest bought ones. */
export function spotlightParts(f: FilmFacts, n = 3): string[] {
  const vol = (p: FilmPart) => (p.box[1][0] - p.box[0][0]) * (p.box[1][1] - p.box[0][1]) * (p.box[1][2] - p.box[0][2]);
  const seen = new Set<string>();
  const pick: FilmPart[] = [];
  const priced = new Map(f.bom.filter((r) => r.price !== undefined).map((r) => [r.item, r.price!]));
  const cands = f.parts.filter((p) => !p.hardware && vol(p) > 0);
  const made = cands.filter((p) => p.kind === "part").sort((a, b) => vol(b) - vol(a));
  const bought = cands.filter((p) => p.kind === "component").sort((a, b) => (priced.get(b.label) ?? 0) - (priced.get(a.label) ?? 0) || vol(b) - vol(a));
  // alternate made and bought, skipping a second copy of the same block
  for (let i = 0; pick.length < n && (i < made.length || i < bought.length); i++) {
    for (const p of [made[i], bought[i]]) {
      if (!p || pick.length >= n || seen.has(p.name)) continue;
      seen.add(p.name);
      pick.push(p);
    }
  }
  // the biggest overall first: the camera starts wide and closes in
  return pick.sort((a, b) => vol(b) - vol(a)).map((p) => p.id);
}

/** Default caption lines for a section, written from the design. */
export function defaultCaption(kind: SectionKind, f: FilmFacts): { title: string; text: string } {
  const parts = f.make + f.buy;
  switch (kind) {
    case "title":
      return { title: f.title, text: f.purpose ? firstSentence(f.purpose) : "" };
    case "reveal":
      return { title: f.title, text: [f.size ? fmtSize(f.size) : "", f.mass > 0 ? fmtMass(f.mass) : ""].filter(Boolean).join(" · ") };
    case "build":
      return { title: "How it goes together", text: `${parts} part${parts === 1 ? "" : "s"}: ${f.make} made, ${f.buy} bought` };
    case "explode": {
      const mats = f.materials.slice(0, 3).map((m) => m.label);
      return { title: "Every part", text: mats.length ? `In ${list(mats)}` : `${parts} parts` };
    }
    case "inside":
      return { title: "Inside", text: "Cut through the middle" };
    case "motion": {
      const n = f.parts.filter((p) => p.moving).length;
      return { title: "In motion", text: `${n} moving part${n === 1 ? "" : "s"}` };
    }
    case "sim":
      return { title: "Simulated", text: f.sims[0]?.label ?? "" };
    case "airflow": {
      const a = f.airflow[0];
      const bits = [a?.cda !== undefined ? `CdA ${a.cda.toFixed(3)} m²` : "", a?.watts !== undefined && a.speed !== undefined ? `${Math.round(a.watts)} W at ${Math.round(a.speed)} km/h` : ""].filter(Boolean);
      return { title: "Airflow", text: bits.join(" · ") || (a?.label ?? "") };
    }
    case "results": {
      const r = f.structural[0];
      return { title: "Strength", text: r?.safety !== undefined ? `Safety factor ${r.safety.toFixed(1)} under its loads` : (r?.label ?? "") };
    }
    case "wiring":
      return { title: "Wiring", text: `${f.wires} wire${f.wires === 1 ? "" : "s"}, routed and checked` };
    case "spotlight":
      return { title: "Details", text: "" };
    case "firmware": {
      const fw = f.firmware;
      return { title: "Firmware", text: fw ? `${fw.lines.length} lines of ${fw.lang}, written from the design` : "" };
    }
    case "specs":
      return { title: "By the numbers", text: "" };
    case "parts":
      return { title: "What it takes", text: f.cost && f.cost.total > 0 ? `About ${fmtMoney(f.cost.total)} in bought parts` : `${parts} parts` };
    case "end":
      return { title: f.title, text: "" };
  }
}

function firstSentence(s: string): string {
  const m = /^(.{8,110}?[.!?])(\s|$)/.exec(s.trim());
  const t = (m ? m[1] : s.trim()).replace(/[.]$/, "");
  return t.length > 110 ? `${t.slice(0, 107).trimEnd()}…` : t;
}

/** The order sections play in when they are all on. */
const ORDER: SectionKind[] = ["title", "reveal", "build", "explode", "spotlight", "inside", "motion", "sim", "airflow", "results", "wiring", "firmware", "specs", "parts", "end"];
/** Sections on by default (when the design has what they need), for a film near a minute long. */
const ON_BY_DEFAULT = new Set<SectionKind>(["title", "reveal", "build", "explode", "spotlight", "motion", "sim", "airflow", "results", "wiring", "firmware", "specs", "parts", "end"]);

/** A section with its default length and captions. */
export function defaultSection(kind: SectionKind, f: FilmFacts): FilmSection {
  const c = defaultCaption(kind, f);
  const s: FilmSection = { kind, seconds: sectionInfo(kind).seconds, title: c.title, text: c.text };
  if (kind === "spotlight") s.parts = spotlightParts(f);
  if (kind === "inside") s.axis = longestFlat(f);
  if (kind === "sim") s.label = f.sims[0]?.label;
  if (kind === "airflow") s.label = f.airflow[0]?.label;
  if (kind === "results") s.label = f.structural[0]?.label;
  return s;
}

/** Cut across the box's longest flat side, so the section shows the most. */
function longestFlat(f: FilmFacts): "x" | "y" | "z" {
  const d = [0, 1, 2].map((i) => f.box[1][i] - f.box[0][i]);
  // cut across y (looking from the front) unless the design is far deeper than wide
  return d[1] > d[0] * 1.6 ? "x" : "y";
}

/** Every section the film maker offers for this design, on or off, in playing order. */
export function sectionChoices(f: FilmFacts): { section: FilmSection; on: boolean; unavailable: string | null }[] {
  return ORDER.map((k) => {
    const why = sectionAvailable(k, f);
    return { section: defaultSection(k, f), on: !why && ON_BY_DEFAULT.has(k) && trimmed(k, f), unavailable: why };
  });
}

/** Keep the default film near a minute: drop the less important extras on a design that has everything. */
function trimmed(k: SectionKind, f: FilmFacts): boolean {
  const extras = [f.sims.length, f.airflow.length, f.structural.length, f.wires, f.firmware ? 1 : 0].filter(Boolean).length;
  if (extras >= 3 && (k === "results" || k === "firmware")) return false;
  if (k === "spotlight") return spotlightParts(f).length >= 2;
  return true;
}

/** The film Kerf suggests for a design. */
export function defaultFilm(f: FilmFacts): FilmSpec {
  return {
    title: f.title,
    tagline: f.purpose ? firstSentence(f.purpose) : "",
    sections: sectionChoices(f)
      .filter((c) => c.on)
      .map((c) => c.section),
    aspect: "16:9",
    size: 1080,
    fps: 30,
    look: "studio",
    accent: DEFAULT_ACCENT,
    music: "drive",
    captions: true,
    badge: "DESIGNED IN KERF",
    endLine: "Designed in Kerf",
    quality: "good",
    motionBlur: true,
  };
}
