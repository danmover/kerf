// Live part search: Anthropic's server-side web search and web fetch tools.
// They run on Anthropic's side (the page itself can only reach
// api.anthropic.com), so all the browser does is declare them, show what
// Claude searched and read, and keep their blocks in the history unchanged.

import type { BetaContentBlock, BetaMessageParam, BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";

/** Searches and page reads Claude may make per request. */
export const WEB_MAX_USES = 8;
/** Keeps one fetched page from flooding the context (does not apply to PDFs). */
export const WEB_FETCH_MAX_TOKENS = 20000;

/**
 * Current Opus and Sonnet models take the _20260209 versions (dynamic
 * filtering: Claude filters results with code before they reach its context).
 * Haiku and older models take the basic versions.
 */
export function supportsDynamicFiltering(model: string): boolean {
  return /^claude-(opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|fable-5|mythos-5)/.test(model);
}

export function webTools(model: string): BetaToolUnion[] {
  if (supportsDynamicFiltering(model)) {
    return [
      { type: "web_search_20260209", name: "web_search", max_uses: WEB_MAX_USES },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: WEB_MAX_USES, max_content_tokens: WEB_FETCH_MAX_TOKENS },
    ];
  }
  return [
    { type: "web_search_20250305", name: "web_search", max_uses: WEB_MAX_USES },
    { type: "web_fetch_20250910", name: "web_fetch", max_uses: WEB_MAX_USES, max_content_tokens: WEB_FETCH_MAX_TOKENS },
  ];
}

export const WEB_TOOL_NAMES = ["web_search", "web_fetch"] as const;
export type WebToolName = (typeof WEB_TOOL_NAMES)[number];
export const isWebTool = (name: string): name is WebToolName => (WEB_TOOL_NAMES as readonly string[]).includes(name);

/** Only http(s) links are ever shown as links. */
export function safeUrl(u: unknown): string | null {
  if (typeof u !== "string" || u.length > 2000) return null;
  try {
    const url = new URL(u);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function domainOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u.slice(0, 60);
  }
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Plain-English reasons for the error codes web search and web fetch return inside a 200 response. */
export function webErrorText(tool: WebToolName, code: string): string {
  switch (code) {
    case "max_uses_exceeded":
      return tool === "web_search" ? `Claude used all ${WEB_MAX_USES} web searches allowed for one step.` : `Claude read the ${WEB_MAX_USES} pages allowed for one step.`;
    case "too_many_requests":
      return "The search service is busy right now (rate limited).";
    case "unavailable":
      return "The web search service is unavailable right now.";
    case "query_too_long":
      return "The search was too long.";
    case "invalid_tool_input":
      return tool === "web_search" ? "The search was not valid." : "The web address was not valid.";
    case "request_too_large":
      return "The request was too large.";
    case "url_too_long":
      return "The web address was too long.";
    case "url_not_allowed":
      return "That site is not allowed.";
    case "url_not_in_prior_context":
      return "Claude can only open addresses that came up in the conversation or in search results.";
    case "url_not_accessible":
      return "The page could not be opened (it may need a login or block automated readers).";
    case "unsupported_content_type":
      return "The page is in a format that cannot be read.";
    case "content_too_large":
      return "The page is too large to read.";
    default:
      return `The web tool reported "${code}".`;
  }
}

export interface WebActivity {
  toolUseId: string;
  name: WebToolName;
  status: "running" | "done" | "error";
  title: string;
  detail?: string;
  link?: { url: string; label: string };
  error?: { code: string; text: string };
}

type Block = BetaContentBlock | { type: string; [k: string]: unknown };

function errorCode(content: unknown): string | null {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const c = content as { type?: string; error_code?: string };
    if (typeof c.type === "string" && c.type.endsWith("_error")) return String(c.error_code ?? "unknown");
  }
  return null;
}

/**
 * What one server tool call looked like: the query or address, and its result
 * if it has one yet. A call that finished without a result block in the
 * response (dynamic filtering can read results in code) counts as done.
 */
