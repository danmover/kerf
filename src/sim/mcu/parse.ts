// Parser for the C/C++ subset in ast.ts. Types are resolved while parsing (a
// struct is complete once its closing brace is read), as a C compiler does.

import type { Expr, FuncDef, Param, Pos, Program, Stmt, VarDecl } from "./ast";
import { BOOL, VOID, intType, sizeOf, type CType, type StructField, type Types } from "./ctypes";
import { CError, type Tok } from "./lex";

const STORAGE = new Set(["static", "extern", "register", "inline", "volatile", "const", "constexpr", "auto", "__inline", "unsigned", "signed", "short", "long"]);
const BASE = new Set(["int", "char", "float", "double", "void", "bool", "_Bool", "struct", "enum", "union"]);
/** inline assembly keywords */
const ASM = new Set(["asm", "__asm__", "__asm"]);

export interface ParseOptions {
  T: Types;
  /** library classes objects can be declared with (Servo) */
  classes: Set<string>;
  /** library methods that take template arguments, worked out here as constants (FastLED.addLeds<WS2812B, 6, GRB>) */
  templated?: Set<string>;
}

export function parseProgram(toks: Tok[], opts: ParseOptions): Program {
  return new Parser(toks, opts).program();
}

/**
 * Parse a program, and give back a way to parse expressions with its types, structs and enums afterwards (the
 * debugger's conditions and watches, which name the program's own types in casts and sizeof).
 */
export function parseProgramForDebug(toks: Tok[], opts: ParseOptions): { prog: Program; parseExpr: (toks: Tok[]) => Expr } {
  const p = new Parser(toks, opts);
  const prog = p.program();
  const parseExpr = (t: Tok[]) => {
    const q = new Parser(t, opts);
    q.typedefs = p.typedefs;
    q.structs = p.structs;
    q.enums = p.enums;
    q.consts = p.consts;
    const e = q.expr();
    if (q.peek().k !== "eof") q.fail(`Unexpected "${q.peek().v}" after the expression`);
    return e;
  };
  return { prog, parseExpr };
}

class Parser {
  p = 0;
  T: Types;
  typedefs = new Map<string, CType>();
  structs = new Map<string, Extract<CType, { k: "struct" }>>();
  enums = new Map<string, CType>();
  consts = new Map<string, { v: number; type: CType }>();
  /** integer constants declared in the enclosing blocks, innermost last; null marks a variable or parameter that hides an outer one */
  locals: Map<string, number | null>[] = [];
  globals: VarDecl[] = [];
  funcs = new Map<string, FuncDef>();
  ramStrings = 0;
  flashDepth = 0;

  constructor(
    private toks: Tok[],
    private opts: ParseOptions,
  ) {
    const T = (this.T = opts.T);
    const td: [string, CType][] = [
      ["int8_t", intType(8, true)],
      ["uint8_t", intType(8, false)],
      ["int16_t", intType(16, true)],
      ["uint16_t", intType(16, false)],
      ["int32_t", intType(32, true)],
      ["uint32_t", intType(32, false)],
      ["int64_t", intType(64, true)],
      ["uint64_t", intType(64, false)],
      ["size_t", T.sizeT],
      ["byte", intType(8, false, "byte")],
      ["boolean", BOOL],
      ["word", intType(16, false, "word")],
      ["intptr_t", intType((T.abi.ptrBytes * 8) as 16 | 32, true)],
      ["uintptr_t", intType((T.abi.ptrBytes * 8) as 16 | 32, false)],
    ];
    for (const [n, t] of td) this.typedefs.set(n, t);
  }

  // ---------- tokens ----------

  peek(o = 0): Tok {
    return this.toks[Math.min(this.p + o, this.toks.length - 1)];
  }
  next(): Tok {
    return this.toks[this.p++];
  }
  is(v: string, o = 0): boolean {
    const t = this.peek(o);
    return (t.k === "punc" || t.k === "id") && t.v === v;
  }
  eat(v: string): boolean {
    if (this.is(v)) {
      this.p++;
      return true;
    }
    return false;
  }
  expect(v: string, what?: string): Tok {
    const t = this.peek();
    if (!this.is(v)) this.fail(`Expected ${what ?? `"${v}"`} but found "${t.v || "end of file"}"`, t);
    return this.next();
  }
  fail(msg: string, t: Tok = this.peek()): never {
    throw new CError(msg, t.file || "firmware", t.line);
  }
  pos(t: Tok = this.peek()): Pos {
    return { file: t.file, line: t.line };
  }

