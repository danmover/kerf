// Recursive-descent parser for the Kerf design language.
// Recovers at statement boundaries so the editor can show several errors.

import type { Arg, Expr, Item, Program, Span, Stmt } from "./ast";
import { lex, LexError, type Token } from "./lexer";

export interface Diagnostic {
  message: string;
  start: number;
  end: number;
  severity: "error" | "warning";
  /** a design-rule warning, shown as a check with this title */
  rule?: string;
}

export class ParseError extends Error {
  constructor(
    message: string,
    public start: number,
    public end: number,
  ) {
    super(message);
  }
}

const TOP_LEVEL = new Set(["design", "param", "let", "component", "interface", "part", "require", "note"]);

export function parse(src: string): { program: Program; diagnostics: Diagnostic[] } {
  let tokens: Token[];
  try {
    tokens = lex(src);
  } catch (e) {
    if (e instanceof LexError) {
      return { program: { stmts: [] }, diagnostics: [{ message: e.message, start: e.start, end: e.end, severity: "error" }] };
    }
    throw e;
  }
  const p = new Parser(tokens);
  return p.program();
}

/** Parse a single expression (a selector typed into a tool, for example). */
export function parseExpression(src: string): { expr?: Expr; error?: string } {
  try {
    const p = new Parser(lex(src));
    const expr = p.expr();
    if (!p.is("eof")) return { error: `Unexpected "${p.peek().value}" after the expression` };
    return { expr };
  } catch (e) {
    if (e instanceof ParseError || e instanceof LexError) return { error: e.message };
    throw e;
  }
}

class Parser {
  i = 0;
  diagnostics: Diagnostic[] = [];
  constructor(private t: Token[]) {}

  peek(o = 0) {
    return this.t[Math.min(this.i + o, this.t.length - 1)];
  }
  next() {
    return this.t[this.i++];
  }
  is(kind: Token["kind"], value?: string, o = 0) {
    const tk = this.peek(o);
    return tk.kind === kind && (value === undefined || tk.value === value);
  }
  isOp(v: string, o = 0) {
    return this.is("op", v, o);
  }
  eat(kind: Token["kind"], value?: string): Token | undefined {
    if (this.is(kind, value)) return this.next();
    return undefined;
  }
  expect(kind: Token["kind"], value?: string, what?: string): Token {
    const tk = this.peek();
    if (tk.kind === kind && (value === undefined || tk.value === value)) return this.next();
    const wanted = what ?? (value ? `"${value}"` : kind === "ident" ? "a name" : kind);
    const got = tk.kind === "eof" ? "end of file" : `"${tk.value}"`;
    throw new ParseError(`Expected ${wanted} but found ${got}`, tk.start, Math.max(tk.end, tk.start + 1));
  }
  prevEnd() {
    return this.t[this.i - 1]?.end ?? 0;
  }

  program(): { program: Program; diagnostics: Diagnostic[] } {
    const stmts: Stmt[] = [];
    while (!this.is("eof")) {
      const startIdx = this.i;
      try {
        stmts.push(this.stmt());
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.diagnostics.push({ message: e.message, start: e.start, end: e.end, severity: "error" });
        this.recover(startIdx);
      }
    }
    return { program: { stmts }, diagnostics: this.diagnostics };
  }

  /** Skip to the next top-level keyword that is outside any braces. */
  recover(startIdx: number) {
    if (this.i === startIdx) this.i++;
    let depth = 0;
    // re-scan from statement start to compute depth correctly
    for (let j = startIdx; j < this.i; j++) {
      const tk = this.t[j];
      if (tk.kind === "op" && tk.value === "{") depth++;
      if (tk.kind === "op" && tk.value === "}") depth--;
    }
    while (!this.is("eof")) {
      const tk = this.peek();
      if (depth <= 0 && tk.kind === "kw" && TOP_LEVEL.has(tk.value) && this.atLineStart()) return;
      if (tk.kind === "op" && tk.value === "{") depth++;
      if (tk.kind === "op" && tk.value === "}") depth--;
      this.i++;
    }
  }
  atLineStart() {
    const prev = this.t[this.i - 1];
    return !prev || prev.line < this.peek().line;
  }