export function describeWebCall(name: WebToolName, id: string, input: unknown, result?: Block, finished = false): WebActivity {
  const inp = (input && typeof input === "object" ? input : {}) as { query?: unknown; url?: unknown };
  if (name === "web_search") {
    const q = typeof inp.query === "string" ? clip(inp.query.trim(), 120) : "";
    if (!result && finished) return { toolUseId: id, name, status: "done", title: q ? `Searched the web: ${q}` : "Searched the web" };
    if (!result) return { toolUseId: id, name, status: "running", title: q ? `Searching the web: ${q}` : "Searching the web" };
    const content = (result as { content?: unknown }).content;
    const code = errorCode(content);
    if (code) {
      const text = webErrorText(name, code);
      return { toolUseId: id, name, status: "error", title: q ? `Web search did not work: ${q}` : "Web search did not work", detail: text, error: { code, text } };
    }
    const hits = Array.isArray(content) ? (content as { url?: string }[]) : [];
    const domains = [...new Set(hits.map((h) => (typeof h.url === "string" ? domainOf(h.url) : "")).filter(Boolean))];
    return {
      toolUseId: id,
      name,
      status: "done",
      title: q ? `Searched the web: ${q}` : "Searched the web",
      detail: hits.length ? `${hits.length} result${hits.length === 1 ? "" : "s"}: ${domains.slice(0, 4).join(", ")}${domains.length > 4 ? ", …" : ""}` : "No results",
    };
  }
  const url = safeUrl(inp.url);
  const domain = url ? domainOf(url) : typeof inp.url === "string" ? clip(inp.url, 60) : "a web page";
  if (!result && finished) return { toolUseId: id, name, status: "done", title: `Read: ${domain}`, link: url ? { url, label: clip(url, 90) } : undefined };
  if (!result) return { toolUseId: id, name, status: "running", title: `Reading: ${domain}` };
  const content = (result as { content?: unknown }).content;
  const code = errorCode(content);
  if (code) {
    const text = webErrorText(name, code);
    return { toolUseId: id, name, status: "error", title: `Could not read: ${domain}`, detail: text, link: url ? { url, label: clip(url, 90) } : undefined, error: { code, text } };
  }
  const page = content as { url?: unknown; content?: { title?: unknown } } | undefined;
  const finalUrl = safeUrl(page?.url) ?? url;
  const title = typeof page?.content?.title === "string" && page.content.title.trim() ? clip(page.content.title.trim(), 90) : finalUrl ? clip(finalUrl, 90) : "";
  return { toolUseId: id, name, status: "done", title: `Read: ${finalUrl ? domainOf(finalUrl) : domain}`, link: finalUrl ? { url: finalUrl, label: title } : undefined };
}

/**
 * Every web search and page read in one response, matched with its result
 * block. finished: the response is complete, so calls without a result have
 * run; "paused" leaves the trailing call of a paused turn running.
 */
export function webActivity(content: readonly Block[], finished: false | true | "paused" = false): WebActivity[] {
  const results = new Map<string, Block>();
  for (const b of content) {
    if ((b.type === "web_search_tool_result" || b.type === "web_fetch_tool_result") && typeof (b as { tool_use_id?: unknown }).tool_use_id === "string") results.set((b as { tool_use_id: string }).tool_use_id, b);
  }
  const out: WebActivity[] = [];
  content.forEach((b, i) => {
    if (b.type !== "server_tool_use") return;
    const u = b as { id: string; name: string; input: unknown };
    if (!isWebTool(u.name)) return;
    const done = finished === true || (finished === "paused" && i < content.length - 1);
    out.push(describeWebCall(u.name, u.id, u.input, results.get(u.id), done));
  });
  return out;
}

export interface Source {
  url: string;
  title: string;
}

/** Pages Claude cited in its text (web search citations), in order, without repeats. */
export function citedSources(content: readonly Block[]): Source[] {
  const seen = new Map<string, Source>();
  for (const b of content) {
    if (b.type !== "text") continue;
    const cites = (b as { citations?: unknown }).citations;
    if (!Array.isArray(cites)) continue;
    for (const c of cites as { type?: string; url?: unknown; title?: unknown }[]) {
      if (c.type !== "web_search_result_location") continue;
      const url = safeUrl(c.url);
      if (!url || seen.has(url)) continue;
      seen.set(url, { url, title: typeof c.title === "string" && c.title.trim() ? clip(c.title.trim(), 120) : domainOf(url) });
    }
  }
  return [...seen.values()];
}

/**
 * A turn the server paused (stop_reason "pause_turn") ends with a server tool
 * call that has no result yet. Sending the history back as it is resumes it.
 */
export function isPausedTurn(m: BetaMessageParam | undefined): boolean {
  if (!m || m.role !== "assistant" || typeof m.content === "string" || !m.content.length) return false;
  return m.content[m.content.length - 1].type === "server_tool_use";
}

/**
 * Thinking blocks are bound to the exact conversation that produced them. When
 * the history had to change (a trimmed image, web search switched on or off),
 * the API rejects them; dropping every thinking block is the documented recovery.
 */
export function stripThinking(history: BetaMessageParam[]): { history: BetaMessageParam[]; removed: number } {
  let removed = 0;
  const out = history.map((m) => {
    if (m.role !== "assistant" || typeof m.content === "string") return m;
    const kept = m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
    removed += m.content.length - kept.length;
    if (kept.length === m.content.length) return m;
    return { ...m, content: kept.length ? kept : [{ type: "text" as const, text: "(no text)" }] };
  });
  return { history: out, removed };
}

