// Writing shots back into the design source. Every change from the shot
// editor, the gallery and Claude is a plain edit of a `shot` block, so the
// editor, undo, version history and the assistant all see it. Edits touch
// only the lines they change: comments and anything else in the block stay.

import type { Model } from "../core/model";
import { lex, type Token } from "../lang/lexer";
import { KIND_DEFAULTS, type Callout, type ShotSpec } from "./spec";
import type { V3 } from "../kernel/recipe";

const num = (n: number, dp = 3) => {
  const k = 10 ** dp;
  const r = Math.round(n * k) / k;
  return String(Object.is(r, -0) ? 0 : r);
};
const str = (s: string) => JSON.stringify(s);
const ident = (n: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : str(n));
const names = (xs: string[]) => (xs.length === 1 ? ident(xs[0]) : `[${xs.map(ident).join(", ")}]`);
const point = (p: V3) => `(${p.map((x) => num(x, 2)).join(", ")})`;

/** The properties the editor and tools change, in the order they are written. */
export const WRITE_ORDER = ["title", "kind", "angle", "lens", "aperture", "focus", "frame", "fill", "offset", "roll", "aspect", "lighting", "light_angle", "backdrop", "color", "surface", "explode", "section", "hide", "ghost", "props", "motion", "duration", "note"] as const;
export type WriteKey = (typeof WRITE_ORDER)[number];

/**
 * The source text of one property of a shot, or null when the line should not
 * be there (the value is the kind's default and not worth writing).
 */
export function propLine(spec: ShotSpec, key: WriteKey): string | null {
  const d = KIND_DEFAULTS[spec.kind];
  switch (key) {
    case "title":
      return `title: ${str(spec.title)}`;
    case "kind":
      return `kind: ${str(spec.kind)}`;
    case "angle":
      return `angle: (${num(spec.angle[0], 1)}deg, ${num(spec.angle[1], 1)}deg)`;
    case "lens":
      return `lens: ${num(spec.lens, 0)}mm`;
    case "aperture":
      if (spec.aperture === null) return d.aperture === null ? null : "aperture: false";
      return `aperture: ${num(spec.aperture, 1)}`;
    case "focus":
      if (spec.focus === null) return null;
      return `focus: ${typeof spec.focus === "string" ? ident(spec.focus) : point(spec.focus)}`;
    case "frame":
      return spec.frame.length ? `frame: ${names(spec.frame)}` : null;
    case "fill":
      return `fill: ${num(spec.fill, 2)}`;
    case "offset":
      return Math.abs(spec.offset[0]) < 1e-4 && Math.abs(spec.offset[1]) < 1e-4 ? null : `offset: (${num(spec.offset[0], 3)}, ${num(spec.offset[1], 3)})`;
    case "roll":
      return Math.abs(spec.roll) < 1e-3 ? null : `roll: ${num(spec.roll, 1)}deg`;
    case "aspect":
      return `aspect: ${str(spec.aspect)}`;
    case "lighting":
      return `lighting: ${str(spec.lighting)}`;
    case "light_angle":
      return spec.lightAngle === null ? null : `light_angle: ${num(spec.lightAngle, 0)}deg`;
    case "backdrop":
      return `backdrop: ${str(spec.backdrop)}`;
    case "color":
      return spec.color ? `color: ${spec.color}` : null;
    case "surface":
      return spec.backdrop === "surface" || spec.surface !== d.surface ? `surface: ${str(spec.surface)}` : null;
    case "explode":
      return spec.explode > 1e-4 || d.explode > 0 ? `explode: ${num(spec.explode, 2)}` : null;
    case "section":
      if (!spec.section) return d.section ? "section: false" : null;
      return `section(${str(spec.section.axis)}${spec.section.at === null ? "" : `, at: ${num(spec.section.at, 2)}mm`})`;
    case "hide":
      return spec.hide.length ? `hide: ${names(spec.hide)}` : null;
    case "ghost":
      return spec.ghost.length ? `ghost: ${names(spec.ghost)}` : null;
    case "props":
      return spec.props.length || d.props.length ? `props: [${spec.props.map(str).join(", ")}]` : null;
    case "motion":
      return spec.motion === "none" ? null : `motion: ${str(spec.motion)}`;
    case "duration":
      return spec.motion === "none" || Math.abs(spec.duration - d.duration) < 1e-3 ? null : `duration: ${num(spec.duration, 1)}`;
    case "note":
      return spec.note ? `note: ${str(spec.note)}` : null;
  }
}

