// The small expression language an app's panels read signals through:
// "drag / 100", "hypot(x, y)", "mode == 2 && z > -500", "avg(drag, 2)",
// "contains(state, 'fault')". Compiled once to closures; nothing is ever
// passed to eval, so a design file from anyone is safe to open.
//
// Names may hold dots (tunnel.drag, fw.dragMn). A name nobody has sent yet
// reads as NaN, so a panel shows a dash rather than a wrong number, and any
// comparison with it is false.

export type ExprValue = number | string;

export interface ExprEnv {
  /** the latest value of a signal; undefined when it has not arrived */
  get(name: string): ExprValue | undefined;
  /** samples of a signal over the last `seconds`, oldest first */
  window(name: string, seconds: number): { t: ArrayLike<number>; v: ArrayLike<number>; n: number };
}

export interface Compiled {
  run(env: ExprEnv): ExprValue;
  /** every signal name it reads */
  names: string[];
  /** the history it needs, s, for each name read through avg(), rms() and the like */
  windows: Record<string, number>;
  source: string;
}

export class ExprError extends Error {
  constructor(
    message: string,
    public at: number,
  ) {
    super(message);
  }
}

type Tok = { k: "num"; v: number; at: number } | { k: "str"; v: string; at: number } | { k: "name"; v: string; at: number } | { k: "op"; v: string; at: number } | { k: "end"; at: number };

const OPS = ["<=", ">=", "==", "!=", "&&", "||", "+", "-", "*", "/", "%", "^", "<", ">", "!", "(", ")", ",", "?", ":"];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ k: "num", v: Number(m[0]), at: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_µ°]/.test(c)) {
      const m = /^[A-Za-z_µ°][A-Za-z0-9_µ°]*(?:\.[A-Za-z0-9_µ°]+)*/.exec(src.slice(i))!;
      out.push({ k: "name", v: m[0], at: i });
      i += m[0].length;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new ExprError("text that starts with a quote needs a closing quote", i);
      out.push({ k: "str", v: src.slice(i + 1, end), at: i });
      i = end + 1;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`"${c}" cannot be used here`, i);
    out.push({ k: "op", v: op, at: i });
    i += op.length;
  }
  out.push({ k: "end", at: src.length });
  return out;
}

type Fn0 = (env: ExprEnv) => ExprValue;

const num = (v: ExprValue): number => (typeof v === "number" ? v : v === "" ? NaN : Number.isFinite(Number(v)) ? Number(v) : NaN);
const truthy = (v: ExprValue) => (typeof v === "number" ? v !== 0 && !Number.isNaN(v) : v !== "");

const MATH: Record<string, { n: [number, number]; f: (...a: number[]) => number }> = {
  abs: { n: [1, 1], f: Math.abs },
  sqrt: { n: [1, 1], f: Math.sqrt },
  min: { n: [1, 9], f: Math.min },
  max: { n: [1, 9], f: Math.max },
  hypot: { n: [1, 9], f: Math.hypot },
  atan2: { n: [2, 2], f: Math.atan2 },
  sin: { n: [1, 1], f: Math.sin },
  cos: { n: [1, 1], f: Math.cos },
  tan: { n: [1, 1], f: Math.tan },
  asin: { n: [1, 1], f: Math.asin },
  acos: { n: [1, 1], f: Math.acos },
  atan: { n: [1, 1], f: Math.atan },
  exp: { n: [1, 1], f: Math.exp },
  log: { n: [1, 1], f: Math.log },
  log10: { n: [1, 1], f: Math.log10 },
  round: { n: [1, 2], f: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d },
  floor: { n: [1, 1], f: Math.floor },
  ceil: { n: [1, 1], f: Math.ceil },
  sign: { n: [1, 1], f: Math.sign },
  pow: { n: [2, 2], f: Math.pow },
  clamp: { n: [3, 3], f: (x, lo, hi) => Math.min(hi, Math.max(lo, x)) },
  deg: { n: [1, 1], f: (r) => (r * 180) / Math.PI },
  rad: { n: [1, 1], f: (d) => (d * Math.PI) / 180 },
  isnan: { n: [1, 1], f: (x) => (Number.isNaN(x) ? 1 : 0) },
};