  stmt(): Stmt {
    const tk = this.peek();
    if (tk.kind !== "kw" || !TOP_LEVEL.has(tk.value)) {
      throw new ParseError(
        `Expected a top-level statement (param, let, component, interface, part, require) but found "${tk.value}"`,
        tk.start,
        Math.max(tk.end, tk.start + 1),
      );
    }
    const start = tk.start;
    this.next();
    switch (tk.value) {
      case "design": {
        const s = this.expect("str", undefined, "a design name in quotes");
        return { k: "design", name: s.value, span: { start, end: this.prevEnd() } };
      }
      case "note": {
        const s = this.expect("str", undefined, "a note in quotes");
        return { k: "note", text: s.value, span: { start, end: this.prevEnd() } };
      }
      case "param": {
        const nameTk = this.expect("ident");
        this.expect("op", "=");
        const vStart = this.peek().start;
        const value = this.expr();
        const valueSpan = { start: vStart, end: this.prevEnd() };
        let min: Expr | undefined;
        let max: Expr | undefined;
        let desc: string | undefined;
        let locked = false;
        for (;;) {
          if (this.eat("kw", "range")) {
            min = this.expr();
            this.expect("op", "..");
            max = this.expr();
          } else if (this.is("str")) {
            desc = this.next().value;
          } else if (this.eat("kw", "locked")) {
            locked = true;
          } else break;
        }
        return {
          k: "param",
          name: nameTk.value,
          value,
          min,
          max,
          desc,
          locked,
          span: { start, end: this.prevEnd() },
          nameSpan: { start: nameTk.start, end: nameTk.end },
          valueSpan,
        };
      }
      case "let": {
        const nameTk = this.expect("ident");
        this.expect("op", "=");
        const value = this.expr();
        return { k: "let", name: nameTk.value, value, span: { start, end: this.prevEnd() }, nameSpan: { start: nameTk.start, end: nameTk.end } };
      }
      case "component": {
        const nameTk = this.expect("ident");
        this.expect("op", "=");
        const call = this.expr();
        if (call.k !== "call") throw new ParseError("A component must be created from a library call, e.g. lib.bearing(\"608\")", call.span.start, call.span.end);
        let items: Item[] = [];
        if (this.isOp("{")) items = this.block();
        return { k: "component", name: nameTk.value, call, items, span: { start, end: this.prevEnd() }, nameSpan: { start: nameTk.start, end: nameTk.end } };
      }
      case "interface": {
        const nameTk = this.expect("ident");
        this.expect("op", "{");
        const fields: { name: string; value: Expr; span: Span }[] = [];
        while (!this.isOp("}")) {
          if (this.is("eof")) throw new ParseError("Unclosed interface block", start, this.peek().start);
          const f = this.expect("ident", undefined, "a field name");
          if (!this.eat("op", "=")) this.expect("op", ":", '"=" or ":"');
          const value = this.expr();
          fields.push({ name: f.value, value, span: { start: f.start, end: this.prevEnd() } });
          while (this.eat("op", ",") || this.eat("op", ";"));
        }
        this.expect("op", "}");
        return { k: "interface", name: nameTk.value, fields, span: { start, end: this.prevEnd() }, nameSpan: { start: nameTk.start, end: nameTk.end } };
      }
      case "part": {
        const nameTk = this.expect("ident");
        const items = this.block();
        return { k: "part", name: nameTk.value, items, span: { start, end: this.prevEnd() }, nameSpan: { start: nameTk.start, end: nameTk.end } };
      }
      case "require": {
        const label = this.expect("str", undefined, "a requirement label in quotes").value;
        let level: "hard" | "soft" = "hard";
        if (this.eat("kw", "soft")) level = "soft";
        else this.eat("kw", "hard");
        this.expect("op", ":");
        const expr = this.expr();
        return { k: "require", label, level, expr, span: { start, end: this.prevEnd() } };
      }
    }
    throw new ParseError("Unknown statement", tk.start, tk.end);
  }

