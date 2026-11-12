// CodeMirror support for scripts: JavaScript highlighting in the app's colours, and completion of the kerf API.

import { StreamLanguage, type StreamParser } from "@codemirror/language";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { SCRIPT_API } from "../../scripts/reference";

const KEYWORDS = new Set(
  "await async break case catch class const continue default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while yield".split(" "),
);
const ATOMS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);
const GLOBALS = new Set(["kerf", "console", "Math", "JSON", "Object", "Array", "Number", "String", "Date", "Promise", "Map", "Set"]);

interface State {
  comment: boolean;
  template: boolean;
}

function quoted(stream: Parameters<StreamParser<State>["token"]>[0], end: string): boolean {
  while (!stream.eol()) {
    const c = stream.next();
    if (c === "\\") stream.next();
    else if (c === end) return true;
  }
  return false;
}

const parser: StreamParser<State> = {
  name: "kerf-script",
  startState: () => ({ comment: false, template: false }),
  token(stream, state) {
    if (state.comment) {
      if (stream.skipTo("*/")) {
        stream.pos += 2;
        state.comment = false;
      } else stream.skipToEnd();
      return "comment";
    }
    if (state.template) {
      if (quoted(stream, "`")) state.template = false;
      return "string";
    }
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      state.comment = true;
      return "comment";
    }
    const ch = stream.peek();
    if (ch === '"' || ch === "'") {
      stream.next();
      quoted(stream, ch);
      return "string";
    }
    if (ch === "`") {
      stream.next();
      state.template = !quoted(stream, "`");
      return "string";
    }
    if (stream.match(/^(?:0x[\da-f]+|\d+(?:\.\d*)?(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)/i)) return "number";
    if (stream.match(/^[A-Za-z_$][\w$]*/)) {
      const w = stream.current();
      if (stream.string[stream.start - 1] === ".") return "propertyName";
      if (KEYWORDS.has(w)) return "keyword";
      if (ATOMS.has(w)) return "bool";
      if (GLOBALS.has(w)) return "namespace";
      return "variableName";
    }
    if (stream.match(/^[+\-*/%=<>!&|^~?:]+/)) return "operator";
    stream.next();
    return "punctuation";
  },
  languageData: { commentTokens: { line: "//", block: { open: "/*", close: "*/" } }, closeBrackets: { brackets: ["(", "[", "{", "'", '"', "`"] } },
};

export const scriptLanguage = StreamLanguage.define(parser);

/** kerf. offers the API's methods, with what each takes and does. */
export function scriptCompletions(ctx: CompletionContext): CompletionResult | null {
  const m = ctx.matchBefore(/\bkerf\.\w*$/);
  if (!m) return null;
  return {
    from: m.from + 5,
    options: SCRIPT_API.filter((a) => a.sig.startsWith("kerf.")).map((a) => ({ label: a.name, type: "function", detail: a.sig.slice(5 + a.name.length), info: a.doc })),
    validFor: /^\w*$/,
  };
}
