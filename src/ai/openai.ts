// Translate Kerf's shared message/tool format at the network boundary. The
// existing chat, reviewer and agents keep the same tool execution and history.
// No credentials or provider-specific request headers cross between providers.
type Wire = Record<string, any>;
const REASONING = "kerf-openai:";
export const isOpenAIModel = (model: string) => model.startsWith("gpt-");

function parts(blocks: unknown, assistant = false): Wire[] {
  if (typeof blocks === "string") return [{ type: assistant ? "output_text" : "input_text", text: blocks }];
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((b: Wire): Wire[] => {
    if (b.type === "text") return [{ type: assistant ? "output_text" : "input_text", text: b.text }];
    if (b.type === "image" && b.source?.type === "base64") return [{ type: "input_image", image_url: `data:${b.source.media_type};base64,${b.source.data}` }];
    if (b.type === "document" && b.source?.type === "base64") return [{ type: "input_file", filename: b.title || "reference.pdf", file_data: `data:${b.source.media_type};base64,${b.source.data}` }];
    if (b.type === "compaction" && b.content) return [{ type: "input_text", text: `Earlier conversation summary:\n${b.content}` }];
    return [];
  });
}

/** Preserve function IDs, images/PDFs, message order and encrypted reasoning. */
export function responseRequest(p: Wire): Wire {
  const input: Wire[] = [];
  for (const m of p.messages ?? []) {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? [];
    let pending: Wire[] = [];
    const flush = () => {
      if (!pending.length) return;
      const content = parts(pending, m.role === "assistant");
      if (content.length) input.push({ role: m.role, content, ...(m.role === "assistant" && pending[0].openai_phase ? { phase: pending[0].openai_phase } : {}) });
      pending = [];
    };
    for (const b of blocks) {
      if (b.type === "tool_use") {
        flush(); input.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
      } else if (b.type === "tool_result") {
        flush(); const output = parts(b.content);
        input.push({ type: "function_call_output", call_id: b.tool_use_id, output: output.length ? output : String(b.is_error ? "Tool failed." : "Done.") });
      } else if (b.type === "redacted_thinking" && String(b.data).startsWith(REASONING)) {
        flush(); input.push(JSON.parse(b.data.slice(REASONING.length)));
      } else if (b.type === "compaction") {
        flush(); input.push({ role: "user", content: parts([b]) });
      } else if (b.type === "text" || b.type === "image" || b.type === "document") pending.push(b);
      // Anthropic thinking signatures and server-tool blocks are not OpenAI input.
    }
    flush();
  }
  const tools = (p.tools ?? []).filter((t: Wire) => t.input_schema).map((t: Wire) => ({ type: "function", name: t.name, description: t.description, parameters: t.input_schema, strict: false }));
  if ((p.tools ?? []).some((t: Wire) => /^web_search_/.test(t.type ?? ""))) tools.push({ type: "web_search" });
  const effort = p.output_config?.effort;
  const summary = !!p.compaction;
  return {
    model: p.model, store: false, stream: !!p.stream,
    instructions: (typeof p.system === "string" ? p.system : (p.system ?? []).map((b: Wire) => b.text ?? "").join("\n\n")) + (summary ? `\n\nSummarise this conversation for continuing the design task. ${p.compaction.instructions ?? ""} Return only the summary; do not call tools.` : ""),
    input, max_output_tokens: Math.max(1024, p.max_tokens ?? 8192),
    ...(tools.length && !summary ? { tools } : {}),
    reasoning: { ...(effort ? { effort: effort === "max" ? "xhigh" : effort } : {}), ...(p.thinking?.display !== "omitted" ? { summary: "auto" } : {}) },
    include: ["reasoning.encrypted_content"],
  };
}

function usage(r: Wire): Wire {
  const u = r.usage ?? {};
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  return { input_tokens: Math.max(0, (u.input_tokens ?? 0) - cached), output_tokens: u.output_tokens ?? 0, cache_read_input_tokens: cached, cache_creation_input_tokens: 0,
    server_tool_use: { web_search_requests: (r.output ?? []).filter((i: Wire) => i.type === "web_search_call").length } };
}
function citation(a: Wire): Wire[] {
  return a.type === "url_citation" ? [{ type: "web_search_result_location", url: a.url, title: a.title || a.url, encrypted_index: "", cited_text: "" }] : [];
}
function finalBlocks(r: Wire, summary: boolean): Wire[] {
  if (summary) return [{ type: "compaction", content: (r.output ?? []).flatMap((i: Wire) => (i.content ?? []).map((b: Wire) => b.text ?? "")).join("\n") }];
  return (r.output ?? []).flatMap((i: Wire): Wire[] => {
    if (i.type === "reasoning" && i.encrypted_content) return [{ type: "redacted_thinking", data: REASONING + JSON.stringify(i) }];
    if (i.type === "function_call") return [{ type: "tool_use", id: i.call_id, name: i.name, input: JSON.parse(i.arguments || "{}") }];
    if (i.type === "message") return (i.content ?? []).map((b: Wire) => ({ type: "text", text: b.text ?? b.refusal ?? "", citations: (b.annotations ?? []).flatMap(citation), ...(i.phase ? { openai_phase: i.phase } : {}) }));
    return [];
  });
}
function stopReason(r: Wire, summary: boolean) {
  if (r.status === "incomplete") return "max_tokens";
  return summary ? "compaction" : (r.output ?? []).some((i: Wire) => i.type === "function_call") ? "tool_use" : "end_turn";
}
function message(r: Wire, summary: boolean): Wire {
  return { id: r.id, type: "message", role: "assistant", model: r.model, content: finalBlocks(r, summary), stop_reason: stopReason(r, summary), stop_sequence: null, usage: usage(r) };
}

