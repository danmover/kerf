// Fewer round trips while Claude builds: changes come back with their build and
// checks, a short design goes with the user's message, write_design keeps the
// brief so it can share a response with update_brief, and the reviewer reads
// its renders from the prompt cache. No test here touches the network.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { keepBrief } from "../src/core/brief";
import { evaluate } from "../src/lang/evaluator";
import { runTool } from "../src/ai/tools";
import { useDesign } from "../src/core/engine";
import { useSettings } from "../src/app/settings";
import { clearChat, sendMessage, setClientFactory, chatHistory } from "../src/ai/chat";
import { callReviewer } from "../src/ai/review/reviewer";
import type { CheckReport } from "../src/core/checks";

const BRIEF = `brief {
  purpose: "Hold a 25 mm tube to a wall"
  use hold "Holds the tube" { load: 20N, dir: -Z }
  given tube_d = 25mm "Tube diameter"
}`;
const WITH_BRIEF = `design "Clip"\nnote "A tube clip."\n\n${BRIEF}\n\npart base { body box(40, tube_d, 5) }\n`;

const report = (pass: number): CheckReport => ({
  items: Array.from({ length: pass }, (_, i) => ({ id: `req:r${i}`, category: "requirement", status: "pass", title: `Requirement ${i + 1}`, detail: "holds" })) as never,
  counts: { pass, fail: 0, warn: 0, pending: 0, info: 0 } as never,
  ms: 1,
});

/** Stands in for the kernel: every new revision gets its checks straight away. */
function fakePipeline(pass = 3) {
  return useDesign.subscribe((s) => {
    if (s.rev > s.reportRev) useDesign.setState({ report: report(pass), reportRev: s.rev, stage: "done" });
  });
}

describe("write_design keeps the brief", () => {
  const model = evaluate(WITH_BRIEF);

  it("puts the current brief block back when the new source has none", () => {
    const next = keepBrief(`design "Clip"\nnote "Rewritten."\n\npart base { body box(50, tube_d, 6) }\n`, WITH_BRIEF, model);
    expect(next).toContain(BRIEF);
    expect(next.indexOf(BRIEF)).toBeGreaterThan(next.indexOf('note "Rewritten."'));
    const m = evaluate(next);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(m.brief?.givens.map((g) => g.name)).toEqual(["tube_d"]);
  });

  it("leaves a source that writes its own brief, or replaces a design without one, as it is", () => {
    const own = `design "Clip"\nbrief {\n  purpose: "Something else"\n}\npart base { body box(1, 1, 1) }\n`;
    expect(keepBrief(own, WITH_BRIEF, model)).toBe(own);
    const plain = `design "Clip"\npart base { body box(1, 1, 1) }\n`;
    expect(keepBrief(plain, plain, evaluate(plain))).toBe(plain);
  });
});

describe("changes that come back with their checks", () => {
  let stop: () => void;
  beforeEach(() => {
    useDesign.setState({ source: 'design "t"\npart a { body box(10, 10, 10) }\n', model: null, report: null });
    stop = fakePipeline();
  });
  afterEach(() => stop());

  it("waits for the build and returns every check with the edit", async () => {
    const r = await runTool("write_design", { summary: "Bigger block", source: 'design "t"\npart a { body box(20, 10, 10) }\n' }, { check: true });
    expect(r.isError).toBeFalsy();
    const text = String(r.content);
    expect(text).toContain("Built and checked:");
    expect(text).toContain("Checks: 3 pass, 0 fail");
    expect(text).not.toContain("call run_checks");
    // the design summary is given once, with the checks
    expect(text.match(/Design "t"/g)).toHaveLength(1);
    expect(r.card.detail).toMatch(/lines · All 3 checks pass$/);
  });

  it("says a later change carries the checks, and keeps asking for run_checks when nobody said", async () => {
    const later = await runTool("edit_design", { summary: "Wider", edits: [{ old_text: "box(10,", new_text: "box(12," }] }, { check: false });
    expect(String(later.content)).toContain("The build and check results come after your last change in this response.");
    expect(String(later.content)).not.toContain("Built and checked");
    const plain = await runTool("edit_design", { summary: "Wider still", edits: [{ old_text: "box(12,", new_text: "box(14," }] });
    expect(String(plain.content)).toContain("Next: call run_checks");
  });

  it("does not wait when nothing changed or the edit failed", async () => {
    stop();
    const same = await runTool("write_design", { summary: "Same", source: useDesign.getState().source }, { check: true });
    expect(String(same.content)).toMatch(/^No change/);
    const bad = await runTool("edit_design", { summary: "Nope", edits: [{ old_text: "no such text", new_text: "x" }] }, { check: true });
    expect(bad.isError).toBe(true);
  });
});

// ---------- the chat loop ----------

type Block = Record<string, unknown> & { type: string };
type Reply = { content: Block[]; stop_reason: string };

function fakeClient(replies: Reply[]) {
  const requests: { messages: { role: string; content: Block[] | string }[] }[] = [];
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
              return { id: "msg", type: "message", role: "assistant", model: params.model, content: r.content, stop_reason: r.stop_reason, usage: {} };
            },
          };
        },
      },
    },
  };
  setClientFactory(() => client as unknown as Anthropic);
  return requests;
}

const textOf = (content: Block[] | string) => (typeof content === "string" ? content : content.map((b) => (typeof b.text === "string" ? b.text : typeof b.content === "string" ? b.content : "")).join("\n"));

