import { describe, expect, it } from "vitest";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { bindingKey, firstEdit, forSaving, hasThinking, isThinkingSignatureError, messageKeys, prepareSaved, stripImages, stripThinking } from "../src/ai/history";

const image = { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: "AAAA" } };

function convo(): BetaMessageParam[] {
  return [
    { role: "user", content: [{ type: "text", text: "make a bracket" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "plan", signature: "s1" }, { type: "tool_use", id: "t1", name: "capture_view", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "iso view" }, image] }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "looks fine", signature: "s2" }, { type: "text", text: "Done." }] },
    { role: "user", content: [{ type: "text", text: "thicker" }] },
    { role: "assistant", content: [{ type: "redacted_thinking", data: "x" }, { type: "text", text: "Made it 6 mm." }] },
  ];
}

describe("chat history fingerprints", () => {
  it("treats appending, or dropping messages from the end, as unchanged", () => {
    const h = convo();
    const before = messageKeys(h.slice(0, 4));
    expect(firstEdit(before, messageKeys(h))).toBe(-1);
    expect(firstEdit(messageKeys(h), messageKeys(h.slice(0, 3)))).toBe(-1);
  });

  it("finds the first earlier message that changed, even when edited in place", () => {
    const h = convo();
    const before = messageKeys(h);
    (h[2].content as { content: unknown[] }[])[0].content[1] = { type: "text", text: "[earlier image removed]" };
    expect(firstEdit(before, messageKeys(h))).toBe(2);
  });

  it("ignores cache_control markers, which can move freely", () => {
    const h = convo();
    const marked = h.map((m, i) => (i === 4 ? { ...m, content: [{ type: "text" as const, text: "thicker", cache_control: { type: "ephemeral" as const } }] } : m));
    expect(firstEdit(messageKeys(h), messageKeys(marked))).toBe(-1);
    expect(bindingKey([{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }], [])).toBe(bindingKey([{ type: "text", text: "sys" }], []));
  });

  it("changes the binding when the system prompt or the tools change", () => {
    const k = bindingKey([{ type: "text", text: "sys" }], [{ name: "a" }]);
    expect(bindingKey([{ type: "text", text: "sys!" }], [{ name: "a" }])).not.toBe(k);
    expect(bindingKey([{ type: "text", text: "sys" }], [{ name: "a" }, { name: "b" }])).not.toBe(k);
  });
});

describe("removing thinking blocks", () => {
  it("removes thinking and redacted thinking from a message on, keeping text and tool calls", () => {
    const h = convo();
    const same = h;
    expect(stripThinking(h, 2)).toBe(2);
    expect(h).toBe(same);
    expect((h[1].content as { type: string }[]).map((b) => b.type)).toEqual(["thinking", "tool_use"]);
    expect((h[3].content as { type: string }[]).map((b) => b.type)).toEqual(["text"]);
    expect((h[5].content as { type: string }[]).map((b) => b.type)).toEqual(["text"]);
    expect(hasThinking(h, 2)).toBe(false);
    expect(hasThinking(h)).toBe(true);
  });

  it("keeps an assistant turn that was only thinking valid", () => {
    const h: BetaMessageParam[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "s" }] },
    ];
    stripThinking(h);
    expect(h[1].content).toEqual([{ type: "text", text: "(no reply text)" }]);
  });
});

describe("saving and reopening a chat", () => {
  it("leaves messages without images untouched and notes where saving changed them", () => {
    const h = convo();
    const { history, validBefore } = forSaving(h, messageKeys(h));
    expect(validBefore).toBe(2);
    expect(history[0]).toBe(h[0]);
    expect(history[1]).toBe(h[1]);
    expect(JSON.stringify(history[2])).toContain("[image omitted from saved history]");
    expect(JSON.stringify(h[2])).not.toContain("omitted");
  });

  it("strips attached images and documents in user turns too", () => {
    const m: BetaMessageParam = { role: "user", content: [image, { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBE" } }, { type: "text", text: "like this" }] };
    expect(JSON.stringify(stripImages(m))).not.toContain("base64");
    const plain: BetaMessageParam = { role: "user", content: [{ type: "text", text: "x" }] };
    expect(stripImages(plain)).toBe(plain);
  });

  it("notes an earlier message that changed since the last request", () => {
    const h = convo().slice(0, 2);
    const keys = messageKeys(h);
    h[0] = { role: "user", content: [{ type: "text", text: "make a hook" }] };
    expect(forSaving(h, keys).validBefore).toBe(0);
  });

  it("keeps thinking that still matches when the prompt and tools are the same", () => {
    const h = convo();
    const { history, validBefore } = forSaving(h, messageKeys(h));
    expect(prepareSaved(history, { binding: "k", validBefore }, "k")).toBe(2);
    expect(hasThinking(history, 0)).toBe(true);
    expect(hasThinking(history, 2)).toBe(false);
  });

  it("drops all thinking after an update changed the prompt or tools, or from a chat saved before this was recorded", () => {
    const a = convo();
    expect(prepareSaved(a, { binding: "old", validBefore: 6 }, "new")).toBe(3);
    const b = convo();
    expect(prepareSaved(b, {}, "new")).toBe(3);
    expect(hasThinking(a) || hasThinking(b)).toBe(false);
  });
});

describe("recognising the API's answer", () => {
  it("knows the signature error from a model that does not support thinking", () => {
    const real =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.3.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to \\"drop_block\\". That setting requires the `thinking-binding-controls-2026-08-01` value in the `anthropic-beta` header. Content before this block differs from when it was created, first at `messages.2.content.0`."}}';
    expect(isThinkingSignatureError(real)).toBe(true);
    expect(isThinkingSignatureError('400 {"error":{"message":"thinking: adaptive thinking is not supported on this model"}}')).toBe(false);
  });
});
