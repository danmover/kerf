// C/C++ tokenizer for the virtual microcontroller. It reads the firmware Kerf
// generates (and hand edits to it) exactly as a compiler would see it after
// the preprocessor: identifiers, numbers with their C type suffixes, chars,
// strings and punctuators. Positions are kept so errors point at a line.

export type TokKind = "id" | "num" | "str" | "chr" | "punc" | "eof";

export interface Tok {
  k: TokKind;
  v: string;
  file: string;
  line: number;
  /** first token on its source line (preprocessor directives) */
  bol?: boolean;
  /** whitespace before it (function-like macro detection) */
  ws?: boolean;
  /** numbers: value; chars: code */
  n?: number;
  /** numbers: float literal */
  float?: boolean;
  /** numbers: suffix flags */
  unsigned?: boolean;
  long?: number;
  /** number written in hex, octal or binary (C picks its type differently) */
  radix?: number;
  /** strings: bytes without the terminating zero */
  bytes?: number[];
}

export class CError extends Error {
  constructor(
    message: string,
    public file: string,
    public line: number,
  ) {
    super(`${file}:${line}: ${message}`);
  }
}

const PUNCS = [
  "<<=",
  ">>=",
  "...",
  "->",
  "++",
  "--",
  "<<",
  ">>",
  "<=",
  ">=",
  "==",
  "!=",
  "&&",
  "||",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "::",
  "##",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "=",
  "!",
  "~",
  "&",
  "|",
  "^",
  "?",
  ":",
  ";",
  ",",
  ".",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "#",
];

const isIdStart = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isId = (c: string) => isIdStart(c) || (c >= "0" && c <= "9");
const isDigit = (c: string) => c >= "0" && c <= "9";

function escape(src: string, i: number, file: string, line: number): [number, number] {
  // src[i] is the character after the backslash
  const c = src[i];
  switch (c) {
    case "n":
      return [10, i + 1];
    case "t":
      return [9, i + 1];
    case "r":
      return [13, i + 1];
    case "0":
    case "1":
    case "2":
    case "3":
    case "4":
    case "5":
    case "6":
    case "7": {
      let j = i;
      let v = 0;
      while (j < i + 3 && src[j] >= "0" && src[j] <= "7") v = v * 8 + (src.charCodeAt(j++) - 48);
      return [v & 255, j];
    }
    case "x": {
      let j = i + 1;
      let v = 0;
      while (/[0-9a-fA-F]/.test(src[j] ?? "")) v = v * 16 + parseInt(src[j++], 16);
      if (j === i + 1) throw new CError("\\x needs hex digits", file, line);
      return [v & 255, j];
    }
    case "a":
      return [7, i + 1];
    case "b":
      return [8, i + 1];
    case "f":
      return [12, i + 1];
    case "v":
      return [11, i + 1];
    case "\\":
    case "'":
    case '"':
    case "?":
      return [c.charCodeAt(0), i + 1];
    default:
      throw new CError(`Unknown escape \\${c}`, file, line);
  }
}