  // ---------- program ----------

  program(): Program {
    while (this.peek().k !== "eof") this.external();
    return { globals: this.globals, funcs: this.funcs, consts: this.consts, ramStrings: this.ramStrings, structs: this.structs };
  }

  external() {
    if (this.eat(";")) return;
    if (this.is("typedef")) return this.typedef();
    if (this.is("template") || this.is("class") || this.is("namespace") || this.is("using")) this.fail(`The simulator does not run C++ ${this.peek().v} declarations`);
    if (this.is("__attribute__")) this.skipAttribute();
    const start = this.peek();
    const spec = this.specifiers();
    if (this.eat(";")) return; // struct or enum definition on its own
    for (;;) {
      const d = this.declarator(spec.type);
      if (!d.name) this.fail("Expected a name", start);
      if (d.type.k === "fn") {
        const fn: FuncDef = { name: d.name, ret: d.type.ret, params: d.params ?? [], isStatic: spec.storage === "static", ...this.pos(start) };
        while (this.is("__attribute__")) this.skipAttribute();
        if (this.is("{")) {
          const prior = this.funcs.get(d.name);
          if (prior?.body) this.fail(`${d.name}() is defined twice`, start);
          this.locals.push(new Map(fn.params.flatMap((q) => (q.name ? [[q.name, null] as const] : []))));
          fn.body = this.block();
          this.locals.pop();
          this.funcs.set(d.name, fn);
          return;
        }
        if (!this.funcs.has(d.name)) this.funcs.set(d.name, fn);
      } else {
        const v: VarDecl = { name: d.name, type: d.type, storage: spec.storage === "static" ? "static" : spec.storage === "extern" ? "extern" : "auto", isConst: spec.isConst, ...this.pos(start) };
        if (d.ctor) v.init = d.ctor;
        else if (this.eat("=")) v.init = this.initializer();
        else if (this.is("{")) v.init = this.initializer();
        v.type = this.completeArray(v.type, v.init);
        if (v.storage !== "extern" || v.init) this.globals.push(v);
      }
      if (this.eat(",")) continue;
      this.expect(";");
      return;
    }
  }

  skipAttribute() {
    this.next();
    this.expect("(");
    let depth = 1;
    while (depth > 0 && this.peek().k !== "eof") {
      const t = this.next();
      if (t.v === "(") depth++;
      else if (t.v === ")") depth--;
    }
  }

  typedef() {
    this.next();
    const spec = this.specifiers();
    for (;;) {
      const d = this.declarator(spec.type);
      if (!d.name) this.fail("typedef needs a name");
      this.typedefs.set(d.name, d.type);
      if (!this.eat(",")) break;
    }
    this.expect(";");
  }

  /** Arrays declared [] take their size from the initializer. */
  completeArray(t: CType, init?: Expr): CType {
    if (t.k !== "arr" || t.n >= 0) return t;
    if (init?.k === "init") return { ...t, n: init.items.length };
    if (init?.k === "str" && t.of.k === "int" && t.of.bits === 8) return { ...t, n: init.bytes.length + 1 };
    this.fail("An array declared with [] needs an initializer");
  }

  // ---------- types ----------

  isTypeStart(o = 0): boolean {
    const t = this.peek(o);
    if (t.k !== "id") return false;
    return STORAGE.has(t.v) || BASE.has(t.v) || this.typedefs.has(t.v) || this.structs.has(t.v) || this.enums.has(t.v) || this.opts.classes.has(t.v) || this.scopedClass(o) !== null;
  }

  /** a library class named in its namespace (fs::FS), starting at token o */
  scopedClass(o = 0): string | null {
    const t = this.peek(o);
    const n = this.peek(o + 2);
    if (t.k !== "id" || !this.is("::", o + 1) || n.k !== "id") return null;
    const name = `${t.v}::${n.v}`;
    return this.opts.classes.has(name) ? name : null;
  }

