// Runs that stopped or paid twice for no good reason: the API busy part-way
// through a response, a review or a subassembly agent cut off at the length
// limit, and a turn ending in a picture missing the prompt cache. The client is
// a stand-in and waits are skipped; nothing here touches the network.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";

const waits = vi.hoisted(() => [] as number[]);
vi.mock("../src/ai/retry", async (orig) => ({
  ...(await orig<typeof import("../src/ai/retry")>()),
  pause: async (ms: number) => void waits.push(ms),
}));

import { retryWait } from "../src/ai/retry";
import { useDesign } from "../src/core/engine";
import { useSettings } from "../src/app/settings";
import { chatHistory, clearChat, sendMessage, setClientFactory, useChat, withCacheBreakpoint } from "../src/ai/chat";
import { callReviewer } from "../src/ai/review/reviewer";
import { runAgent, type AgentHooks, type Workspace } from "../src/agents/subagent";
import type { CheckReport } from "../src/core/checks";

type Block = Record<string, unknown> & { type: string };
type Reply = { content: Block[]; stop_reason: string } | Error;
type Sent = { max_tokens: number; messages: { role: string; content: Block[] | string }[] };

/** What the API sends part-way through a stream when it is overloaded. */
const overloaded = () => new Anthropic.APIError(undefined, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, undefined, new Headers(), "overloaded_error");

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
              if (r instanceof Error) throw r;
              return { id: "msg", type: "message", role: "assistant", model: params.model, content: r.content, stop_reason: r.stop_reason, usage: { input_tokens: 1, output_tokens: 1 } };
            },
          };
        },
      },
    },
  };
  return { requests, client: client as unknown as Anthropic };
}

beforeEach(() => void (waits.length = 0));

