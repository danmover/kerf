// Facts the left panel derives from the model and source: parameter sections,
// what each parameter drives, display units, and part descriptions.
// Pure functions, so they can be unit tested without a browser.

import type { EvalParam, EvalPart, Model } from "../../core/model";

// ---------- parameter sections ----------

export interface ParamSection {
  /** heading taken from a `// ── Title ──` comment, or null before the first one */
  title: string | null;
  params: EvalParam[];
  /** names of parameters that start a new blank-line-separated cluster */
  breaks: Set<string>;
}

// `// ── Layout ───`, `// -- Layout --`, `// == Layout ==`
const SECTION_RE = /^[ \t]*\/\/[ \t]*[─━—–\-=#*]{2,}[ \t]*(.*?)[ \t]*[─━—–\-=#*]*[ \t]*$/;

/** Section headings in the source, with their offsets, in order. */
export function sourceSections(src: string): { title: string; at: number }[] {
  const out: { title: string; at: number }[] = [];
  let at = 0;
  for (const line of src.split("\n")) {
    const m = SECTION_RE.exec(line);
    if (m && m[1]) out.push({ title: m[1].replace(/[─━—–]+$/, "").trim(), at });
    at += line.length + 1;
  }
  return out;
}

/** Group parameters under the section comment above them, keeping source order. */
export function paramSections(src: string, params: EvalParam[]): ParamSection[] {
  const heads = sourceSections(src);
  const sections: ParamSection[] = [];
  const ordered = [...params].sort((a, b) => a.span.start - b.span.start);
  let prevEnd = -1;
  for (const p of ordered) {
    let title: string | null = null;
    for (const h of heads) {
      if (h.at < p.span.start) title = h.title;
      else break;
    }
    let sec = sections[sections.length - 1];
    if (!sec || sec.title !== title) {
      sec = { title, params: [], breaks: new Set() };
      sections.push(sec);
    } else if (prevEnd >= 0 && /\n[ \t]*\n/.test(src.slice(prevEnd, p.span.start))) {
      sec.breaks.add(p.name);
    }
    sec.params.push(p);
    prevEnd = p.span.end;
  }
  return sections;
}

// ---------- what a parameter drives ----------

export interface ParamImpact {
  /** part and component names the value reaches, in model order */
  parts: string[];
  /** the subset whose own definition reads the parameter */
  direct: string[];
  /** instance ids for those parts (for highlighting in the viewport) */
  partIds: string[];
  /** requirement labels whose result can change */
  checks: string[];
}

/**
 * Follow the dependency graph from each parameter through derived values to
 * the parts and requirements it reaches. Stops at parts: a gear meshing with
 * another does not make the second gear depend on the first one's size.
 */
export function paramImpacts(model: Model): Map<string, ParamImpact> {
  const kind = new Map(model.graph.nodes.map((n) => [n.id, n.kind]));
  const out = new Map<string, string[]>();
  for (const e of model.graph.edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const partOrder = new Map<string, number>();
  model.parts.forEach((p, i) => !partOrder.has(p.name) && partOrder.set(p.name, i));
  const result = new Map<string, ParamImpact>();
  for (const p of model.params) {
    const parts = new Set<string>();
    const direct = new Set<string>();
    const checks = new Set<string>();
    const seen = new Set<string>([p.name]);
    const queue = [p.name];
    while (queue.length) {
      const id = queue.shift()!;
      for (const to of out.get(id) ?? []) {
        if (seen.has(to)) continue;
        seen.add(to);
        const k = kind.get(to);
        if (k === "require" || to.startsWith("require:")) checks.add(to.replace(/^require:/, ""));
        else if (k === "part" || k === "component") {
          parts.add(to);
          if (id === p.name) direct.add(to);
          // a requirement that reads this part can change too
          for (const r of out.get(to) ?? []) if (r.startsWith("require:")) checks.add(r.slice(8));
        } else queue.push(to);
      }
    }
    const names = [...parts].filter((n) => partOrder.has(n)).sort((a, b) => partOrder.get(a)! - partOrder.get(b)!);
    const set = new Set(names);
    result.set(p.name, { parts: names, direct: names.filter((n) => direct.has(n)), partIds: model.parts.filter((x) => set.has(x.name)).map((x) => x.id), checks: [...checks] });
  }
  return result;
}

// ---------- units and number formatting ----------

export interface DisplayUnit {
  /** suffix shown after the value ("mm", "°", "") */
  suffix: string;
  /** multiply the stored value by this to display it */
  scale: number;
  /** whole numbers only (tooth counts, ratios written without a decimal point) */
  integer: boolean;
}

/** How to show a parameter's value: in the units it was written in, converted to base units. */
export function displayUnit(p: EvalParam): DisplayUnit {
  if (typeof p.value !== "number") return { suffix: "", scale: 1, integer: false };
  const m = /^-?\d+(?:\.(\d+))?\s*([a-zA-Z%]*)$/.exec(p.text.trim());
  const unit = m?.[2] ?? "";
  const integer = !!m && !m[1] && !unit && Number.isInteger(p.value);
  switch (unit) {
    case "mm":
    case "cm":
    case "m":
    case "in":
      return { suffix: "mm", scale: 1, integer: false };
    case "deg":
    case "rad":
      return { suffix: "°", scale: 1, integer: false };
    case "Nm":
      return { suffix: "N·m", scale: 0.001, integer: false };
    case "g":
    case "kg":
      return { suffix: "g", scale: 1, integer: false };
    case "N":
    case "rpm":
      return { suffix: unit, scale: 1, integer: false };
    case "%":
      return { suffix: "", scale: 1, integer: false };
  }
  // a plain number described in degrees reads better with the sign
  if (p.desc && /\bdeg(rees?)?\b|\bangle\b/i.test(p.desc)) return { suffix: "°", scale: 1, integer };
  return { suffix: "", scale: 1, integer };
}

/** Slider range: the declared range, or a generous band around the value. */
export function autoRange(p: EvalParam): [number, number] {
  const v = p.value as number;
  if (p.min !== undefined && p.max !== undefined) return [p.min, p.max];
  if (v === 0) return [p.min ?? -50, p.max ?? 50];
  const lo = p.min ?? (v > 0 ? v * 0.25 : v * 4);
  const hi = p.max ?? (v > 0 ? v * 2.5 : v * 0.25);
  return [Math.min(lo, hi), Math.max(lo, hi)];
}

/** Step for sliders, scrubbing and arrow keys. */
export function stepFor(p: EvalParam): number {
  if (displayUnit(p).integer) return 1;
  const [lo, hi] = autoRange(p);
  const span = Math.abs(hi - lo);
  return span > 50 ? 1 : span > 5 ? 0.1 : 0.01;
}

/** Keep a scrubbed value inside the declared range, and above zero for positive sizes. */
export function clampParam(p: EvalParam, v: number): number {
  const cur = p.value as number;
  const lo = p.min ?? (cur > 0 ? stepFor(p) : -Infinity);
  const hi = p.max ?? Infinity;
  return Math.min(hi, Math.max(lo, v));
}

export function roundTo(v: number, step: number): number {
  const digits = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return Number((Math.round(v / step) * step).toFixed(digits));
}

/** True when the parameter is a plain literal (editing it keeps the source readable). */
export const isLiteral = (p: EvalParam) => /^-?\d+(\.\d+)?\s*[a-zA-Z%]*$|^".*"$|^(true|false)$/.test(p.text.trim());

// ---------- parts ----------

/** One line saying what a part is: "Spur gear m1 z12", "Bearing 625", "PETG". */
export function describePart(model: Model, part: EvalPart): string {
  const node = model.graph.nodes.find((n) => n.id === part.name);
  if (part.kind === "component") {
    if (node && node.label !== part.name) return node.label;
    if (part.bom?.description) return part.bom.description;
    return part.label.replace(/\s#\d+$/, "");
  }
  return part.material || "";
}

/** Short content hash shown next to versions, like a commit id. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 7);
}

/** "Today", "Yesterday" or a date, for grouping the history. */
export function dayLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const today = new Date(now);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(today) - start(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: days < 7 ? "long" : undefined, month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}
