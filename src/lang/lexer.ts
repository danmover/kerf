// Tokenizer for the Kerf design language (.kerf).
// Produces a flat token list with source offsets so diagnostics and
// editor <-> geometry links can point at exact ranges.

export type TokenKind =
  | "num"
  | "str"
  | "color"
  | "ident"
  | "kw"
  | "op"
  | "eof";

export interface Token {
  kind: TokenKind;
  value: string;
  /** numeric value (already converted to base units) for num tokens */
  num?: number;
  /** unit suffix as written, for num tokens */
  unit?: string;
  start: number;
  end: number;
  line: number;
  col: number;
}

export const KEYWORDS = new Set([
  "design",
  "param",
  "let",
  "component",
  "interface",
  "part",
  "require",
  "for",
  "in",
  "if",
  "else",
  "body",
  "add",
  "cut",
  "intersect",
  "range",
  "locked",
  "hard",
  "soft",
  "true",
  "false",
  "note",
  "brief",
  "decision",
  "sketch",
  "analysis",
  "as",
  "cosmetic",
]);

/**
 * Unit suffix -> multiplier into base units: mm, degrees, g, N, N·mm, V, A,
 * W, mAh, Ohm, mH, MPa (N/mm²), s, Hz, °C.
 */
export const UNITS: Record<string, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  deg: 1,
  rad: 180 / Math.PI,
  "%": 0.01,
  g: 1,
  kg: 1000,
  rpm: 1,
  N: 1,
  Nm: 1000,
  // machines: torque, electrical, pressure, time, frequency
  kN: 1000,
  Ncm: 10,
  Nmm: 1,
  kgcm: 98.0665,
  V: 1,
  mV: 0.001,
  A: 1,
  mA: 0.001,
  W: 1,
  kW: 1000,
  Wh: 1,
  Ah: 1000,
  mAh: 1,
  Ohm: 1,
  kOhm: 1000,
  mOhm: 0.001,
  mH: 1,
  MPa: 1,
  kPa: 0.001,
  Pa: 0.000001,
  GPa: 1000,
  s: 1,
  ms: 0.001,
  min: 60,
  h: 3600,
  Hz: 1,
  kHz: 1000,
  degC: 1,
  // degrees Celsius, for the brief's service temperatures
  C: 1,
  // structural analysis: force in N, torque in N·mm, stress and pressure in MPa (N/mm²); time stays in seconds
  lbf: 4.448222,
  // weight of a kilogram, so 5kgf is 49 N (kg itself is a mass, in grams)
  kgf: 9.80665,
  bar: 0.1,
  psi: 0.00689476,
  hr: 3600,
  // wind and riding speeds, in mm/s
  kmh: 1e6 / 3600,
  mph: 447.04,
};

const OPS = [
  "->",
  "..",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "+",
  "-",
  "*",
  "/",
  "^",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  ",",
  ":",
  ".",
  "=",
  "<",
  ">",
  "!",
  "?",
  ";",
];

export class LexError extends Error {
  constructor(
    message: string,
    public start: number,
    public end: number,
  ) {
    super(message);
  }
}

export function lex(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const n = src.length;

  const push = (kind: TokenKind, value: string, start: number, extra: Partial<Token> = {}) => {
    tokens.push({ kind, value, start, end: i, line, col: start - lineStart + 1, ...extra });
  };

  while (i < n) {
    const c = src[i];
    if (c === "\n") {
      i++;
      line++;
      lineStart = i;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    // line comment
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    // block comment
    if (c === "/" && src[i + 1] === "*") {
      const s = i;
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") {
          line++;
          lineStart = i + 1;
        }
        i++;
      }
      if (i >= n) throw new LexError("Unterminated block comment", s, n);
      i += 2;
      continue;
    }
    const start = i;
    // number (with optional unit). A leading '.' digit is allowed ('.5')
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? "") && src[i - 1] !== ".")) {
      while (i < n && isDigit(src[i])) i++;
      if (src[i] === "." && src[i + 1] !== "." && isDigit(src[i + 1] ?? "")) {
        i++;
        while (i < n && isDigit(src[i])) i++;
      } else if (src[i] === "." && src[i + 1] !== "." && !isIdentStart(src[i + 1] ?? "")) {
        i++;
      }
      if ((src[i] === "e" || src[i] === "E") && (isDigit(src[i + 1] ?? "") || ((src[i + 1] === "-" || src[i + 1] === "+") && isDigit(src[i + 2] ?? "")))) {
        i += 2;
        while (i < n && isDigit(src[i])) i++;
      }
      const raw = src.slice(start, i);
      let value = parseFloat(raw);
      let unit: string | undefined;
      // unit suffix
      if (src[i] === "%") {
        unit = "%";
        i++;
      } else {
        let j = i;
        while (j < n && /[A-Za-z]/.test(src[j])) j++;
        const u = src.slice(i, j);
        if (u && UNITS[u] !== undefined && !isIdentChar(src[j] ?? "")) {
          unit = u;
          i = j;
        } else if (u) {
          let k = j;
          while (k < n && isIdentChar(src[k])) k++;
          throw new LexError(`Unknown unit "${src.slice(i, k)}" after ${raw}. Units are ${Object.keys(UNITS).join(", ")}; leave a space before a name.`, i, k);
        }
      }
      if (unit) value *= UNITS[unit];
      push("num", src.slice(start, i), start, { num: value, unit });
      continue;
    }
    if (c === '"') {
      i++;
      let out = "";
      while (i < n && src[i] !== '"') {
        if (src[i] === "\n") throw new LexError("Unterminated string", start, i);
        if (src[i] === "\\" && i + 1 < n) {
          const e = src[i + 1];
          out += e === "n" ? "\n" : e === "t" ? "\t" : e;
          i += 2;
          continue;
        }
        out += src[i++];
      }
      if (i >= n) throw new LexError("Unterminated string", start, n);
      i++;
      push("str", out, start);
      continue;
    }
    if (c === "#") {
      i++;
      while (i < n && /[0-9a-fA-F]/.test(src[i])) i++;
      const hex = src.slice(start + 1, i);
      if (hex.length !== 3 && hex.length !== 6) throw new LexError(`Invalid color "#${hex}" (use #RGB or #RRGGBB)`, start, i);
      push("color", "#" + hex.toLowerCase(), start);
      continue;
    }
    if (isIdentStart(c)) {
      while (i < n && isIdentChar(src[i])) i++;
      const word = src.slice(start, i);
      push(KEYWORDS.has(word) ? "kw" : "ident", word, start);
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      i += op.length;
      push("op", op, start);
      continue;
    }
    throw new LexError(`Unexpected character "${c}"`, i, i + 1);
  }
  tokens.push({ kind: "eof", value: "", start: n, end: n, line, col: n - lineStart + 1 });
  return tokens;
}

function isDigit(c: string) {
  return c >= "0" && c <= "9";
}
function isIdentStart(c: string) {
  return /[A-Za-z_]/.test(c);
}
function isIdentChar(c: string) {
  return /[A-Za-z0-9_]/.test(c);
}

/** 1-based line/column for an offset. */
export function lineCol(src: string, offset: number): { line: number; col: number } {
  let line = 1;
  let last = 0;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === "\n") {
      line++;
      last = i + 1;
    }
  }
  return { line, col: offset - last + 1 };
}