/** The API's message when replayed thinking blocks no longer match the conversation. */
export function isThinkingBindingError(message: string): boolean {
  return /bound to a different conversation|invalid `?signature`? in `?thinking`? block/i.test(message);
}

/** The API's message when this organisation or model cannot use the web tools declared in the request. */
export function isWebToolError(message: string): boolean {
  return /web_search|web_fetch|web search|web fetch/i.test(message) && /not (enabled|available|supported|allowed|permitted)|disabled|does not match|unknown|unrecognized|unsupported|invalid|tools\.\d+|organi[sz]ation|permission/i.test(message);
}

/** The API's message when the history holds server tool blocks it will not take (for example after web search was switched off). */
export function isServerBlockError(message: string): boolean {
  return /web_search|web_fetch|server_tool_use|code_execution/i.test(message);
}

const isServerResult = (b: { type: string }) => b.type.endsWith("_tool_result") && b.type !== "mcp_tool_result" && typeof (b as { tool_use_id?: unknown }).tool_use_id === "string";

/**
 * The blocks of one response to send back in later requests. After a
 * server-side fallback switched models partway through, everything before the
 * last fallback block except text and completed server tool calls is left out,
 * as the API requires; without a fallback the response goes back unchanged.
 */
export function echoContent<T extends { type: string }>(content: readonly T[]): T[] {
  let cut = -1;
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i].type === "fallback") {
      cut = i;
      break;
    }
  }
  if (cut < 0) return content.slice();
  const before = content.slice(0, cut);
  const answered = new Set(before.filter(isServerResult).map((b) => (b as unknown as { tool_use_id: string }).tool_use_id));
  const paired = new Set(before.filter((b) => b.type === "server_tool_use" && answered.has((b as unknown as { id: string }).id)).map((b) => (b as unknown as { id: string }).id));
  return content.filter((b, i) => {
    if (i >= cut || b.type === "text") return true;
    if (b.type === "server_tool_use") return paired.has((b as unknown as { id: string }).id);
    if (isServerResult(b)) return paired.has((b as unknown as { tool_use_id: string }).tool_use_id);
    return false;
  });
}

/**
 * Turns every server tool call in the history into a short text note and drops
 * web citations, for a request that cannot carry those blocks (web search was
 * switched off or is not available). What Claude found stays readable.
 */
export function flattenServerTools(history: BetaMessageParam[]): { history: BetaMessageParam[]; changed: number } {
  let changed = 0;
  const out = history.map((m) => {
    if (m.role !== "assistant" || typeof m.content === "string") return m;
    const blocks = m.content as unknown as Block[];
    if (!blocks.some((b) => b.type === "server_tool_use" || isServerResult(b) || (b.type === "text" && Array.isArray((b as { citations?: unknown }).citations)))) return m;
    const calls = new Map<string, { name: string; input: unknown }>();
    const kept: Block[] = [];
    for (const b of blocks) {
      if (b.type === "server_tool_use") {
        const u = b as { id: string; name: string; input: unknown };
        calls.set(u.id, { name: u.name, input: u.input });
        changed++;
        continue;
      }
      if (isServerResult(b)) {
        const call = calls.get((b as { tool_use_id: string }).tool_use_id);
        changed++;
        if (call && isWebTool(call.name)) {
          const a = describeWebCall(call.name, (b as { tool_use_id: string }).tool_use_id, call.input, b);
          const hits = call.name === "web_search" && Array.isArray((b as { content?: unknown }).content) ? ((b as { content: { url?: unknown; title?: unknown }[] }).content.map((h) => (typeof h.url === "string" ? `${typeof h.title === "string" ? h.title : ""} <${h.url}>`.trim() : "")).filter(Boolean).slice(0, 8)) : [];
          kept.push({ type: "text", text: `[${a.title}${a.link ? ` <${a.link.url}>` : ""}${a.error ? ` (${a.error.text})` : ""}${hits.length ? `\n${hits.join("\n")}` : ""}]` });
        }
        continue;
      }
      if (b.type === "text" && Array.isArray((b as { citations?: unknown }).citations)) {
        const { citations: _c, ...rest } = b as { citations?: unknown; type: string };
        void _c;
        kept.push(rest as Block);
        changed++;
        continue;
      }
      kept.push(b);
    }
    return { ...m, content: (kept.length ? kept : [{ type: "text", text: "(no text)" }]) as unknown as typeof m.content };
  });
  return { history: out, changed };
}
