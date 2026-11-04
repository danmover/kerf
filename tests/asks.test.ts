// What the user asked for, measured after every change: conditions read as in
// a require statement, keeps compared part by part, and the parts that changed
// though no ask needs them. The kernel is the real one; the chat's client is a
// stand-in, so nothing here touches the network.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { evaluate, evaluateConditions } from "../src/lang/evaluator";
import { geoKey, type GeoQuery } from "../src/lang/values";
import { KernelCore } from "../src/kernel/core";
import { buildChecksRequest, type CheckItem, type CheckReport } from "../src/core/checks";
import { templateById } from "../src/demos/templates";
import { asksState, asksText, measureAsks, snapshot, type Ask } from "../src/ai/asks";
import { useDesign } from "../src/core/engine";
import { useSettings } from "../src/app/settings";
import { clearChat, sendMessage, setClientFactory, useChat } from "../src/ai/chat";
import { initKernel } from "./helpers/kernel";

const ENCLOSURE = templateById("enclosure")!.source;

describe("reading a condition against a design", () => {
  it("reads params at once, asks for the geometry it lacks, and says what it cannot read", () => {
    const first = evaluateConditions(ENCLOSURE, ["wall == 3", 'size(lid, "z") <= 5', "nope == 1"]);
    expect(first.results[0]).toMatchObject({ ok: false, detail: "2 = 3", uses: ["wall"] });
    expect(first.results[1].ok).toBeNull();
    expect(first.results[2].error).toMatch(/not defined/);
    expect(first.queries).toEqual([{ q: "bbox", a: "lid", axis: "z", side: "size" }]);

    const second = evaluateConditions(ENCLOSURE, ['size(lid, "z") <= 5'], { geo: { [geoKey(first.queries[0])]: 4.4 } });
    expect(second.results[0]).toMatchObject({ ok: true });
  });
});

describe("measuring the asks on a built design", () => {
  beforeAll(() => initKernel(), 60_000);

  const core = new KernelCore();
  const built = new Set<string>();
  function geoFor(src: string) {
    const model = evaluate(src);
    for (const p of model.parts) {
      if (built.has(p.hash)) continue;
      core.build({ hash: p.hash, recipe: p.recipe, label: p.label }, "preview");
      built.add(p.hash);
    }
    return { model, geo: async (queries: GeoQuery[]) => core.checks({ ...buildChecksRequest(model, built), queries }) };
  }
  const start = snapshot(evaluate(ENCLOSURE));

  const asks: Ask[] = [
    { ask: "walls 3 mm thick", expect: "wall == 3" },
    { ask: "lid no taller than 5 mm", expect: 'size(lid, "z") <= 5' },
    { ask: "keep the lid screws", keep: true, part: "lid_fasteners" },
    { ask: "looks tidy" },
  ];

  it("passes what was done, keeps what was kept, and counts what the change needed as asked for", async () => {
    const src = ENCLOSURE.replace(/param wall\s+= 2.0mm/, "param wall = 3mm");
    expect(src).not.toBe(ENCLOSURE);
    const { model, geo } = geoFor(src);
    const r = await measureAsks(asks, { source: src, model, start, startEmpty: false, geo });
    expect(r.results.map((x) => x.status)).toEqual(["pass", "pass", "pass", "open"]);
    expect(r.results[0].detail).toBe("3 = 3");
    // the base, the lid and the board on the thicker floor all changed, all because of the wall
    expect(r.unasked).toEqual([]);
    expect(asksText(r)).toBe(
      ["✓ walls 3 mm thick (3 = 3)", `✓ lid no taller than 5 mm (${r.results[1].detail})`, "✓ keep: keep the lid screws (lid_fasteners unchanged)", "○ looks tidy (not measured: check it yourself)"].join("\n"),
    );
  }, 120_000);

  it("fails a keep that moved, and names the parts that changed though nothing asked for it", async () => {
    const src = ENCLOSURE.replace(/param wall\s+= 2.0mm/, "param wall = 3mm").replace(/param corner_r\s+= 6mm/, "param corner_r = 8mm");
    const { model, geo } = geoFor(src);
    const r = await measureAsks([...asks, { ask: "corner radius stays 6 mm", keep: true, expect: "corner_r == 6" }], { source: src, model, start, startEmpty: false, geo });
    expect(r.results.map((x) => x.status)).toEqual(["pass", "pass", "fail", "open", "fail"]);
    expect(r.results[2].detail).toBe("lid_fasteners changed");
    expect(r.results[4].detail).toBe("8 = 6");
    // the screws moved with the corners; a keep's own measure covers nothing
    expect(r.unasked).toEqual(expect.arrayContaining(["lid_inserts"]));
    expect(r.unasked).not.toContain("base");
    expect(asksText(r)).toMatch(/Changed though no ask names them: .*lid_inserts.*undo the rest\.$/);
  }, 120_000);

  it("says when a measure cannot be read, and leaves a new design's parts alone", async () => {
    const { model, geo } = geoFor(ENCLOSURE);
    const r = await measureAsks([{ ask: "gap 1 mm", expect: "gap == 1" }, { ask: "keep the stand", keep: true, part: "stand" }], { source: ENCLOSURE, model, start: new Map(), startEmpty: true, geo });
    expect(r.results.map((x) => x.status)).toEqual(["error", "error"]);
    expect(r.results[1].detail).toMatch(/no part named stand/);
    expect(r.unasked).toEqual([]);
    expect(asksText(r)).toMatch(/^! gap 1 mm \(cannot measure: .*correct its expect with record_asks\)/);
  }, 120_000);
});

