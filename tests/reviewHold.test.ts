// review_design asked for in the same response as an edit: it waits for the
// edit's build and checks, and is held, without using a review round, when the
// edit broke something the designer should fix first. The client is a
// stand-in; nothing here touches the network.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { useDesign } from "../src/core/engine";
import { useSettings } from "../src/app/settings";
import { clearChat, sendMessage, setClientFactory } from "../src/ai/chat";
import type { CheckItem, CheckReport } from "../src/core/checks";

type Block = Record<string, unknown> & { type: string };
type Sent = { messages: { role: string; content: Block[] | string }[] };

function fakeClient(replies: { content: Block[]; stop_reason: string }[]) {
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
const edit = (from: string, to: string) => ({ type: "tool_use", id: "e1", name: "edit_design", input: { summary: "Thinner wall", edits: [{ old_text: from, new_text: to }] } });
const review = { type: "tool_use", id: "r1", name: "review_design", input: {} };
const resultOf = (r: Sent, id: string) => {
  const c = r.messages.at(-1)!.content as Block[];
  const b = c.find((x) => x.tool_use_id === id)!;
  return typeof b.content === "string" ? b.content : (b.content as Block[]).map((x) => String(x.text ?? "")).join("\n");
};

/** a check that fails once the wall is thinner than 2 mm */
function reportFor(source: string): CheckReport {
  const thin = /param wall = 1\b/.test(source);
  const items = [{ id: "wall:plate", category: "geometry", status: thin ? "fail" : "pass", title: "Plate wall is thick enough", detail: "", basis: "geometry" }] as unknown as CheckItem[];
  return { items, counts: { pass: thin ? 0 : 1, fail: thin ? 1 : 0, warn: 0, pending: 0, info: 0 }, ms: 1 };
}

describe("a review asked for with the edit that finishes the work", () => {
  let stop: () => void;
  beforeEach(async () => {
    await clearChat();
    useSettings.setState({ model: "claude-opus-5-5", webSearch: false, maxSteps: 30, selfReview: "off", routeQuick: false, reviewRounds: 2 });
    useDesign.setState({ source: SOURCE, model: null, report: reportFor(SOURCE) });
    stop = useDesign.subscribe((s) => {
      if (s.rev > s.reportRev) useDesign.setState({ report: reportFor(s.source), reportRev: s.rev, stage: "done" });
    });
  });
  afterEach(() => {
    stop();
    setClientFactory(null);
  });

  it("is held when the edit leaves a check failing that passed before, so the designer fixes it first", async () => {
    const requests = fakeClient([{ stop_reason: "tool_use", content: [edit("param wall = 4", "param wall = 1"), review] }]);
    await sendMessage("Make the wall thinner");

    expect(resultOf(requests[1], "e1")).toMatch(/Built and checked/);
    const held = resultOf(requests[1], "r1");
    expect(held).toMatch(/^Not reviewed yet/);
    expect(held).toContain("Plate wall is thick enough");
    expect(held).toMatch(/No review round was used/);
    // finishing with the check still failing sends Claude back once to fix it
    expect(requests).toHaveLength(3);
    const gate = requests[2].messages.at(-1)!.content as Block[];
    expect(gate.map((b) => String(b.text ?? "")).join("")).toMatch(/before you finish, the design still fails 1 check[\s\S]*Plate wall is thick enough/);
  });

  it("is held when the edit was not applied", async () => {
    const requests = fakeClient([{ stop_reason: "tool_use", content: [edit("param wall = 9", "param wall = 3"), review] }]);
    await sendMessage("Make the wall thinner");

    expect(requests).toHaveLength(2);
    expect(resultOf(requests[1], "r1")).toMatch(/a change above was not applied/);
  });

  it("runs when the edit leaves nothing new failing", async () => {
    const requests = fakeClient([{ stop_reason: "tool_use", content: [edit("param wall = 4", "param wall = 3"), review] }]);
    await sendMessage("Make the wall thinner");

    expect(resultOf(requests.at(-1)!, "r1")).not.toMatch(/Not reviewed/);
  });
});
