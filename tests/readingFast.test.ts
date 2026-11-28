// Reading a design is done again at every edit, so its two busiest pieces were made quicker: the lexer tells what a
// character is by its code, and a recipe is written out for hashing without building lists to join. Neither may
// change what it gives. A token that moved would move every diagnostic, and a hash that changed would orphan every
// part kept from an earlier session.

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lex, LexError, type Token } from "../src/lang/lexer";
import { hashString, recipeHash, stableStringify } from "../src/kernel/recipe";
import { evaluate } from "../src/lang/evaluator";

const kinds = (src: string) => lex(src).map((t) => `${t.kind}:${t.value}`);
const failure = (src: string) => {
  try {
    lex(src);
  } catch (e) {
    if (e instanceof LexError) return [e.message.split(".")[0], e.start, e.end];
    throw e;
  }
  return null;
};

describe("the lexer, telling characters by their codes", () => {
  it("takes the longer operator where two fit, and each single one", () => {
    expect(kinds("a->b..c==d!=e<=f>=g&&h||i").filter((k) => k.startsWith("op"))).toEqual(["op:->", "op:..", "op:==", "op:!=", "op:<=", "op:>=", "op:&&", "op:||"]);
    expect(kinds("+-*/^()[]{},:.=<>!?;").slice(0, -1)).toEqual([..."+-*/^()[]{},:.=<>!?;"].map((c) => `op:${c}`));
    // a lone & or | is not an operator
    expect(failure("a & b")).toEqual(['Unexpected character "&"', 2, 3]);
    expect(failure("a | b")).toEqual(['Unexpected character "|"', 2, 3]);
  });

  it("reads numbers with their units, and ranges without swallowing the dots", () => {
    const num = (src: string) => lex(src).filter((t) => t.kind === "num").map((t) => [t.value, t.num, t.unit]);
    expect(num("5mm 2.5cm .5 1e3 1.5e-2m 40% 3kg 7")).toEqual([
      ["5mm", 5, "mm"],
      ["2.5cm", 25, "cm"],
      [".5", 0.5, undefined],
      ["1e3", 1000, undefined],
      ["1.5e-2m", 15, "m"],
      ["40%", 0.4, "%"],
      ["3kg", 3000, "kg"],
      ["7", 7, undefined],
    ]);
    expect(kinds("1..5")).toEqual(["num:1", "op:..", "num:5", "eof:"]);
    expect(kinds("a.5")).toEqual(["ident:a", "num:.5", "eof:"]);
    expect(kinds("2.x")).toEqual(["num:2", "op:.", "ident:x", "eof:"]);
    expect(kinds("2. ")).toEqual(["num:2.", "eof:"]);
    // every number token says its unit, even when it has none
    expect(lex("7")[0]).toHaveProperty("unit", undefined);
    expect(lex("x")[0]).not.toHaveProperty("unit");
  });

  it("refuses a unit it does not know, and names all of it", () => {
    expect(failure("5turn")).toEqual(['Unknown unit "turn" after 5', 1, 5]);
    expect(failure("5mm_2")).toEqual(['Unknown unit "mm_2" after 5', 1, 5]);
    expect(failure("5mmx9 ")).toEqual(['Unknown unit "mmx9" after 5', 1, 5]);
  });

  it("reads names, keywords and colours", () => {
    expect(kinds("part _a1 B_2 cosmetic x9")).toEqual(["kw:part", "ident:_a1", "ident:B_2", "kw:cosmetic", "ident:x9", "eof:"]);
    expect(kinds("#FfA #00ff7F")).toEqual(["color:#ffa", "color:#00ff7f", "eof:"]);
    expect(failure("#12")).toEqual(['Invalid color "#12" (use #RGB or #RRGGBB)', 0, 3]);
    // g is not a hex digit: the colour ends before it
    expect(failure("#abg")).toEqual(['Invalid color "#ab" (use #RGB or #RRGGBB)', 0, 3]);
  });

  it("takes only plain letters in a name", () => {
    expect(failure("é")).toEqual(['Unexpected character "é"', 0, 1]);
    expect(failure("aµ")).toEqual(['Unexpected character "µ"', 1, 2]);
    expect(failure("a@")).toEqual(['Unexpected character "@"', 1, 2]);
    expect(failure("a`")).toEqual(['Unexpected character "`"', 1, 2]);
  });

  it("says where each token is", () => {
    const at = (t: Token) => [t.value, t.start, t.end, t.line, t.col];
    expect(lex("a = 5mm\n  b(2)").map(at)).toEqual([
      ["a", 0, 1, 1, 1],
      ["=", 2, 3, 1, 3],
      ["5mm", 4, 7, 1, 5],
      ["b", 10, 11, 2, 3],
      ["(", 11, 12, 2, 4],
      ["2", 12, 13, 2, 5],
      [")", 13, 14, 2, 6],
      ["", 14, 14, 2, 7],
    ]);
  });
});

/** the plain way to write a value out, which the quick way must match to the letter */
function plain(v: unknown): string {
  if (typeof v === "number") return Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(plain).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + plain(o[k])).join(",") + "}";
}

describe("a recipe written out for hashing", () => {
  it("is what the plain way writes, for values of every awkward kind", () => {
    const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays
    const values: unknown[] = [
      undefined,
      null,
      NaN,
      Infinity,
      -0,
      1e21,
      1e-7,
      0.1 + 0.2,
      123456.7890123,
      "",
      'a"b\\c\n é',
      true,
      [],
      {},
      [undefined],
      [null, undefined, 1],
      sparse,
      { b: 1, a: 2 },
      { a: undefined, b: 1 },
      { a: undefined },
      { "": 1, é: 2, "\n": 3, Z: 4, a: 5, _: 6, "0": 7, "10": 8, "9": 9 },
      { f: () => 1 },
      [() => 1],
      new Date(0),
      new Float32Array([1.5, 2.5]),
      { nested: [{ z: [1, [2, [3, { y: undefined, x: null }]]] }] },
      Object.create({ inherited: 1 }),
    ];
    for (const v of values) expect(stableStringify(v)).toBe(plain(v));
  });

  it("is what the plain way writes for every part of every built-in design, so no hash changes", () => {
    const dir = new URL("../src/demos/", import.meta.url);
    let parts = 0;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".kerf"))) {
      const model = evaluate(readFileSync(new URL(f, dir), "utf8"));
      for (const p of model.parts) {
        expect(stableStringify(p.recipe)).toBe(plain(p.recipe));
        expect(p.hash).toBe(hashString(plain(p.recipe)));
        parts++;
      }
    }
    expect(parts).toBeGreaterThan(500);
  });

  it("gives a component put in many places one hash", () => {
    const model = evaluate(`
part plate { material: "Aluminum 6061"  body box(60, 20, 3) }
component s = lib.screw(M3, 8) { at: [(-20, 0, 3), (0, 0, 3), (20, 0, 3)], axis: -Z }
`);
    const screws = model.parts.filter((p) => p.name === "s");
    expect(screws).toHaveLength(3);
    expect(new Set(screws.map((p) => p.hash)).size).toBe(1);
    expect(screws[0].hash).toBe(recipeHash(screws[0].recipe));
  });
});
