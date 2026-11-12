// Source edits for a part's process: set, change or clear its process:
// property. Like every other change, these are edits to the design text.

import type { EvalPart } from "../core/model";
import { PROCESSES, specToSource } from "./profiles";
import type { ProcessSpec, SettingValue } from "./types";

/** Replace the part's process: property, insert one, or remove it (spec null). A placed design's part is changed in that design, so its source is left as it is. */
export function setPartProcess(src: string, part: Pick<EvalPart, "span" | "processSpan" | "insert">, spec: ProcessSpec | null | false): string {
  if (part.insert) return src;
  const text = spec ? `process: ${specToSource(spec)}` : spec === false ? "process: false" : "";
  const ps = part.processSpan;
  if (ps) {
    if (text) return src.slice(0, ps.start) + text + src.slice(ps.end);
    // drop the whole line when the property stands alone on it
    const lineStart = src.lastIndexOf("\n", ps.start - 1) + 1;
    const lineEnd = src.indexOf("\n", ps.end);
    const before = src.slice(lineStart, ps.start);
    const after = src.slice(ps.end, lineEnd < 0 ? src.length : lineEnd);
    if (!before.trim() && !after.trim()) return src.slice(0, lineStart) + src.slice(lineEnd < 0 ? src.length : lineEnd + 1);
    return src.slice(0, ps.start) + src.slice(ps.end).replace(/^[ \t]*/, "");
  }
  if (!text) return src;
  const open = src.indexOf("{", part.span.start);
  if (open < 0 || open > part.span.end) return src;
  // match the indentation of the first line inside the block
  const nextLine = src.slice(open + 1).match(/^[^\n]*\n([ \t]*)\S/);
  const sameLine = /^[ \t]*\S/.test(src.slice(open + 1, src.indexOf("\n", open + 1) >>> 0));
  if (sameLine) return src.slice(0, open + 1) + ` ${text}` + src.slice(open + 1);
  const indent = nextLine ? nextLine[1] : "  ";
  return src.slice(0, open + 1) + `\n${indent}${text}` + src.slice(open + 1);
}

/** The same process with one setting changed (or reset to its default with null). */
export function withSetting(spec: ProcessSpec, key: string, value: SettingValue | null): ProcessSpec {
  const settings = { ...spec.settings };
  const def = PROCESSES[spec.id].settings.find((s) => s.key === key);
  if (value === null || (def && def.def !== null && JSON.stringify(def.def) === JSON.stringify(value))) delete settings[key];
  else settings[key] = value;
  return { ...spec, settings };
}
