// Turning what the firmware prints into signals. The same parser reads the
// real machine's USB serial port and the simulated twin's console, so an app
// built against the simulation shows the same numbers on the real machine.
//
// Every line also feeds three text signals: `state` (the firmware's latest
// "state: ..." line, the convention Kerf's generated firmware follows),
// `fault` (the latest line that starts with FAULT or ERROR) and `line` (the
// latest line of any kind).

import type { ColumnDef, TelemetryFormat } from "./spec";
import type { ExprValue } from "./expr";

export type LineValues = Record<string, ExprValue>;

const NUM = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const PAIR = /([A-Za-z_µ][\w.µ]*)\s*[=:]\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)(?![\w.])/g;
const SPACED = /(?:^|\s)([A-Za-z_µ][\w.µ]*)\s+([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)(?![\w.])/g;
const STATE = /^state:\s*(.+?)\s*$/i;
const FAULT = /^(?:fault|error)\b[:\s]*(.*)$/i;

/** "ms mode x:µm y:µm" → columns with units. */
export function parseColumns(text: string): ColumnDef[] {
  return text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((tok) => {
      const i = tok.indexOf(":");
      return i > 0 ? { name: tok.slice(0, i), unit: tok.slice(i + 1) || undefined } : { name: tok };
    });
}

const value = (s: string): ExprValue => (NUM.test(s.trim()) ? Number(s) : s.trim());

function flatten(o: unknown, prefix: string, out: LineValues, depth = 0) {
  if (depth > 4 || o === null || typeof o !== "object") return;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    const name = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "number" && Number.isFinite(v)) out[name] = v;
    else if (typeof v === "boolean") out[name] = v ? 1 : 0;
    else if (typeof v === "string") out[name] = v;
    else if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, name, out, depth + 1);
  }
}

function afterPrefix(line: string, prefix: string): string | null {
  if (!prefix) return line;
  if (!line.startsWith(prefix)) return null;
  const rest = line.slice(prefix.length);
  if (rest && !/^[\s,:;=]/.test(rest)) return null;
  return rest.replace(/^[\s,:;]+/, "");
}

/** A reader for one app's formats: a line in, the signals it gives out (null when it gives none). */
export function lineReader(formats: TelemetryFormat[]): (line: string) => LineValues | null {
  const fs: TelemetryFormat[] = formats.length ? formats : [{ kind: "keys", prefix: "" }];
  return (raw) => {
    const line = raw.replace(/\r$/, "");
    const out: LineValues = {};
    let any = false;
    const st = STATE.exec(line);
    if (st) {
      out.state = st[1];
      any = true;
    }
    const ft = FAULT.exec(line);
    if (ft) {
      out.fault = (ft[1] || line).trim();
      any = true;
    }
    if (!st) {
      for (const f of fs) {
        if (f.kind === "csv") {
          const parts = line.split(f.sep === " " ? /\s+/ : f.sep).map((s) => s.trim());
          let vals: string[];
          if (f.prefix) {
            if (parts[0] !== f.prefix) continue;
            vals = parts.slice(1);
          } else {
            if (parts.length !== f.columns.length || !parts.every((s) => NUM.test(s))) continue;
            vals = parts;
          }
          const n = Math.min(vals.length, f.columns.length);
          for (let i = 0; i < n; i++) out[f.columns[i].name] = value(vals[i]);
          any = any || n > 0;
          break;
        }
        const rest = afterPrefix(line, f.prefix);
        if (rest === null) continue;
        if (f.kind === "json") {
          const s = rest.trim();
          if (!s.startsWith("{")) continue;
          try {
            const before = Object.keys(out).length;
            flatten(JSON.parse(s), "", out);
            if (Object.keys(out).length > before) {
              any = true;
              break;
            }
          } catch {
            // not JSON after all: try the next format
          }
          continue;
        }
        let found = false;
        const re = f.spaced ? SPACED : PAIR;
        re.lastIndex = 0;
        for (let m = re.exec(rest); m; m = re.exec(rest)) {
          out[m[1]] = Number(m[2]);
          found = true;
        }
        // "state waiting  dist 0 mm": the first word after the prefix is a state too
        if (f.spaced && f.prefix === "state" && found) {
          const w = /^([A-Za-z_][\w-]*)/.exec(rest);
          if (w && !(w[1] in out)) out.state = w[1];
        }
        if (found) {
          any = true;
          break;
        }
      }
    }
    out.line = line;
    return any ? out : { line };
  };
}

/** The column names every csv format gives, with their units. */
export function telemetryColumns(formats: TelemetryFormat[]): ColumnDef[] {
  const out: ColumnDef[] = [];
  for (const f of formats) if (f.kind === "csv") for (const c of f.columns) if (!out.some((o) => o.name === c.name)) out.push(c);
  return out;
}

/** Text signals every app has, whatever its telemetry. */
export const TEXT_SIGNALS = ["state", "fault", "line"];
