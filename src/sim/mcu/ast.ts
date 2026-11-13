// Syntax tree for the C/C++ subset the virtual microcontroller runs: what
// Arduino sketches use (functions, globals, structs, enums, arrays, pointers
// and references, static locals, switch, casts, function pointers), not templates or classes.

import type { CType } from "./ctypes";

export interface Pos {
  file: string;
  line: number;
}

export type Expr = Pos &
  (
    | { k: "num"; v: number; type: CType }
    | { k: "str"; bytes: number[] }
    | { k: "id"; name: string }
    | { k: "bin"; op: string; a: Expr; b: Expr }
    | { k: "logic"; op: "&&" | "||"; a: Expr; b: Expr }
    | { k: "un"; op: "-" | "+" | "!" | "~" | "*" | "&" | "++" | "--"; a: Expr }
    | { k: "post"; op: "++" | "--"; a: Expr }
    | { k: "assign"; op: string; a: Expr; b: Expr }
    | { k: "cond"; c: Expr; a: Expr; b: Expr }
    | { k: "call"; fn: Expr; args: Expr[] }
    | { k: "idx"; a: Expr; i: Expr }
    /** targs: a library method's template arguments, worked out while parsing (FastLED.addLeds<WS2812B, 6, GRB>) */
    | { k: "mem"; a: Expr; name: string; arrow: boolean; targs?: number[] }
    | { k: "cast"; type: CType; a: Expr }
    | { k: "sizeofT"; type: CType }
    | { k: "sizeofE"; a: Expr }
    | { k: "comma"; a: Expr; b: Expr }
    | { k: "init"; items: Expr[] }
  );

export interface VarDecl extends Pos {
  name: string;
  type: CType;
  init?: Expr;
  storage: "static" | "extern" | "auto";
  isConst: boolean;
}

export type Stmt = Pos &
  (
    | { k: "block"; body: Stmt[] }
    | { k: "expr"; e: Expr }
    | { k: "decl"; vars: VarDecl[] }
    | { k: "if"; c: Expr; t: Stmt; e?: Stmt }
    | { k: "while"; c: Expr; body: Stmt }
    | { k: "do"; body: Stmt; c: Expr }
    | { k: "for"; init?: Stmt; c?: Expr; step?: Expr; body: Stmt }
    | { k: "switch"; e: Expr; body: Stmt[] }
    | { k: "case"; v: Expr }
    | { k: "default" }
    | { k: "break" }
    | { k: "continue" }
    | { k: "return"; e?: Expr }
    | { k: "empty" }
  );

export interface Param {
  name?: string;
  type: CType;
}

export interface FuncDef extends Pos {
  name: string;
  ret: CType;
  params: Param[];
  body?: Extract<Stmt, { k: "block" }>;
  isStatic: boolean;
}

export interface Program {
  globals: VarDecl[];
  funcs: Map<string, FuncDef>;
  /** enum constants: name -> value and the enum's type */
  consts: Map<string, { v: number; type: CType }>;
  /** string literals' total size outside F() (they take RAM on AVR) */
  ramStrings: number;
  /** every struct type by name, the libraries' (CRGB) among them */
  structs: Map<string, Extract<CType, { k: "struct" }>>;
}