/** UTF-8 bytes of a source character (string literals are byte arrays on the chip). */
function utf8(cp: number): number[] {
  if (cp < 0x80) return [cp];
  if (cp < 0x800) return [0xc0 | (cp >> 6), 0x80 | (cp & 63)];
  if (cp < 0x10000) return [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
  return [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
}

export function lex(src: string, file: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  let bol = true;
  let ws = false;
  const n = src.length;
  const push = (t: Tok) => {
    if (bol) t.bol = true;
    if (ws) t.ws = true;
    bol = false;
    ws = false;
    out.push(t);
  };
  while (i < n) {
    const c = src[i];
    if (c === "\n") {
      line++;
      i++;
      bol = true;
      ws = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v") {
      i++;
      ws = true;
      continue;
    }
    if (c === "\\" && (src[i + 1] === "\n" || (src[i + 1] === "\r" && src[i + 2] === "\n"))) {
      // line continuation: the logical line goes on
      i += src[i + 1] === "\r" ? 3 : 2;
      line++;
      ws = true;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") {
        if (src[i] === "\\" && src[i + 1] === "\n") {
          i += 2;
          line++;
          continue;
        }
        i++;
      }
      ws = true;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) throw new CError("Unclosed /* comment", file, line);
      for (let j = i; j < end; j++) if (src[j] === "\n") line++;
      i = end + 2;
      ws = true;
      continue;
    }
    const start = line;
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isId(src[j])) j++;
      push({ k: "id", v: src.slice(i, j), file, line: start });
      i = j;
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      let j = i;
      let float = false;
      let radix = 10;
      let v: number;
      if (c === "0" && (src[i + 1] === "x" || src[i + 1] === "X")) {
        j = i + 2;
        while (/[0-9a-fA-F']/.test(src[j] ?? "")) j++;
        v = parseInt(src.slice(i + 2, j).replace(/'/g, ""), 16);
        radix = 16;
      } else if (c === "0" && (src[i + 1] === "b" || src[i + 1] === "B")) {
        j = i + 2;
        while (/[01']/.test(src[j] ?? "")) j++;
        v = parseInt(src.slice(i + 2, j).replace(/'/g, ""), 2);
        radix = 2;
      } else {
        while (isDigit(src[j] ?? "") || src[j] === "'") j++;
        if (src[j] === ".") {
          float = true;
          j++;
          while (isDigit(src[j] ?? "")) j++;
        }
        if ((src[j] === "e" || src[j] === "E") && /[0-9+-]/.test(src[j + 1] ?? "")) {
          float = true;
          j += 2;
          while (isDigit(src[j] ?? "")) j++;
        }
        const text = src.slice(i, j).replace(/'/g, "");
        if (!float && text.length > 1 && text[0] === "0") {
          radix = 8;
          v = parseInt(text, 8);
        } else v = float ? parseFloat(text) : parseInt(text, 10);
      }
      let unsigned = false;
      let long = 0;
      let isF = false;
      while (j < n && /[uUlLfF]/.test(src[j])) {
        const s = src[j].toLowerCase();
        if (s === "u") unsigned = true;
        else if (s === "l") long++;
        else if (s === "f") {
          if (!float && radix === 16) break;
          isF = true;
          float = true;
        }
        j++;
      }
      if (isId(src[j] ?? "")) throw new CError(`Bad number "${src.slice(i, j + 1)}"`, file, start);
      push({ k: "num", v: src.slice(i, j), file, line: start, n: v, float: float || isF, unsigned, long, radix });
      i = j;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let code: number;
      if (src[j] === "\\") [code, j] = escape(src, j + 1, file, start);
      else {
        code = src.codePointAt(j)!;
        j += code > 0xffff ? 2 : 1;
        if (code > 255) throw new CError("Character literal outside one byte", file, start);
      }
      if (src[j] !== "'") throw new CError("Unclosed character literal", file, start);
      push({ k: "chr", v: src.slice(i, j + 1), file, line: start, n: code });
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      const bytes: number[] = [];
      while (j < n && src[j] !== '"') {
        if (src[j] === "\n") throw new CError("Unclosed string", file, start);
        if (src[j] === "\\") {
          let code: number;
          [code, j] = escape(src, j + 1, file, start);
          bytes.push(code);
        } else {
          const cp = src.codePointAt(j)!;
          bytes.push(...utf8(cp));
          j += cp > 0xffff ? 2 : 1;
        }
      }
      if (src[j] !== '"') throw new CError("Unclosed string", file, start);
      push({ k: "str", v: src.slice(i, j + 1), file, line: start, bytes });
      i = j + 1;
      continue;
    }
    const p = PUNCS.find((x) => src.startsWith(x, i));
    if (!p) throw new CError(`Unexpected character "${c}"`, file, start);
    push({ k: "punc", v: p, file, line: start });
    i += p.length;
  }
  out.push({ k: "eof", v: "", file, line, bol: true });
  return out;
}
