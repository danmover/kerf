// A CAN bus is one line from node to node: a net marked chain: true is wired pin to pin in the order listed, where
// any other net is a star from its first pin.
import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { wireList } from "../src/machine/wiring";

const design = (chain: string) => `
component can = lib.part("waveshare_sn65hvd230") { at: (0, 0, 0) }
component a1 = lib.servo("cubemars_ak70_10") { at: (100, 0, 0) }
component a2 = lib.servo("cubemars_ak70_10") { at: (200, 0, 0) }
component a3 = lib.servo("cubemars_ak70_10") { at: (300, 0, 0) }
component term = lib.part("resistor_mf") { at: (350, 0, 0) }
net BUS_H: can.CAN_H, a1.CAN_H, a2.CAN_H, a3.CAN_H, term.A { gauge: 26${chain} }
`;
const hops = (src: string) =>
  wireList(evaluate(src, { skipGeometry: true }).machine!)
    .filter((r) => r.net === "BUS_H")
    .map((r) => `${r.from.comp}-${r.to.comp}`);

describe("nets wired as a chain", () => {
  it("runs a chain: true net from each pin to the next, in the order listed", () => {
    expect(hops(design(", chain: true"))).toEqual(["can-a1", "a1-a2", "a2-a3", "a3-term"]);
  });
  it("keeps any other net a star from its first pin", () => {
    expect(hops(design(""))).toEqual(["can-a1", "can-a2", "can-a3", "can-term"]);
  });
  it("explains a chain: that is not true or false", () => {
    const m = evaluate(design(', chain: "yes"'), { skipGeometry: true });
    expect(m.diagnostics.some((d) => d.severity === "error" && /chain:/.test(d.message))).toBe(true);
  });
});
