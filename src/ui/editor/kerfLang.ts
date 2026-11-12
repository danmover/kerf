// CodeMirror support for .kerf: highlighting, completion and a theme that
// matches the app.

import { StreamLanguage, HighlightStyle, syntaxHighlighting, type StreamParser } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { StateEffect, StateField } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";
import { KEYWORDS, UNITS } from "../../lang/lexer";
import { SHAPE_FNS, MATH_FNS, modifierDocs, GEO_FNS } from "../../lang/builtins";
import { useImports } from "../../core/imports";
import { FEATURE_FNS, MODELLING_FNS, PATH_FNS, PROFILE_FNS, SELECT_FNS, SOLID_FNS } from "../../lang/modelling";
import { SHEET_FNS } from "../../lang/sheet";
import { MOULD_FNS } from "../../lang/mould";
import { SPLIT_FNS } from "../../lang/split";
import { AERO_FNS } from "../../lang/aero";
import { LIBRARY } from "../../library/components";
import { PROCESSES, PROCESS_IDS } from "../../mfg/profiles";
import { DRAWING_DOCS, DRAWING_PROPS } from "../../drawing/spec";
import { THREADS, MATERIALS } from "../../library/standards";
import type { Model } from "../../core/model";
import { BRIEF_FIELDS } from "../../lang/evaluator";
import { CONSTRAINTS } from "../../sketch/evaluate";
import { SKETCH_FNS } from "../../sketch/fns";
import { ANALYSIS_FNS, DRIVETRAIN_PROPS, STRUCTURAL_PROPS, UCI_PROPS } from "../../analysis/lang";
import { AIRFLOW_PROPS } from "../../analysis/aeroLang";
import { MATE_FNS } from "../../lang/mates";
import { currentTheme } from "../../app/theme";
import "../../styles/syntax.css";

const STATEMENTS = new Set(["design", "note", "brief", "param", "let", "component", "interface", "part", "require", "decision", "sketch", "analysis"]);
// brief entries are ordinary names elsewhere, so they only read as keywords at the start of a line
const BRIEF_ENTRIES = new Set(["use", "given", "reference", "assume"]);
// "drawing" starts a block only at the start of a line; elsewhere it is an ordinary name
const LINE_KEYWORDS = new Set(["drawing", "frame"]);
const BRIEF_FLAGS = new Set(["assumed", "confirmed"]);
const OPS_KW = new Set(["body", "add", "cut", "intersect"]);
const BUILTIN_FNS = new Set([...Object.keys(SHAPE_FNS), ...Object.keys(MODELLING_FNS), ...Object.keys(SKETCH_FNS), ...Object.keys(MATH_FNS), ...Object.keys(modifierDocs), ...GEO_FNS, "step", ...Object.keys(ANALYSIS_FNS), ...Object.keys(MATE_FNS)]);
/** Words that start a statement inside a sketch block. */
const SKETCH_GEOMETRY = ["line", "circle", "arc", "point", "construction"];
const SKETCH_WORDS = new Set([...SKETCH_GEOMETRY, ...Object.keys(CONSTRAINTS), "on", "dist", "dx", "dy"]);
const CONSTS = new Set(["X", "Y", "Z", "ORIGIN", "PI", ...Object.keys(THREADS)]);

interface St {
  inComment: boolean;
  /** brace depth, and the depth inside the sketch block being read (sketch statements are coloured there) */
  depth: number;
  sketchDepth: number;
  afterSketch: boolean;
  /** no token yet on this line */
  lineStart: boolean;
}

