// Right-click menus: locking a part from its menu writes `locked` into its block (and unlocking takes it out again),
// menus drop stray separators, and the menus offer what the spot and the view allow.

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { setBlockLocked } from "../src/core/sourceEdit";
import { openContextMenu, useContextMenu } from "../src/ui/ContextMenu";

const multi = `part plate {
  material: "Aluminum 6061"
  body box(80, 4, 40)
}
part peg { body cylinder(d: 6, h: 10) }
`;

const locked = (src: string, name: string) => evaluate(src).parts.find((p) => p.name === name)?.locked;

describe("locking a part from its menu", () => {
  it("adds locked to a block written over several lines, and takes it out again", () => {
    const on = setBlockLocked(multi, "plate", true);
    expect(on).toContain(`part plate {\n  locked\n  material: "Aluminum 6061"`);
    expect(locked(on, "plate")).toBe(true);
    expect(setBlockLocked(on, "plate", true)).toBe(on);
    expect(setBlockLocked(on, "plate", false)).toBe(multi);
  });

  it("adds it to a block on one line", () => {
    const on = setBlockLocked(multi, "peg", true);
    expect(on).toContain("part peg { locked, body cylinder(d: 6, h: 10) }");
    expect(locked(on, "peg")).toBe(true);
    expect(evaluate(on).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(setBlockLocked(on, "peg", false)).toBe(multi);
  });

  it("leaves the text alone for a block that isn't there", () => {
    expect(setBlockLocked(multi, "nothing", true)).toBe(multi);
  });
});

describe("context menus", () => {
  it("drops separators at the ends and doubled ones", () => {
    const run = () => undefined;
    openContextMenu({ x: 10, y: 20 }, ["sep", { label: "A", run }, "sep", "sep", { label: "B", run }, "sep"]);
    const m = useContextMenu.getState().menu!;
    expect(m.entries.map((e) => (e === "sep" ? "-" : "label" in e ? e.label : "?"))).toEqual(["A", "-", "B"]);
    expect([m.x, m.y]).toEqual([10, 20]);
  });
});