describe("waiting out a busy API", () => {
  it("retries what passes by itself, including an overload said part-way through a stream", () => {
    expect(retryWait(overloaded(), 0)).toBe(5);
    expect(retryWait(overloaded(), 1)).toBe(15);
    expect(retryWait(overloaded(), 3)).toBeNull();
    const limited = new Anthropic.RateLimitError(429, { type: "error", error: { type: "rate_limit_error" } }, "Rate limited", new Headers({ "retry-after": "30" }));
    expect(retryWait(limited, 0)).toBe(30);
    expect(retryWait(new Anthropic.APIConnectionError({ message: "Connection reset" }), 0)).toBe(5);
    expect(retryWait(new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error" } }, "Bad", new Headers()), 0)).toBeNull();
    expect(retryWait(new Anthropic.APIUserAbortError(), 0)).toBeNull();
  });

  describe("in the chat", () => {
    let stop: () => void;
    beforeEach(async () => {
      await clearChat();
      useSettings.setState({ model: "claude-opus-5-5", webSearch: false, maxSteps: 30, selfReview: "off", routeQuick: false });
      useDesign.setState({ source: 'design "Untitled design"\n', model: null, report: null });
      const report = { items: [], counts: { pass: 1, fail: 0, warn: 0, pending: 0, info: 0 }, ms: 1 } as unknown as CheckReport;
      stop = useDesign.subscribe((s) => {
        if (s.rev > s.reportRev) useDesign.setState({ report, reportRev: s.rev, stage: "done" });
      });
    });
    afterEach(() => {
      stop();
      setClientFactory(null);
    });

    it("sends the request again instead of ending the run", async () => {
      const { requests, client } = fakeClient([overloaded(), { stop_reason: "end_turn", content: [{ type: "text", text: "Here it is." }] }]);
      setClientFactory(() => client);
      await sendMessage("Make a block");
      expect(requests).toHaveLength(2);
      expect(waits).toEqual([5000]);
      // the busy note goes once the retry is under way, and no error is left behind
      expect(useChat.getState().items.filter((i) => i.kind === "notice")).toEqual([]);
      expect(chatHistory().at(-1)).toEqual({ role: "assistant", content: [{ type: "text", text: "Here it is." }] });
    });
  });

  it("keeps a review going", async () => {
    const submit = { type: "tool_use", id: "s1", name: "submit_review", input: { verdict: "pass", summary: "Fine.", assumptions: "", checked: [], findings: [], earlier: [] } };
    const { requests, client } = fakeClient([overloaded(), { stop_reason: "tool_use", content: [submit] }]);
    const out = await callReviewer(reviewInput(client));
    expect(out.submission.verdict).toBe("pass");
    expect(requests).toHaveLength(2);
    expect(waits).toEqual([5000]);
  });
});

function reviewInput(client: Anthropic) {
  return {
    client,
    model: "claude-opus-5-5",
    effort: "high",
    brief: { text: "A hook", from: "conversation" as const },
    round: 1,
    designSummary: "Design Hook",
    inventory: "plate",
    source: '1| design "Hook"',
    views: [{ name: "iso", label: "3/4 view", image: "data:image/jpeg;base64,AAAA" }],
    earlier: [],
    closeup: async () => null,
  };
}

describe("a review cut off at the length limit", () => {
  it("has room to think, and leaves out the unsigned thinking it was cut off in", async () => {
    const submit = { type: "tool_use", id: "s1", name: "submit_review", input: { verdict: "pass", summary: "Fine.", assumptions: "", checked: [], findings: [], earlier: [] } };
    const { requests, client } = fakeClient([
      { stop_reason: "max_tokens", content: [{ type: "thinking", thinking: "", signature: "" }] },
      { stop_reason: "tool_use", content: [submit] },
    ]);
    const out = await callReviewer(reviewInput(client));
    expect(out.submission.verdict).toBe("pass");
    expect(requests[0].max_tokens).toBe(64000);
    const [, cut, nudge] = requests[1].messages;
    expect(cut.content).toEqual([{ type: "text", text: "(Cut off at the length limit.)" }]);
    expect(String((nudge.content as Block[])[0].text)).toMatch(/You ran out of room/);
  });
});

describe("a subassembly agent cut off at the length limit", () => {
  const ws: Workspace = {
    id: "base",
    name: "Base",
    body: () => "",
    setBody: () => undefined,
    isolated: (b) => ({ src: 'design "t"\n' + b, start: 11, end: 11 + b.length }),
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

  it("carries on rather than reporting half its work as done", async () => {
    const { requests, client } = fakeClient([
      { stop_reason: "max_tokens", content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "Plan: a base pl" }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Built the base." }] },
    ]);
    const end = await runAgent({ anthropic: client, model: "claude-opus-5-5", effort: "high", system: "You build one subassembly.", kickoff: "Build the base.", maxSteps: 10, signal: new AbortController().signal }, ws, hooks);
    expect(end).toEqual({ status: "done", summary: "Built the base." });
    expect(requests).toHaveLength(2);
    expect(String((requests[1].messages[2].content as Block[])[0].text)).toMatch(/cut off\. Carry on/);
  });

  it("waits out an overload said part-way through a stream", async () => {
    const { requests, client } = fakeClient([overloaded(), { stop_reason: "end_turn", content: [{ type: "text", text: "Built the base." }] }]);
    const end = await runAgent({ anthropic: client, model: "claude-opus-5-5", effort: "high", system: "You build one subassembly.", kickoff: "Build the base.", maxSteps: 10, signal: new AbortController().signal }, ws, hooks);
    expect(end.status).toBe("done");
    expect(requests).toHaveLength(2);
    expect(waits).toEqual([5000]);
  });
});

describe("the prompt cache", () => {
  it("marks the newest turn even when it ends in a picture, such as a review's contact sheet", () => {
    const image = { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: "AAAA" } };
    const out = withCacheBreakpoint([
      { role: "user", content: [{ type: "text", text: "Make a hook" }] },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
      { role: "user", content: [{ type: "text", text: "Review: 1 finding" }, image] },
    ]);
    const last = out[2].content as Block[];
    expect(last[1].cache_control).toEqual({ type: "ephemeral" });
  });
});
