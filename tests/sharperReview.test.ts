// The reviewer is told what the renders cannot show reliably: a part made of
// pieces that do not touch, a part that touches nothing, which lines changed,
// and, for a small part on a big one, views framed on the small part. The
// kernel runs in Node; nothing here touches the network.

import { beforeAll, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { evaluate } from "../src/lang/evaluator";
import { KernelCore } from "../src/kernel/core";
import { assembleReport, buildChecksRequest } from "../src/core/checks";
import type { V3 } from "../src/kernel/recipe";
import { aloneParts, buildInventory, inventoryText } from "../src/ai/review/inventory";
import { changesText, subjectBox } from "../src/ai/review/index";
import { callReviewer } from "../src/ai/review/reviewer";
import { initKernel } from "./helpers/kernel";

const SRC = `design "Hook"
part plate {
  material: "PETG"
  body box(40, 4, 30)
  add cylinder(d: 6, h: 8, at: (0, 6.2, 0), dir: Y) as peg
}
part stray {
  material: "PETG"
  body box(10, 10, 10, at: (100, 0, 0))
}
part wall {
  material: "PETG"
  body box(60, 2, 40, at: (0, -3, 0))
}
`;

function built(src: string) {
  const model = evaluate(src);
  const core = new KernelCore();
  const boxes = new Map<string, [V3, V3]>();
  for (const p of model.parts) if (!boxes.has(p.hash)) boxes.set(p.hash, core.build({ hash: p.hash, recipe: p.recipe, label: p.label }, "preview").bbox as [V3, V3]);
  return { model, core, bbox: (h: string) => boxes.get(h) };
}

describe("parts in separate pieces, and parts that touch nothing", () => {
  beforeAll(() => initKernel(), 60_000);

  it("warns the designer and tells the reviewer where the loose piece is", async () => {
    const { model, core, bbox } = built(SRC);
    const kernel = core.checks(buildChecksRequest(model, new Set(model.parts.map((p) => p.hash))));
    const report = assembleReport(model, { geoModel: null, kernel, buildErrors: new Map() });
    const item = report.items.find((i) => i.id === "pieces:plate");
    expect(item?.status).toBe("warn");
    expect(item?.title).toMatch(/is 2 separate pieces/);
    expect(report.items.some((i) => i.id.startsWith("pieces:") && i.id !== "pieces:plate")).toBe(false);

    const inv = await buildInventory(model, SRC, async (names) => core.inspect(names), bbox);
    expect(inv.alone).toEqual(["stray"]);
    const text = inventoryText(inv);
    expect(text).toContain("TOUCHES NOTHING: no other part comes within 0.5 mm of stray.");
    // the peg starts 4.2 mm off the plate's face, so its middle is at y = 10.2
    expect(text).toMatch(/SEPARATE PIECES: made of 2 solids that do not touch; besides the main body \d+ mm³ at \(0, 10\.2, 0\)/);
  }, 120_000);

  it("says nothing when the parts are laid out apart rather than assembled", () => {
    const { model, bbox } = built(`design "Set"\npart a { body box(10, 10, 10) }\npart b { body box(10, 10, 10, at: (50, 0, 0)) }\n`);
    expect(aloneParts(model, bbox)).toEqual([]);
  }, 60_000);
});

describe("what the reviewer sees", () => {
  it("lists the changed lines, numbered as they are now", () => {
    const before = "a\nb\nc\nd";
    expect(changesText(before, before)).toBe("Nothing changed since then.");
    const text = changesText(before, "a\nB\nc\nd\ne");
    expect(text).toContain("2 lines added and 1 removed");
    expect(text).toContain("+   2| B");
    expect(text).toContain("-    | b");
    expect(text).toContain("+   5| e");
    const fresh = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
    expect(changesText("", fresh)).toMatch(/^Most of the design is new/);
  });

  it("frames the views on a small made part beside a big bought one", () => {
    const src = `design "Clip"\npart post { process: false\n body box(30, 30, 600) }\npart clip { body box(40, 10, 20, at: (0, 20, 0)) }\n`;
    const model = evaluate(src);
    const sizes: Record<string, [V3, V3]> = {};
    for (const p of model.parts) sizes[p.hash] = p.name === "post" ? [[-15, -15, -300], [15, 15, 300]] : [[-20, 15, -10], [20, 25, 10]];
    const box = subjectBox(model, (h) => sizes[h])!;
    expect(box[0][2]).toBeGreaterThan(-20);
    expect(box[1][2]).toBeLessThan(20);
    // a made part about the size of the whole is framed as usual
    const same = evaluate(`design "Box"\npart a { body box(40, 40, 40) }\n`);
    expect(subjectBox(same, () => [[-20, -20, -20], [20, 20, 20]])).toBeUndefined();
  });

  it("hands the changes to the reviewer before the renders", async () => {
    const sent: { messages: { content: { type: string; text?: string }[] }[] }[] = [];
    const client = {
      beta: {
        messages: {
          stream: (req: (typeof sent)[number]) => {
            sent.push(req);
            const message = {
              id: "m",
              type: "message",
              role: "assistant",
              model: "claude-opus-5-5",
              stop_reason: "tool_use",
              usage: { input_tokens: 1, output_tokens: 1 },
              content: [{ type: "tool_use", id: "t", name: "submit_review", input: { verdict: "pass", summary: "Fine.", assumptions: "", checked: [], findings: [], earlier: [] } }],
            };
            return { finalMessage: async () => message, on: () => undefined, abort: () => undefined };
          },
        },
      },
    };
    await callReviewer({
      client: client as unknown as Anthropic,
      model: "claude-opus-5-5",
      effort: "high",
      brief: { text: "A hook", from: "conversation" },
      round: 2,
      designSummary: "Design Hook",
      inventory: "plate",
      source: '1| design "Hook"',
      views: [{ name: "iso", label: "3/4 view", image: "data:image/jpeg;base64,AAAA" }],
      earlier: [],
      changes: "1 line added and 0 removed",
      closeup: async () => null,
    });
    const blocks = sent[0].messages[0].content;
    const at = blocks.findIndex((b) => b.text?.startsWith('<changes since="the last review round">\n1 line added'));
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(blocks.findIndex((b) => b.type === "image"));
  });
});
