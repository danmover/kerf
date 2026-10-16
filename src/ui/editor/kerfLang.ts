// CodeMirror support for .kerf: highlighting, completion and a theme that
// matches the app.

import { StreamLanguage, HighlightStyle, syntaxHighlighting, type StreamParser } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { EditorView } from "@codemirror/view";
import type { CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";
import { KEYWORDS, UNITS } from "../../lang/lexer";
import { SHAPE_FNS, MATH_FNS, modifierDocs, GEO_FNS } from "../../lang/builtins";
import { LIBRARY } from "../../library/components";
import { THREADS, MATERIALS } from "../../library/standards";
import type { Model } from "../../core/model";
import { ANALYSIS_FNS, DRIVETRAIN_PROPS, STRUCTURAL_PROPS } from "../../analysis/lang";

const STATEMENTS = new Set(["design", "note", "param", "let", "component", "interface", "part", "require", "analysis"]);
const OPS_KW = new Set(["body", "add", "cut", "intersect"]);
const BUILTIN_FNS = new Set([...Object.keys(SHAPE_FNS), ...Object.keys(MATH_FNS), ...Object.keys(modifierDocs), ...GEO_FNS, ...Object.keys(ANALYSIS_FNS)]);
const CONSTS = new Set(["X", "Y", "Z", "ORIGIN", "PI", ...Object.keys(THREADS)]);

interface St {
  inComment: boolean;
}

const parser: StreamParser<St> = {
  name: "kerf",
  startState: () => ({ inComment: false }),
  token(stream, state) {
    if (state.inComment) {
      if (stream.match(/^.*?\*\//)) state.inComment = false;
      else stream.skipToEnd();
      return "comment";
    }
    if (stream.eatSpace()) return null;
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
      if (STATEMENTS.has(w)) return "keyword";
      if (OPS_KW.has(w)) return "operatorKeyword";
      if (KEYWORDS.has(w)) return w === "true" || w === "false" ? "bool" : "controlKeyword";
      if (w === "lib") return "namespace";
      if (CONSTS.has(w)) return "constant";
      if (stream.peek() === "(" && BUILTIN_FNS.has(w)) return "builtin";
      if (stream.peek() === ":") return "propertyName";
      return "variableName";
    }
    if (stream.match(/^(\.\.|==|!=|<=|>=|&&|\|\||[-+*/^<>=!?:])/)) return "operator";
    if (stream.match(/^[{}()[\],;.]/)) return "punctuation";
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

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "#c792ff", fontWeight: "500" },
  { tag: t.operatorKeyword, color: "#ff9e64", fontWeight: "500" },
  { tag: t.controlKeyword, color: "#c792ff" },
  { tag: t.comment, color: "#5c6680", fontStyle: "italic" },
  { tag: t.string, color: "#a5e075" },
  { tag: t.number, color: "#ffcb6b" },
  { tag: t.unit, color: "#ffcb6b" },
  { tag: t.color, color: "#ff8fb1" },
  { tag: t.bool, color: "#ff9e64" },
  { tag: t.function(t.standard(t.variableName)), color: "#7cc4ff" },
  { tag: t.constant(t.variableName), color: "#f78c6c" },
  { tag: t.namespace, color: "#4fd1c5" },
  { tag: t.propertyName, color: "#89ddff" },
  { tag: t.variableName, color: "#d6deeb" },
  { tag: t.operator, color: "#89ddff" },
  { tag: t.punctuation, color: "#7f8aa3" },
]);

export const kerfHighlight = syntaxHighlighting(highlight);

export const kerfTheme = EditorView.theme(
  {
    "&": { color: "#d6deeb", backgroundColor: "transparent", height: "100%", fontSize: "12.5px" },
    ".cm-scroller": { fontFamily: "'IBM Plex Mono', ui-monospace, monospace", lineHeight: "1.62" },
    ".cm-content": { caretColor: "#8fa8ff", padding: "8px 0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#8fa8ff", borderLeftWidth: "2px" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "rgba(109,139,255,0.28) !important" },
    ".cm-gutters": { backgroundColor: "transparent", color: "#3e475c", border: "none", paddingRight: "6px" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#8fa8ff" },
    ".cm-activeLine": { backgroundColor: "rgba(109,139,255,0.06)" },
    ".cm-foldPlaceholder": { backgroundColor: "#1b2030", border: "none", color: "#8fa8ff" },
    ".cm-tooltip": { backgroundColor: "#141824", border: "1px solid #2a3142", borderRadius: "8px", boxShadow: "0 12px 32px rgba(0,0,0,.45)" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "rgba(109,139,255,0.22)", color: "#fff" },
    ".cm-tooltip-autocomplete > ul": { fontFamily: "'IBM Plex Mono', monospace", fontSize: "12px", maxHeight: "260px" },
    ".cm-completionDetail": { color: "#7f8aa3", fontStyle: "normal", marginLeft: "8px" },
    ".cm-completionInfo": { maxWidth: "380px", padding: "8px 10px", fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "12px", lineHeight: "1.5" },
    ".cm-diagnostic": { fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "12px", padding: "6px 10px" },
    ".cm-diagnostic-error": { borderLeft: "3px solid #ff5d6c" },
    ".cm-diagnostic-warning": { borderLeft: "3px solid #f5b84b" },
    ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy #ff5d6c", textUnderlineOffset: "3px" },
    ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy #f5b84b", textUnderlineOffset: "3px" },
    ".cm-searchMatch": { backgroundColor: "rgba(255,203,107,0.25)", outline: "1px solid rgba(255,203,107,0.5)" },
    ".cm-panels": { backgroundColor: "#11141d", color: "#d6deeb", borderTop: "1px solid #232938" },
    ".cm-panel input, .cm-panel button": { fontFamily: "inherit" },
    ".cm-textfield": { backgroundColor: "#0b0e15", border: "1px solid #2a3142", borderRadius: "4px", color: "#d6deeb" },
    ".cm-button": { backgroundImage: "none", backgroundColor: "#1b2030", border: "1px solid #2a3142", borderRadius: "4px", color: "#d6deeb" },
  },
  { dark: true },
);

/** Completions from the language tables plus names defined in the current model. */
export function kerfCompletions(getModel: () => Model | null) {
  const fnCompletions: Completion[] = [
    ...Object.values(SHAPE_FNS).map((f) => ({ label: f.name, type: "function", info: f.doc, detail: "shape", apply: f.name + "(" })),
    ...Object.values(MATH_FNS).map((f) => ({ label: f.name, type: "function", info: f.doc, detail: "math", apply: f.name + "(" })),
    ...Object.entries(modifierDocs).map(([k, d]) => ({ label: k, type: "function", info: d, detail: "modifier", apply: k + "(" })),
    ...GEO_FNS.map((g) => ({ label: g, type: "function", detail: "geometry", apply: g + "(" })),
    ...Object.values(ANALYSIS_FNS).map((f) => ({ label: f.name, type: "function", info: f.doc, detail: "analysis", apply: f.name + "(" })),
  ];
  const kw: Completion[] = [...KEYWORDS].map((k) => ({ label: k, type: "keyword" }));
  const consts: Completion[] = [...CONSTS].map((c) => ({ label: c, type: "constant", detail: THREADS[c] ? "thread" : undefined }));
  const libItems: Completion[] = Object.entries(LIBRARY).map(([k, e]) => ({ label: k, type: "class", info: `${e.signature}\n\n${e.doc}`, detail: "library", apply: k + "(" }));
  const props: Completion[] = [...new Set(["color", "material", "group", "at", "axis", "facing", "rotate", "spin", "mesh", "turns_with", "label", "axis_at", ...STRUCTURAL_PROPS, ...DRIVETRAIN_PROPS])].map((p) => ({ label: p + ":", type: "property" }));
  const materials: Completion[] = Object.keys(MATERIALS).map((m) => ({ label: `"${m}"`, type: "text", detail: "material" }));

  return (ctx: CompletionContext): CompletionResult | null => {
    const lib = ctx.matchBefore(/lib\.[A-Za-z_0-9]*/);
    if (lib) return { from: lib.from + 4, options: libItems, validFor: /^[A-Za-z_0-9]*$/ };
    const word = ctx.matchBefore(/[A-Za-z_][A-Za-z_0-9]*/);
    const line = ctx.state.doc.lineAt(ctx.pos).text;
    if (/material:\s*"?[A-Za-z ]*$/.test(line.slice(0, ctx.pos - ctx.state.doc.lineAt(ctx.pos).from))) {
      const m = ctx.matchBefore(/"?[A-Za-z0-9 ]*/);
      return { from: m ? m.from : ctx.pos, options: materials };
    }
    if (!word || (word.from === word.to && !ctx.explicit)) return null;
    const model = getModel();
    const defined: Completion[] = [];
    if (model) {
      for (const p of model.params) defined.push({ label: p.name, type: "variable", detail: `param = ${typeof p.value === "number" ? +p.value.toFixed(3) : String(p.value)}`, info: p.desc });
      for (const b of model.blocks) if (b.kind !== "param" && b.kind !== "require") defined.push({ label: b.name, type: b.kind === "let" ? "variable" : "class", detail: b.kind });
    }
    return { from: word.from, options: [...defined, ...fnCompletions, ...consts, ...kw, ...props, { label: "lib", type: "namespace" }], validFor: /^[A-Za-z_0-9]*$/ };
  };
}