const parser: StreamParser<St> = {
  name: "kerf",
  startState: () => ({ inComment: false, depth: 0, sketchDepth: -1, afterSketch: false, lineStart: true }),
  token(stream, state) {
    if (stream.sol()) state.lineStart = true;
    const first = state.lineStart;
    if (state.inComment) {
      if (stream.match(/^.*?\*\//)) state.inComment = false;
      else stream.skipToEnd();
      return "comment";
    }
    if (stream.eatSpace()) return null;
    state.lineStart = false;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      state.inComment = true;
      return "comment";
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^#[0-9a-fA-F]{3,8}\b/)) return "color";
    if (stream.match(/^\d+(\.\d+)?/)) {
      const units = Object.keys(UNITS).sort((a, b) => b.length - a.length);
      for (const u of units) if (stream.match(u, true)) return "unit";
      return "number";
    }
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      const w = stream.current();
      if (w === "sketch") state.afterSketch = true;
      if (STATEMENTS.has(w)) return "keyword";
      if (BRIEF_ENTRIES.has(w) && !stream.string.slice(0, stream.start).trim() && stream.peek() === " ") return "keyword";
      if (LINE_KEYWORDS.has(w) && !stream.string.slice(0, stream.start).trim() && stream.match(/^\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/, false)) return "keyword";
      // mate name = against(...) and mate against(...): a statement only at the start of a line
      if (w === "mate" && !stream.string.slice(0, stream.start).trim() && stream.match(/^\s+[A-Za-z_][A-Za-z0-9_]*\s*[(=]/, false)) return "keyword";
      if (BRIEF_FLAGS.has(w) && stream.peek() !== ":" && !stream.string.slice(stream.pos).trim()) return "controlKeyword";
      if (first && state.depth === state.sketchDepth && SKETCH_WORDS.has(w) && /^\s+[A-Za-z_(]/.test(stream.string.slice(stream.pos))) return "operatorKeyword";
      if (OPS_KW.has(w)) return "operatorKeyword";
      if (KEYWORDS.has(w)) return w === "true" || w === "false" ? "bool" : "controlKeyword";
      if (w === "mfg") return "namespace";
      if (w === "lib") return "namespace";
      if (w === "option" && stream.match(/^\s*"/, false)) return "controlKeyword";
      if (CONSTS.has(w)) return "constant";
      if (stream.peek() === "(" && BUILTIN_FNS.has(w)) return "builtin";
      if (stream.peek() === ":") return "propertyName";
      return "variableName";
    }
    if (stream.match(/^(\.\.|==|!=|<=|>=|&&|\|\||[-+*/^<>=!?:])/)) return "operator";
    if (stream.match(/^[{}()[\],;.]/)) {
      const c = stream.current();
      if (c === "{") {
        state.depth++;
        if (state.afterSketch) state.sketchDepth = state.depth;
        state.afterSketch = false;
      } else if (c === "}") {
        if (state.depth === state.sketchDepth) state.sketchDepth = -1;
        state.depth = Math.max(0, state.depth - 1);
      }
      return "punctuation";
    }
    stream.next();
    return null;
  },
  tokenTable: {
    color: t.color,
    unit: t.unit,
    bool: t.bool,
    builtin: t.function(t.standard(t.variableName)),
    constant: t.constant(t.variableName),
    namespace: t.namespace,
    operatorKeyword: t.operatorKeyword,
    controlKeyword: t.controlKeyword,
  },
  languageData: { commentTokens: { line: "//", block: { open: "/*", close: "*/" } }, closeBrackets: { brackets: ["(", "[", "{", '"'] } },
};

export const kerfLanguage = StreamLanguage.define(parser);

// colours are tokens from styles/syntax.css, so they follow the light and dark themes
const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "var(--syn-keyword)", fontWeight: "500" },
  { tag: t.operatorKeyword, color: "var(--syn-op)", fontWeight: "500" },
  { tag: t.controlKeyword, color: "var(--syn-keyword)" },
  { tag: t.comment, color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: t.string, color: "var(--syn-string)" },
  { tag: t.number, color: "var(--syn-number)" },
  { tag: t.unit, color: "var(--syn-number)" },
  { tag: t.color, color: "var(--syn-color)" },
  { tag: t.bool, color: "var(--syn-op)" },
  { tag: t.function(t.standard(t.variableName)), color: "var(--syn-builtin)" },
  { tag: t.constant(t.variableName), color: "var(--syn-constant)" },
  { tag: t.namespace, color: "var(--syn-namespace)" },
  { tag: t.propertyName, color: "var(--syn-property)" },
  { tag: t.variableName, color: "var(--syn-name)" },
  { tag: t.operator, color: "var(--syn-property)" },
  { tag: t.punctuation, color: "var(--syn-punct)" },
]);

export const kerfHighlight = syntaxHighlighting(highlight);

// CodeMirror draws what the theme below leaves out (tooltip text, the current
// search match) by its own light or dark set, so keep its dark flag on the app's theme.
const setDark = StateEffect.define<boolean>();
const darkFlag = StateField.define<boolean>({
  create: () => currentTheme() === "dark",
  update: (dark, tr) => tr.effects.reduce((d, e) => (e.is(setDark) ? e.value : d), dark),
  provide: (f) => EditorView.darkTheme.from(f),
});
const followTheme = ViewPlugin.define((view) => {
  const watch = new MutationObserver(() => {
    const dark = currentTheme() === "dark";
    if (view.state.field(darkFlag) !== dark) view.dispatch({ effects: setDark.of(dark) });
  });
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return { destroy: () => watch.disconnect() };
});

export const kerfTheme = [
  EditorView.theme({
    "&": { color: "var(--syn-name)", backgroundColor: "transparent", height: "100%", fontSize: "12.5px" },
    ".cm-scroller": { fontFamily: "'IBM Plex Mono', ui-monospace, monospace", lineHeight: "1.62" },
    ".cm-content": { caretColor: "var(--accent-2)", padding: "8px 0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent-2)", borderLeftWidth: "2px" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "rgb(var(--accent-rgb) / 0.28) !important" },
    ".cm-gutters": { backgroundColor: "transparent", color: "var(--code-gutter)", border: "none", paddingRight: "6px" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--accent-2)" },
    ".cm-activeLine": { backgroundColor: "rgb(var(--accent-rgb) / 0.06)" },
    ".cm-foldPlaceholder": { backgroundColor: "var(--code-raised)", border: "none", color: "var(--accent-2)" },
    ".cm-tooltip": { backgroundColor: "var(--code-tip)", border: "1px solid var(--code-edge)", borderRadius: "8px", boxShadow: "var(--code-tip-shadow)" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "rgb(var(--accent-rgb) / 0.22)", color: "rgb(var(--ink-rgb))" },
    ".cm-tooltip-autocomplete > ul": { fontFamily: "'IBM Plex Mono', monospace", fontSize: "12px", maxHeight: "260px" },
    ".cm-completionDetail": { color: "var(--syn-punct)", fontStyle: "normal", marginLeft: "8px" },
    ".cm-completionInfo": { maxWidth: "380px", padding: "8px 10px", fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "12px", lineHeight: "1.5" },
    ".cm-diagnostic": { fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "12px", padding: "6px 10px" },
    ".cm-diagnostic-error": { borderLeft: "3px solid var(--fail)" },
    ".cm-diagnostic-warning": { borderLeft: "3px solid var(--warn)" },
    ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--fail)", textUnderlineOffset: "3px" },
    ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy var(--warn)", textUnderlineOffset: "3px" },
    ".cm-searchMatch": { backgroundColor: "rgb(var(--code-find-rgb) / 0.25)", outline: "1px solid rgb(var(--code-find-rgb) / 0.5)" },
    ".cm-panels": { backgroundColor: "var(--code-panel)", color: "var(--syn-name)", borderTop: "1px solid var(--code-panel-line)" },
    ".cm-panel input, .cm-panel button": { fontFamily: "inherit" },
    ".cm-textfield": { backgroundColor: "var(--code-field)", border: "1px solid var(--code-edge)", borderRadius: "4px", color: "var(--syn-name)" },
    ".cm-button": { backgroundImage: "none", backgroundColor: "var(--code-raised)", border: "1px solid var(--code-edge)", borderRadius: "4px", color: "var(--syn-name)" },
  }),
  darkFlag,
  followTheme,
];

/** Completions from the language tables plus names defined in the current model. */
export function kerfCompletions(getModel: () => Model | null) {
  const fnCompletions: Completion[] = [
    ...Object.values({ ...SHAPE_FNS, ...SOLID_FNS, ...SKETCH_FNS }).map((f) => ({ label: f.name, type: "function", info: f.doc, detail: f.name === "plane" ? "sketch plane" : "shape", apply: f.name + "(" })),
    ...Object.values(PROFILE_FNS).map((f) => ({ label: f.name, type: "function", info: f.doc, detail: "profile", apply: f.name + "(" })),
    ...Object.values(PATH_FNS).map((f) => ({ label: f.name, type: "function", info: f.doc, detail: "path", apply: f.name + "(" })),
    ...Object.values(FEATURE_FNS).map((f) => ({ label: f.name, type: "function", info: f.doc, detail: "feature", apply: f.name + "(" })),
    ...Object.values({ ...SHEET_FNS, ...MOULD_FNS }).map((f) => ({ label: f.name, type: "function", info: f.doc, detail: f.name === "mould" ? "mould" : "sheet metal", apply: f.name + "(" })),
    ...Object.values(SPLIT_FNS).map((f) => ({ label: f.name, type: "function", info: f.doc, detail: "split into pieces", apply: f.name + "(" })),
    ...Object.values(AERO_FNS).map((f) => ({ label: f.name, type: "function", info: f.doc, detail: f.name === "airfoil" ? "profile" : "aero tube", apply: f.name + "(" })),
    ...Object.values(SELECT_FNS).map((f) => ({ label: f.name, type: "function", info: f.doc, detail: "selection", apply: f.name + "(" })),
    ...Object.entries(CONSTRAINTS).map(([k, c]) => ({ label: k, type: "keyword", info: c.doc, detail: c.dim ? "sketch dimension" : "sketch relation" })),
    ...SKETCH_GEOMETRY.map((k) => ({ label: k, type: "keyword", detail: "sketch geometry" })),
    ...Object.values(MATH_FNS).map((f) => ({ label: f.name, type: "function", info: f.doc, detail: "math", apply: f.name + "(" })),
    ...Object.entries(modifierDocs).map(([k, d]) => ({ label: k, type: "function", info: d, detail: "modifier", apply: k + "(" })),
    ...GEO_FNS.map((g) => ({ label: g, type: "function", detail: "geometry", apply: g + "(" })),
    ...Object.values(ANALYSIS_FNS).map((f) => ({ label: f.name, type: "function", info: f.doc, detail: "analysis", apply: f.name + "(" })),
    ...Object.entries(DRAWING_DOCS)
      .filter(([k]) => k !== "note")
      .map(([k, d]) => ({ label: k, type: "function", info: d, detail: "drawing", apply: k + "(" })),
  ];
  // mates: face(), axis(), point() and plane() share names with sketch and analysis functions, listed once
  for (const f of Object.values(MATE_FNS)) if (!fnCompletions.some((c) => c.label === f.name)) fnCompletions.push({ label: f.name, type: "function", info: f.doc, detail: "mate", apply: f.name + "(" });
  const kw: Completion[] = [...KEYWORDS].map((k) => ({ label: k, type: "keyword" }));
  kw.push({ label: "mate", type: "keyword", detail: "how two parts meet", info: "mate name = against(face(lid, -Z), face(box, +Z)): places the first part by how its faces, holes and points meet the second's (against, flush, concentric, pin, distance, angle, parallel, perpendicular, tangent, coincident, rigid); what the mates leave free can be dragged" });
  kw.push({ label: "frame", type: "keyword", detail: "structural frame", info: 'frame name { profile: "2020", box: (w, d, h) } or path: [(x, y, z), ...]: 2020 extrusion or steel sections along lines, trimmed where they meet, with a cut list' });
  const profiles: Completion[] = ["2020", "2040", "box 40x40x3", "box 50x25x2.5", "tube 26.9x2.6", "angle 30x30x3", "flat 40x5", "bar 20x20", "rod 12"].map((p) => ({ label: `"${p}"`, type: "text", detail: /^\d/.test(p) ? "V-slot extrusion" : "section" }));
  const consts: Completion[] = [...CONSTS].map((c) => ({ label: c, type: "constant", detail: THREADS[c] ? "thread" : undefined }));
  const libItems: Completion[] = Object.entries(LIBRARY).map(([k, e]) => ({ label: k, type: "class", info: `${e.signature}\n\n${e.doc}`, detail: "library", apply: k + "(" }));
  const mfgItems: Completion[] = PROCESS_IDS.map((id) => ({ label: id, type: "class", info: `${PROCESSES[id].label}. ${PROCESSES[id].summary}\n\nSettings: ${PROCESSES[id].settings.map((s) => `${s.key}: ${s.doc}`).join("; ") || "none"}`, detail: "process", apply: id + "(" }));
  const processNames: Completion[] = PROCESS_IDS.map((id) => ({ label: `"${id}"`, type: "text", detail: PROCESSES[id].label }));
  fnCompletions.push({ label: "mfg", type: "namespace", detail: "manufacturing processes" });
  const props: Completion[] = [...new Set(["color", "material", "process", "group", "at", "axis", "facing", "rotate", "spin", "mesh", "turns_with", "rides", "slides", "swings", "links", "pins", "held", "explode", "mass", "split", "chain", "label", "axis_at", "plane", "offset", "profile", "box", "path", "levels", "ends", ...STRUCTURAL_PROPS, ...DRIVETRAIN_PROPS, ...AIRFLOW_PROPS, ...UCI_PROPS, ...DRAWING_PROPS])].map((p) => ({ label: p + ":", type: "property" }));
  const briefProps: Completion[] = [...BRIEF_FIELDS, "load", "dir", "on", "cycles", "note", "file", "url", "notes"].filter((p) => !props.some((q) => q.label === p + ":")).map((p) => ({ label: p + ":", type: "property", detail: "brief" }));
  const materials: Completion[] = Object.keys(MATERIALS).map((m) => ({ label: `"${m}"`, type: "text", detail: "material" }));

  return (ctx: CompletionContext): CompletionResult | null => {
    const mfg = ctx.matchBefore(/mfg\.[A-Za-z_0-9]*/);
    if (mfg) return { from: mfg.from + 4, options: mfgItems, validFor: /^[A-Za-z_0-9]*$/ };
    const lib = ctx.matchBefore(/lib\.[A-Za-z_0-9]*/);
    if (lib) return { from: lib.from + 4, options: libItems, validFor: /^[A-Za-z_0-9]*$/ };
    const word = ctx.matchBefore(/[A-Za-z_][A-Za-z_0-9]*/);
    const line = ctx.state.doc.lineAt(ctx.pos).text;
    if (/process:\s*"[A-Za-z_]*$/.test(line.slice(0, ctx.pos - ctx.state.doc.lineAt(ctx.pos).from))) {
      const m = ctx.matchBefore(/"[A-Za-z_]*/);
      return { from: m ? m.from : ctx.pos, options: processNames };
    }
    if (/profile:\s*"?[A-Za-z0-9 .x]*$/.test(line.slice(0, ctx.pos - ctx.state.doc.lineAt(ctx.pos).from))) {
      const m = ctx.matchBefore(/"?[A-Za-z0-9 .x]*/);
      return { from: m ? m.from : ctx.pos, options: profiles };
    }
    if (/material:\s*"?[A-Za-z ]*$/.test(line.slice(0, ctx.pos - ctx.state.doc.lineAt(ctx.pos).from))) {
      const m = ctx.matchBefore(/"?[A-Za-z0-9 ]*/);
      return { from: m ? m.from : ctx.pos, options: materials };
    }
    if (!word || (word.from === word.to && !ctx.explicit)) return null;
    const model = getModel();
    const defined: Completion[] = [];
    if (model) {
      for (const p of model.params) defined.push({ label: p.name, type: "variable", detail: `param = ${typeof p.value === "number" ? +p.value.toFixed(3) : String(p.value)}`, info: p.desc });
      for (const b of model.blocks) if (b.kind !== "param" && b.kind !== "require" && b.kind !== "decision") defined.push({ label: b.name, type: b.kind === "let" || b.kind === "given" ? "variable" : "class", detail: b.kind });
      for (const u of model.brief?.uses ?? []) defined.push({ label: u.id, type: "constant", detail: "use", info: u.text });
    }
    // imported STEP files place like library components
    const imports: Completion[] = useImports.getState().list.map((i) => ({ label: `step(${JSON.stringify(i.name)})`, type: "class", detail: "imported STEP", info: i.file, apply: `step(${JSON.stringify(i.name)})` }));
    return { from: word.from, options: [...defined, ...imports, ...fnCompletions, ...consts, ...kw, ...props, ...briefProps, { label: "lib", type: "namespace" }], validFor: /^[A-Za-z_0-9]*$/ };
  };
}