/** Functions over a signal's recent history: the first argument is a signal's name, the second seconds. */
const WINDOWED: Record<string, { def: number; f: (t: ArrayLike<number>, v: ArrayLike<number>, n: number) => number }> = {
  avg: { def: 1, f: (_t, v, n) => (n ? sum(v, n) / n : NaN) },
  rms: {
    def: 1,
    f: (_t, v, n) => {
      if (!n) return NaN;
      let s = 0;
      for (let i = 0; i < n; i++) s += v[i] * v[i];
      return Math.sqrt(s / n);
    },
  },
  /** how far it wanders about its own average: the standard deviation */
  wander: {
    def: 1,
    f: (_t, v, n) => {
      if (n < 2) return NaN;
      const m = sum(v, n) / n;
      let s = 0;
      for (let i = 0; i < n; i++) s += (v[i] - m) ** 2;
      return Math.sqrt(s / n);
    },
  },
  lowest: { def: 10, f: (_t, v, n) => (n ? extreme(v, n, -1) : NaN) },
  highest: { def: 10, f: (_t, v, n) => (n ? extreme(v, n, 1) : NaN) },
  spread: { def: 10, f: (_t, v, n) => (n ? extreme(v, n, 1) - extreme(v, n, -1) : NaN) },
  /** change per second, from the first and last samples in the window */
  rate: { def: 0.5, f: (t, v, n) => (n >= 2 && t[n - 1] > t[0] ? (v[n - 1] - v[0]) / (t[n - 1] - t[0]) : NaN) },
};

function sum(v: ArrayLike<number>, n: number) {
  let s = 0;
  for (let i = 0; i < n; i++) s += v[i];
  return s;
}
function extreme(v: ArrayLike<number>, n: number, dir: 1 | -1) {
  let best = v[0];
  for (let i = 1; i < n; i++) if ((v[i] - best) * dir > 0) best = v[i];
  return best;
}

export const EXPR_FUNCTIONS = [...Object.keys(MATH), ...Object.keys(WINDOWED), "contains", "starts"];

