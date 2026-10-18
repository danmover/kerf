// A response that runs past the output limit before its work is done: Claude
// carries on by itself in smaller steps instead of leaving the user a
// "continue" button. The client is a stand-in; nothing touches the network.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { useDesign } from "../src/core/engine";
import { useSettings } from "../src/app/settings";
import { clearChat, sendMessage, setClientFactory, useChat } from "../src/ai/chat";
import { trimCutOff } from "../src/ai/history";
import type { CheckReport } from "../src/core/checks";

type Block = Record<string, unknown> & { type: string };
type Reply = { content: Block[]; stop_reason: string };
type Sent = { max_tokens: number; messages: { role: string; content: Block[] | string }[] };

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

const thinking = { type: "thinking", thinking: "", signature: "sig" };
const cutWrite = { type: "tool_use", id: "w1", name: "write_design", input: { summary: "Clip", source: 'design "Clip"\npart base { body box(40, ' } };
const SOURCE = 'design "Clip"\npart base { body box(40, 25, 5) }\n';
const notices = () => useChat.getState().items.filter((i) => i.kind === "notice") as { level: string; title: string }[];

describe("a response cut off at the length limit", () => {
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

  it("carries on by itself when the first write_design is cut off, keeping the thinking that planned it", async () => {
    const requests = fakeClient([
      { stop_reason: "max_tokens", content: [thinking, cutWrite] },
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "w2", name: "write_design", input: { summary: "Clip", source: SOURCE } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Here is the clip." }] },
    ]);
    await sendMessage("Make a clip for a 25 mm tube");

    expect(requests).toHaveLength(3);
    expect(requests[0].max_tokens).toBe(64000);
    // the cut call is gone, the signed thinking stays, and Claude is told what happened
    const [, cut, note] = requests[1].messages;
    expect(cut.content).toEqual([thinking, { type: "text", text: "(Cut off at the length limit.)" }]);
    expect(note.role).toBe("user");
    expect((note.content as Block[])[0].text).toMatch(/while writing its write_design call, so that call did not run\. Write the design in two or more steps/);
    expect(useDesign.getState().source).toBe(SOURCE);
    expect(notices().map((n) => n.level)).toEqual(["info"]);
  });

  it("runs the calls that were complete, and tells Claude about the cut one with their results", async () => {
    const requests = fakeClient([
      {
        stop_reason: "max_tokens",
        content: [thinking, { type: "tool_use", id: "b1", name: "update_brief", input: { summary: "Brief", fields: { purpose: "Hold a 25 mm tube" } } }, cutWrite],
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] },
    ]);
    await sendMessage("Make a clip for a 25 mm tube");
    const results = requests[1].messages[2].content as Block[];
    expect(results.map((b) => b.type)).toEqual(["tool_result", "text"]);
    expect(results[0].tool_use_id).toBe("b1");
    expect(String(results[1].text)).toContain("write_design call");
    expect(useDesign.getState().model?.brief?.purpose).toBe("Hold a 25 mm tube");
  });

  it("stops and says so when it keeps running past the limit", async () => {
    const requests = fakeClient([
      { stop_reason: "max_tokens", content: [thinking, cutWrite] },
      { stop_reason: "max_tokens", content: [thinking, cutWrite] },
      { stop_reason: "max_tokens", content: [thinking, cutWrite] },
    ]);
    await sendMessage("Make a clip");
    expect(requests).toHaveLength(3);
    expect(notices().map((n) => n.level)).toEqual(["info", "info", "warn"]);
    expect(useChat.getState().busy).toBe(false);
  });

  it("leaves out thinking that stopped part-way", () => {
    const { content, cutTool } = trimCutOff([{ type: "text", text: "Planning" }, { type: "thinking", thinking: "", signature: "" }]);
    expect(cutTool).toBeNull();
    expect(content).toEqual([{ type: "text", text: "Planning" }]);
  });
});