export function calloutLine(c: Callout): string {
  return `callout(${typeof c.target === "string" ? ident(c.target) : point(c.target)}, ${str(c.text)})`;
}

/** Source text of a whole shot block. */
export function shotToSource(spec: ShotSpec, name = spec.name): string {
  const lines = [`shot ${name} {`];
  for (const k of WRITE_ORDER) {
    const l = propLine(spec, k);
    if (l) lines.push(`  ${l}`);
  }
  for (const c of spec.callouts) lines.push(`  ${calloutLine(c)}`);
  if (spec.locked) lines.push("  locked");
  lines.push("}");
  return lines.join("\n");
}

/** A block name for a new shot that is free in the design. */
export function freeShotName(model: Model | null, base: string): string {
  const clean = base.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").replace(/^([0-9])/, "_$1") || "shot";
  const taken = new Set([...(model?.shots.map((d) => d.name) ?? []), ...(model?.blocks.map((b) => b.name) ?? [])]);
  let name = clean;
  for (let i = 2; taken.has(name); i++) name = `${clean}_${i}`;
  return name;
}

/**
 * Start and end of a shot block in the source, found with the language's own
 * lexer so braces in strings and comments don't count. The start is the
 * beginning of the block's line.
 */
export function shotRange(src: string, name: string): { start: number; end: number; open: number } | null {
  let tokens: Token[];
  try {
    tokens = lex(src);
  } catch {
    return null;
  }
  for (let i = 0; i + 2 < tokens.length; i++) {
    const [kw, id, open] = [tokens[i], tokens[i + 1], tokens[i + 2]];
    if (kw.kind !== "ident" || kw.value !== "shot" || (id.kind !== "ident" && id.kind !== "kw") || id.value !== name || open.kind !== "op" || open.value !== "{") continue;
    const lineStart = src.lastIndexOf("\n", kw.start - 1) + 1;
    if (src.slice(lineStart, kw.start).trim()) continue;
    let depth = 0;
    for (let k = i + 2; k < tokens.length; k++) {
      const t = tokens[k];
      if (t.kind !== "op") continue;
      if (t.value === "{") depth++;
      else if (t.value === "}" && --depth === 0) return { start: lineStart, end: t.end, open: open.end };
    }
    return null;
  }
  return null;
}

/** Add a shot block at the end of the source. */
export function appendShot(src: string, spec: ShotSpec, name = spec.name): string {
  const sep = src.endsWith("\n\n") ? "" : src.endsWith("\n") ? "\n" : src.length ? "\n\n" : "";
  return `${src}${sep}${shotToSource(spec, name)}\n`;
}

/** Remove a shot block, with the blank line before it. */
export function removeShot(src: string, name: string): string {
  const r = shotRange(src, name);
  if (!r) return src;
  let start = r.start;
  let end = r.end;
  if (src[end] === "\n") end++;
  // take one blank line before the block with it
  if (start >= 2 && src.slice(start - 2, start) === "\n\n") start--;
  return src.slice(0, start) + src.slice(end);
}

/** Lines of a block body with their offsets, for line-level edits. */
function bodyLines(src: string, r: { start: number; end: number; open: number }) {
  const out: { start: number; end: number; text: string }[] = [];
  let at = src.indexOf("\n", r.open);
  const close = r.end - 1;
  while (at >= 0 && at < close) {
    const s = at + 1;
    let e = src.indexOf("\n", s);
    if (e < 0 || e > close) e = close;
    out.push({ start: s, end: e, text: src.slice(s, e) });
    at = e === close ? -1 : e;
  }
  return out;
}

