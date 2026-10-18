// A subassembly agent's write or edit comes back with its section's checks, so
// the agent needs no check_section step after each change. The geometry worker
// is stood in for; no test here touches the network.

import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { evaluate } from "../src/lang/evaluator";

const checked = vi.hoisted(() => ({ runs: 0 }));
vi.mock("../src/agents/isolated", () => ({
  checkIsolated: async (src: string) => {
    checked.runs++;
    return { model: evaluate(src), report: { items: [], counts: { pass: 4, fail: 0, warn: 0, pending: 0, info: 0 }, ms: 1 }, worker: 1, built: 1, ms: 5 };
  },
}));

import { runAgent, type AgentHooks, type Workspace } from "../src/agents/subagent";

type Block = Record<string, unknown> & { type: string };

function agentFor(replies: { content: Block[]; stop_reason: string }[]) {
  const requests: { messages: { role: string; content: Block[] | string }[] }[] = [];
  const anthropic = {
    beta: {
      messages: {
        stream(params: Record<string, unknown>) {
          requests.push(JSON.parse(JSON.stringify(params)));
          const r = replies.shift() ?? { content: [{ type: "text", text: "Built the base." }], stop_reason: "end_turn" };
          return {
            on() {
              return this;
            },
            finalMessage: async () => ({ model: params.model, content: r.content, stop_reason: r.stop_reason, usage: { input_tokens: 1, output_tokens: 1 } }),
          };
        },
      },
    },
  };
  let body = "";
  const ws: Workspace = {
    id: "base",
    name: "Base",
    body: () => body,
    setBody: (b) => void (body = b),
    isolated: (b) => {
      const head = 'design "t"\n';
      return { src: head + b, start: head.length, end: head.length + b.length };
    },
    otherNames: () => new Map(),
    readOther: () => null,
    requestChange: () => "Noted.",
    look: async () => ({ text: "No view here." }),
    onChecks: () => undefined,
  };
  const hooks: AgentHooks = {
    activity: () => undefined,
    step: () => "s",
    updateStep: () => undefined,
    usage: () => undefined,
    budgetOk: () => true,
    takeSteering: () => null,
    setSteps: () => null,
    firstEvent: () => undefined,
  };
  const run = () => runAgent({ anthropic: anthropic as unknown as Anthropic, model: "claude-opus-5-5", effort: "high", system: "You build one subassembly.", kickoff: "Build the base.", maxSteps: 10, signal: new AbortController().signal }, ws, hooks);
  return { requests, run };
}

describe("subassembly agents", () => {
  it("get the checks with the last change of a response", async () => {
    checked.runs = 0;
    const { requests, run } = agentFor([
      {
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "w1", name: "write_section", input: { summary: "Base plate", source: 'part base { body box(40, 20, 5) group: "Base" }\n' } },
          { type: "tool_use", id: "e1", name: "edit_section", input: { summary: "Thicker", edits: [{ old_text: "5)", new_text: "6)" }] } },
        ],
      },
    ]);
    const end = await run();
    expect(end.status).toBe("done");
    expect(requests).toHaveLength(2);
    const results = requests[1].messages[2].content as Block[];
    expect(String(results[0].content)).toContain("The checks come after your last change in this response.");
    expect(String(results[0].content)).not.toContain("Built and checked");
    expect(String(results[1].content)).toContain("Built and checked:");
    expect(String(results[1].content)).not.toContain("call check_section");
    expect(checked.runs).toBe(1);
  });

  it("leave the checks to check_section when the agent asks for it", async () => {
    checked.runs = 0;
    const { requests, run } = agentFor([
      {
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "w1", name: "write_section", input: { summary: "Base plate", source: 'part base { body box(40, 20, 5) group: "Base" }\n' } },
          { type: "tool_use", id: "c1", name: "check_section", input: {} },
        ],
      },
    ]);
    await run();
    const results = requests[1].messages[2].content as Block[];
    expect(String(results[0].content)).not.toContain("Built and checked");
    expect(checked.runs).toBe(1);
  });
});
