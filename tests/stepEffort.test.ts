// The first step of a reply thinks at the effort set in Settings, the steps
// after it at medium. The level is set by marks inside the conversation, so
// the request's own effort, and with it the prompt cache, never changes. The
// client is a stand-in; nothing here touches the network.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { useDesign } from "../src/core/engine";
import { useSettings } from "../src/app/settings";
import { chatHistory, clearChat, sendMessage, setClientFactory } from "../src/ai/chat";
import { cutPoints } from "../src/ai/compact";
import { STEP_EFFORT_BETA, currentEffort, effortMark, markEffort, stepEffort } from "../src/ai/stepEffort";

type Block = Record<string, unknown> & { type: string };
type Reply = { content: Block[]; stop_reason: string } | Error;
type Sent = { betas?: string[]; output_config?: { effort?: string }; messages: { role: string; content: Block[] | string; output_config?: { effort: string } }[] };

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
  setClientFactory(() => client as unknown as Anthropic);
  return requests;
}

const text = (t: string) => ({ type: "text", text: t });
const look: Reply = { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "get_design", input: {} }] };
const done = (t: string): Reply => ({ stop_reason: "end_turn", content: [text(t)] });
const bare = (m: unknown) => JSON.parse(JSON.stringify(m, (k, v) => (k === "cache_control" ? undefined : v)));
const marks = (r: Sent) => r.messages.flatMap((m, i) => (m.role === "system" ? [[i, m.output_config?.effort]] : []));

const u = (t: string): BetaMessageParam => ({ role: "user", content: [{ type: "text", text: t }] });
const a = (t: string): BetaMessageParam => ({ role: "assistant", content: [{ type: "text", text: t }] });

describe("the effort for each step", () => {
  it("is the chosen one for the first step, and at most medium after it", () => {
    expect(stepEffort("high", true, true)).toBe("high");
    expect(stepEffort("high", false, true)).toBe("medium");
    expect(stepEffort("max", false, true)).toBe("medium");
    expect(stepEffort("low", false, true)).toBe("low");
    expect(stepEffort("high", false, false)).toBe("high");
  });

  it("is set by a mark before the newest user message, only when it changes", () => {
    const h = [u("Make a bracket"), a("Here it is."), u("Thicker")];
    expect(markEffort(h, "high", "high")).toBe(false);
    expect(markEffort(h, "medium", "high")).toBe(true);
    expect(h.map((m) => m.role)).toEqual(["user", "assistant", "system", "user"]);
    expect(currentEffort(h, "high")).toBe("medium");
    expect(markEffort(h, "medium", "high")).toBe(false);
  });

  it("leaves a mark with the turns a summary covers, so the kept turns still start with a user message", () => {
    const h = [u("Make a bracket"), a("Here it is."), effortMark("high"), u("Thicker"), a("Done."), u("Add a hole")];
    expect(cutPoints(h)).toEqual([3, 5]);
  });
});

describe("a reply with several steps", () => {
  beforeEach(async () => {
    await clearChat();
    useSettings.setState({ model: "claude-opus-5-5", effort: "high", fasterFollowUps: true, webSearch: false, maxSteps: 30, selfReview: "off", routeQuick: false });
    useDesign.setState({ source: 'design "Bracket"\npart plate { body box(40, 4, 30) }\n', model: null, report: null });
  });
  afterEach(() => setClientFactory(null));

  it("thinks at medium after the first step and back at high for the next message, without changing the request's effort", async () => {
    const requests = fakeClient([look, done("It is 40 mm wide."), done("Made it thicker.")]);
    await sendMessage("How wide is the bracket?");
    await sendMessage("Make it thicker");

    expect(requests).toHaveLength(3);
    expect(requests.map((r) => r.output_config?.effort)).toEqual(["high", "high", "high"]);
    // the first step: no mark, no opt-in
    expect(marks(requests[0])).toEqual([]);
    expect(requests[0].betas ?? []).not.toContain(STEP_EFFORT_BETA);
    // the step after the tool call: medium, set just before the tool result
    expect(requests[1].messages.map((m) => m.role)).toEqual(["user", "assistant", "system", "user"]);
    expect(marks(requests[1])).toEqual([[2, "medium"]]);
    expect(requests[1].messages[2].content).toEqual([]);
    expect(requests[1].betas).toContain(STEP_EFFORT_BETA);
    // the next message: high again, and every earlier message as it was sent
    expect(marks(requests[2])).toEqual([
      [2, "medium"],
      [5, "high"],
    ]);
    expect(bare(requests[2].messages.slice(0, 4))).toEqual(bare(requests[1].messages));
    expect(chatHistory().filter((m) => (m.role as string) === "system")).toHaveLength(2);
  });

  it("keeps every step at the chosen effort when faster follow-ups are off", async () => {
    useSettings.setState({ fasterFollowUps: false });
    const requests = fakeClient([look, done("It is 40 mm wide.")]);
    await sendMessage("How wide is the bracket?");

    expect(requests.flatMap(marks)).toEqual([]);
    expect(requests.map((r) => r.output_config?.effort)).toEqual(["high", "high"]);
  });

  it("sends the conversation without marks to a model that refuses them", async () => {
    const msg = "output_config.effort requires a model that supports per-turn effort; this model does not";
    const refusal = new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: msg } }, msg, new Headers());
    const requests = fakeClient([look, refusal, done("It is 40 mm wide.")]);
    await sendMessage("How wide is the bracket?");

    expect(requests).toHaveLength(3);
    expect(marks(requests[1])).toEqual([[2, "medium"]]);
    expect(marks(requests[2])).toEqual([]);
    expect(requests[2].betas ?? []).not.toContain(STEP_EFFORT_BETA);
    expect(requests[2].output_config?.effort).toBe("high");
  });
});
