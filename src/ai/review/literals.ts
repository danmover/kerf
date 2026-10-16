// Finds dimensions typed straight into part geometry instead of coming from
// a named parameter, derived value or interface. Each one is a number nobody
// can trace back to a reason ("why 26 mm?"), and a value a revision will miss.

import { parse } from "../../lang/parser";
import { lineCol } from "../../lang/lexer";
import type { Expr, Item, Stmt } from "../../lang/ast";
import type { Literal } from "./types";

/** Calls whose numeric arguments are counts or indices, not dimensions. */
const COUNT_CALLS = new Set(["range", "round", "floor", "ceil", "min", "max"]);
/** Part properties that never hold dimensions. */
const SKIP_PROPS = new Set(["color", "material", "group", "label", "spin"]);

export function unexplainedLiterals(src: string, limit = 80): Literal[] {
  const { program } = parse(src);
  const out: Literal[] = [];
  const lines = src.split("\n");
  const add = (part: string, e: Expr & { k: "num" }) => {
    const { line } = lineCol(src, e.span.start);
    const value = src.slice(e.span.start, e.span.end);
    // the same number twice on one line is one decision
    if (out.some((l) => l.part === part && l.line === line && l.value === value)) return;
    out.push({ part, line, value, context: (lines[line - 1] ?? "").trim().slice(0, 140) });
  };

  const expr = (part: string, e: Expr, parent?: Expr) => {
    switch (e.k) {
      case "num": {
        const v = Math.abs(e.v);
        // zero, overlap epsilons and small scale factors (2 * wall, d / 2) explain themselves
        if (v < 0.2) return;
        if (parent?.k === "binary" && (parent.op === "*" || parent.op === "/") && Number.isInteger(v) && v <= 4) return;
        if (e.unit === "deg" || (parent?.k === "unary" && v % 90 === 0)) return;
        add(part, e);
        return;
      }
      case "vec":
      case "list":
        for (const it of e.items) expr(part, it, e);
        return;
      case "unary":
        expr(part, e.arg, e);
        return;
      case "binary":
        expr(part, e.left, e);
        expr(part, e.right, e);
        return;
      case "ternary":
        expr(part, e.cond, e);
        expr(part, e.a, e);
        expr(part, e.b, e);
        return;
      case "member":
        expr(part, e.obj, e);
        return;
      case "index":
        expr(part, e.obj, e);
        return;
      case "call": {
        const name = e.callee.k === "ident" ? e.callee.name : "";
        if (COUNT_CALLS.has(name)) return;
        for (const a of e.args) {
          // hole(M3, fit: "insert") style options and angles are not dimensions
          if (a.name === "rot" || a.name === "angle" || a.name === "teeth" || a.name === "z") continue;
          expr(part, a.value, e);
        }
        return;
      }
      default:
        return;
    }
  };

  const items = (part: string, list: Item[]) => {
    for (const it of list) {
      switch (it.k) {
        case "prop":
          if (!SKIP_PROPS.has(it.name) && it.name !== "rotate") expr(part, it.value);
          break;
        case "op":
          expr(part, it.shape);
          break;
        case "modifier":
          expr(part, it.call);
          break;
        case "for":
          items(part, it.body);
          break;
        case "if":
          items(part, it.then);
          if (it.else) items(part, it.else);
          break;
        case "let":
          // a named local explains its own value
          break;
        default:
          break;
      }
    }
  };

  for (const s of program.stmts as Stmt[]) {
    if (s.k === "part") items(s.name, s.items);
  }
  return out.slice(0, limit);
}