  specifiers(): { type: CType; storage?: string; isConst: boolean } {
    let storage: string | undefined;
    let isConst = false;
    let signed: boolean | undefined;
    let short = false;
    let long = 0;
    let base: string | undefined;
    let type: CType | undefined;
    const start = this.peek();
    for (;;) {
      const t = this.peek();
      if (t.k !== "id") break;
      const v = t.v;
      if (v === "static" || v === "extern") storage = v;
      else if (v === "const" || v === "constexpr") isConst = true;
      else if (v === "volatile" || v === "register" || v === "inline" || v === "__inline") {
        /* no effect on the simulation */
      } else if (v === "unsigned") signed = false;
      else if (v === "signed") signed = true;
      else if (v === "short") short = true;
      else if (v === "long") long++;
      else if (v === "__attribute__") {
        this.skipAttribute();
        continue;
      } else if (!type && !base && (v === "int" || v === "char" || v === "float" || v === "double" || v === "void" || v === "bool" || v === "_Bool")) base = v;
      else if (!type && !base && (v === "struct" || v === "union")) {
        this.next();
        type = this.structSpec(v === "union");
        continue;
      } else if (!type && !base && v === "enum") {
        this.next();
        type = this.enumSpec();
        continue;
      } else if (!type && !base && signed === undefined && !short && !long && this.scopedClass() !== null) {
        type = { k: "class", name: this.scopedClass()! };
        this.next();
        this.next();
      } else if (!type && !base && signed === undefined && !short && !long && (this.typedefs.has(v) || this.structs.has(v) || this.enums.has(v) || this.opts.classes.has(v))) {
        type = this.typedefs.get(v) ?? this.structs.get(v) ?? this.enums.get(v) ?? { k: "class", name: v };
      } else break;
      this.next();
    }
    if (!type) {
      const T = this.T;
      if (base === "void") type = VOID;
      else if (base === "bool" || base === "_Bool") type = BOOL;
      else if (base === "float") type = T.float;
      else if (base === "double") type = long ? T.double : T.double;
      else if (base === "char") type = signed === undefined ? T.char : signed ? T.schar : T.uchar;
      else if (short) type = signed === false ? T.ushort : T.short;
      else if (long >= 2) type = intType(64, signed !== false, signed === false ? "unsigned long long" : "long long");
      else if (long === 1) type = signed === false ? T.ulong : T.long;
      else if (base === "int" || signed !== undefined) type = signed === false ? T.uint : T.int;
      else this.fail(`Expected a type but found "${start.v}"`, start);
    }
    return { type, storage, isConst };
  }

  structSpec(union: boolean): CType {
    // a library's header declares it (FastLED's CRGB): the library's C++ for it applies
    const lib = this.peek().file.startsWith("<");
    let name = this.peek().k === "id" && !this.is("{") ? this.next().v : `<anonymous ${union ? "union" : "struct"}>`;
    if (!this.is("{")) {
      const known = this.structs.get(name);
      if (known) return known;
      const fwd: Extract<CType, { k: "struct" }> = { k: "struct", name, fields: [], size: 0, complete: false };
      this.structs.set(name, fwd);
      return fwd;
    }
    this.expect("{");
    if (union) name = name.replace("struct", "union");
    const st: Extract<CType, { k: "struct" }> = this.structs.get(name) ?? { k: "struct", name, fields: [], size: 0, complete: false };
    st.fields = [];
    this.structs.set(name, st);
    let offset = 0;
    let size = 0;
    while (!this.eat("}")) {
      const spec = this.specifiers();
      for (;;) {
        const d = this.declarator(spec.type);
        if (!d.name) this.fail(`Expected a field name in ${name}`);
        if (d.type.k === "fn") this.fail(`Member functions are not supported (${name}::${d.name})`);
        if (this.eat(":")) this.fail("Bit fields are not supported");
        const f: StructField = { name: d.name, type: d.type, offset: union ? 0 : offset };
        st.fields.push(f);
        const s = sizeOf(d.type, this.T.abi);
        // AVR packs structs with no padding; 32-bit targets align fields to their size
        if (!union) offset += s;
        size = union ? Math.max(size, s) : offset;
        if (!this.eat(",")) break;
      }
      this.expect(";");
    }
    st.size = size;
    st.complete = true;
    if (lib) st.lib = true;
    return st;
  }

  enumSpec(): CType {
    if (this.is("class") || this.is("struct")) this.next();
    const name = this.peek().k === "id" && !this.is("{") && !this.is(":") ? this.next().v : "<anonymous enum>";
    let base: CType = this.T.int;
    if (this.eat(":")) base = this.specifiers().type;
    const type: CType = { k: "enum", name, base };
    if (name !== "<anonymous enum>") this.enums.set(name, type);
    if (!this.eat("{")) return this.enums.get(name) ?? type;
    let v = 0;
    while (!this.eat("}")) {
      const t = this.next();
      if (t.k !== "id") this.fail(`Expected an enum constant in ${name}`, t);
      if (this.eat("=")) v = this.constExpr(this.ternary());
      this.consts.set(t.v, { v, type });
      v++;
      if (!this.eat(",")) {
        this.expect("}");
        break;
      }
    }
    return type;
  }

