// A stand-in for the Claude Messages API that checks replayed thinking blocks
// the way the real API does: each block it hands out is bound to the system
// prompt, the tools and every message before it, and sending it back after any
// of those changed is a 400 (or, with drop_block, a reported drop).

export type Turn =
  | { tool: string; input?: Record<string, unknown> }
  | { text: string }
  /** content blocks as given (web searches and their results, text, tool calls), with the stop reason and the searches billed */
  | { raw: { type: string; [k: string]: unknown }[]; stop: string; searches?: number };

interface Options {
  /** answer like a model that rejects thinking.block_binding */
  rejectBinding?: boolean;
  /** how the model router answers (a request for JSON output): "design" unless set; "broken" fails it */
  route?: "quick" | "design" | "broken";
  /** the usage reported for each streamed response */
  usage?: (body: Body) => Record<string, number>;
}

const BINDING_BETA = "thinking-binding-controls-2026-08-01";
const noCache = (k: string, v: unknown) => (k === "cache_control" ? undefined : v);

type Body = { model?: string; stream?: boolean; max_tokens?: number; output_config?: { effort?: string; format?: unknown }; fallbacks?: unknown; system?: unknown; tools?: unknown; messages: { role: string; content: string | { type: string; signature?: string }[] }[]; thinking?: { block_binding?: { prefix_mismatch_behavior?: string } } };

function prefix(body: Body, upTo: number) {
  return JSON.stringify([body.system, body.tools, body.messages.slice(0, upTo)], noCache);
}

function json(o: object, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "request-id": "req_json" } });
}

function error(message: string) {
  return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), { status: 400, headers: { "content-type": "application/json", "request-id": "req_fake" } });
}

export function fakeClaude(script: Turn[], opts: Options = {}) {
  const issued = new Map<string, string>();
  const requests: Body[] = [];
  const dropped: string[] = [];
  /** requests asking which model a turn needs */
  const routerRequests: Body[] = [];
  /** max_tokens: 0 requests that keep the cache warm */
  const warmRequests: Body[] = [];
  let n = 0;

  // the router and keep-warm ask without streaming; neither uses the script
  function answer(body: Body): Response {
    if (body.output_config?.format) {
      routerRequests.push(structuredClone(body));
      if (opts.route === "broken") return json({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, 529);
      const route = opts.route ?? "design";
      const reason = route === "quick" ? "Reads a dimension from the design." : "Needs engineering judgment.";
      return json({ id: "msg_route", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: JSON.stringify({ route, reason }) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 400, output_tokens: 15 } });
    }
    warmRequests.push(structuredClone(body));
    return json({ id: "msg_warm", type: "message", role: "assistant", model: body.model, content: [], stop_reason: "max_tokens", stop_sequence: null, usage: { input_tokens: 10, cache_read_input_tokens: 20000, output_tokens: 0 } });
  }

  async function fetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (!String(url).includes("/v1/messages")) return new Response("not found", { status: 404 });
    const body = JSON.parse(String(init?.body)) as Body;
    if (!body.stream) return answer(body);
    const betas = (new Headers(init?.headers).get("anthropic-beta") ?? "").split(",").map((s) => s.trim());
    const behavior = body.thinking?.block_binding?.prefix_mismatch_behavior;
    if (body.thinking?.block_binding && (opts.rejectBinding || !betas.includes(BINDING_BETA))) return error("thinking.block_binding: Extra inputs are not permitted");
    requests.push(structuredClone(body));

    const transformations: { type: string; path: string; reason: string }[] = [];
    let dropping = false;
    for (let i = 0; i < body.messages.length; i++) {
      const m = body.messages[i];
      if (m.role !== "assistant" || typeof m.content === "string") continue;
      for (let j = 0; j < m.content.length; j++) {
        const b = m.content[j];
        if (b.type !== "thinking") continue;
        const bound = issued.get(b.signature ?? "");
        const path = `messages.${i}.content.${j}`;
        if (bound === undefined) return error(`${path}: Invalid \`signature\` in \`thinking\` block.`);
        if (dropping || bound !== prefix(body, i)) {
          if (behavior === "drop_block") {
            dropping = true;
            dropped.push(path);
            transformations.push({ type: "thinking_dropped", path, reason: "prefix_binding_mismatch" });
            continue;
          }
          return error(
            `${path}: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation. Remove the block, or set \`thinking.block_binding.prefix_mismatch_behavior\` to "drop_block".${betas.includes(BINDING_BETA) ? "" : " That setting requires the `thinking-binding-controls-2026-08-01` value in the `anthropic-beta` header."}`,
          );
        }
      }
    }

    const turn = script.shift() ?? { text: "Done." };
    const id = ++n;
    const signature = `sig${id}`;
    issued.set(signature, prefix(body, body.messages.length));

    const events: object[] = [
      { type: "message_start", message: { id: `msg_${id}`, type: "message", role: "assistant", model: body.model ?? "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: opts.usage?.(body) ?? { input_tokens: 10, output_tokens: 1 }, ...(betas.includes(BINDING_BETA) ? { input_transformations: transformations } : {}) } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: `thought ${id}` } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature } },
      { type: "content_block_stop", index: 0 },
    ];
    if ("raw" in turn) {
      turn.raw.forEach((b, j) => {
        const index = j + 1;
        if (b.type === "text") events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
        else if (b.type === "tool_use") events.push({ type: "content_block_start", index, content_block: { ...b, input: {} } }, { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input ?? {}) } });
        else events.push({ type: "content_block_start", index, content_block: b });
        events.push({ type: "content_block_stop", index });
      });
    } else if ("tool" in turn) {
      events.push(
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: `toolu_${id}`, name: turn.tool, input: {} } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(turn.input ?? {}) } },
        { type: "content_block_stop", index: 1 },
      );
    } else {
      events.push(
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: turn.text } },
        { type: "content_block_stop", index: 1 },
      );
    }
    const stop = "raw" in turn ? turn.stop : "tool" in turn ? "tool_use" : "end_turn";
    const searches = "raw" in turn && turn.searches ? { server_tool_use: { web_search_requests: turn.searches } } : {};
    events.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20, ...searches } }, { type: "message_stop" });
    const sse = events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream", "request-id": `req_${id}` } });
  }

  return { fetch, requests, dropped, script, routerRequests, warmRequests };
}

/** The messages of a request as the API compares them. */
export const normalized = (b: { system?: unknown; tools?: unknown; messages: unknown[] }, upTo = b.messages.length) => JSON.stringify([b.system, b.tools, b.messages.slice(0, upTo)], noCache);