const keyOfLine = (text: string): string | null => {
  const t = text.trim();
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(t);
  if (m) return m[1];
  if (/^section\s*\(/.test(t)) return "section";
  if (/^callout\s*\(/.test(t)) return "callout";
  if (t === "locked") return "locked";
  return null;
};

/**
 * The source after writing `next` over a shot block's current lines. Only the
 * properties in `keys` are touched (all writable ones by default): a changed
 * value replaces its line, a value back at its default loses its line, and a
 * new one goes in its place in WRITE_ORDER. Callouts are rewritten when
 * `callouts` is set. A shot that is not in the source yet is appended.
 */
export function writeShot(src: string, next: ShotSpec, opts: { keys?: readonly WriteKey[]; callouts?: boolean; locked?: boolean } = {}): string {
  const r = shotRange(src, next.name);
  if (!r) return appendShot(src, next);
  const keys = opts.keys ?? WRITE_ORDER;
  const lines = bodyLines(src, r);
  const indent = lines.find((l) => l.text.trim())?.text.match(/^[ \t]*/)?.[0] || "  ";
  type Line = { key: string | null; text: string };
  const body: Line[] = lines.map((l) => ({ key: keyOfLine(l.text), text: l.text }));
  for (const k of keys) {
    const want = propLine(next, k);
    const at = body.findIndex((l) => l.key === k);
    if (want === null) {
      if (at >= 0) body.splice(at, 1);
      continue;
    }
    if (at >= 0) {
      const ind = body[at].text.match(/^[ \t]*/)?.[0] ?? indent;
      body[at] = { key: k, text: ind + want };
      // drop any duplicate lines of the same key
      for (let j = body.length - 1; j > at; j--) if (body[j].key === k) body.splice(j, 1);
      continue;
    }
    // insert after the nearest earlier property in write order
    const order = WRITE_ORDER.indexOf(k);
    let insertAt = -1;
    for (let j = body.length - 1; j >= 0; j--) {
      const bk = body[j].key as WriteKey | null;
      if (bk && WRITE_ORDER.indexOf(bk) >= 0 && WRITE_ORDER.indexOf(bk) < order) {
        insertAt = j + 1;
        break;
      }
    }
    if (insertAt < 0) insertAt = 0;
    body.splice(insertAt, 0, { key: k, text: indent + want });
  }
  if (opts.callouts) {
    const first = body.findIndex((l) => l.key === "callout");
    const kept = body.filter((l) => l.key !== "callout");
    const lockAt = kept.findIndex((l) => l.key === "locked");
    const at = first >= 0 ? Math.min(first, kept.length) : lockAt >= 0 ? lockAt : kept.length;
    kept.splice(at, 0, ...next.callouts.map((c) => ({ key: "callout", text: indent + calloutLine(c) })));
    body.splice(0, body.length, ...kept);
  }
  if (opts.locked !== undefined) {
    const at = body.findIndex((l) => l.key === "locked");
    if (opts.locked && at < 0) body.push({ key: "locked", text: indent + "locked" });
    if (!opts.locked && at >= 0) body.splice(at, 1);
  }
  const text = body
    .map((l) => l.text)
    .filter((t, i, all) => t.trim() !== "" || (i > 0 && all[i - 1].trim() !== ""))
    .join("\n");
  const head = src.slice(r.start, r.open);
  return `${src.slice(0, r.start)}${head}\n${text.replace(/\n+$/, "")}\n}${src.slice(r.end)}`;
}

/** Rename a shot block. */
export function renameShot(src: string, from: string, to: string): string {
  const r = shotRange(src, from);
  if (!r) return src;
  const head = src.slice(r.start, r.open);
  return src.slice(0, r.start) + head.replace(new RegExp(`\\bshot\\s+${from}\\b`), `shot ${to}`) + src.slice(r.open);
}
