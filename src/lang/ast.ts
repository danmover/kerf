// AST for the Kerf design language.

export interface Span {
  start: number;
  end: number;
}

export type Expr =
  | { k: "num"; v: number; unit?: string; span: Span }
  | { k: "str"; v: string; span: Span }
  | { k: "color"; v: string; span: Span }
  | { k: "bool"; v: boolean; span: Span }
  | { k: "ident"; name: string; span: Span }
  | { k: "vec"; items: Expr[]; span: Span }
  | { k: "list"; items: Expr[]; span: Span }
  | { k: "unary"; op: string; arg: Expr; span: Span }
  | { k: "binary"; op: string; left: Expr; right: Expr; span: Span }
  | { k: "ternary"; cond: Expr; a: Expr; b: Expr; span: Span }
  | { k: "member"; obj: Expr; name: string; span: Span }
  | { k: "index"; obj: Expr; index: Expr; span: Span }
  | { k: "call"; callee: Expr; args: Arg[]; span: Span };

export interface Arg {
  name?: string;
  value: Expr;
  span: Span;
}

/** Statements allowed inside part / component blocks. */
export type Item =
  | { k: "prop"; name: string; value: Expr; span: Span }
  | { k: "flag"; name: string; span: Span }
  | { k: "op"; op: "body" | "add" | "cut" | "intersect"; shape: Expr; span: Span }
  | { k: "modifier"; call: Expr & { k: "call" }; span: Span }
  | { k: "for"; varName: string; iter: Expr; body: Item[]; span: Span }
  | { k: "if"; cond: Expr; then: Item[]; else?: Item[]; span: Span }
  | { k: "let"; name: string; value: Expr; span: Span };

/** A `name: value` pair inside a brief entry's braces, e.g. `{ load: 30N, dir: -Z }`. */
export interface BriefProp {
  name: string;
  value: Expr;
  span: Span;
}

/** Entries of the `brief { ... }` block: what the design is for and what it must survive. */
export type BriefItem =
  | { k: "field"; name: string; value: Expr; to?: Expr; assumed: boolean; span: Span; nameSpan: Span }
  | { k: "use"; id: string; text: string; props: BriefProp[]; assumed: boolean; span: Span; idSpan: Span }
  | { k: "given"; name: string; value: Expr; desc?: string; assumed: boolean; span: Span; nameSpan: Span; valueSpan: Span }
  | { k: "reference"; id: string; title: string; props: BriefProp[]; span: Span; idSpan: Span }
  | { k: "assume"; text: string; confirmed: boolean; span: Span };

export type Stmt =
  | { k: "design"; name: string; span: Span }
  | { k: "brief"; items: BriefItem[]; span: Span }
  | { k: "note"; text: string; span: Span }
  | {
      k: "param";
      name: string;
      value: Expr;
      min?: Expr;
      max?: Expr;
      desc?: string;
      locked: boolean;
      span: Span;
      nameSpan: Span;
      valueSpan: Span;
    }
  | { k: "let"; name: string; value: Expr; span: Span; nameSpan: Span }
  | {
      k: "component";
      name: string;
      call: Expr & { k: "call" };
      items: Item[];
      span: Span;
      nameSpan: Span;
    }
  | {
      k: "interface";
      name: string;
      fields: { name: string; value: Expr; span: Span }[];
      span: Span;
      nameSpan: Span;
    }
  | { k: "part"; name: string; items: Item[]; span: Span; nameSpan: Span }
  | { k: "drawing"; name: string; items: Item[]; span: Span; nameSpan: Span }
  | {
      k: "require";
      label: string;
      level: "hard" | "soft";
      /** brief uses this requirement checks (`require "..." for hold_tube: ...`) */
      uses: { name: string; span: Span }[];
      expr: Expr;
      span: Span;
    }
  | {
      k: "decision";
      name: string;
      title: string;
      props: { name: string; value: Expr; span: Span }[];
      options: DecisionOptionNode[];
      span: Span;
      nameSpan: Span;
      /** offset just after the opening brace */
      bodyStart: number;
    }
  | {
      k: "sketch";
      name: string;
      items: SketchItem[];
      span: Span;
      nameSpan: Span;
      /** offset of the closing brace, where new items are inserted */
      bodyEnd: number;
    }
  | { k: "analysis"; label: string; items: Item[]; span: Span; labelSpan: Span };

/** Geometry declared in a sketch: points, lines, circles and arcs. */
export type SketchEntityKind = "point" | "line" | "circle" | "arc";

/** Statements inside a sketch block. */
export type SketchItem =
  | { k: "prop"; name: string; value: Expr; span: Span }
  | { k: "let"; name: string; value: Expr; span: Span }
  | { k: "flag"; name: string; span: Span }
  | {
      k: "entity";
      kind: SketchEntityKind;
      name: string;
      construction: boolean;
      /** point: [position]; line: [start, end]; circle: [center]; arc: [start, end, center] */
      args: Expr[];
      /** circle size as written: r: or d: */
      size?: { which: "r" | "d"; value: Expr };
      span: Span;
      nameSpan: Span;
    }
  | {
      k: "constraint";
      name: string;
      refs: Expr[];
      value?: Expr;
      span: Span;
      nameSpan: Span;
    };

/** One alternative of a decision: a label, an optional consequence and the parameter values it means. */
export interface DecisionOptionNode {
  label: string;
  note?: string;
  sets: { param: string; value: Expr; span: Span }[];
  span: Span;
}

export interface Program {
  stmts: Stmt[];
}

/** Name of a top-level block, used for block-level edits and locking. */
export function stmtName(s: Stmt): string | undefined {
  switch (s.k) {
    case "param":
    case "let":
    case "component":
    case "interface":
    case "part":
    case "sketch":
    case "drawing":
      return s.name;
    case "require":
    case "analysis":
      return s.label;
    case "decision":
      return s.name;
    default:
      return undefined;
  }
}