  block(): Item[] {
    const open = this.expect("op", "{");
    const items: Item[] = [];
    while (!this.isOp("}")) {
      if (this.is("eof")) throw new ParseError("Unclosed block: missing \"}\"", open.start, open.end);
      items.push(this.item());
      while (this.eat("op", ",") || this.eat("op", ";"));
    }
    this.expect("op", "}");
    return items;
  }

  item(): Item {
    const tk = this.peek();
    const start = tk.start;
    if (tk.kind === "kw") {
      switch (tk.value) {
        case "body":
        case "add":
        case "cut":
        case "intersect": {
          this.next();
          const shape = this.expr();
          if (this.eat("kw", "as")) {
            const n = this.expect("ident", undefined, "a feature name after \"as\"");
            return { k: "op", op: tk.value, shape, name: n.value, nameSpan: { start: n.start, end: n.end }, span: { start, end: this.prevEnd() } };
          }
          return { k: "op", op: tk.value, shape, span: { start, end: this.prevEnd() } };
        }
        case "cosmetic": {
          this.next();
          const body = this.block();
          return { k: "cosmetic", body, span: { start, end: this.prevEnd() } };
        }
        case "for": {
          this.next();
          const v = this.expect("ident").value;
          this.expect("kw", "in");
          const iter = this.expr();
          const body = this.block();
          return { k: "for", varName: v, iter, body, span: { start, end: this.prevEnd() } };
        }
        case "if": {
          this.next();
          const cond = this.expr();
          const then = this.block();
          let els: Item[] | undefined;
          if (this.eat("kw", "else")) {
            els = this.isOp("{") ? this.block() : [this.item()];
          }
          return { k: "if", cond, then, else: els, span: { start, end: this.prevEnd() } };
        }
        case "let": {
          this.next();
          const name = this.expect("ident").value;
          this.expect("op", "=");
          const value = this.expr();
          return { k: "let", name, value, span: { start, end: this.prevEnd() } };
        }
        case "locked":
          this.next();
          return { k: "flag", name: "locked", span: { start, end: this.prevEnd() } };
      }
    }
    if (tk.kind === "ident") {
      if (this.isOp(":", 1)) {
        this.next();
        this.next();
        const value = this.expr();
        return { k: "prop", name: tk.value, value, span: { start, end: this.prevEnd() } };
      }
      if (this.isOp("(", 1)) {
        const call = this.expr();
        if (call.k !== "call") throw new ParseError("Expected a modifier call like shell(2)", call.span.start, call.span.end);
        return { k: "modifier", call, span: { start, end: this.prevEnd() } };
      }
      this.next();
      return { k: "flag", name: tk.value, span: { start, end: this.prevEnd() } };
    }
    throw new ParseError(
      `Unexpected "${tk.value || "end of file"}" inside block. Use body/add/cut/intersect, a property like color: #4c8dff, a modifier like shell(2) or fillet(1, edges: ...), cosmetic { }, for, if or let.`,
      tk.start,
      Math.max(tk.end, tk.start + 1),
    );
  }

