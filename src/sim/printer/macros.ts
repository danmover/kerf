// Klipper's gcode_macro templates: enough of Jinja2 to run the macros printer
// configs usually carry ({% set %}, {% if %}/{% elif %}/{% else %}, {expr},
// params.NAME|default(60)|float, printer.toolhead.position.z, [a, b]|min).

export type JVal = number | string | boolean | undefined | JVal[] | { [k: string]: JVal };

export class MacroError extends Error {}

/** Render a macro body to G-code text. */
export function renderMacro(body: string, ctx: Record<string, JVal>): string {
  const vars: Record<string, JVal> = { ...ctx, True: true, False: false, true: true, false: false, None: undefined };
  const out: string[] = [];
  // a stack of if blocks: whether this branch runs, and whether an earlier branch already ran
  const stack: { on: boolean; taken: boolean; parent: boolean }[] = [];
  const active = () => stack.every((s) => s.on);
  const re = /\{%-?\s*([\s\S]*?)\s*-?%\}|\{\{\s*([\s\S]*?)\s*\}\}|\{([^{}%][^{}]*)\}/g;
  let last = 0;
  for (const m of body.matchAll(re)) {
    if (active()) out.push(body.slice(last, m.index));
    last = m.index! + m[0].length;
    if (m[1] !== undefined) {
      const stmt = m[1].trim();
      const word = stmt.split(/\s+/)[0];
      if (word === "set") {
        if (!active()) continue;
        const sm = /^set\s+([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(stmt);
        if (!sm) throw new MacroError(`cannot read {% ${stmt} %}`);
        vars[sm[1]] = evalExpr(sm[2], vars);
      } else if (word === "if") {
        const parent = active();
        const on = parent && truthy(evalExpr(stmt.slice(2), vars));
        stack.push({ on, taken: on, parent });
      } else if (word === "elif") {
        const top = stack[stack.length - 1];
        if (!top) throw new MacroError("{% elif %} without {% if %}");
        const on = top.parent && !top.taken && truthy(evalExpr(stmt.slice(4), vars));
        top.on = on;
        top.taken ||= on;
      } else if (word === "else") {
        const top = stack[stack.length - 1];
        if (!top) throw new MacroError("{% else %} without {% if %}");
        top.on = top.parent && !top.taken;
        top.taken = true;
      } else if (word === "endif") {
        if (!stack.pop()) throw new MacroError("{% endif %} without {% if %}");
      } else throw new MacroError(`Kerf's macro runner does not know {% ${word} %}`);
    } else if (active()) out.push(str(evalExpr((m[2] ?? m[3]).trim(), vars)));
  }
  if (active()) out.push(body.slice(last));
  if (stack.length) throw new MacroError("{% if %} without {% endif %}");
  return out.join("");
}

const truthy = (v: JVal) => (Array.isArray(v) ? v.length > 0 : !!v);

function str(v: JVal): string {
  if (v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? `${v}.0` : String(v);
  if (typeof v === "boolean") return v ? "True" : "False";
  if (Array.isArray(v)) return `[${v.map(str).join(", ")}]`;
  if (typeof v === "object") return "{...}";
  return v;
}

type Tok = { k: "num" | "str" | "id" | "op"; v: string };

function lex(s: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(?:(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([A-Za-z_]\w*)|(\/\/|\*\*|==|!=|<=|>=|[-+*/%<>()[\],.|~:]))/y;
  let i = 0;
  while (i < s.length) {
    if (/^\s*$/.test(s.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) throw new MacroError(`cannot read "${s.slice(i).trim()}"`);
    i = re.lastIndex;
    if (m[1]) out.push({ k: "num", v: m[1] });
    else if (m[2]) out.push({ k: "str", v: m[2].slice(1, -1) });
    else if (m[3]) out.push({ k: "id", v: m[3] });
    else out.push({ k: "op", v: m[4] });
  }
  return out;
}

export function evalExpr(src: string, vars: Record<string, JVal>): JVal {
  const t = lex(src);
  let i = 0;
  const peek = (v?: string) => (i < t.length && (v === undefined || t[i].v === v) ? t[i] : undefined);
  const eat = (v: string) => {
    if (!peek(v)) throw new MacroError(`expected "${v}" in ${src}`);
    i++;
  };
  const num = (v: JVal): number => {
    const n = typeof v === "number" ? v : typeof v === "boolean" ? Number(v) : Number(v);
    if (!Number.isFinite(n)) throw new MacroError(`"${str(v)}" is not a number`);
    return n;
  };
  function or(): JVal {
    let v = and();
    while (peek("or")) {
      i++;
      const r = and();
      v = truthy(v) ? v : r;
    }
    return v;
  }
  function and(): JVal {
    let v = not();
    while (peek("and")) {
      i++;
      const r = not();
      v = truthy(v) ? r : v;
    }
    return v;
  }
  function not(): JVal {
    if (peek("not")) {
      i++;
      return !truthy(not());
    }
    return cmp();
  }
  function cmp(): JVal {
    let v = add();
    for (;;) {
      const op = peek()?.v;
      if (op === "in") {
        i++;
        const r = add();
        v = Array.isArray(r) ? r.includes(v) : typeof r === "string" ? r.includes(str(v)) : typeof r === "object" && r ? str(v) in r : false;
      } else if (op && ["==", "!=", "<", ">", "<=", ">="].includes(op)) {
        i++;
        const r = add();
        const a = typeof v === "number" || typeof r === "number" ? num(v) : str(v);
        const b = typeof v === "number" || typeof r === "number" ? num(r) : str(r);
        v = op === "==" ? a === b : op === "!=" ? a !== b : op === "<" ? a < b : op === ">" ? a > b : op === "<=" ? a <= b : a >= b;
      } else return v;
    }
  }
  function add(): JVal {
    let v = mul();
    for (;;) {
      const op = peek()?.v;
      if (op === "+" || op === "-") {
        i++;
        const r = mul();
        v = op === "+" && (typeof v === "string" || typeof r === "string") ? str(v) + str(r) : op === "+" ? num(v) + num(r) : num(v) - num(r);
      } else if (op === "~") {
        i++;
        v = str(v) + str(mul());
      } else return v;
    }
  }
  function mul(): JVal {
    let v = unary();
    for (;;) {
      const op = peek()?.v;
      if (op !== "*" && op !== "/" && op !== "//" && op !== "%") return v;
      i++;
      const a = num(v);
      const b = num(unary());
      v = op === "*" ? a * b : op === "/" ? a / b : op === "//" ? Math.floor(a / b) : a % b;
    }
  }
  function unary(): JVal {
    if (peek("-")) {
      i++;
      return -num(unary());
    }
    if (peek("+")) {
      i++;
      return num(unary());
    }
    return filters(postfix(atom()));
  }
  function atom(): JVal {
    const k = t[i++];
    if (!k) throw new MacroError(`unexpected end of ${src}`);
    if (k.k === "num") return Number(k.v);
    if (k.k === "str") return k.v;
    if (k.v === "(") {
      const v = or();
      eat(")");
      return v;
    }
    if (k.v === "[") {
      const list: JVal[] = [];
      while (!peek("]")) {
        list.push(or());
        if (!peek(",")) break;
        i++;
      }
      eat("]");
      return list;
    }
    if (k.k === "id") return vars[k.v];
    throw new MacroError(`unexpected "${k.v}" in ${src}`);
  }
  function postfix(v: JVal): JVal {
    for (;;) {
      if (peek(".")) {
        i++;
        const name = t[i++]?.v ?? "";
        v = member(v, name);
      } else if (peek("[")) {
        i++;
        const key = or();
        eat("]");
        v = Array.isArray(v) ? v[num(key)] : member(v, str(key));
      } else return v;
    }
  }
  function filters(v: JVal): JVal {
    while (peek("|")) {
      i++;
      const name = t[i++]?.v ?? "";
      const args: JVal[] = [];
      if (peek("(")) {
        i++;
        while (!peek(")")) {
          args.push(or());
          if (!peek(",")) break;
          i++;
        }
        eat(")");
      }
      v = filter(name, v, args);
    }
    return v;
  }
  const v = or();
  if (i < t.length) throw new MacroError(`cannot read "${t.slice(i).map((x) => x.v).join(" ")}" in ${src}`);
  return v;
}

function member(v: JVal, name: string): JVal {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    // Klipper's params are upper case whatever the macro writes
    if (name in v) return v[name];
    const up = name.toUpperCase();
    if (up in v) return v[up];
    return undefined;
  }
  return undefined;
}

function filter(name: string, v: JVal, args: JVal[]): JVal {
  const n = (x: JVal) => {
    const r = typeof x === "number" ? x : Number(x);
    if (!Number.isFinite(r)) throw new MacroError(`"${str(x)}" is not a number`);
    return r;
  };
  switch (name) {
    case "default":
      return v === undefined || (args[1] === true && !v) ? args[0] : v;
    case "float":
      return v === undefined || v === "" ? (args[0] ?? 0) : n(v);
    case "int":
      return v === undefined || v === "" ? (args[0] ?? 0) : Math.trunc(n(v));
    case "round": {
      const p = args.length ? n(args[0]) : 0;
      return Math.round(n(v) * 10 ** p) / 10 ** p;
    }
    case "abs":
      return Math.abs(n(v));
    case "min":
    case "max": {
      if (!Array.isArray(v) || !v.length) throw new MacroError(`|${name} needs a list`);
      const xs = v.map(n);
      return name === "min" ? Math.min(...xs) : Math.max(...xs);
    }
    case "lower":
      return String(v ?? "").toLowerCase();
    case "upper":
      return String(v ?? "").toUpperCase();
    case "string":
      return str(v);
    case "length":
      return Array.isArray(v) ? v.length : String(v ?? "").length;
    default:
      throw new MacroError(`Kerf's macro runner does not know the |${name} filter`);
  }
}
