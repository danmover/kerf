// Subassembly sections in the design source. A parallel build gives every
// subassembly its own marked region of the one design file:
//
//   // ┌─ subassembly gear_train · Gear train ─────────────────
//   // │ Two-stage 12:1 spur train from the motor to the output shaft.
//   // │ after: drive · uses: motor_mount
//   ...the subassembly's statements...
//   // └─ end gear_train ────────────────────────────────────────
//
// The markers are ordinary comments: the language ignores them and the file
// stays a normal design that people and Claude can edit. Everything before
// the first section is the layout (parameters, positions, interfaces), and
// everything after the last one is integration (requirements that span
// subassemblies). The plan lives in the source, so it survives undo, history
// and export, and can be edited like any other text.

import { parse } from "../lang/parser";
import { stmtName } from "../lang/ast";

export interface SectionMeta {
  id: string;
  name: string;
  brief: string;
  /** subassemblies whose built parts this one needs first */
  after: string[];
  /** layout names and interfaces it implements or reads (informational) */
  uses: string[];
}

export interface Section extends SectionMeta {
  /** the start marker and its │ lines, exactly as written */
  header: string;
  body: string;
  /** the end marker line, exactly as written */
  footer: string;
  /** text between this section's end marker and the next section's start */
  gap: string;
  /** offsets in the text this section was split from */
  start: number;
  bodyStart: number;
  bodyEnd: number;
  end: number;
}

export interface Sectioned {
  head: string;
  sections: Section[];
  tail: string;
}

export type SplitResult = { ok: true; doc: Sectioned } | { ok: false; error: string; line: number };

export const ID_RE = /^[a-z][a-z0-9_]{0,39}$/;
const START_RE = /^\/\/\s*┌─*\s*subassembly\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:[·:]\s*(.*?))?\s*─*\s*$/;
const LINE_RE = /^\/\/\s*│ ?(.*)$/;
const END_RE = /^\/\/\s*└─*\s*end\s+([A-Za-z_][A-Za-z0-9_]*)\b.*$/;
const META_RE = /^(after|uses)\s*:/i;
const WIDTH = 64;

interface Line {
  text: string; // without the newline
  start: number;
  end: number; // offset after the newline (or end of text)
}

function lines(src: string): Line[] {
  const out: Line[] = [];
  let i = 0;
  while (i < src.length) {
    const nl = src.indexOf("\n", i);
    const stop = nl < 0 ? src.length : nl + 1;
    out.push({ text: src.slice(i, nl < 0 ? src.length : nl).replace(/\r$/, ""), start: i, end: stop });
    i = stop;
  }
  return out;
}

function parseList(v: string): string[] {
  const t = v.trim();
  if (!t || t === "—" || t === "-" || /^none$/i.test(t)) return [];
  return t
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseMetaLine(text: string, meta: { after: string[]; uses: string[] }) {
  for (const part of text.split("·")) {
    const m = /^\s*(after|uses)\s*:(.*)$/i.exec(part);
    if (!m) continue;
    const key = m[1].toLowerCase() as "after" | "uses";
    meta[key] = parseList(m[2]);
  }
}

/** Split a design source into layout, subassembly sections and integration. */
export function splitSections(src: string): SplitResult {
  const ls = lines(src);
  const sections: Section[] = [];
  let headEnd = src.length;
  let open: { id: string; name: string; start: number; headerEnd: number; briefLines: string[]; after: string[]; uses: string[]; line: number } | null = null;
  let lastEnd = -1;
  let inHeader = false;
  const seen = new Set<string>();

  for (let n = 0; n < ls.length; n++) {
    const l = ls[n];
    const s = START_RE.exec(l.text);
    const e = END_RE.exec(l.text);
    if (s) {
      if (open) return { ok: false, error: `Subassembly "${s[1]}" starts inside "${open.id}", which has no end marker`, line: n + 1 };
      if (seen.has(s[1])) return { ok: false, error: `Subassembly "${s[1]}" appears twice`, line: n + 1 };
      seen.add(s[1]);
      if (!sections.length) headEnd = l.start;
      else sections[sections.length - 1].gap = src.slice(lastEnd, l.start);
      open = { id: s[1], name: (s[2] ?? "").trim() || s[1], start: l.start, headerEnd: l.end, briefLines: [], after: [], uses: [], line: n + 1 };
      inHeader = true;
      continue;
    }
    if (open && inHeader) {
      const h = LINE_RE.exec(l.text);
      if (h) {
        const content = h[1].trim();
        if (META_RE.test(content)) parseMetaLine(content, open);
        else if (content) open.briefLines.push(content);
        open.headerEnd = l.end;
        continue;
      }
      inHeader = false;
    }
    if (e) {
      if (!open) return { ok: false, error: `End marker for "${e[1]}" has no matching start`, line: n + 1 };
      if (e[1] !== open.id) return { ok: false, error: `End marker for "${e[1]}" closes "${open.id}"`, line: n + 1 };
      sections.push({
        id: open.id,
        name: open.name,
        brief: open.briefLines.join("\n"),
        after: open.after,
        uses: open.uses,
        header: src.slice(open.start, open.headerEnd),
        body: src.slice(open.headerEnd, l.start),
        footer: src.slice(l.start, l.end),
        gap: "",
        start: open.start,
        bodyStart: open.headerEnd,
        bodyEnd: l.start,
        end: l.end,
      });
      lastEnd = l.end;
      open = null;
    }
  }
  if (open) return { ok: false, error: `Subassembly "${open.id}" has no end marker`, line: open.line };
  return {
    ok: true,
    doc: {
      head: src.slice(0, sections.length ? headEnd : src.length),
      sections,
      tail: sections.length ? src.slice(lastEnd) : "",
    },
  };
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n+/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > width) {
        out.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    if (line) out.push(line);
  }
  return out;
}