  /** A const local's value when it is an integer constant expression (so it can size an array), else null. */
  localConst(v: VarDecl): number | null {
    const t = v.type.k === "enum" ? v.type.base : v.type;
    if (!v.init || v.init.k === "init" || (t.k !== "int" && t.k !== "bool")) return null;
    let n: number;
    try {
      n = this.constExpr(v.init);
    } catch (e) {
      if (e instanceof CError) return null;
      throw e;
    }
    if (t.k === "bool") return +!!n;
    if (t.bits === 64) return n;
    if (t.bits === 32) return t.signed ? n | 0 : n >>> 0;
    const m = 2 ** t.bits;
    const u = ((n % m) + m) % m;
    return t.signed && u >= m / 2 ? u - m : u;
  }

  /** Evaluate an integer constant expression at parse time (enum values, array sizes). */
  constExpr(e: Expr): number {
    const ev = (x: Expr): number => {
      switch (x.k) {
        case "num":
          return x.v;
        case "id": {
          for (let i = this.locals.length - 1; i >= 0; i--) {
            const l = this.locals[i].get(x.name);
            if (l === null) return this.fail(`${x.name} is not a constant`, x as unknown as Tok);
            if (l !== undefined) return l;
          }
          const c = this.consts.get(x.name);
          if (c) return c.v;
          const g = this.globals.find((g) => g.name === x.name && g.isConst && g.init);
          if (g?.init) return ev(g.init);
          return this.fail(`${x.name} is not a constant`, x as unknown as Tok);
        }
        case "un":
          return x.op === "-" ? -ev(x.a) : x.op === "+" ? ev(x.a) : x.op === "~" ? ~ev(x.a) : x.op === "!" ? +!ev(x.a) : this.fail("Not a constant expression");
        case "bin": {
          const a = ev(x.a),
            b = ev(x.b);
          switch (x.op) {
            case "+":
              return a + b;
            case "-":
              return a - b;
            case "*":
              return a * b;
            case "/":
              return Math.trunc(a / b);
            case "%":
              return a % b;
            case "<<":
              return a << b;
            case ">>":
              return a >> b;
            case "&":
              return a & b;
            case "|":
              return a | b;
            case "^":
              return a ^ b;
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
          }
          return this.fail("Not a constant expression");
        }
        case "cond":
          return ev(x.c) ? ev(x.a) : ev(x.b);
        case "cast":
          return Math.trunc(ev(x.a));
        case "sizeofT":
          return sizeOf(x.type, this.T.abi);
        default:
          return this.fail("Not a constant expression", x as unknown as Tok);
      }
    };
    return Math.trunc(ev(e));
  }

