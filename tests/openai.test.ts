import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { openAIFetch, responseRequest } from "../src/ai/openai";

describe("OpenAI Responses adapter", () => {
  it("keeps tool IDs, multimodal results, reasoning and message order without Anthropic request fields", () => {
    const reasoning = { id: "rs_1", type: "reasoning", encrypted_content: "opaque", summary: [] };
    const p = responseRequest({ model: "gpt-6.1-sol", max_tokens: 4096, betas: ["anthropic-only"], system: [{ text: "Design carefully", cache_control: { type: "ephemeral" } }], output_config: { effort: "max" }, messages: [
      { role: "user", content: [{ type: "text", text: "Inspect it" }, { type: "document", source: { type: "base64", media_type: "application/pdf", data: "YQ==" } }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "not portable", signature: "claude" }, { type: "redacted_thinking", data: "kerf-openai:" + JSON.stringify(reasoning) }, { type: "tool_use", id: "call_1", name: "get_design", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "YQ==" } }] }] },
    ], tools: [{ name: "get_design", description: "Read", input_schema: { type: "object", properties: {} }, cache_control: { type: "ephemeral" } }] });
    expect(p.store).toBe(false); expect(p.reasoning.effort).toBe("xhigh"); expect(p.betas).toBeUndefined();
    expect(p.input.map((x: { type?: string }) => x.type)).toEqual([undefined, "reasoning", "function_call", "function_call_output"]);
    expect(p.input[0].content[1].file_data).toBe("data:application/pdf;base64,YQ==");
    expect(p.input[3]).toMatchObject({ call_id: "call_1", output: [{ type: "input_image", image_url: "data:image/png;base64,YQ==" }] });
    expect(p.tools[0]).toMatchObject({ type: "function", name: "get_design", strict: false });
  });
  it("streams through the real shared SDK and preserves function calls and usage", async () => {
    const item = { id: "fc_1", type: "function_call", call_id: "call_1", name: "get_design", arguments: "{}" };
    const output = { id: "msg_1", type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Checking the model ✓", annotations: [] }] };
    const response = { id: "resp_1", model: "gpt-6.1-sol", status: "completed", output: [output, item], usage: { input_tokens: 100, output_tokens: 30, input_tokens_details: { cached_tokens: 40 } } };
    const events = [
      { type: "response.output_item.added", item: output },
      { type: "response.output_text.delta", item_id: "msg_1", content_index: 0, delta: "Checking the model ✓" },
      { type: "response.output_item.done", item: output },
      { type: "response.output_item.added", item },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{}" },
      { type: "response.output_item.done", item }, { type: "response.completed", response },
    ];
    let seen = false;
    const fake: typeof fetch = async (url, init) => {
      expect(url).toBe("https://api.openai.com/v1/responses");
      const h = new Headers(init?.headers); expect(h.get("authorization")).toBe("Bearer sk-openai-test"); expect(h.has("x-api-key")).toBe(false); expect(h.has("anthropic-beta")).toBe(false);
      seen = true; const bytes = new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
      return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
    };
    const client = new Anthropic({ apiKey: "placeholder", fetch: openAIFetch("sk-openai-test", fake), maxRetries: 0 });
    const stream = client.beta.messages.stream({ model: "gpt-6.1-sol", max_tokens: 1024, messages: [{ role: "user", content: "Inspect" }] });
    let text = ""; stream.on("text", delta => { text += delta; });
    const final = await stream.finalMessage();
    expect(seen).toBe(true); expect(text).toBe("Checking the model ✓"); expect(final.stop_reason).toBe("tool_use");
    expect(final.content[1]).toMatchObject({ type: "tool_use", id: "call_1", name: "get_design", input: {} });
    expect(final.usage).toMatchObject({ input_tokens: 60, output_tokens: 30, cache_read_input_tokens: 40 });
  });
  it("rejects truncated streams instead of executing an incomplete edit", async () => {
    const fake: typeof fetch = async () => new Response('data: {"type":"response.output_text.delta","item_id":"m","content_index":0,"delta":"partial"}\n\n');
    const client = new Anthropic({ apiKey: "placeholder", fetch: openAIFetch("sk-test", fake), maxRetries: 0 });
    await expect(client.beta.messages.stream({ model: "gpt-6.1-sol", max_tokens: 1024, messages: [{ role: "user", content: "Hi" }] }).finalMessage()).rejects.toThrow(/before it completed/);
  });
  it("retains encrypted reasoning and turns summary responses into compaction blocks", async () => {
    const reasoning = { type: "reasoning", id: "rs_1", encrypted_content: "opaque", summary: [] };
    const fake: typeof fetch = async () => new Response([
      { type: "response.output_item.done", item: reasoning },
      { type: "response.completed", response: { id: "r", model: "gpt-6.1-sol", status: "completed", output: [reasoning, { type: "message", content: [{ type: "output_text", text: "Keep the 30 mm tube." }] }], usage: { input_tokens: 20, output_tokens: 10 } } },
    ].map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
    const client = new Anthropic({ apiKey: "placeholder", fetch: openAIFetch("sk-test", fake), maxRetries: 0 });
    const final = await client.beta.messages.stream({ model: "gpt-6.1-sol", max_tokens: 1024, messages: [{ role: "user", content: "Summarise" }], compaction: { type: "summarize" } } as never).finalMessage();
    expect(final.stop_reason).toBe("compaction"); expect(final.content[0]).toMatchObject({ type: "compaction", content: "Keep the 30 mm tube." });
    const plain = responseRequest({ messages: [{ role: "assistant", content: [{ type: "redacted_thinking", data: "kerf-openai:" + JSON.stringify(reasoning) }] }] });
    expect(plain.input).toEqual([reasoning]);
  });
  it("redacts keys from upstream errors and preserves rate-limit status", async () => {
    const fake: typeof fetch = async () => Response.json({ error: { message: "Rejected sk-secret12345678901234567890" } }, { status: 429, headers: { "retry-after": "2" } });
    const r = await openAIFetch("key", fake)("ignored", { body: JSON.stringify({ model: "gpt-6.1-sol" }) });
    expect(r.status).toBe(429); expect(r.headers.get("retry-after")).toBe("2"); expect(await r.text()).not.toContain("sk-secret");
  });
});
