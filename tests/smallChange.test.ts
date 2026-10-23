import { describe, expect, it } from "vitest";
import { smallChange, type TurnFacts } from "../src/ai/routing";

const facts = (text: string, more: Partial<TurnFacts> = {}): TurnFacts => ({ text, lastReply: "", hasFiles: false, pointsAtModel: false, answersChoice: false, steering: false, parts: 3, ...more });

describe("small changes", () => {
  it.each(["Make the wall 3 mm thicker", "move the lid up 5", "round these edges", "add a 6 mm hole here", "make it 20mm taller", "please change the colour to blue", "remove the logo"])("%s is small", (t) => {
    expect(smallChange(facts(t))).toBe(true);
  });

  it.each([
    "add a battery compartment",
    "design a phone stand",
    "make it stronger",
    "fix the failing checks",
    "why is the wall 3 mm?",
    "make the wall thicker, move the lid up, round the edges and add a hole",
    "add a motor to drive the wheel 10 times a second",
    "make it work",
  ])("%s is not", (t) => {
    expect(smallChange(facts(t))).toBe(false);
  });

  it("needs a design, and not an answer, an attachment or a plan change", () => {
    expect(smallChange(facts("make the wall 3 mm", { parts: 0 }))).toBe(false);
    expect(smallChange(facts("make the wall 3 mm", { answersChoice: true }))).toBe(false);
    expect(smallChange(facts("make the wall 3 mm", { hasFiles: true }))).toBe(false);
    expect(smallChange(facts("make the wall 3 mm", { steering: true }))).toBe(false);
    expect(smallChange(facts("make this 2 mm thicker", { pointsAtModel: true }))).toBe(true);
  });
});
