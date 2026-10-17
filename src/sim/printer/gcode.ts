// Reading G-code lines the way printer firmwares do: a command word (G1,
// M104, T0) with letter-number parameters, Klipper's extended commands
// (START_PRINT BED_TEMP=60), RepRapFirmware's quoted strings (C"out0"),
// comments after ; and in brackets, line numbers and checksums.

export interface GLine {
  /** upper-case command: "G1", "M104", "T0", "START_PRINT"; "" for a blank or comment-only line */
  cmd: string;
  /** letter parameters by upper-case letter, or Klipper's NAME=value parameters by upper-case name */
  params: Record<string, string>;
  /** the line as written, without its comment */
  text: string;
  /** the comment, without the ; */
  comment: string;
  /** an extended (Klipper style) command with NAME=value parameters */
  extended: boolean;
}

const EMPTY: GLine = { cmd: "", params: {}, text: "", comment: "", extended: false };

/** One line of G-code. Never throws: anything unreadable comes back as a command the firmware will not know. */
export function parseLine(raw: string): GLine {
  let line = raw;
  let comment = "";
  // strings in quotes may hold ; (RepRapFirmware), so find the comment outside them
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inStr = !inStr;
    else if (ch === ";" && !inStr) {
      comment = line.slice(i + 1).trim();
      line = line.slice(0, i);
      break;
    }
  }
  // (bracket comments) as Marlin and RepRapFirmware allow
  line = line.replace(/\([^)"]*\)/g, " ");
  // checksum and line number
  line = line.replace(/\*\d+\s*$/, "").trim();
  line = line.replace(/^N\d+\s+/i, "");
  if (!line) return comment ? { ...EMPTY, comment } : EMPTY;
  const head = /^([A-Za-z_][A-Za-z0-9_.]*)/.exec(line);
  if (!head) return { cmd: line.split(/\s+/)[0].toUpperCase(), params: {}, text: line, comment, extended: false };
  let word = head[1].toUpperCase();
  // a G or M word: the letter and its number ("G1", "G28", "M104", "G29.1"); "T0" is a tool change
  const gm = /^([GMT])(\d+(?:\.\d+)?)$/.exec(word);
  const rest = line.slice(head[1].length);
  if (gm) {
    word = `${gm[1]}${Number(gm[2])}`;
    return { cmd: word, params: letterParams(rest), text: line, comment, extended: false };
  }
  // G1X10 written without spaces
  const glued = /^([GM])(\d+)(.*)$/i.exec(line);
  if (glued && !/^[A-Z_]+=/.test(glued[3])) return { cmd: `${glued[1].toUpperCase()}${Number(glued[2])}`, params: letterParams(glued[3]), text: line, comment, extended: false };
  return { cmd: word, params: extendedParams(rest), text: line, comment, extended: true };
}

/** "X10 Y-2.5 E0.4 F3000" or RepRapFirmware's 'C"out0" H1' → { X: "10", ... }. */
function letterParams(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  // numbers may be written 7.06e-8 and lists 80:80:400, so an e inside a number is not a parameter
  const n = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
  const re = new RegExp(String.raw`([A-Za-z])\s*("(?:[^"]|"")*"|${n}(?::${n})*|[^\sA-Za-z"]*)`, "g");
  for (const m of s.matchAll(re)) {
    const k = m[1].toUpperCase();
    let v = m[2];
    if (v.startsWith('"')) v = v.slice(1, -1).replace(/""/g, '"');
    out[k] = v;
  }
  return out;
}

/** "BED_TEMP=60 EXTRUDER_TEMP=210" → { BED_TEMP: "60", ... }; values may be quoted. */
function extendedParams(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|\S+)/g;
  for (const m of s.matchAll(re)) {
    let v = m[2];
    if (/^["']/.test(v)) v = v.slice(1, -1);
    out[m[1].toUpperCase()] = v;
  }
  return out;
}

/** A numeric parameter, or undefined when absent or not a number. */
export function num(l: GLine, k: string): number | undefined {
  const v = l.params[k];
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** RepRapFirmware colon lists: "X600:600" or "80:80:400" → numbers. */
export function nums(v: string | undefined): number[] {
  if (v === undefined || v === "") return [];
  return v.split(":").map((s) => Number(s)).filter((n) => Number.isFinite(n));
}

/** The lines of a file, without carriage returns. */
export const lines = (text: string) => text.split(/\r?\n/);