/** Parse SSE across arbitrary network chunk boundaries; reject truncated streams. */
async function* events(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, "\n");
      let at: number;
      while ((at = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, at); buffer = buffer.slice(at + 2);
        const data = frame.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
        if (data && data !== "[DONE]") yield JSON.parse(data) as Wire;
      }
      if (done) break;
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** A real Responses API stream, emitted in the shared SDK's event format. */
function streamResponse(upstream: Response, summary: boolean, model: string, abort: () => void): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (type: string, data: Wire) => controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`));
      const blocks = new Map<string, { index: number; closed: boolean; args: boolean }>(); let index = 0; let completed = false;
      const items = new Map<string, Wire>();
      const open = (key: string, block: Wire) => {
        let b = blocks.get(key);
        if (!b) { b = { index: index++, closed: false, args: false }; blocks.set(key, b); emit("content_block_start", { index: b.index, content_block: block }); }
        return b;
      };
      const close = (b: { index: number; closed: boolean }) => { if (!b.closed) { emit("content_block_stop", { index: b.index }); b.closed = true; } };
      try {
        emit("message_start", { message: { id: "openai-stream", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
        if (!upstream.body) throw Error("OpenAI returned an empty stream.");
        for await (const e of events(upstream.body)) {
          if (e.type === "response.output_item.added") items.set(e.item.id, e.item);
          if (e.type === "response.output_text.delta" && !summary) {
            const item = items.get(e.item_id); const b = open(e.item_id + ":" + e.content_index, { type: "text", text: "", citations: [], ...(item?.phase ? { openai_phase: item.phase } : {}) });
            emit("content_block_delta", { index: b.index, delta: { type: "text_delta", text: e.delta } });
          } else if (e.type === "response.reasoning_summary_text.delta" && !summary) {
            const b = open(e.item_id + ":summary", { type: "thinking", thinking: "", signature: "" });
            emit("content_block_delta", { index: b.index, delta: { type: "thinking_delta", thinking: e.delta } });
          } else if (e.type === "response.function_call_arguments.delta" && !summary) {
            const item = items.get(e.item_id);
            if (!item) throw Error("OpenAI sent arguments before the function call.");
            const b = open(e.item_id, { type: "tool_use", id: item.call_id, name: item.name, input: {} }); b.args = true;
            emit("content_block_delta", { index: b.index, delta: { type: "input_json_delta", partial_json: e.delta } });
          } else if (e.type === "response.output_item.done" && !summary) {
            const item = e.item;
            if (item.type === "function_call") {
              const b = open(item.id, { type: "tool_use", id: item.call_id, name: item.name, input: {} });
              if (!b.args) emit("content_block_delta", { index: b.index, delta: { type: "input_json_delta", partial_json: item.arguments || "{}" } }); close(b);
            } else if (item.type === "reasoning" && item.encrypted_content) {
              const shown = blocks.get(item.id + ":summary"); if (shown) close(shown);
              const b = open(item.id, { type: "redacted_thinking", data: REASONING + JSON.stringify(item) }); close(b);
            } else if (item.type === "message") {
              (item.content ?? []).forEach((part: Wire, n: number) => {
                const key = item.id + ":" + n; const had = blocks.has(key);
                const b = open(key, { type: "text", text: "", citations: [], ...(item.phase ? { openai_phase: item.phase } : {}) });
                if (!had) emit("content_block_delta", { index: b.index, delta: { type: "text_delta", text: part.text ?? part.refusal ?? "" } });
                for (const c of (part.annotations ?? []).flatMap(citation)) emit("content_block_delta", { index: b.index, delta: { type: "citations_delta", citation: c } }); close(b);
              });
            }
          } else if (e.type === "response.completed" || e.type === "response.incomplete") {
            completed = true;
            if (summary) { const b = open("summary", finalBlocks(e.response, true)[0]); close(b); }
            for (const b of blocks.values()) close(b);
            emit("message_delta", { delta: { stop_reason: stopReason(e.response, summary), stop_sequence: null }, usage: usage(e.response) });
            emit("message_stop", {}); break;
          } else if (e.type === "error" || e.type === "response.failed") throw Error(e.error?.message ?? e.response?.error?.message ?? e.message ?? "OpenAI request failed.");
        }
        if (!completed) throw Error("OpenAI's response ended before it completed. Try again.");
        controller.close();
      } catch (e) { controller.error(e); } finally { abort(); }
    },
    cancel() { abort(); },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

export function openAIFetch(key: string, fetcher: typeof fetch = fetch): typeof fetch {
  return async (_url, init) => {
    const p = JSON.parse(String(init?.body ?? "{}"));
    const ac = new AbortController(); const outer = init?.signal;
    const stop = () => ac.abort(outer?.reason);
    if (outer?.aborted) stop(); else outer?.addEventListener("abort", stop, { once: true });
    const cleanup = () => { outer?.removeEventListener("abort", stop); ac.abort(); };
    try {
      const upstream = await fetcher("https://api.openai.com/v1/responses", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(responseRequest(p)), signal: ac.signal });
      if (!upstream.ok) {
        const error = await upstream.json().catch(() => ({})) as Wire;
        cleanup();
        return Response.json({ type: "error", error: { type: upstream.status === 401 ? "authentication_error" : "api_error", message: String(error.error?.message ?? `OpenAI request failed (${upstream.status}).`).replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]") } }, { status: upstream.status, headers: { ...(upstream.headers.has("retry-after") ? { "retry-after": upstream.headers.get("retry-after")! } : {}) } });
      }
      if (p.stream) return streamResponse(upstream, !!p.compaction, p.model, cleanup);
      const r = await upstream.json() as Wire; cleanup(); return Response.json(message(r, !!p.compaction));
    } catch (e) { cleanup(); throw e; }
  };
}