describe("a from-scratch build in the chat", () => {
  let stop: () => void;
  beforeEach(async () => {
    await clearChat();
    useSettings.setState({ model: "claude-opus-5-5", webSearch: false, maxSteps: 30, selfReview: "off", routeQuick: false });
    useDesign.setState({ source: 'design "Untitled design"\nnote "Describe what you want in the chat, or write it here."\n', model: null, report: null });
    stop = fakePipeline(2);
  });
  afterEach(() => {
    stop();
    setClientFactory(null);
  });

  it("sends a short design with the message, and checks only after the response's last change", async () => {
    const requests = fakeClient([
      {
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "t1", name: "update_brief", input: { summary: "Recorded the brief", fields: { purpose: "Hold a 25 mm tube to a wall" }, givens: [{ name: "tube_d", value: "25mm", description: "Tube diameter" }] } },
          { type: "tool_use", id: "t2", name: "write_design", input: { summary: "First clip", source: 'design "Clip"\n\npart base { body box(40, tube_d, 5) }\n' } },
        ],
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Here is the clip. All 2 checks pass." }] },
    ]);
    await sendMessage("Make a clip for a 25 mm tube");

    // no get_design step: the design was in the first message
    const first = textOf(requests[0].messages[0].content);
    expect(first).toContain('<source note="The design as it is now.');
    expect(first).toContain('1| design "Untitled design"');
    expect(requests).toHaveLength(2);

    const results = requests[1].messages[2].content as Block[];
    expect(results.map((b) => b.tool_use_id)).toEqual(["t1", "t2"]);
    expect(String(results[0].content)).toContain("The build and check results come after your last change in this response.");
    expect(String(results[1].content)).toContain("Built and checked:");
    expect(String(results[1].content)).toContain("Checks: 2 pass");
    // write_design left the brief out, and the brief update_brief recorded is kept
    expect(useDesign.getState().model?.brief?.givens.map((g) => g.name)).toEqual(["tube_d"]);
    expect(useDesign.getState().source).toContain('given tube_d = 25mm "Tube diameter"');

    // Claude wrote the design, so the next message does not send it again
    fakeClient([{ stop_reason: "end_turn", content: [{ type: "text", text: "It is 40 mm long." }] }]);
    await sendMessage("How long is it?");
    expect(textOf(chatHistory()[4].content as Block[])).not.toContain("<source");

    // after the user edits it, the next message carries it again
    useDesign.setState({ source: useDesign.getState().source.replace("box(40,", "box(45,") });
    fakeClient([{ stop_reason: "end_turn", content: [{ type: "text", text: "Now 45 mm." }] }]);
    await sendMessage("And now?");
    const third = textOf(chatHistory()[6].content as Block[]);
    expect(third).toContain("it changed since you last saw it");
    expect(third).toContain("box(45, tube_d, 5)");
  });

  it("leaves the checks to run_checks when Claude asks for it after the change", async () => {
    const requests = fakeClient([
      {
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "e1", name: "write_design", input: { summary: "Block", source: 'design "B"\npart a { body box(5, 5, 5) }\n' } },
          { type: "tool_use", id: "c1", name: "run_checks", input: {} },
        ],
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] },
    ]);
    await sendMessage("A 5 mm cube");
    const results = requests[1].messages[2].content as Block[];
    expect(String(results[0].content)).not.toContain("Built and checked");
    expect(String(results[1].content)).toContain("Checks: 2 pass");
  });
});

// ---------- the reviewer ----------

describe("the reviewer", () => {
  it("reads its renders, source and close-ups from the cache on later steps", async () => {
    const requests: { system: Block[]; messages: { role: string; content: Block[] }[] }[] = [];
    const replies: Reply[] = [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "l1", name: "look_closer", input: { parts: ["base"], view: "iso", section: "none", why: "Check the clip lip" } }] },
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "s1",
            name: "submit_review",
            input: { verdict: "pass", summary: "Fine.", assumptions: "", checked: [], findings: [], earlier: [] },
          },
        ],
      },
    ];
    const client = {
      beta: {
        messages: {
          stream(params: Record<string, unknown>) {
            requests.push(JSON.parse(JSON.stringify(params)));
            const r = replies.shift()!;
            return { finalMessage: async () => ({ model: params.model, content: r.content, stop_reason: r.stop_reason, usage: { input_tokens: 1, output_tokens: 1 } }) };
          },
        },
      },
    };
    const image = "data:image/jpeg;base64,AAAA";
    const out = await callReviewer({
      client: client as unknown as Anthropic,
      model: "claude-opus-5-5",
      effort: "high",
      brief: { text: "A tube clip", from: "conversation" },
      round: 1,
      designSummary: "Design Clip: 1 solid",
      inventory: "base: no sharp edges",
      source: '1| design "Clip"',
      views: [
        { name: "iso", label: "3/4 view", image },
        { name: "front", label: "Front", image },
      ],
      earlier: [],
      closeup: async (q) => ({ name: "closeup-iso", label: `Close-up of ${q.parts.join(", ")}`, image, closeup: { parts: q.parts, why: q.why } }),
    });
    expect(out.submission.verdict).toBe("pass");
    expect(requests).toHaveLength(2);
    const marked = (blocks: Block[]) => blocks.map((b, i) => (b.cache_control ? i : -1)).filter((i) => i >= 0);
    // the first message (renders, inventory, source) ends in a breakpoint on every request
    for (const r of requests) expect(marked(r.messages[0].content)).toEqual([r.messages[0].content.length - 1]);
    // the close-up's result is the newest breakpoint on the second request
    const last = requests[1].messages[2].content;
    expect(last[0].type).toBe("tool_result");
    expect(marked(last)).toEqual([last.length - 1]);
    expect(requests[1].system[0].cache_control).toEqual({ type: "ephemeral" });
  });
});