  /** Pointer stars, a reference, a name and array or function suffixes. */
  declarator(base: CType): { name?: string; type: CType; params?: Param[]; ctor?: Expr } {
    let type = base;
    for (;;) {
      if (this.eat("*")) {
        type = { k: "ptr", to: type };
        while (this.is("const") || this.is("volatile")) this.next();
        continue;
      }
      break;
    }
    let ref = false;
    if (this.eat("&")) ref = true;
    if (this.is("&&")) this.fail("Rvalue references are not supported");
    // a function pointer, or an array of them: void (*patterns[])(), uint8_t (*pick)(uint8_t)
    if (this.is("(") && this.is("*", 1)) {
      this.next();
      let stars = 0;
      while (this.eat("*")) {
        stars++;
        while (this.is("const") || this.is("volatile")) this.next();
      }
      const fname = this.peek().k === "id" && !this.isTypeStart() ? this.next().v : undefined;
      const fdims: number[] = [];
      while (this.eat("[")) {
        if (this.eat("]")) fdims.push(-1);
        else {
          fdims.push(this.constExpr(this.expr()));
          this.expect("]");
        }
      }
      this.expect(")");
      this.expect("(", "the function's parameters");
      const fparams = this.params();
      while (this.is("const") || this.is("noexcept")) this.next();
      let ft: CType = { k: "fn", ret: ref ? { k: "ref", to: type } : type, params: fparams.map((q) => q.type) };
      for (let i = 0; i < stars; i++) ft = { k: "ptr", to: ft };
      for (let i = fdims.length - 1; i >= 0; i--) ft = { k: "arr", of: ft, n: fdims[i] };
      return { name: fname, type: ft };
    }
    let name: string | undefined;
    if (this.peek().k === "id" && !this.isTypeStart()) name = this.next().v;
    // a library struct built with its constructor: CRGB c(255, 0, 0); CHSV hue(HUE_AQUA, 255, 255);
    // (not a function's declaration, CRGB pick(uint8_t i);, whose parentheses hold types)
    if (name && type.k === "struct" && type.lib && !ref && this.is("(") && !this.is(")", 1) && (!this.isTypeStart(1) || this.is("::", 2) || this.is("(", 2))) {
      const pos = this.pos();
      this.next();
      const args: Expr[] = [];
      for (;;) {
        args.push(this.assign());
        if (this.eat(")")) break;
        this.expect(",");
      }
      return { name, type, ctor: { k: "call", fn: { k: "id", name: type.name, ...pos }, args, ...pos } };
    }
    // a library object built with constructor arguments: Adafruit_NeoPixel strip(60, 6, NEO_GRB);
    if (name && type.k === "class" && !ref && this.is("(")) {
      const pos = this.pos();
      this.next();
      const items: Expr[] = [];
      if (!this.eat(")"))
        for (;;) {
          items.push(this.assign());
          if (this.eat(")")) break;
          this.expect(",");
        }
      return { name, type, ctor: { k: "init", items, ...pos } };
    }
    let params: Param[] | undefined;
    const dims: number[] = [];
    for (;;) {
      if (this.eat("[")) {
        if (this.eat("]")) dims.push(-1);
        else {
          dims.push(this.constExpr(this.expr()));
          this.expect("]");
        }
        continue;
      }
      if (this.is("(") && params === undefined && dims.length === 0) {
        this.next();
        params = this.params();
        while (this.is("const") || this.is("noexcept") || this.is("override")) this.next();
        continue;
      }
      break;
    }
    for (let i = dims.length - 1; i >= 0; i--) type = { k: "arr", of: type, n: dims[i] };
    if (ref) type = { k: "ref", to: type };
    if (params) return { name, type: { k: "fn", ret: type, params: params.map((p) => p.type) }, params };
    return { name, type };
  }

  params(): Param[] {
    const out: Param[] = [];
    if (this.eat(")")) return out;
    if (this.is("void") && this.is(")", 1)) {
      this.next();
      this.next();
      return out;
    }
    for (;;) {
      if (this.eat("...")) this.fail("Variadic functions are not supported");
      const spec = this.specifiers();
      const d = this.declarator(spec.type);
      let t = d.type;
      // array parameters are pointers
      if (t.k === "arr") t = { k: "ptr", to: t.of };
      if (this.eat("=")) this.fail("Default arguments are not supported");
      out.push({ name: d.name, type: t });
      if (this.eat(")")) return out;
      this.expect(",");
    }
  }

  typeName(): CType {
    const spec = this.specifiers();
    return this.declarator(spec.type).type;
  }

  // ---------- statements ----------

  block(): Extract<Stmt, { k: "block" }> {
    const pos = this.pos();
    this.expect("{");
    const body: Stmt[] = [];
    this.locals.push(new Map());
    while (!this.eat("}")) {
      if (this.peek().k === "eof") this.fail("Missing } at the end of a block");
      body.push(this.stmt());
    }
    this.locals.pop();
    return { k: "block", body, ...pos };
  }

