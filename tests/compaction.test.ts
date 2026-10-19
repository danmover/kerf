// A conversation that grows past what Claude should read on every step, or past
// what it can read at all: the older turns become a summary written by the API,
// the newest stay word for word, and the user's messages, the plan and the
// design are given again in full. The client is a stand-in; nothing here
// touches the network.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { useDesign } from "../src/core/engine";
import { useSettings } from "../src/app/settings";
import { chatHistory, clearChat, sendMessage, setClientFactory, useChat } from "../src/ai/chat";
import { COMPACT_BETA, cutPoints, keepTokens, planCut, promptTooLong } from "../src/ai/compact";
import type { CheckReport } from "../src/core/checks";

type Block = Record<string, unknown> & { type: string };
type Reply = { content: Block[]; stop_reason: string; usage?: Record<string, unknown> } | Error;
type Sent = { betas?: string[]; compaction?: { type: string; instructions?: string }; system: unknown; tools: unknown; messages: { role: string; content: Block[] | string }[] };

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
              return { id: "msg", type: "message", role: "assistant", model: params.model, content: r.content, stop_reason: r.stop_reason, usage: r.usage ?? { input_tokens: 1, output_tokens: 1 } };
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
const reply = (t: string, input_tokens = 1, extra: Block[] = []): Reply => ({ stop_reason: "end_turn", content: [...extra, text(t)], usage: { input_tokens, output_tokens: 1 } });
const summary = (s: string): Reply => ({
  stop_reason: "compaction",
  content: [{ type: "compaction", content: s, encrypted_content: null, signature: `sig-${s}` }],
  usage: { input_tokens: 0, output_tokens: 0, iterations: [{ type: "compaction", input_tokens: 150_000, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }] },
});
const tooLong = () => {
  const msg = "prompt is too long: 1054564 tokens > 1000000 maximum";
  return new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: msg } }, msg, new Headers());
};
/** a message as Claude saw it, without the cache markers that move from request to request */
const bare = (m: unknown) => JSON.parse(JSON.stringify(m, (k, v) => (k === "cache_control" ? undefined : v)));
const lastText = (m: { content: Block[] | string }) => {
  const c = m.content as Block[];
  return c.filter((b) => b.type === "text").map((b) => String(b.text)).join("\n");
};
const notices = () => useChat.getState().items.filter((i) => i.kind === "notice") as { level: string; title: string; detail?: string }[];

const SOURCE = 'design "Bracket"\npart plate { body box(40, 4, 30) }\n';

describe("where a summary may cut the conversation", () => {
  const u = (t: string): BetaMessageParam => ({ role: "user", content: [{ type: "text", text: t }] });
  const a = (t: string): BetaMessageParam => ({ role: "assistant", content: [{ type: "text", text: t }] });
  const call: BetaMessageParam = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "run_checks", input: {} }] };
  const result: BetaMessageParam = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "All pass." }] };
  const h = [u("Make a bracket"), a("Here it is."), u("Thicker"), call, result, a("Done."), u("Add a hole")];

  it("keeps the newest turns that fit, and never separates a tool call from its result", () => {
    expect(cutPoints(h)).toEqual([2, 6]);
    expect(planCut(h, 40_000, 600_000, [10, 60_000, 10, 10_000, 30_000, 5_000, 10])).toEqual({ at: 6, all: false, final: true });
    expect(planCut(h, 40_000, 600_000, [10, 60_000, 10, 1_000, 3_000, 500, 10])).toEqual({ at: 2, all: false, final: true });
  });

  it("summarises everything when one long turn would leave too little before it", () => {
    expect(planCut(h, 40_000, 600_000, [10, 100, 10, 10_000, 30_000, 5_000, 10])).toEqual({ at: 7, all: true, final: true });
  });

  it("summarises a conversation too long for one request in parts, oldest first", () => {
    expect(planCut(h, 40_000, 70_000, [10, 60_000, 10, 10_000, 30_000, 5_000, 10])).toEqual({ at: 2, all: false, final: false });
    expect(planCut(h, 40_000, 50_000, [10, 60_000, 10, 10_000, 30_000, 5_000, 10])).toBeNull();
  });

  it("does not cut right after an earlier summary, and reads the size from a refusal", () => {
    const block: BetaMessageParam = { role: "assistant", content: [{ type: "compaction", content: "Summary", signature: "s" } as never] };
    expect(cutPoints([block, u("Thicker"), a("Done."), u("Add a hole")])).toEqual([3]);
    expect(promptTooLong("400 prompt is too long: 1054564 tokens > 1000000 maximum")).toBe(1054564);
    expect(promptTooLong("400 Invalid `signature` in `thinking` block")).toBeNull();
  });

  it("keeps a fifth of the size set in Settings word for word", () => {
    expect(keepTokens(500_000)).toBe(100_000);
    expect(planCut(h, keepTokens(500_000), 600_000, [10, 60_000, 10, 10_000, 30_000, 5_000, 10])).toEqual({ at: 2, all: false, final: true });
  });
});