describe("the asks in the chat", () => {
  type Block = Record<string, unknown> & { type: string };
  type Sent = { messages: { role: string; content: Block[] | string }[] };
  type Reply = { content: Block[]; stop_reason: string };

  function fakeClient(replies: Reply[]) {
    const requests: Sent[] = [];
    const client = {
      beta: {
        messages: {
          stream(params: Record<string, unknown>) {
            requests.push(JSON.parse(JSON.stringify(params)));
            const r = replies.shift() ?? { content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" };
            return {
              on() {
                return this;
              },
              async finalMessage() {
                return { id: "msg", type: "message", role: "assistant", model: params.model, content: r.content, stop_reason: r.stop_reason, usage: { input_tokens: 1, output_tokens: 1 } };
              },
            };
          },
        },
      },
    };
    setClientFactory(() => client as unknown as Anthropic);
    return requests;
  }

  const SOURCE = 'design "Bracket"\nparam wall = 4\npart plate { body box(40, wall, 30) }\n';
  const record = { type: "tool_use", id: "a1", name: "record_asks", input: { asks: [{ ask: "wall 3 mm", expect: "wall == 3" }] } };
  const edit = { type: "tool_use", id: "e1", name: "edit_design", input: { summary: "Thinner wall", edits: [{ old_text: "param wall = 4", new_text: "param wall = 3" }] } };
  const done = (t: string): Reply => ({ stop_reason: "end_turn", content: [{ type: "text", text: t }] });
  const resultOf = (r: Sent, id: string) => {
    const b = (r.messages.at(-1)!.content as Block[]).find((x) => x.tool_use_id === id)!;
    return typeof b.content === "string" ? b.content : (b.content as Block[]).map((x) => String(x.text ?? "")).join("\n");
  };
  const report = (): CheckReport => ({ items: [] as CheckItem[], counts: { pass: 0, fail: 0, warn: 0, pending: 0, info: 0 }, ms: 1 });

  let stop: () => void;
  beforeEach(async () => {
    await clearChat();
    useSettings.setState({ model: "claude-opus-5-5", webSearch: false, maxSteps: 30, selfReview: "off", routeQuick: false, fastChanges: false, speed: "normal" });
    useDesign.setState({ source: SOURCE, model: null, report: report() });
    stop = useDesign.subscribe((s) => {
      if (s.rev > s.reportRev) useDesign.setState({ report: report(), reportRev: s.rev, stage: "done" });
    });
  });
  afterEach(() => {
    stop();
    setClientFactory(null);
  });

  it("measures them before and after the change, and shows them as one checklist", async () => {
    const requests = fakeClient([{ stop_reason: "tool_use", content: [record, edit] }, done("The wall is 3 mm.")]);
    await sendMessage("Thin the wall down so the plate is lighter");

    expect(requests).toHaveLength(2);
    expect(resultOf(requests[1], "a1")).toMatch(/^Recorded 1 ask\. .*\n✗ wall 3 mm \(4 = 3\)$/s);
    expect(resultOf(requests[1], "e1")).toContain("The user's asks, measured after this change:\n✓ wall 3 mm (3 = 3)");
    const items = useChat.getState().items;
    expect(items.filter((i) => i.kind === "asks")).toMatchObject([{ asks: [{ ask: "wall 3 mm", status: "pass", detail: "3 = 3" }], unasked: [] }]);
    // the checklist stands for the record_asks step
    expect(JSON.stringify(items)).not.toMatch(/Noted 1 ask/);
  });

  it("keeps the asks for 'continue' and starts afresh for a new message", async () => {
    fakeClient([{ stop_reason: "tool_use", content: [record, edit] }, done("Done."), done("Carried on."), done("Done.")]);
    await sendMessage("Thin the wall down so the plate is lighter");
    expect(asksState().asks).toHaveLength(1);
    await sendMessage("continue");
    expect(asksState().asks).toHaveLength(1);
    await sendMessage("What is it made of?");
    expect(asksState().asks).toHaveLength(0);
  });
});