  stmt(): Stmt {
    const t = this.peek();
    const pos = this.pos(t);
    if (t.k === "punc") {
      if (t.v === "{") return this.block();
      if (t.v === ";") {
        this.next();
        return { k: "empty", ...pos };
      }
    }
    if (t.k === "id" && ASM.has(t.v)) return this.asmStmt();
    if (t.k === "id") {
      switch (t.v) {
        case "if": {
          this.next();
          this.expect("(");
          const c = this.expr();
          this.expect(")");
          const th = this.stmt();
          const el = this.eat("else") ? this.stmt() : undefined;
          return { k: "if", c, t: th, e: el, ...pos };
        }
        case "while": {
          this.next();
          this.expect("(");
          const c = this.expr();
          this.expect(")");
          return { k: "while", c, body: this.stmt(), ...pos };
        }
        case "do": {
          this.next();
          const body = this.stmt();
          this.expect("while");
          this.expect("(");
          const c = this.expr();
          this.expect(")");
          this.expect(";");
          return { k: "do", body, c, ...pos };
        }
        case "for": {
          this.next();
          this.expect("(");
          let init: Stmt | undefined;
          if (!this.eat(";")) {
            if (this.isTypeStart()) init = this.declStmt();
            else {
              init = { k: "expr", e: this.expr(), ...pos };
              this.expect(";");
            }
          }
          const c = this.is(";") ? undefined : this.expr();
          this.expect(";");
          const step = this.is(")") ? undefined : this.expr();
          this.expect(")");
          return { k: "for", init, c, step, body: this.stmt(), ...pos };
        }
        case "switch": {
          this.next();
          this.expect("(");
          const e = this.expr();
          this.expect(")");
          const blk = this.stmt();
          return { k: "switch", e, body: blk.k === "block" ? blk.body : [blk], ...pos };
        }
        case "case": {
          this.next();
          const v = this.ternary();
          this.expect(":");
          return { k: "case", v, ...pos };
        }
        case "default":
          if (this.is(":", 1)) {
            this.next();
            this.next();
            return { k: "default", ...pos };
          }
          break;
        case "break":
          this.next();
          this.expect(";");
          return { k: "break", ...pos };
        case "continue":
          this.next();
          this.expect(";");
          return { k: "continue", ...pos };
        case "return": {
          this.next();
          if (this.eat(";")) return { k: "return", ...pos };
          const e = this.expr();
          this.expect(";");
          return { k: "return", e, ...pos };
        }
        case "goto":
          this.fail("goto is not supported");
      }
      // a declaration, unless it is a functional cast or a call: float(x), Servo s; x = 1
      if (this.isTypeStart() && !(this.is("(", 1) && !this.isStorageWord(t.v))) return this.declStmt();
    }
    const e = this.expr();
    this.expect(";");
    return { k: "expr", e, ...pos };
  }

  /**
   * Inline assembly. The sketch runs as C++, not as AVR machine code, so only
   * assembly with no effect beyond time is accepted: an empty barrier,
   * asm volatile("" ::: "memory") (as avr-libc's cli() and sei() use), and nops.
   */
  asmStmt(): Stmt {
    const start = this.next();
    const pos = this.pos(start);
    while (["volatile", "__volatile__", "__volatile", "inline", "goto"].some((q) => this.is(q))) this.next();
    this.expect("(");
    const bytes: number[] = [];
    while (this.peek().k === "str") bytes.push(...(this.next().bytes ?? []));
    // after the template: outputs, inputs and clobbers, separated by colons
    let section = 0;
    let operands = false;
    for (let depth = 0; ; ) {
      const t = this.next();
      if (t.k === "eof") this.fail("Missing ) at the end of asm(...)", start);
      if (t.k === "punc" && (t.v === ":" || t.v === "::")) {
        section += t.v.length;
        continue;
      }
      if (t.k === "punc" && t.v === ")" && depth === 0) break;
      if (t.k === "punc" && t.v === "(") depth++;
      if (t.k === "punc" && t.v === ")") depth--;
      if (section === 1 || section === 2) operands = true;
    }
    this.expect(";");
    const text = String.fromCharCode(...bytes);
    const words = text.split(/[\s;]+/).filter(Boolean);
    if (!operands && words.every((w) => w.toLowerCase() === "nop")) {
      if (!words.length) return { k: "empty", ...pos };
      const cycles: Expr = { k: "num", v: words.length, type: this.T.ulong, ...pos };
      return { k: "expr", e: { k: "call", fn: { k: "id", name: "__builtin_avr_delay_cycles", ...pos }, args: [cycles], ...pos }, ...pos };
    }
    return this.fail(
      `The simulator runs the sketch as C++, not as AVR machine code, so it cannot run inline assembly (asm("${text.trim().replace(/\s+/g, " ").slice(0, 40)}")). It accepts an empty barrier, asm volatile("" ::: "memory"), and nops; write the rest in C++`,
      start,
    );
  }

  isStorageWord(v: string) {
    return STORAGE.has(v) || BASE.has(v);
  }