/** Compile an expression. Throws ExprError with the position of the mistake. */
export function compile(source: string): Compiled {
  const toks = lex(source);
  let p = 0;
  const names = new Set<string>();
  const windows: Record<string, number> = {};
  const peek = () => toks[p];
  const isOp = (v: string) => {
    const t = toks[p];
    return t.k === "op" && t.v === v;
  };
  const eat = (v: string) => {
    if (isOp(v)) {
      p++;
      return true;
    }
    return false;
  };
  const want = (v: string, what: string) => {
    if (!eat(v)) throw new ExprError(`expected ${what}`, peek().at);
  };

  const expr = (): Fn0 => {
    const c = or();
    if (eat("?")) {
      const a = expr();
      want(":", '":" and the value when it is false');
      const b = expr();
      return (e) => (truthy(c(e)) ? a(e) : b(e));
    }
    return c;
  };
  const or = (): Fn0 => {
    let l = and();
    while (eat("||")) {
      const a = l;
      const b = and();
      l = (e) => (truthy(a(e)) || truthy(b(e)) ? 1 : 0);
    }
    return l;
  };
  const and = (): Fn0 => {
    let l = cmp();
    while (eat("&&")) {
      const a = l;
      const b = cmp();
      l = (e) => (truthy(a(e)) && truthy(b(e)) ? 1 : 0);
    }
    return l;
  };
  const cmp = (): Fn0 => {
    const l = add();
    const t = peek();
    if (t.k === "op" && ["<", "<=", ">", ">=", "==", "!="].includes(t.v)) {
      p++;
      const r = add();
      const op = t.v;
      return (e) => {
        const a = l(e);
        const b = r(e);
        if (typeof a === "string" || typeof b === "string") {
          const sa = String(a);
          const sb = String(b);
          if (op === "==") return sa === sb ? 1 : 0;
          if (op === "!=") return sa !== sb ? 1 : 0;
        }
        const x = num(a);
        const y = num(b);
        if (Number.isNaN(x) || Number.isNaN(y)) return 0;
        switch (op) {
          case "<":
            return x < y ? 1 : 0;
          case "<=":
            return x <= y ? 1 : 0;
          case ">":
            return x > y ? 1 : 0;
          case ">=":
            return x >= y ? 1 : 0;
          case "==":
            return x === y ? 1 : 0;
          default:
            return x !== y ? 1 : 0;
        }
      };
    }
    return l;
  };
  const add = (): Fn0 => {
    let l = mul();
    for (;;) {
      if (eat("+")) {
        const a = l;
        const b = mul();
        l = (e) => {
          const x = a(e);
          const y = b(e);
          return typeof x === "string" || typeof y === "string" ? `${x}${y}` : x + y;
        };
      } else if (eat("-")) {
        const a = l;
        const b = mul();
        l = (e) => num(a(e)) - num(b(e));
      } else return l;
    }
  };
  const mul = (): Fn0 => {
    let l = unary();
    for (;;) {
      const t = peek();
      if (t.k !== "op" || !["*", "/", "%"].includes(t.v)) return l;
      p++;
      const a = l;
      const b = unary();
      l = t.v === "*" ? (e) => num(a(e)) * num(b(e)) : t.v === "/" ? (e) => num(a(e)) / num(b(e)) : (e) => num(a(e)) % num(b(e));
    }
  };
  const unary = (): Fn0 => {
    if (eat("-")) {
      const a = unary();
      return (e) => -num(a(e));
    }
    if (eat("+")) {
      const a = unary();
      return (e) => num(a(e));
    }
    if (eat("!")) {
      const a = unary();
      return (e) => (truthy(a(e)) ? 0 : 1);
    }
    return power();
  };
  const power = (): Fn0 => {
    const base = atom();
    if (eat("^")) {
      const ex = unary();
      return (e) => num(base(e)) ** num(ex(e));
    }
    return base;
  };
  const atom = (): Fn0 => {
    const t = peek();
    if (t.k === "num") {
      p++;
      const v = t.v;
      return () => v;
    }
    if (t.k === "str") {
      p++;
      const v = t.v;
      return () => v;
    }
    if (eat("(")) {
      const inner = expr();
      want(")", 'a closing ")"');
      return inner;
    }
    if (t.k === "name") {
      p++;
      if (isOp("(")) return call(t.v, t.at);
      if (t.v === "pi") return () => Math.PI;
      if (t.v === "true") return () => 1;
      if (t.v === "false") return () => 0;
      const name = t.v;
      names.add(name);
      return (e) => {
        const v = e.get(name);
        return v === undefined ? NaN : v;
      };
    }
    if (t.k === "end") throw new ExprError(source.trim() ? "the expression stops too soon" : "the expression is empty", t.at);
    throw new ExprError(`"${t.v}" cannot start a value`, t.at);
  };
  const call = (fname: string, at: number): Fn0 => {
    want("(", '"("');
    if (WINDOWED[fname]) {
      const nt = peek();
      if (nt.k !== "name") throw new ExprError(`${fname}() takes a signal's name first, like ${fname}(drag, 2)`, nt.at);
      p++;
      let secs = WINDOWED[fname].def;
      if (eat(",")) {
        const st = peek();
        if (st.k !== "num" || !(st.v > 0)) throw new ExprError(`${fname}(): the second value is seconds, a number above 0`, st.at);
        p++;
        secs = st.v;
      }
      want(")", 'a closing ")"');
      const name = nt.v;
      names.add(name);
      windows[name] = Math.max(windows[name] ?? 0, secs);
      const f = WINDOWED[fname].f;
      return (e) => {
        const w = e.window(name, secs);
        return f(w.t, w.v, w.n);
      };
    }
    const args: Fn0[] = [];
    if (!isOp(")")) {
      do args.push(expr());
      while (eat(","));
    }
    want(")", 'a closing ")"');
    if (fname === "contains" || fname === "starts") {
      if (args.length !== 2) throw new ExprError(`${fname}() takes two values: the text and what to look for`, at);
      const [a, b] = args;
      return fname === "contains" ? (e) => (String(a(e)).toLowerCase().includes(String(b(e)).toLowerCase()) ? 1 : 0) : (e) => (String(a(e)).toLowerCase().startsWith(String(b(e)).toLowerCase()) ? 1 : 0);
    }
    const m = MATH[fname];
    if (!m) throw new ExprError(`there is no function "${fname}": use ${EXPR_FUNCTIONS.join(", ")}`, at);
    if (args.length < m.n[0] || args.length > m.n[1]) throw new ExprError(`${fname}() takes ${m.n[0] === m.n[1] ? m.n[0] : `${m.n[0]} to ${m.n[1]}`} value${m.n[1] === 1 ? "" : "s"}`, at);
    const f = m.f;
    if (args.length === 1) {
      const a = args[0];
      return (e) => f(num(a(e)));
    }
    return (e) => f(...args.map((a) => num(a(e))));
  };

  const root = expr();
  if (peek().k !== "end") throw new ExprError(`"${(peek() as { v: string }).v}" is left over: is an operator missing?`, peek().at);
  return { run: root, names: [...names], windows, source };
}

const cache = new Map<string, Compiled | ExprError>();

/** Compile with a cache; returns the error instead of throwing. */
export function compiled(source: string): Compiled | ExprError {
  let c = cache.get(source);
  if (!c) {
    try {
      c = compile(source);
    } catch (e) {
      c = e instanceof ExprError ? e : new ExprError(String(e), 0);
    }
    if (cache.size > 2000) cache.clear();
    cache.set(source, c);
  }
  return c;
}

export const asNumber = num;
export const isTrue = truthy;
