// C preprocessor for the virtual microcontroller: #include from the firmware's
// own files and the simulator's built-in headers, object- and function-like
// macros (with # and ##), and #if/#ifdef/#elif/#else/#endif with defined().
// Unknown system headers are an error rather than silently ignored, so a
// sketch that needs a library the simulator lacks says so.

import { CError, lex, type Tok } from "./lex";

interface Macro {
  name: string;
  params?: string[];
  variadic?: boolean;
  body: Tok[];
}

export interface PreOptions {
  /** the firmware's files by name (brain.ino, pins.h, config.h) */
  files: Record<string, string>;
  /** built-in headers by name (Arduino.h, Wire.h, ...) */
  system: Record<string, string>;
  /** predefined macros: name -> replacement text */
  defines: Record<string, string>;
}

const MAX_INCLUDE_DEPTH = 20;
const MAX_EXPANSION = 2_000_000;

export function preprocess(main: string, opts: PreOptions): Tok[] {
  const macros = new Map<string, Macro>();
  for (const [name, text] of Object.entries(opts.defines)) macros.set(name, { name, body: lex(text, "<predefined>").filter((t) => t.k !== "eof") });
  const once = new Set<string>();
  const out: Tok[] = [];
  let expansions = 0;

  const readFile = (name: string, system: boolean, from: Tok | null): { text: string; file: string } => {
    if (!system && name in opts.files) return { text: opts.files[name], file: name };
    const base = name.split("/").pop()!;
    if (!system && base in opts.files) return { text: opts.files[base], file: base };
    if (name in opts.system) return { text: opts.system[name], file: `<${name}>` };
    if (!system && name in opts.system) return { text: opts.system[name], file: `<${name}>` };
    throw new CError(`The simulator has no ${system ? "library header" : "file"} "${name}". It runs the Arduino core with Wire, EEPROM and Servo.`, from?.file ?? name, from?.line ?? 0);
  };

  // ---------- macro expansion ----------

  const expand = (toks: Tok[], disabled: Set<string>): Tok[] => {
    const res: Tok[] = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (++expansions > MAX_EXPANSION) throw new CError("Macro expansion does not end", t.file, t.line);
      if (t.k !== "id" || disabled.has(t.v)) {
        res.push(t);
        continue;
      }
      const m = macros.get(t.v);
      if (!m) {
        res.push(t);
        continue;
      }
      if (!m.params) {
        const inner = new Set(disabled).add(m.name);
        for (const x of expand(m.body.map((b) => ({ ...b, file: t.file, line: t.line })), inner)) res.push(x);
        continue;
      }
      // function-like: only when followed by (
      if (toks[i + 1]?.v !== "(" || toks[i + 1]?.k !== "punc") {
        res.push(t);
        continue;
      }
      let depth = 0;
      let j = i + 1;
      const args: Tok[][] = [[]];
      for (; j < toks.length; j++) {
        const a = toks[j];
        if (a.k === "punc" && (a.v === "(" || a.v === "[" || a.v === "{")) {
          if (depth++ === 0 && a.v === "(") continue;
        } else if (a.k === "punc" && (a.v === ")" || a.v === "]" || a.v === "}")) {
          if (--depth === 0) break;
        } else if (a.k === "punc" && a.v === "," && depth === 1 && !(m.variadic && args.length > m.params.length)) {
          args.push([]);
          continue;
        }
        args[args.length - 1].push(a);
      }
      if (j >= toks.length) throw new CError(`Unclosed call of macro ${m.name}`, t.file, t.line);
      if (m.params.length === 0 && args.length === 1 && args[0].length === 0) args.length = 0;
      const need = m.params.length;
      if (args.length < need || (!m.variadic && args.length > need)) {
        if (!(need === 1 && args.length === 0)) throw new CError(`Macro ${m.name} takes ${need} argument${need === 1 ? "" : "s"}, given ${args.length}`, t.file, t.line);
        args.push([]);
      }
      const named = new Map<string, Tok[]>();
      m.params.forEach((p, k) => named.set(p, args[k] ?? []));
      if (m.variadic) {
        const rest: Tok[] = [];
        args.slice(need).forEach((a, k) => {
          if (k) rest.push({ k: "punc", v: ",", file: t.file, line: t.line });
          rest.push(...a);
        });
        named.set("__VA_ARGS__", rest);
      }
      const expanded = new Map<string, Tok[]>();
      const full = (p: string) => {
        if (!expanded.has(p)) expanded.set(p, expand(named.get(p)!, disabled));
        return expanded.get(p)!;
      };
      const body: Tok[] = [];
      const mb = m.body;
      for (let k = 0; k < mb.length; k++) {
        const b = mb[k];
        if (b.k === "punc" && b.v === "#" && mb[k + 1]?.k === "id" && named.has(mb[k + 1].v)) {
          const text = named
            .get(mb[k + 1].v)!
            .map((x) => x.v)
            .join(" ");
          body.push({ k: "str", v: JSON.stringify(text), bytes: [...text].map((c) => c.charCodeAt(0) & 255), file: t.file, line: t.line });
          k++;
          continue;
        }
        const pasteNext = mb[k + 1]?.k === "punc" && mb[k + 1].v === "##";
        const pastePrev = mb[k - 1]?.k === "punc" && mb[k - 1].v === "##";
        if (b.k === "punc" && b.v === "##") continue;
        if (b.k === "id" && named.has(b.v)) {
          const val = pasteNext || pastePrev ? named.get(b.v)! : full(b.v);
          for (const x of val) body.push({ ...x, file: t.file, line: t.line });
        } else body.push({ ...b, file: t.file, line: t.line });
        if (pastePrev && body.length >= 2) {
          // join the last token of the left side with the first of the right
          const right = body.pop()!;
          const left = body.pop()!;
          const joined = lex(left.v + right.v, t.file).filter((x) => x.k !== "eof");
          if (joined.length !== 1) throw new CError(`## made "${left.v + right.v}", which is not one token`, t.file, t.line);
          body.push({ ...joined[0], line: t.line });
        }
      }
      const inner = new Set(disabled).add(m.name);
      // rescan the result with this macro disabled
      for (const x of expand(body, inner)) res.push(x);
      i = j;
    }
    return res;
  };

  // ---------- #if expressions ----------

  const evalCond = (line: Tok[], at: Tok): boolean => {
    // replace defined(X) / defined X before expansion
    const pre: Tok[] = [];
    for (let i = 0; i < line.length; i++) {
      const t = line[i];
      if (t.k === "id" && t.v === "defined") {
        let name: Tok | undefined;
        if (line[i + 1]?.v === "(") {
          name = line[i + 2];
          if (line[i + 3]?.v !== ")") throw new CError("defined( needs a closing )", t.file, t.line);
          i += 3;
        } else {
          name = line[i + 1];
          i += 1;
        }
        if (!name || name.k !== "id") throw new CError("defined needs a macro name", t.file, t.line);
        pre.push({ k: "num", v: macros.has(name.v) ? "1" : "0", n: macros.has(name.v) ? 1 : 0, file: t.file, line: t.line });
      } else pre.push(t);
    }
    const toks = expand(pre, new Set()).map((t) => (t.k === "id" ? { ...t, k: "num" as const, n: t.v === "true" ? 1 : 0, v: "0" } : t));
    let p = 0;
    const peek = () => toks[p];
    const eat = (v: string) => {
      if (toks[p]?.v === v && toks[p].k === "punc") {
        p++;
        return true;
      }
      return false;
    };
    const fail = (msg: string): never => {
      throw new CError(`#if: ${msg}`, at.file, at.line);
    };
    const prim = (): number => {
      const t = toks[p++];
      if (!t) fail("expression ends early");
      if (t.k === "num" || t.k === "chr") return Math.trunc(t.n ?? 0);
      if (t.k === "punc" && t.v === "(") {
        const v = ternary();
        if (!eat(")")) fail("missing )");
        return v;
      }
      if (t.k === "punc" && t.v === "!") return prim() ? 0 : 1;
      if (t.k === "punc" && t.v === "-") return -prim();
      if (t.k === "punc" && t.v === "+") return prim();
      if (t.k === "punc" && t.v === "~") return ~prim();
      return fail(`unexpected "${t.v}"`);
    };
    const levels: string[][] = [["*", "/", "%"], ["+", "-"], ["<<", ">>"], ["<", ">", "<=", ">="], ["==", "!="], ["&"], ["^"], ["|"], ["&&"], ["||"]];
    const apply = (op: string, a: number, b: number): number => {
      switch (op) {
        case "*":
          return a * b;
        case "/":
          return b ? Math.trunc(a / b) : fail("division by zero");
        case "%":
          return b ? a % b : fail("division by zero");
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "<<":
          return a * 2 ** b;
        case ">>":
          return Math.floor(a / 2 ** b);
        case "<":
          return +(a < b);
        case ">":
          return +(a > b);
        case "<=":
          return +(a <= b);
        case ">=":
          return +(a >= b);
        case "==":
          return +(a === b);
        case "!=":
          return +(a !== b);
        case "&":
          return a & b;
        case "^":
          return a ^ b;
        case "|":
          return a | b;
        case "&&":
          return +(!!a && !!b);
        case "||":
          return +(!!a || !!b);
      }
      return fail(`bad operator ${op}`);
    };
    const bin = (lvl: number): number => {
      if (lvl < 0) return prim();
      let a = bin(lvl - 1);
      for (;;) {
        const t = peek();
        if (t?.k === "punc" && levels[lvl].includes(t.v)) {
          p++;
          a = apply(t.v, a, bin(lvl - 1));
        } else return a;
      }
    };
    const ternary = (): number => {
      const c = bin(levels.length - 1);
      if (eat("?")) {
        const a = ternary();
        if (!eat(":")) fail("missing : in ?:");
        const b = ternary();
        return c ? a : b;
      }
      return c;
    };
    const v = ternary();
    if (p < toks.length) fail(`unexpected "${toks[p].v}"`);
    return v !== 0;
  };

  // ---------- directives ----------

  const run = (text: string, file: string, depth: number) => {
    if (depth > MAX_INCLUDE_DEPTH) throw new CError("#include nests too deep", file, 0);
    const toks = lex(text, file);
    // conditional stack: [active, anyTaken, parentActive]
    const cond: [boolean, boolean, boolean][] = [];
    const active = () => cond.every((c) => c[0]);
    let i = 0;
    let pending: Tok[] = [];
    const flush = () => {
      if (pending.length) for (const t of expand(pending, new Set())) out.push(t);
      pending = [];
    };
    while (i < toks.length && toks[i].k !== "eof") {
      const t = toks[i];
      if (t.k === "punc" && t.v === "#" && t.bol) {
        // collect the directive line
        const line: Tok[] = [];
        let j = i + 1;
        while (toks[j].k !== "eof" && !toks[j].bol) line.push(toks[j++]);
        i = j;
        const d = line[0];
        if (!d) continue; // null directive
        const rest = line.slice(1);
        const on = active();
        switch (d.v) {
          case "if":
            cond.push(on ? (evalCond(rest, d) ? [true, true, true] : [false, false, true]) : [false, true, false]);
            continue;
          case "ifdef":
          case "ifndef": {
            const has = macros.has(rest[0]?.v ?? "");
            const yes = d.v === "ifdef" ? has : !has;
            cond.push(on ? [yes, yes, true] : [false, true, false]);
            continue;
          }
          case "elif": {
            const c = cond[cond.length - 1];
            if (!c) throw new CError("#elif without #if", d.file, d.line);
            if (!c[2] || c[1]) c[0] = false;
            else if (evalCond(rest, d)) {
              c[0] = true;
              c[1] = true;
            } else c[0] = false;
            continue;
          }
          case "else": {
            const c = cond[cond.length - 1];
            if (!c) throw new CError("#else without #if", d.file, d.line);
            c[0] = c[2] && !c[1];
            c[1] = true;
            continue;
          }
          case "endif":
            if (!cond.pop()) throw new CError("#endif without #if", d.file, d.line);
            continue;
        }
        if (!on) continue;
        flush();
        switch (d.v) {
          case "include": {
            let name: string;
            let system = false;
            if (rest[0]?.k === "str") name = String.fromCharCode(...(rest[0].bytes ?? []));
            else if (rest[0]?.v === "<") {
              system = true;
              name = rest
                .slice(1, rest.findIndex((x) => x.v === ">"))
                .map((x) => x.v)
                .join("");
            } else throw new CError("#include needs \"file\" or <file>", d.file, d.line);
            const f = readFile(name, system, d);
            if (!once.has(f.file)) run(f.text, f.file, depth + 1);
            break;
          }
          case "define": {
            const nameTok = rest[0];
            if (!nameTok || nameTok.k !== "id") throw new CError("#define needs a name", d.file, d.line);
            let body = rest.slice(1);
            let params: string[] | undefined;
            let variadic = false;
            if (body[0]?.v === "(" && !body[0].ws) {
              params = [];
              let k = 1;
              for (; k < body.length && body[k].v !== ")"; k++) {
                if (body[k].v === ",") continue;
                if (body[k].v === "...") {
                  variadic = true;
                  continue;
                }
                if (body[k].k !== "id") throw new CError(`Bad macro parameter "${body[k].v}"`, d.file, d.line);
                params.push(body[k].v);
              }
              body = body.slice(k + 1);
            }
            macros.set(nameTok.v, { name: nameTok.v, params, variadic, body: body.map((b) => ({ ...b, bol: false })) });
            break;
          }
          case "undef":
            macros.delete(rest[0]?.v ?? "");
            break;
          case "pragma":
            if (rest[0]?.v === "once") once.add(file);
            break;
          case "error":
            throw new CError(`#error ${rest.map((x) => x.v).join(" ")}`, d.file, d.line);
          case "warning":
          case "line":
            break;
          default:
            throw new CError(`Unknown directive #${d.v}`, d.file, d.line);
        }
        continue;
      }
      if (active()) pending.push(t);
      i++;
    }
    if (cond.length) throw new CError("#if without #endif", file, toks[toks.length - 1].line);
    flush();
  };

  run(main, Object.keys(opts.files).find((k) => opts.files[k] === main) ?? "main.ino", 0);
  // adjacent string literals join
  const res: Tok[] = [];
  for (const t of out) {
    const prev = res[res.length - 1];
    if (t.k === "str" && prev?.k === "str") res[res.length - 1] = { ...prev, bytes: [...(prev.bytes ?? []), ...(t.bytes ?? [])], v: prev.v.slice(0, -1) + t.v.slice(1) };
    else res.push(t);
  }
  res.push({ k: "eof", v: "", file: "", line: 0 });
  return res;
}
