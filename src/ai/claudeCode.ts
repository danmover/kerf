// Kerf's design tools for the person's own Claude Code. The desktop app serves
// them as a local MCP server (desktop/mcp.ts) and passes each call here, where
// they run exactly as they do for Kerf's chat. Claude Code runs the
// conversation on the person's Claude plan, signed in through its own login;
// Kerf never sees those credentials.

import { TOOL_DEFS, runTool, type ToolResultContent } from "./tools";
import { systemPrompt } from "./prompt";
import { useChat } from "./chat";
import { useProject } from "../app/project";
import { desktop } from "../app/desktop";
import { toast } from "../app/ui";

/** Tools that need Kerf's own chat: questions and follow-up chips show there, and the reviewer and parallel agents call the API with Kerf's key. */
const CHAT_ONLY = new Set(["ask_user", "suggest_next_steps", "review_design", "build_subassemblies"]);

const GUIDE_TOOL = "kerf_instructions";

const PREAMBLE = `You are working in Kerf through Claude Code: Claude Code calls Kerf's tools, and the person watches the design change in Kerf's window. The guide below is written for Kerf's own chat, so read it with these differences:
- There is no context note. Call get_design at the start of each task, and again whenever the person may have changed the design in Kerf.
- ask_user, suggest_next_steps, review_design and build_subassemblies are not available here. Ask questions in your reply, offer follow-ups in your reply, review your own work before you report (capture_view from every side, inspect_part on the details), and build subassemblies one after another yourself.
- update_plan shows your plan in Kerf's plan panel beside the design.`;

type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };

export function mcpTools() {
  const tools = TOOL_DEFS.filter((t) => "input_schema" in t && !CHAT_ONLY.has(t.name)).map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));
  return [
    {
      name: GUIDE_TOOL,
      description: "Kerf's design guide and the reference for its design language. Call once before working on a design, and follow it.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    ...tools,
  ];
}

export function toMcp(c: ToolResultContent): McpContent[] {
  if (typeof c === "string") return [{ type: "text", text: c || "Done." }];
  return c.map((b, i): McpContent => {
    if (b.type === "text") return { type: "text", text: b.text };
    if (b.type === "image") return { type: "image", data: b.source.data, mimeType: b.source.media_type };
    return { type: "resource", resource: { uri: `kerf://document/${i + 1}.pdf`, mimeType: b.source.media_type, blob: b.source.data } };
  });
}

const refuse = (text: string) => ({ isError: true, content: [{ type: "text", text }] });

// one call at a time, as in Kerf's chat: each edit starts from the last one's result
let queue: Promise<unknown> = Promise.resolve();

export async function callTool(params: { name?: unknown; arguments?: unknown }, signal: AbortSignal) {
  const name = String(params.name ?? "");
  if (name === GUIDE_TOOL) return { content: [{ type: "text", text: `${PREAMBLE}\n\n${systemPrompt()}` }] };
  if (!mcpTools().some((t) => t.name === name)) return refuse(`Kerf has no tool called ${name}.`);
  const run = async () => {
    if (signal.aborted) return refuse("Cancelled.");
    if (!useProject.getState().current) return refuse("No project is open in Kerf. Ask the person to open or create one in Kerf's window, then call get_design.");
    if (useChat.getState().busy) return refuse("Kerf's own chat is working on this design right now. Ask the person to wait for it or stop it, so the two don't edit at once.");
    const out = await runTool(name, params.arguments ?? {}, { signal, check: true });
    if (!out.isError && (name === "edit_design" || name === "write_design")) toast({ kind: "info", title: "Claude Code changed the design", detail: out.card.title });
    return { content: toMcp(out.content), ...(out.isError ? { isError: true } : {}) };
  };
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}

let serving = false;

/** In the desktop app, answer Claude Code's calls whenever Settings → Claude has them switched on. */
export function serveClaudeCode() {
  const cc = desktop()?.claudeCode;
  if (!cc || serving) return;
  serving = true;
  const running = new Map<number, AbortController>();
  void cc.serve({
    run: async (id, method, params) => {
      const ac = new AbortController();
      running.set(id, ac);
      try {
        return method === "tools/list" ? { tools: mcpTools() } : await callTool((params ?? {}) as { name?: unknown; arguments?: unknown }, ac.signal);
      } finally {
        running.delete(id);
      }
    },
    cancel: (id) => running.get(id)?.abort(),
  });
}