  declStmt(): Stmt {
    const start = this.peek();
    const spec = this.specifiers();
    const vars: VarDecl[] = [];
    if (this.eat(";")) return { k: "empty", ...this.pos(start) };
    for (;;) {
      const d = this.declarator(spec.type);
      if (!d.name) this.fail("Expected a variable name", start);
      if (d.type.k === "fn") this.fail(`Declare ${d.name}() outside functions`, start);
      const v: VarDecl = { name: d.name, type: d.type, storage: spec.storage === "static" ? "static" : "auto", isConst: spec.isConst, ...this.pos(start) };
      if (d.ctor) v.init = d.ctor;
      else if (this.eat("=")) v.init = this.initializer();
      else if (this.is("{")) v.init = this.initializer();
      v.type = this.completeArray(v.type, v.init);
      this.locals[this.locals.length - 1]?.set(v.name, v.isConst ? this.localConst(v) : null);
      vars.push(v);
      if (!this.eat(",")) break;
    }
    this.expect(";");
    return { k: "decl", vars, ...this.pos(start) };
  }

  initializer(): Expr {
    if (this.is("{")) {
      const pos = this.pos();
      this.next();
      const items: Expr[] = [];
      while (!this.eat("}")) {
        if (this.is(".")) this.fail("Designated initializers are not supported");
        items.push(this.initializer());
        if (!this.eat(",")) {
          this.expect("}");
          break;
        }
      }
      return { k: "init", items, ...pos };
    }
    return this.assign();
  }

  // ---------- expressions ----------

  expr(): Expr {
    let e = this.assign();
    while (this.is(",")) {
      const pos = this.pos();
      this.next();
      e = { k: "comma", a: e, b: this.assign(), ...pos };
    }
    return e;
  }

  assign(): Expr {
    const a = this.ternary();
    const t = this.peek();
    if (t.k === "punc" && ["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="].includes(t.v)) {
      this.next();
      return { k: "assign", op: t.v, a, b: this.assign(), ...this.pos(t) };
    }
    return a;
  }

  ternary(): Expr {
    const c = this.binary(0);
    if (this.is("?")) {
      const pos = this.pos();
      this.next();
      const a = this.expr();
      this.expect(":");
      const b = this.assign();
      return { k: "cond", c, a, b, ...pos };
    }
    return c;
  }

  static LEVELS = [["||"], ["&&"], ["|"], ["^"], ["&"], ["==", "!="], ["<", ">", "<=", ">="], ["<<", ">>"], ["+", "-"], ["*", "/", "%"]];

  binary(lvl: number): Expr {
    if (lvl >= Parser.LEVELS.length) return this.unary();
    let a = this.binary(lvl + 1);
    for (;;) {
      const t = this.peek();
      if (t.k === "punc" && Parser.LEVELS[lvl].includes(t.v)) {
        this.next();
        const b = this.binary(lvl + 1);
        a = t.v === "&&" || t.v === "||" ? { k: "logic", op: t.v, a, b, ...this.pos(t) } : { k: "bin", op: t.v, a, b, ...this.pos(t) };
      } else return a;
    }
  }

  unary(): Expr {
    const t = this.peek();
    const pos = this.pos(t);
    if (t.k === "punc") {
      if (["-", "+", "!", "~", "*", "&", "++", "--"].includes(t.v)) {
        this.next();
        const a = this.unary();
        return { k: "un", op: t.v as "-", a, ...pos };
      }
      if (t.v === "(" && this.isTypeStart(1)) {
        this.next();
        const type = this.typeName();
        this.expect(")");
        if (this.is("{")) this.fail("Compound literals are not supported");
        return { k: "cast", type, a: this.unary(), ...pos };
      }
    }
    if (t.k === "id" && t.v === "sizeof") {
      this.next();
      if (this.is("(") && this.isTypeStart(1)) {
        this.next();
        const type = this.typeName();
        this.expect(")");
        return { k: "sizeofT", type, ...pos };
      }
      return { k: "sizeofE", a: this.unary(), ...pos };
    }
    if (t.k === "id" && (t.v === "static_cast" || t.v === "reinterpret_cast" || t.v === "const_cast")) {
      this.next();
      this.expect("<");
      const type = this.typeName();
      this.expect(">");
      this.expect("(");
      const a = this.expr();
      this.expect(")");
      return this.postfix({ k: "cast", type, a, ...pos });
    }
    return this.postfix(this.primary());
  }