const clean = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/[┌└│]/g, "").trim();

export function formatHeader(m: SectionMeta): string {
  const title = `// ┌─ subassembly ${m.id} · ${clean(m.name) || m.id} `;
  const out = [title + "─".repeat(Math.max(3, WIDTH - title.length))];
  for (const l of wrap(m.brief.replace(/[┌└│]/g, ""), WIDTH + 24)) out.push(`// │ ${l}`);
  const meta = [m.after.length ? `after: ${m.after.join(", ")}` : "", m.uses.length ? `uses: ${m.uses.join(", ")}` : ""].filter(Boolean);
  if (meta.length) out.push(`// │ ${meta.join(" · ")}`);
  return out.join("\n") + "\n";
}

export function formatFooter(id: string): string {
  const t = `// └─ end ${id} `;
  return t + "─".repeat(Math.max(3, WIDTH - t.length)) + "\n";
}

const withNl = (s: string) => (s && !s.endsWith("\n") ? s + "\n" : s);

/** Rebuild the source text. Unchanged headers keep their exact formatting. */
export function composeSections(doc: Sectioned): string {
  let out = doc.sections.length ? withNl(doc.head) : doc.head;
  doc.sections.forEach((s, i) => {
    out += withNl(s.header) + withNl(s.body) + withNl(s.footer);
    if (i < doc.sections.length - 1) out += s.gap;
  });
  return out + doc.tail;
}

/** A fresh section with canonical markers. */
export function newSection(meta: SectionMeta, body = ""): Section {
  return { ...meta, header: formatHeader(meta), body, footer: formatFooter(meta.id), gap: "\n", start: 0, bodyStart: 0, bodyEnd: 0, end: 0 };
}

/** Same section with new metadata; the header is rewritten only when the metadata changed. */
export function withMeta(s: Section, meta: SectionMeta): Section {
  const same = s.id === meta.id && s.name === meta.name && s.brief === meta.brief && s.after.join() === meta.after.join() && s.uses.join() === meta.uses.join();
  return same ? s : { ...s, ...meta, header: formatHeader(meta), footer: formatFooter(meta.id) };
}

/** Which region of the source an offset falls in. */
export function ownerAt(doc: Sectioned, offset: number): string {
  for (const s of doc.sections) if (offset >= s.start && offset < s.end) return s.id;
  if (doc.sections.length && offset >= doc.sections[doc.sections.length - 1].end) return INTEGRATION;
  return LAYOUT;
}

export const LAYOUT = "(layout)";
export const INTEGRATION = "(integration)";

/** Names of the top-level blocks a piece of source defines (it need not evaluate on its own). */
export function definedNames(text: string): string[] {
  const { program } = parse(text);
  const out: string[] = [];
  for (const s of program.stmts) {
    if (s.k === "require") continue;
    const n = stmtName(s);
    if (n) out.push(n);
  }
  return out;
}

/**
 * Three-way merge by region. `base` is what the run last showed, `theirs` is
 * the source now (someone may have edited it during the run), `ours` is the
 * run's result. A region someone changed keeps their text; every other region
 * takes the run's. Returns null when `theirs` no longer splits cleanly.
 */
export function mergeByRegion(base: Sectioned, ours: Sectioned, theirs: string): { doc: Sectioned; kept: string[] } | null {
  const t = splitSections(theirs);
  if (!t.ok) return null;
  const kept: string[] = [];
  const head = t.doc.head !== base.head ? (kept.push(LAYOUT), t.doc.head) : ours.head;
  const tail = t.doc.tail !== base.tail ? (kept.push(INTEGRATION), t.doc.tail) : ours.tail;
  const baseById = new Map(base.sections.map((s) => [s.id, s]));
  const theirsById = new Map(t.doc.sections.map((s) => [s.id, s]));
  const sections: Section[] = [];
  for (const s of ours.sections) {
    const b = baseById.get(s.id);
    const th = theirsById.get(s.id);
    if (b && !th) {
      kept.push(s.id); // they deleted it
      continue;
    }
    if (b && th && (th.body !== b.body || th.header !== b.header)) {
      kept.push(s.id);
      sections.push(th);
    } else sections.push(s);
  }
  // sections someone added by hand during the run
  for (const th of t.doc.sections) if (!baseById.has(th.id) && !sections.some((s) => s.id === th.id)) sections.push(th), kept.push(th.id);
  return { doc: { head, sections, tail }, kept };
}