describe("a long design conversation", () => {
  let stop: () => void;
  beforeEach(async () => {
    await clearChat();
    useSettings.setState({ model: "claude-opus-5-5", webSearch: false, maxSteps: 30, selfReview: "off", routeQuick: false, compactAt: 200_000 });
    useDesign.setState({ source: SOURCE, model: null, report: null });
    const report = { items: [], counts: { pass: 1, fail: 0, warn: 0, pending: 0, info: 0 }, ms: 1 } as unknown as CheckReport;
    stop = useDesign.subscribe((s) => {
      if (s.rev > s.reportRev) useDesign.setState({ report, reportRev: s.rev, stage: "done" });
    });
  });
  afterEach(() => {
    stop();
    setClientFactory(null);
  });

  it("is summarised past 200K tokens, keeping the newest turns, their thinking and everything the user said", async () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig2" };
    const requests = fakeClient([reply("x".repeat(300_000), 70_000), reply("Made it 40 mm wide.", 210_000, [thinking]), summary("A bracket for a shelf."), reply("Added the hole.")]);
    await sendMessage("Make a bracket");
    await sendMessage("Make it 40 mm wide");
    await sendMessage("Now add a 5 mm hole");

    expect(requests).toHaveLength(4);
    const [, second, compact, next] = requests;
    // the summary request: the older turn only, with the same system prompt and tools, and no tools to call
    expect(compact.compaction?.type).toBe("summarize");
    expect(compact.compaction?.instructions).toMatch(/Do not call any tools/);
    expect(compact.betas).toContain(COMPACT_BETA);
    expect(compact.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(compact.system).toEqual(second.system);
    expect(compact.tools).toEqual(second.tools);

    // the next request starts from the summary exactly as returned, then the kept turn unchanged, thinking included
    const [block, keptUser, keptReply, newest] = next.messages;
    expect(block).toEqual({ role: "assistant", content: (summary("A bracket for a shelf.") as { content: Block[] }).content });
    expect(bare(keptUser)).toEqual(bare(second.messages[2]));
    expect(keptReply.content).toEqual([thinking, text("Made it 40 mm wide.")]);
    expect(next.betas).toContain(COMPACT_BETA);
    const restated = lastText(newest);
    expect(restated).toContain("Now add a 5 mm hole");
    expect(restated).toMatch(/<user-messages[^>]*>\n1\. Make a bracket\n2\. Make it 40 mm wide\n3\. Now add a 5 mm hole\n<\/user-messages>/);
    expect(restated).toContain("part plate { body box(40, 4, 30) }");

    expect(chatHistory()[0]).toEqual(block);
    expect(notices().map((n) => n.title)).toEqual(["Summarised the earlier conversation"]);
    expect(notices()[0].detail).toMatch(/the last 2 turns stay word for word/);
  });

  it("is not summarised below the size set in Settings", async () => {
    useSettings.setState({ compactAt: 500_000 });
    const requests = fakeClient([reply("x".repeat(300_000), 70_000), reply("Made it 40 mm wide.", 210_000), reply("Added the hole.", 300_000)]);
    await sendMessage("Make a bracket");
    await sendMessage("Make it 40 mm wide");
    await sendMessage("Now add a 5 mm hole");

    expect(requests).toHaveLength(3);
    expect(requests.some((r) => r.compaction)).toBe(false);
    expect(notices()).toEqual([]);
  });

  it("recovers a chat already over Claude's limit when the user tries again, summarising it in parts", async () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig3" };
    const requests = fakeClient([reply("y".repeat(1_300_000)), reply("z".repeat(1_300_000)), reply("Frame done.", 1, [thinking]), tooLong(), summary("Part one."), summary("Parts one and two."), reply("Carrying on with the plan.")]);
    await sendMessage("Plan a drill robot");
    await sendMessage("Build the frame");
    await sendMessage("Check the frame");
    await sendMessage("Continue with the plan.");

    expect(requests).toHaveLength(7);
    const [, , , refused, first, second, retry] = requests;
    expect(refused.messages).toHaveLength(7);
    // the oldest turn first, then that summary with the next turn
    expect(first.compaction).toBeDefined();
    expect(first.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(second.compaction).toBeDefined();
    expect((second.messages[0].content as Block[])[0]).toMatchObject({ type: "compaction", content: "Part one." });
    expect(second.messages).toHaveLength(3);
    // the request goes again from the newest summary, then the kept turn with its thinking, then the message that was refused
    expect(retry.compaction).toBeUndefined();
    expect(retry.messages).toHaveLength(4);
    expect((retry.messages[0].content as Block[])[0]).toMatchObject({ type: "compaction", content: "Parts one and two." });
    expect(retry.messages[2].content).toEqual([thinking, text("Frame done.")]);
    expect(lastText(retry.messages[3])).toMatch(/Continue with the plan\.\n<after-summary/);
    expect(chatHistory().at(-1)).toEqual({ role: "assistant", content: [text("Carrying on with the plan.")] });
    expect(notices().map((n) => n.level)).toEqual(["info"]);
  });

  it("carries on with the whole conversation when it cannot be summarised, and does not ask again at every step", async () => {
    const refusal = new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "compaction is not supported" } }, "Bad", new Headers());
    const requests = fakeClient([reply("x".repeat(300_000), 70_000), reply("Made it 40 mm wide.", 210_000), refusal, reply("Added the hole.", 215_000), reply("Rounded the corners.", 220_000)]);
    await sendMessage("Make a bracket");
    await sendMessage("Make it 40 mm wide");
    await sendMessage("Now add a 5 mm hole");
    await sendMessage("Round the corners");

    expect(requests).toHaveLength(5);
    expect(requests[3].compaction).toBeUndefined();
    expect(requests[3].messages).toHaveLength(5);
    expect(requests[4].compaction).toBeUndefined();
    expect(notices().map((n) => [n.level, n.title])).toEqual([["warn", "Could not summarise the earlier conversation"]]);
    expect(chatHistory().at(-1)).toEqual({ role: "assistant", content: [text("Rounded the corners.")] });
  });
});