  // ---- expressions ----
  expr(): Expr {
    return this.ternary();
  }
  ternary(): Expr {
    const cond = this.or();
    if (this.eat("op", "?")) {
      const a = this.expr();
      this.expect("op", ":");
      const b = this.expr();
      return { k: "ternary", cond, a, b, span: { start: cond.span.start, end: b.span.end } };
    }
    return cond;
  }
  or(): Expr {
    let l = this.and();
    while (this.isOp("||")) {
      this.next();
      const r = this.and();
      l = { k: "binary", op: "||", left: l, right: r, span: { start: l.span.start, end: r.span.end } };
    }
    return l;
  }
  and(): Expr {
    let l = this.cmp();
    while (this.isOp("&&")) {
      this.next();
      const r = this.cmp();
      l = { k: "binary", op: "&&", left: l, right: r, span: { start: l.span.start, end: r.span.end } };
    }
    return l;
  }
  cmp(): Expr {
    const l = this.add();
    for (const op of ["==", "!=", "<=", ">=", "<", ">"]) {
      if (this.isOp(op)) {
        this.next();
        const r = this.add();
        return { k: "binary", op, left: l, right: r, span: { start: l.span.start, end: r.span.end } };
      }
    }
    return l;
  }
  add(): Expr {
    let l = this.mul();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.next().value;
      const r = this.mul();
      l = { k: "binary", op, left: l, right: r, span: { start: l.span.start, end: r.span.end } };
    }
    return l;
  }
  mul(): Expr {
    let l = this.unary();
    while (this.isOp("*") || this.isOp("/")) {
      const op = this.next().value;
      const r = this.unary();
      l = { k: "binary", op, left: l, right: r, span: { start: l.span.start, end: r.span.end } };
    }
    return l;
  }
  unary(): Expr {
    if (this.isOp("-") || this.isOp("!") || this.isOp("+")) {
      const tk = this.next();
      const arg = this.unary();
      if (tk.value === "+") return arg;
      return { k: "unary", op: tk.value, arg, span: { start: tk.start, end: arg.span.end } };
    }
    return this.pow();
  }
  pow(): Expr {
    const base = this.postfix();
    if (this.isOp("^")) {
      this.next();
      const exp = this.unary();
      return { k: "binary", op: "^", left: base, right: exp, span: { start: base.span.start, end: exp.span.end } };
    }
    return base;
  }
  postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.isOp("(")) {
        this.next();
        const args: Arg[] = [];
        while (!this.isOp(")")) {
          const aStart = this.peek().start;
          let name: string | undefined;
          if ((this.is("ident") || this.is("kw")) && this.isOp(":", 1)) {
            name = this.next().value;
            this.next();
          }
          const value = this.expr();
          args.push({ name, value, span: { start: aStart, end: this.prevEnd() } });
          if (!this.eat("op", ",")) break;
        }
        this.expect("op", ")", '")" to close the call');
        e = { k: "call", callee: e, args, span: { start: e.span.start, end: this.prevEnd() } };
      } else if (this.isOp(".")) {
        this.next();
        const nameTk = this.peek();
        if (nameTk.kind !== "ident" && nameTk.kind !== "kw") this.expect("ident", undefined, "a field name after \".\"");
        this.next();
        e = { k: "member", obj: e, name: nameTk.value, span: { start: e.span.start, end: nameTk.end } };
      } else if (this.isOp("[") && this.peek().line === this.t[this.i - 1].line) {
        this.next();
        const index = this.expr();
        this.expect("op", "]");
        e = { k: "index", obj: e, index, span: { start: e.span.start, end: this.prevEnd() } };
      } else break;
    }
    return e;
  }
  primary(): Expr {
    const tk = this.peek();
    const span = { start: tk.start, end: tk.end };
    switch (tk.kind) {
      case "num":
        this.next();
        return { k: "num", v: tk.num!, unit: tk.unit, span };
      case "str":
        this.next();
        return { k: "str", v: tk.value, span };
      case "color":
        this.next();
        return { k: "color", v: tk.value, span };
      case "ident":
        this.next();
        return { k: "ident", name: tk.value, span };
      case "kw":
        if (tk.value === "true" || tk.value === "false") {
          this.next();
          return { k: "bool", v: tk.value === "true", span };
        }
        if (tk.value === "range" && this.isOp("(", 1)) {
          this.next();
          return { k: "ident", name: "range", span };
        }
        break;
      case "op":
        if (tk.value === "(") {
          this.next();
          const first = this.expr();
          if (this.eat("op", ",")) {
            const items = [first];
            while (!this.isOp(")")) {
              items.push(this.expr());
              if (!this.eat("op", ",")) break;
            }
            this.expect("op", ")");
            return { k: "vec", items, span: { start: tk.start, end: this.prevEnd() } };
          }
          this.expect("op", ")");
          return first;
        }
        if (tk.value === "[") {
          this.next();
          const items: Expr[] = [];
          while (!this.isOp("]")) {
            items.push(this.expr());
            if (!this.eat("op", ",")) break;
          }
          this.expect("op", "]");
          return { k: "list", items, span: { start: tk.start, end: this.prevEnd() } };
        }
    }
    throw new ParseError(
      tk.kind === "eof" ? "Unexpected end of file in expression" : `Unexpected "${tk.value}" in expression`,
      tk.start,
      Math.max(tk.end, tk.start + 1),
    );
  }
}
