// Recursive-descent parser for the Kerf design language.
// Recovers at statement boundaries so the editor can show several errors.

import type { Arg, BriefItem, BriefProp, ConfigRowNode, DecisionOptionNode, DefParam, Expr, Item, Program, SketchEntityKind, ScenarioItem, SketchItem, Span, Stmt } from "./ast";
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

const TOP_LEVEL = new Set(["design", "param", "let", "component", "interface", "part", "require", "note", "brief", "decision", "sketch", "analysis"]);

/** Machine statements. They are contextual words, not keywords, so older designs can still use them as names. */
const MACHINE_STMTS = new Set(["wire", "net", "firmware", "test", "buy", "scenario"]);

/** The design's own functions and features: `fn name(`, `function name(` and `feature name(`. Contextual words, not keywords. */
const DEF_WORDS = new Set(["fn", "function", "feature"]);

/** Entries inside `brief { ... }` that are not `field: value` pairs. Not keywords, so they stay usable as names elsewhere. */
const BRIEF_ENTRIES = new Set(["use", "given", "reference", "assume"]);
const SKETCH_ENTITIES = new Set<SketchEntityKind>(["point", "line", "circle", "arc", "spline", "ellipse"]);

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
  try {
    return p.program();
  } catch (e) {
    // deeply nested source overflows the recursive parser; report it instead of failing to open the design
    if (e instanceof RangeError) return { program: { stmts: [] }, diagnostics: [{ message: "This source is nested too deeply to read. Flatten the deepest brackets or blocks.", start: 0, end: Math.min(src.length, 1), severity: "error" }] };
    throw e;
  }
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
    // look again from the start of the line that went wrong: a statement there (fn twice(v) = ...) may have been read
    // as part of the unfinished one above
    while (this.i > startIdx + 1 && this.t[this.i - 1].line === this.peek().line) this.i--;
    let depth = 0;
    // re-scan from statement start to compute depth correctly
    for (let j = startIdx; j < this.i; j++) {
      const tk = this.t[j];
      if (tk.kind === "op" && tk.value === "{") depth++;
      if (tk.kind === "op" && tk.value === "}") depth--;
    }
    while (!this.is("eof")) {
      const tk = this.peek();
      if (depth <= 0 && ((tk.kind === "kw" && TOP_LEVEL.has(tk.value)) || this.atDrawing() || this.atFrame() || this.atMate() || this.atConfigs() || this.atSchematic() || this.atDef() || this.machineStmtAhead()) && this.atLineStart()) return;
      if (tk.kind === "op" && tk.value === "{") depth++;
      if (tk.kind === "op" && tk.value === "}") depth--;
      this.i++;
    }
  }
  atLineStart() {
    const prev = this.t[this.i - 1];
    return !prev || prev.line < this.peek().line;
  }

  /** `drawing <name> {` starts a drawing block; elsewhere "drawing" is an ordinary name. */
  atDrawing() {
    return this.is("ident", "drawing") && this.is("ident", undefined, 1) && this.is("op", "{", 2);
  }

  /** app "Control room" { ... } */
  atApp() {
    return this.is("ident", "app") && this.is("str", undefined, 1);
  }
  /** `frame <name> {` starts a frame of structural members; elsewhere "frame" is an ordinary name. */
  atFrame() {
    return this.is("ident", "frame") && this.is("ident", undefined, 1) && this.is("op", "{", 2);
  }

  /** `schematic {` lays out the design's schematic sheet; elsewhere "schematic" is an ordinary name. */
  atSchematic() {
    return this.is("ident", "schematic") && this.is("op", "{", 1);
  }

  /** `configs "Sizes" {` (or `configs {`) starts the design's configurations; elsewhere "configs" is an ordinary name. */
  atConfigs() {
    return this.is("ident", "configs") && ((this.is("str", undefined, 1) && this.is("op", "{", 2)) || this.is("op", "{", 1));
  }

  /** `fn name(`, `function name(` or `feature name(`: the design's own function or feature; elsewhere these are ordinary names. */
  atDef() {
    return this.is("ident") && DEF_WORDS.has(this.peek().value) && this.is("ident", undefined, 1) && this.is("op", "(", 2);
  }

  /** The parameters of a function or feature: `(at, d: 8, h = 10)`. A default is worked out each time it is used. */
  defParams(what: string): DefParam[] {
    this.expect("op", "(");
    const out: DefParam[] = [];
    while (!this.isOp(")")) {
      const tk = this.expect("ident", undefined, `a parameter name for ${what}`);
      let def: Expr | undefined;
      if (this.eat("op", ":") || this.eat("op", "=")) def = this.expr();
      if (out.some((p) => p.name === tk.value)) throw new ParseError(`${what} has two parameters named ${tk.value}`, tk.start, tk.end);
      out.push({ name: tk.value, ...(def ? { default: def } : {}), span: { start: tk.start, end: this.prevEnd() } });
      if (!this.eat("op", ",")) break;
    }
    this.expect("op", ")", `")" after ${what}'s parameters`);
    return out;
  }

  /**
   * fn area(w, h) = w * h
   * fn web(len, h: 8) "A stiffening web" { let t = max(1.2, h / 6)  box(len, t, h) }
   * feature boss(at, d: 8, h: 10) "A screw boss" { add cylinder(d: d, h: h, at: at) as post  fillet(0.5, edges: post.root) }
   */
  defStmt(): Stmt {
    const kw = this.next();
    const start = kw.start;
    const nameTk = this.expect("ident", undefined, kw.value === "feature" ? "a feature name" : "a function name");
    const what = `${nameTk.value}()`;
    const params = this.defParams(what);
    const doc = this.is("str") ? this.next().value : undefined;
    const nameSpan = { start: nameTk.start, end: nameTk.end };
    if (kw.value === "feature") {
      if (this.isOp("=")) throw new ParseError(`A feature is a block of steps: feature ${nameTk.value}(...) { add ... cut ... }. For a value, write fn ${nameTk.value}(...) = ...`, this.peek().start, this.peek().end);
      const items = this.block();
      return { k: "feature", name: nameTk.value, params, ...(doc !== undefined ? { doc } : {}), items, span: { start, end: this.prevEnd() }, nameSpan };
    }
    const lets: { name: string; value: Expr; span: Span }[] = [];
    let body: Expr;
    if (this.eat("op", "=")) body = this.expr();
    else {
      const open = this.expect("op", "{", `"=" and the value it gives, or "{" with lets and the value last, like fn area(w, h) = w * h`);
      for (;;) {
        while (this.eat("op", ";") || this.eat("op", ","));
        if (!this.is("kw", "let")) break;
        const l = this.next();
        const n = this.expect("ident");
        this.expect("op", "=");
        const value = this.expr();
        lets.push({ name: n.value, value, span: { start: l.start, end: this.prevEnd() } });
      }
      if (this.isOp("}") || this.is("eof")) throw new ParseError(`${what} needs the value it gives back as its last line, after its lets`, open.start, open.end);
      // `return x` reads as x
      if (this.is("ident", "return") && !this.isOp("}", 1) && !this.is("eof", undefined, 1) && this.peek(1).line === this.peek().line) this.next();
      body = this.expr();
      while (this.eat("op", ";") || this.eat("op", ","));
      this.expect("op", "}", `"}" to close ${what}: a function's last line is the value it gives back, and nothing comes after it`);
    }
    return { k: "fn", name: nameTk.value, params, ...(doc !== undefined ? { doc } : {}), lets, body, span: { start, end: this.prevEnd() }, nameSpan };
  }

  /** `mate against(...)` or `mate name = against(...)`: how two parts meet; elsewhere "mate" is an ordinary name. */
  atMate() {
    return this.is("ident", "mate") && this.is("ident", undefined, 1) && (this.is("op", "(", 2) || this.is("op", "=", 2));
  }

  /** wire a.X -> b.Y, net NAME: ..., firmware NAME { }, test "label": ... */
  machineStmtAhead(): boolean {
    const tk = this.peek();
    if (tk.kind !== "ident" || !MACHINE_STMTS.has(tk.value)) return false;
    switch (tk.value) {
      case "wire":
        return this.is("ident", undefined, 1);
      case "net":
        return this.is("ident", undefined, 1) && this.isOp(":", 2);
      case "firmware":
        return this.is("ident", undefined, 1) && this.isOp("{", 2);
      case "test":
      case "buy":
      case "scenario":
        return this.is("str", undefined, 1);
    }
    return false;
  }

  machineStmt(): Stmt {
    const tk = this.next();
    const start = tk.start;
    switch (tk.value) {
      case "wire": {
        const path = [this.pinRef()];
        this.expect("op", "->", '"->" between the two pins (wire ctrl.D5 -> driver.PWM)');
        path.push(this.pinRef());
        while (this.eat("op", "->")) path.push(this.pinRef());
        const items = this.isOp("{") ? this.block() : [];
        return { k: "wire", path, items, span: { start, end: this.prevEnd() } };
      }
      case "net": {
        const nameTk = this.expect("ident");
        this.expect("op", ":");
        const pins = [this.pinRef()];
        while (this.eat("op", ",")) pins.push(this.pinRef());
        const items = this.isOp("{") ? this.block() : [];
        return { k: "net", name: nameTk.value, pins, items, span: { start, end: this.prevEnd() }, nameSpan: { start: nameTk.start, end: nameTk.end } };
      }
      case "firmware": {
        const nameTk = this.expect("ident");
        const items = this.block();
        return { k: "firmware", name: nameTk.value, items, span: { start, end: this.prevEnd() }, nameSpan: { start: nameTk.start, end: nameTk.end } };
      }
      case "scenario":
        return this.scenario(start);
      case "buy": {
        const label = this.expect("str", undefined, "what to buy, in quotes").value;
        const items = this.isOp("{") ? this.block() : [];
        return { k: "buy", label, items, span: { start, end: this.prevEnd() } };
      }
      default: {
        const label = this.expect("str", undefined, "a test label in quotes").value;
        this.expect("op", ":");
        const procedure = this.expr();
        return { k: "test", label, procedure, span: { start, end: this.prevEnd() } };
      }
    }
  }

  /** scenario "label" [for use, ...] { world: ..., expect "label" [soft]: expr, ... } */
  scenario(start: number): Stmt {
    const labelTk = this.expect("str", undefined, "a scenario name in quotes");
    const uses: { name: string; span: Span }[] = [];
    if (this.eat("kw", "for")) {
      do {
        const u = this.expect("ident", undefined, "the name of a use from the brief");
        uses.push({ name: u.value, span: { start: u.start, end: u.end } });
      } while (this.eat("op", ","));
    }
    const open = this.expect("op", "{");
    const items: ScenarioItem[] = [];
    while (!this.isOp("}")) {
      if (this.is("eof")) throw new ParseError('Unclosed scenario block: missing "}"', open.start, open.end);
      const from = this.i;
      try {
        items.push(this.scenarioItem());
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.diagnostics.push({ message: e.message, start: e.start, end: e.end, severity: "error" });
        this.skipBriefEntry(from);
      }
      while (this.eat("op", ",") || this.eat("op", ";"));
    }
    this.expect("op", "}");
    return { k: "scenario", label: labelTk.value, uses, items, span: { start, end: this.prevEnd() }, labelSpan: { start: labelTk.start, end: labelTk.end } };
  }

  scenarioItem(): ScenarioItem {
    const tk = this.peek();
    const start = tk.start;
    if (tk.kind === "ident" && tk.value === "expect" && this.is("str", undefined, 1)) {
      this.next();
      const label = this.next().value;
      let level: "hard" | "soft" = "hard";
      if (this.eat("kw", "soft")) level = "soft";
      else this.eat("kw", "hard");
      this.expect("op", ":", '":" and what has to be true, e.g. expect "Gets through": through');
      const expr = this.expr();
      return { k: "expect", label, level, expr, span: { start, end: this.prevEnd() } };
    }
    if (this.eat("kw", "let")) {
      const nameTk = this.expect("ident");
      this.expect("op", "=");
      const value = this.expr();
      return { k: "let", name: nameTk.value, value, span: { start, end: this.prevEnd() } };
    }
    if ((tk.kind === "ident" || tk.kind === "kw") && this.isOp(":", 1)) {
      this.next();
      this.next();
      const value = this.expr();
      return { k: "prop", name: tk.value, value, span: { start, end: this.prevEnd() } };
    }
    throw new ParseError(`Expected a scenario entry such as world: sim.sand_pit(…), firmware: brain, or expect "…": …, but found "${tk.value || "end of file"}"`, tk.start, Math.max(tk.end, tk.start + 1));
  }

  /** component.PIN or component[2].PIN */
  pinRef(): Expr {
    const e = this.postfix();
    if (e.k === "member" && (e.obj.k === "ident" || (e.obj.k === "index" && e.obj.obj.k === "ident"))) return e;
    throw new ParseError("Expected a pin like ctrl.D5 or motor.M_PLUS", e.span.start, e.span.end);
  }

  stmt(): Stmt {
    const tk = this.peek();
    if (this.atDrawing()) {
      const start = tk.start;
      this.next();
      const nameTk = this.expect("ident", undefined, "a drawing name");
      const items = this.block();
      return { k: "drawing", name: nameTk.value, items, span: { start, end: this.prevEnd() }, nameSpan: { start: nameTk.start, end: nameTk.end } };
    }
    if (this.atApp()) {
      const start = tk.start;
      this.next();
      const labelTk = this.expect("str", undefined, 'an app name in quotes, like app "Control room" { ... }');
      const items = this.block();
      return { k: "app", label: labelTk.value, items, span: { start, end: this.prevEnd() }, labelSpan: { start: labelTk.start, end: labelTk.end } };
    }
    if (this.atFrame()) {
      const start = tk.start;
      this.next();
      const nameTk = this.expect("ident", undefined, "a frame name");
      const items = this.block();
      return { k: "frame", name: nameTk.value, items, span: { start, end: this.prevEnd() }, nameSpan: { start: nameTk.start, end: nameTk.end } };
    }
    if (this.atConfigs()) {
      const start = tk.start;
      this.next();
      return this.configs(start);
    }
    if (this.atSchematic()) {
      const start = tk.start;
      this.next();
      return this.schematic(start);
    }
    if (this.atMate()) {
      const start = tk.start;
      this.next();
      let name: string | undefined;
      let nameSpan: Span | undefined;
      if (this.is("op", "=", 1)) {
        const nameTk = this.expect("ident", undefined, "a mate name");
        name = nameTk.value;
        nameSpan = { start: nameTk.start, end: nameTk.end };
        this.expect("op", "=");
      }
      const call = this.expr();
      if (call.k !== "call") throw new ParseError("A mate is one of against(), flush(), concentric(), pin(), distance(), angle(), parallel(), perpendicular(), tangent(), coincident() or rigid(), like mate against(face(lid, -Z), face(box, +Z))", call.span.start, call.span.end);
      return { k: "mate", ...(name ? { name, nameSpan } : {}), call, span: { start, end: this.prevEnd() } };
    }
    if (this.atDef()) return this.defStmt();
    if (this.machineStmtAhead()) return this.machineStmt();
    if (tk.kind !== "kw" || !TOP_LEVEL.has(tk.value)) {
      throw new ParseError(
        `Expected a top-level statement (brief, param, let, fn, feature, component, interface, part, sketch, require, decision, analysis, drawing, frame, mate, configs, schematic, wire, net, firmware, test, buy, scenario, app) but found "${tk.value}"`,
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
      case "brief":
        return { k: "brief", items: this.briefBlock(), span: { start, end: this.prevEnd() } };
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
      case "sketch": {
        const nameTk = this.expect("ident");
        const open = this.expect("op", "{");
        const items: SketchItem[] = [];
        for (;;) {
          while (this.eat("op", ";"));
          if (this.isOp("}")) break;
          if (this.is("eof")) throw new ParseError('Unclosed sketch: missing "}"', open.start, open.end);
          items.push(this.sketchItem());
        }
        const close = this.expect("op", "}");
        return { k: "sketch", name: nameTk.value, items, span: { start, end: this.prevEnd() }, nameSpan: { start: nameTk.start, end: nameTk.end }, bodyEnd: close.start };
      }
      case "require": {
        const label = this.expect("str", undefined, "a requirement label in quotes").value;
        let level: "hard" | "soft" = "hard";
        if (this.eat("kw", "soft")) level = "soft";
        else this.eat("kw", "hard");
        const uses: { name: string; span: Span }[] = [];
        if (this.eat("kw", "for")) {
          do {
            const u = this.expect("ident", undefined, "the name of a use from the brief");
            uses.push({ name: u.value, span: { start: u.start, end: u.end } });
          } while (this.eat("op", ","));
        }
        this.expect("op", ":");
        const expr = this.expr();
        return { k: "require", label, level, uses, expr, span: { start, end: this.prevEnd() } };
      }
      case "decision":
        return this.decision(start);
      case "analysis": {
        const labelTk = this.expect("str", undefined, 'an analysis name in quotes, like analysis "Shelf load" { ... }');
        const items = this.block();
        return { k: "analysis", label: labelTk.value, items, span: { start, end: this.prevEnd() }, labelSpan: { start: labelTk.start, end: labelTk.end } };
      }
    }
    throw new ParseError("Unknown statement", tk.start, tk.end);
  }

  // ---- the brief ----

  /** Parses `{ entries }`. A bad entry is reported and skipped so the rest of the brief still counts. */
  briefBlock(): BriefItem[] {
    const open = this.expect("op", "{");
    const items: BriefItem[] = [];
    while (!this.isOp("}")) {
      if (this.is("eof")) throw new ParseError('Unclosed brief block: missing "}"', open.start, open.end);
      const from = this.i;
      try {
        items.push(this.briefItem());
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.diagnostics.push({ message: e.message, start: e.start, end: e.end, severity: "error" });
        this.skipBriefEntry(from);
      }
      while (this.eat("op", ",") || this.eat("op", ";"));
    }
    this.expect("op", "}");
    return items;
  }

  /** After a bad entry: move to the next line inside the brief, or to its closing brace. */
  skipBriefEntry(from: number) {
    const line = this.t[from].line;
    let depth = 0;
    if (this.i === from) this.i++;
    for (let j = from; j < this.i; j++) {
      const tk = this.t[j];
      if (tk.kind === "op" && tk.value === "{") depth++;
      if (tk.kind === "op" && tk.value === "}") depth--;
    }
    while (!this.is("eof")) {
      const tk = this.peek();
      if (depth <= 0 && tk.kind === "op" && tk.value === "}") return;
      if (depth <= 0 && tk.line > line) return;
      if (tk.kind === "op" && tk.value === "{") depth++;
      if (tk.kind === "op" && tk.value === "}") depth--;
      this.i++;
    }
  }

  /** A trailing flag word such as `assumed`, only when it sits on the same line as what it marks. */
  sameLineFlag(word: string): boolean {
    if (this.is("ident", word) && this.peek().line === this.t[this.i - 1]?.line) {
      this.next();
      return true;
    }
    return false;
  }

  briefItem(): BriefItem {
    const tk = this.peek();
    const start = tk.start;
    if (tk.kind !== "ident" && tk.kind !== "kw") {
      throw new ParseError(`Expected a brief entry such as purpose: "…", use, given, reference or assume, but found "${tk.value || "end of file"}"`, tk.start, Math.max(tk.end, tk.start + 1));
    }
    if (this.isOp(":", 1)) {
      this.next();
      this.next();
      const value = this.expr();
      let to: Expr | undefined;
      if (this.eat("op", "..")) to = this.expr();
      const assumed = this.sameLineFlag("assumed");
      return { k: "field", name: tk.value, value, to, assumed, span: { start, end: this.prevEnd() }, nameSpan: { start: tk.start, end: tk.end } };
    }
    if (tk.kind === "ident" && BRIEF_ENTRIES.has(tk.value)) {
      this.next();
      switch (tk.value) {
        case "use": {
          const id = this.expect("ident", undefined, "a short name for the use, like hold_tube");
          const text = this.expect("str", undefined, "what the design must do, in quotes").value;
          const props = this.isOp("{") ? this.briefProps() : [];
          const assumed = this.sameLineFlag("assumed");
          return { k: "use", id: id.value, text, props, assumed, span: { start, end: this.prevEnd() }, idSpan: { start: id.start, end: id.end } };
        }
        case "given": {
          const nameTk = this.expect("ident", undefined, "a name for the dimension, like tube_d");
          this.expect("op", "=");
          const vStart = this.peek().start;
          const value = this.expr();
          const valueSpan = { start: vStart, end: this.prevEnd() };
          let desc: string | undefined;
          if (this.is("str") && this.peek().line === this.t[this.i - 1].line) desc = this.next().value;
          const assumed = this.sameLineFlag("assumed");
          return { k: "given", name: nameTk.value, value, desc, assumed, span: { start, end: this.prevEnd() }, nameSpan: { start: nameTk.start, end: nameTk.end }, valueSpan };
        }
        case "reference": {
          const id = this.expect("ident", undefined, "a short name for the reference, like photo1");
          const title = this.expect("str", undefined, "a title in quotes").value;
          const props = this.isOp("{") ? this.briefProps() : [];
          return { k: "reference", id: id.value, title, props, span: { start, end: this.prevEnd() }, idSpan: { start: id.start, end: id.end } };
        }
        case "assume": {
          const text = this.expect("str", undefined, "the assumption in quotes").value;
          const confirmed = this.sameLineFlag("confirmed");
          return { k: "assume", text, confirmed, span: { start, end: this.prevEnd() } };
        }
      }
    }
    throw new ParseError(`Unknown brief entry "${tk.value}". Use a field such as purpose: "…", or use, given, reference or assume.`, tk.start, Math.max(tk.end, tk.start + 1));
  }

  briefProps(): BriefProp[] {
    const open = this.expect("op", "{");
    const props: BriefProp[] = [];
    while (!this.isOp("}")) {
      if (this.is("eof")) throw new ParseError('Unclosed "{" in the brief', open.start, open.end);
      const f = this.peek();
      if (f.kind !== "ident" && f.kind !== "kw") this.expect("ident", undefined, "a property name");
      this.next();
      this.expect("op", ":");
      const value = this.expr();
      props.push({ name: f.value, value, span: { start: f.start, end: this.prevEnd() } });
      while (this.eat("op", ",") || this.eat("op", ";"));
    }
    this.expect("op", "}");
    return props;
  }

  /**
   * decision name "Title" {
   *   ask: "..."  chose: "..."  by: "you"  why: "..."
   *   option "Label" { param: value, ... } "What happens if chosen"
   * }
   */
  decision(start: number): Stmt {
    const nameTk = this.expect("ident", undefined, "a decision name, e.g. lid_fastening");
    const title = this.expect("str", undefined, "a decision title in quotes").value;
    const open = this.expect("op", "{");
    const props: { name: string; value: Expr; span: Span }[] = [];
    const options: DecisionOptionNode[] = [];
    while (!this.isOp("}")) {
      if (this.is("eof")) throw new ParseError("Unclosed decision block: missing \"}\"", open.start, open.end);
      const tk = this.peek();
      if (tk.kind === "ident" && tk.value === "option" && this.is("str", undefined, 1)) {
        this.next();
        const label = this.next().value;
        let note: string | undefined;
        const sets: { param: string; value: Expr; span: Span }[] = [];
        let gotSets = false;
        for (;;) {
          if (this.is("str") && note === undefined) note = this.next().value;
          else if (this.isOp("{") && !gotSets) {
            gotSets = true;
            this.next();
            while (!this.isOp("}")) {
              if (this.is("eof")) throw new ParseError("Unclosed option values: missing \"}\"", tk.start, tk.end);
              const key = this.expect("ident", undefined, "a parameter name");
              if (!this.eat("op", "=")) this.expect("op", ":", '":" or "="');
              const value = this.expr();
              sets.push({ param: key.value, value, span: { start: key.start, end: this.prevEnd() } });
              while (this.eat("op", ",") || this.eat("op", ";"));
            }
            this.expect("op", "}");
          } else break;
        }
        options.push({ label, note, sets, span: { start: tk.start, end: this.prevEnd() } });
      } else if (tk.kind === "ident" && this.isOp(":", 1)) {
        this.next();
        this.next();
        const value = this.expr();
        props.push({ name: tk.value, value, span: { start: tk.start, end: this.prevEnd() } });
      } else {
        throw new ParseError(
          `Unexpected "${tk.value || "end of file"}" inside decision. Use ask:, chose:, by:, why: or option "Label" { param: value } "consequence".`,
          tk.start,
          Math.max(tk.end, tk.start + 1),
        );
      }
      while (this.eat("op", ",") || this.eat("op", ";"));
    }
    this.expect("op", "}");
    return { k: "decision", name: nameTk.value, title, props, options, span: { start, end: this.prevEnd() }, nameSpan: { start: nameTk.start, end: nameTk.end }, bodyStart: open.end };
  }

  /**
   * configs "Sizes" {
   *   show: "Medium"
   *   config "Small" { width: 40, depth: 30 } "What it is for"
   * }
   */
  configs(start: number): Stmt {
    const title = this.is("str") ? this.next().value : "Configurations";
    const open = this.expect("op", "{");
    const props: { name: string; value: Expr; span: Span }[] = [];
    const rows: ConfigRowNode[] = [];
    while (!this.isOp("}")) {
      if (this.is("eof")) throw new ParseError('Unclosed configs block: missing "}"', open.start, open.end);
      const tk = this.peek();
      if (tk.kind === "ident" && tk.value === "config" && this.is("str", undefined, 1)) {
        this.next();
        const label = this.next().value;
        const brace = this.expect("op", "{", '"{" and the parameter values, like config "Large" { width: 80 }');
        const sets: { param: string; value: Expr; span: Span }[] = [];
        while (!this.isOp("}")) {
          if (this.is("eof")) throw new ParseError("Unclosed configuration values: missing \"}\"", tk.start, tk.end);
          const key = this.expect("ident", undefined, "a parameter name");
          if (!this.eat("op", "=")) this.expect("op", ":", '":" or "="');
          const value = this.expr();
          sets.push({ param: key.value, value, span: { start: key.start, end: this.prevEnd() } });
          while (this.eat("op", ",") || this.eat("op", ";"));
        }
        this.expect("op", "}");
        const note = this.is("str") ? this.next().value : undefined;
        rows.push({ label, ...(note !== undefined ? { note } : {}), sets, span: { start: tk.start, end: this.prevEnd() }, setsStart: brace.end });
      } else if ((tk.kind === "ident" || tk.kind === "kw") && this.isOp(":", 1)) {
        this.next();
        this.next();
        const value = this.expr();
        props.push({ name: tk.value, value, span: { start: tk.start, end: this.prevEnd() } });
      } else {
        throw new ParseError(`Unexpected "${tk.value || "end of file"}" inside configs. Use show: "Label" or config "Label" { param: value } "what it is for".`, tk.start, Math.max(tk.end, tk.start + 1));
      }
      while (this.eat("op", ",") || this.eat("op", ";"));
    }
    this.expect("op", "}");
    return { k: "configs", title, props, rows, span: { start, end: this.prevEnd() }, bodyStart: open.end };
  }

  schematic(start: number): Stmt {
    const open = this.expect("op", "{");
    const places: { name: string; value: Expr; span: Span }[] = [];
    while (!this.isOp("}")) {
      if (this.is("eof")) throw new ParseError('Unclosed schematic block: missing "}"', open.start, open.end);
      const tk = this.peek();
      // one of a patterned part's copies: leds[2]: (40, 60)
      const copy = tk.kind === "ident" && this.isOp("[", 1) && this.is("num", undefined, 2) && this.isOp("]", 3) && this.isOp(":", 4);
      if (((tk.kind === "ident" || tk.kind === "kw") && this.isOp(":", 1)) || copy) {
        this.next();
        let name = tk.value;
        if (copy) {
          this.next();
          name = `${tk.value}[${Number(this.next().value)}]`;
          this.next();
        }
        this.next();
        const value = this.expr();
        places.push({ name, value, span: { start: tk.start, end: this.prevEnd() } });
      } else throw new ParseError(`Unexpected "${tk.value || "end of file"}" inside schematic. Give each part's place on the sheet, like ctrl: (40, 60), or drv: (160, 60, 90) to turn it a quarter turn.`, tk.start, Math.max(tk.end, tk.start + 1));
      while (this.eat("op", ",") || this.eat("op", ";"));
    }
    this.expect("op", "}");
    return { k: "schematic", places, span: { start, end: this.prevEnd() }, bodyStart: open.end };
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
        case "note":
          // note("...") inside a drawing block
          if (this.isOp("(", 1)) {
            const kw = this.next();
            const call = this.callTail({ k: "ident", name: "note", span: { start: kw.start, end: kw.end } });
            return { k: "modifier", call, span: { start, end: this.prevEnd() } };
          }
          break;
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
        // a use of the design's own feature can be named: boss((10, 10, 3)) as big
        if (this.eat("kw", "as")) {
          const n = this.expect("ident", undefined, 'a name after "as"');
          return { k: "modifier", call, name: n.value, nameSpan: { start: n.start, end: n.end }, span: { start, end: this.prevEnd() } };
        }
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

  /**
   * One statement inside a sketch block:
   *   plane: XY                         property
   *   let r = 4                         local value
   *   [construction] point|line|circle|arc name = ...
   *   horizontal l1, l3                 constraint (names are checked by the evaluator)
   *   length l1 = width                 dimension
   */
  sketchItem(): SketchItem {
    const tk = this.peek();
    const start = tk.start;
    if (tk.kind === "kw" && tk.value === "let") {
      this.next();
      const name = this.expect("ident").value;
      this.expect("op", "=");
      const value = this.expr();
      return { k: "let", name, value, span: { start, end: this.prevEnd() } };
    }
    if (tk.kind === "kw" && tk.value === "locked") {
      this.next();
      return { k: "flag", name: "locked", span: { start, end: this.prevEnd() } };
    }
    if (tk.kind !== "ident") {
      throw new ParseError(
        `Unexpected "${tk.value || "end of file"}" inside sketch. Use point, line, circle, arc, spline or ellipse to add geometry, a constraint like horizontal l1, a dimension like length l1 = 20, or a property like plane: XY.`,
        tk.start,
        Math.max(tk.end, tk.start + 1),
      );
    }
    if (this.isOp(":", 1)) {
      this.next();
      this.next();
      const value = this.expr();
      return { k: "prop", name: tk.value, value, span: { start, end: this.prevEnd() } };
    }
    let construction = false;
    let kindTk = tk;
    if (tk.value === "construction" && this.is("ident", undefined, 1)) {
      construction = true;
      this.next();
      kindTk = this.peek();
    }
    if (SKETCH_ENTITIES.has(kindTk.value as SketchEntityKind) && this.is("ident", undefined, 1) && this.isOp("=", 2)) {
      this.next();
      const kind = kindTk.value as SketchEntityKind;
      const nameTk = this.next();
      this.next(); // "="
      const args: Expr[] = [];
      let size: { which: "r" | "d"; value: Expr } | undefined;
      let opts: { name: string; value: Expr; span: Span; nameSpan: Span }[] | undefined;
      /** name: value pairs after the points, until the end of the statement */
      const namedOpts = () => {
        const out: { name: string; value: Expr; span: Span; nameSpan: Span }[] = [];
        do {
          const at = this.peek();
          if (!(at.kind === "ident" && this.isOp(":", 1))) throw new ParseError(`Expected a named option like ${kind === "ellipse" ? "rx: 20" : "closed: true"}`, at.start, Math.max(at.end, at.start + 1));
          this.next();
          this.next();
          const value = this.expr();
          out.push({ name: at.value, value, span: { start: at.start, end: this.prevEnd() }, nameSpan: { start: at.start, end: at.end } });
        } while (this.eat("op", ","));
        return out;
      };
      if (kind === "point") args.push(this.expr());
      else if (kind === "spline") {
        // its points in order, then options: spline s1 = (0, 0), (10, 8), p3, closed: true
        do {
          const at = this.peek();
          if (at.kind === "ident" && this.isOp(":", 1)) {
            opts = namedOpts();
            break;
          }
          args.push(this.expr());
        } while (this.eat("op", ","));
      } else if (kind === "ellipse") {
        args.push(this.expr());
        this.expect("op", ",", '", rx: ..., ry: ..." after the ellipse\'s center');
        opts = namedOpts();
      } else if (kind === "line" || kind === "arc") {
        args.push(this.expr());
        this.expect("op", "->", `"->" between the ${kind}'s start and end`);
        args.push(this.expr());
        if (kind === "arc") {
          this.expect("op", ",", '", center: ..." after the arc\'s end point');
          const c = this.expect("ident", undefined, "center:");
          if (c.value !== "center") throw new ParseError(`Expected "center:" but found "${c.value}"`, c.start, c.end);
          this.expect("op", ":");
          args.push(this.expr());
        }
      } else {
        args.push(this.expr());
        this.expect("op", ",", '", r: ..." or ", d: ..." after the circle\'s center');
        const w = this.expect("ident", undefined, "r: or d:");
        if (w.value !== "r" && w.value !== "d") throw new ParseError(`Expected "r:" (radius) or "d:" (diameter) but found "${w.value}"`, w.start, w.end);
        this.expect("op", ":");
        size = { which: w.value, value: this.expr() };
      }
      return { k: "entity", kind, name: nameTk.value, construction, args, size, opts, span: { start, end: this.prevEnd() }, nameSpan: { start: nameTk.start, end: nameTk.end } };
    }
    if (construction) throw new ParseError('"construction" must be followed by point, line, circle, arc, spline or ellipse', tk.start, tk.end);
    // constraint or dimension: name ref, ref [, key: value …] [= value]
    this.next();
    const refs: Expr[] = [];
    const opts: { name: string; value: Expr; span: Span; nameSpan: Span }[] = [];
    if (!this.atLineStart() && !this.isOp("}") && !this.isOp("=")) {
      do {
        const at = this.peek();
        if (at.kind === "ident" && this.isOp(":", 1)) {
          this.next();
          this.next();
          const value = this.expr();
          opts.push({ name: at.value, value, span: { start: at.start, end: this.prevEnd() }, nameSpan: { start: at.start, end: at.end } });
        } else {
          if (opts.length) throw new ParseError(`Put the geometry before the named options (${opts[0].name}: …)`, at.start, Math.max(at.end, at.start + 1));
          refs.push(this.expr());
        }
      } while (this.eat("op", ","));
    }
    let value: Expr | undefined;
    if (this.eat("op", "=")) value = this.expr();
    return { k: "constraint", name: tk.value, refs, value, opts: opts.length ? opts : undefined, span: { start, end: this.prevEnd() }, nameSpan: { start: tk.start, end: tk.end } };
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
  /** The argument list of a call on callee, starting at "(". */
  callTail(callee: Expr): Expr & { k: "call" } {
    this.expect("op", "(");
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
    return { k: "call", callee, args, span: { start: callee.span.start, end: this.prevEnd() } };
  }
  postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.isOp("(")) {
        e = this.callTail(e);
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
        // design("name"): another design placed as a component (a design "name" line is a statement, with no bracket)
        if (tk.value === "design" && this.isOp("(", 1)) {
          this.next();
          return { k: "ident", name: "design", span };
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
          // the span covers the parentheses, so the source text of a grouped expression reads whole
          return { ...first, span: { start: tk.start, end: this.prevEnd() } };
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