  postfix(e: Expr): Expr {
    for (;;) {
      const t = this.peek();
      const pos = this.pos(t);
      if (t.k !== "punc") return e;
      if (t.v === "(") {
        this.next();
        const isFlash = e.k === "id" && e.name === "__flash_str";
        if (isFlash) this.flashDepth++;
        const args: Expr[] = [];
        if (!this.eat(")")) {
          for (;;) {
            args.push(this.assign());
            if (this.eat(")")) break;
            this.expect(",");
          }
        }
        if (isFlash) this.flashDepth--;
        e = { k: "call", fn: e, args, ...pos };
      } else if (t.v === "[") {
        this.next();
        const i = this.expr();
        this.expect("]");
        e = { k: "idx", a: e, i, ...pos };
      } else if (t.v === "." || t.v === "->") {
        this.next();
        const n = this.next();
        if (n.k !== "id") this.fail("Expected a member name", n);
        e = { k: "mem", a: e, name: n.v, arrow: t.v === "->", ...pos };
        // a library method's template arguments, constants known here: FastLED.addLeds<WS2812B, DATA_PIN, GRB>(...)
        if (this.opts.templated?.has(n.v) && this.is("<")) {
          this.next();
          const targs: number[] = [];
          if (!this.eat(">"))
            for (;;) {
              // above the comparisons, so the closing > ends it
              targs.push(this.constExpr(this.binary(7)));
              if (this.eat(">")) break;
              this.expect(",", `"," or ">" in ${n.v}<...>`);
            }
          e.targs = targs;
        }
      } else if (t.v === "++" || t.v === "--") {
        this.next();
        e = { k: "post", op: t.v, a: e, ...pos };
      } else return e;
    }
  }

  primary(): Expr {
    const t = this.next();
    const pos = this.pos(t);
    const T = this.T;
    switch (t.k) {
      case "num": {
        if (t.float) return { k: "num", v: t.v.toLowerCase().endsWith("f") ? Math.fround(t.n!) : T.abi.doubleBits === 32 ? Math.fround(t.n!) : t.n!, type: t.v.toLowerCase().endsWith("f") ? T.float : T.double, ...pos };
        return { k: "num", v: t.n!, type: this.literalType(t), ...pos };
      }
      case "chr":
        return { k: "num", v: t.n!, type: T.char, ...pos };
      case "str":
        if (!this.flashDepth) this.ramStrings += (t.bytes?.length ?? 0) + 1;
        return { k: "str", bytes: t.bytes ?? [], ...pos };
      case "id": {
        if (t.v === "true" || t.v === "false") return { k: "num", v: t.v === "true" ? 1 : 0, type: BOOL, ...pos };
        if (t.v === "nullptr") return { k: "id", name: "NULL", ...pos };
        // a name in a class's scope: AccelStepper::DRIVER, CRGB::Red
        if (this.is("::") && this.peek(1).k === "id") {
          let name = t.v;
          while (this.is("::") && this.peek(1).k === "id") {
            this.next();
            name += "::" + this.next().v;
          }
          return { k: "id", name, ...pos };
        }
        // functional cast: float(x), uint8_t(x)
        if ((this.typedefs.has(t.v) || BASE.has(t.v)) && this.is("(")) {
          this.p--;
          const type = this.specifiers().type;
          this.expect("(");
          const a = this.expr();
          this.expect(")");
          return { k: "cast", type, a, ...pos };
        }
        return { k: "id", name: t.v, ...pos };
      }
      case "punc":
        if (t.v === "(") {
          const e = this.expr();
          this.expect(")");
          return e;
        }
        if (t.v === "{") this.fail("A braced list can only start an initializer", t);
        break;
    }
    return this.fail(`Unexpected "${t.v || "end of file"}"`, t);
  }

  /** C's rules for an integer literal's type, with the chip's int size. */
  literalType(t: Tok): CType {
    const T = this.T;
    const v = t.n!;
    const ib = T.abi.intBits;
    const fits = (bits: number, signed: boolean) => (signed ? v <= 2 ** (bits - 1) - 1 : v <= 2 ** bits - 1);
    const dec = t.radix === 10;
    const cands: CType[] = [];
    const L = t.long ?? 0;
    if (t.unsigned) {
      if (L === 0) cands.push(T.uint);
      if (L <= 1) cands.push(T.ulong);
      cands.push(intType(64, false, "unsigned long long"));
    } else {
      if (L === 0) {
        cands.push(T.int);
        if (!dec) cands.push(T.uint);
      }
      if (L <= 1) {
        cands.push(T.long);
        if (!dec) cands.push(T.ulong);
      }
      cands.push(T.llong);
    }
    for (const c of cands) if (c.k === "int" && fits(c.bits, c.signed)) return c;
    void ib;
    return intType(64, false, "unsigned long long");
  }
}
