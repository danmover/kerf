// One subassembly agent: a Claude tool loop that writes and checks a single
// section of the design. The orchestrator gives it a workspace; the agent
// never touches the rest of the file.

import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlock, BetaContentBlockParam, BetaMessageParam, BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { evaluate } from "../lang/evaluator";
import { lineCol } from "../lang/lexer";
import { applyTextEdits, diffStats } from "../core/sourceEdit";
import type { CheckItem } from "../core/checks";
import type { Model } from "../core/model";
import { MAX_SOURCE_CHARS } from "../persist/files";
import { checkIsolated } from "./isolated";
import type { Usage } from "./pricing";
import type { AgentStep } from "./progress";
import { STEP_STATUSES, type StepInput } from "../ai/plan";
import { BINDING_BETA, hasThinking, isThinkingSignatureError, stripThinking } from "../ai/history";

z.config({ jitless: true });

export const VIEWS = ["iso", "front", "back", "top", "bottom", "left", "right"] as const;

export const SUBAGENT_TOOLS = [
  {
    name: "write_section",
    description: "Replace your whole section with new Kerf source (statements only, no section markers). The section is evaluated at once with the layout and your dependencies, and the result is returned. Use for the first draft or a rewrite.",
    eager_input_streaming: true,
    input_schema: {
      type: "object" as const,
      properties: {
        summary: { type: "string", description: "One short line describing the change, in the user's terms." },
        source: { type: "string", description: "The complete section source." },
      },
      required: ["summary", "source"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_section",
    description: "Apply exact text replacements inside your section, in order. Each old_text must appear exactly once in your section. Returns the evaluation result.",
    eager_input_streaming: true,
    input_schema: {
      type: "object" as const,
      properties: {
        summary: { type: "string", description: "One short line describing the change." },
        edits: {
          type: "array",
          minItems: 1,
          maxItems: 40,
          items: {
            type: "object",
            properties: { old_text: { type: "string" }, new_text: { type: "string" } },
            required: ["old_text", "new_text"],
            additionalProperties: false,
          },
        },
      },
      required: ["summary", "edits"],
      additionalProperties: false,
    },
  },
  {
    name: "check_section",
    description: "Build your section with the layout and your dependencies in a separate geometry worker and run every check: build errors, requirements, solid interference, tool access, gear meshing and motion. Returns the results that involve your parts.",
    input_schema: { type: "object" as const, properties: {}, additionalProperties: false },
  },
  {
    name: "look",
    description: "Render the assembled model as it stands, with your parts highlighted, and return the image.",
    input_schema: {
      type: "object" as const,
      properties: {
        view: { type: "string", enum: [...VIEWS] },
        section: { type: "string", enum: ["x", "y", "z"], description: "Cut the model in half across this axis." },
      },
      required: ["view"],
      additionalProperties: false,
    },
  },
  {
    name: "read_subassembly",
    description: "Read another subassembly's current section (it may still be in progress).",
    input_schema: { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "request_change",
    description: "Ask the lead engineer to change the layout or another subassembly because yours cannot work well otherwise. Be specific: what to change, to what, and why. Then continue with the best design you can make within the current contracts.",
    input_schema: {
      type: "object" as const,
      properties: {
        target: { type: "string", description: '"layout", "integration", or a subassembly id.' },
        change: { type: "string", description: "The specific change, e.g. 'interface motor_mount: hole spacing 31 mm → 31.5 mm'." },
        reason: { type: "string" },
      },
      required: ["target", "change", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "update_plan",
    description:
      "Show the user your subassembly's to-do list as a branch of Kerf's live plan tree, and keep it current. Call it at the start with every step (the parts and features you will build, then checking), in the same response as your first write_section, then again as steps start and finish, in the same response as your next action so it costs no extra turn. Send the whole list each time, keep one step doing, and name the parts each step works on. The user can rename, annotate, skip and add steps while you work; their changes reach you as a <plan-changes> note and come before your brief.",
    input_schema: {
      type: "object" as const,
      properties: {
        steps: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Short stable id, e.g. s1. Keep ids across updates, including steps the user added." },
              title: { type: "string", description: "What the step does, a few words in the user's terms." },
              status: { type: "string", enum: [...STEP_STATUSES] },
              detail: { type: "string", description: "Optional one line: what you found or decided." },
              parts: { type: "array", items: { type: "string" }, maxItems: 20, description: "Part names this step works on." },
              parent: { type: "string", description: "Optional id of an earlier step this is a sub-step of." },
            },
            required: ["id", "title", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["steps"],
      additionalProperties: false,
    },
  },
];

const WriteIn = z.object({ summary: z.string().min(1).max(300), source: z.string().max(MAX_SOURCE_CHARS) });
const EditIn = z.object({ summary: z.string().min(1).max(300), edits: z.array(z.object({ old_text: z.string().max(MAX_SOURCE_CHARS), new_text: z.string().max(MAX_SOURCE_CHARS) })).min(1).max(40) });
const LookIn = z.object({ view: z.enum(VIEWS), section: z.enum(["x", "y", "z"]).optional() });
const ReadIn = z.object({ id: z.string().max(60) });
const ReqIn = z.object({ target: z.string().min(1).max(60), change: z.string().min(1).max(1000), reason: z.string().max(1000) });
const PlanIn = z.object({
  steps: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        title: z.string().min(1).max(300),
        status: z.enum(STEP_STATUSES),
        detail: z.string().max(1000).optional(),
        parts: z.array(z.string().max(80)).max(20).optional(),
        parent: z.string().max(40).optional(),
      }),
    )
    .max(20),
});

type ResultContent = BetaToolResultBlockParam["content"];

/** What the orchestrator gives an agent to work with. */
export interface Workspace {
  id: string;
  name: string;
  body(): string;
  setBody(body: string, summary: string): void;
  /** the layout, the agent's dependencies and the given body, with the body's offsets */
  isolated(body: string): { src: string; start: number; end: number };
  /** names defined anywhere else in the design right now, with their owner */
  otherNames(): Map<string, string>;
  readOther(id: string): string | null;
  requestChange(target: string, change: string, reason: string): string;
  look(view: (typeof VIEWS)[number], section?: "x" | "y" | "z"): Promise<{ image?: string; text: string }>;
  onChecks(c: { pass: number; fail: number; warn: number }): void;
}

export interface AgentHooks {
  activity(text: string | undefined): void;
  step(s: Omit<AgentStep, "id" | "ts">): string;
  updateStep(id: string, patch: Partial<AgentStep>): void;
  usage(model: string, u: Usage): void;
  /** false once the run's spending cap is reached */
  budgetOk(): boolean;
  /** the user's changes to this agent's branch of the plan since the last call, ready to send; null if none */
  takeSteering(): string | null;
  /** show the agent's own steps in the plan; returns a problem with them, or null */
  setSteps(steps: StepInput[]): string | null;
  /** resolved once the shared prompt is in the cache, so later agents read it instead of writing it again */
  firstEvent(): void;
}

export interface AgentConfig {
  anthropic: Anthropic;
  model: string;
  effort: string;
  system: string;
  kickoff: string;
  maxSteps: number;
  signal: AbortSignal;
}

export type AgentEnd =
  | { status: "done"; summary: string }
  | { status: "failed"; summary: string; fatal?: boolean }
  | { status: "stopped"; summary: string };

const unsupported = new Set<"effort" | "thinking" | "binding" | "fallbacks">();
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export async function runAgent(cfg: AgentConfig, ws: Workspace, hooks: AgentHooks): Promise<AgentEnd> {
  const history: BetaMessageParam[] = [{ role: "user", content: [{ type: "text", text: cfg.kickoff }] }];
  const system = [{ type: "text" as const, text: cfg.system, cache_control: { type: "ephemeral" as const } }];
  let lastText = "";
  let signalled = false;

  for (let step = 0; step < cfg.maxSteps; step++) {
    if (cfg.signal.aborted) return { status: "stopped", summary: lastText || "Stopped before finishing." };
    if (!hooks.budgetOk()) return { status: "stopped", summary: lastText || "Stopped at the run's spending cap." };
    // the history only ever grows: Claude's thinking blocks are bound to every message before them
    deliver(history, hooks.takeSteering());

    const params: Record<string, unknown> = {
      model: cfg.model,
      max_tokens: 32000,
      system,
      tools: SUBAGENT_TOOLS,
      messages: withCacheBreakpoint(history),
    };
    const betas: string[] = [];
    if (!unsupported.has("thinking")) {
      const thinking: Record<string, unknown> = { type: "adaptive", display: "summarized" };
      // a block that no longer matches its conversation is dropped instead of failing the request
      if (!unsupported.has("binding")) {
        thinking.block_binding = { prefix_mismatch_behavior: "drop_block" };
        betas.push(BINDING_BETA);
      }
      params.thinking = thinking;
    }
    if (!unsupported.has("effort")) params.output_config = { effort: cfg.effort };
    if (!unsupported.has("fallbacks")) {
      params.fallbacks = "default";
      betas.push(FALLBACK_BETA);
    }
    if (betas.length) params.betas = betas;

    hooks.activity("Thinking");
    let final: Awaited<ReturnType<typeof streamOnce>>;
    try {
      final = await streamOnce(cfg, params, history, hooks, () => {
        if (!signalled) {
          signalled = true;
          hooks.firstEvent();
        }
      });
    } catch (e) {
      if (!signalled) {
        signalled = true;
        hooks.firstEvent();
      }
      if (e instanceof Anthropic.APIUserAbortError || cfg.signal.aborted) return { status: "stopped", summary: lastText || "Stopped before finishing." };
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return { status: "failed", summary: e instanceof Anthropic.AuthenticationError ? "The API key was not accepted." : "This key cannot use the selected model.", fatal: true };
      return { status: "failed", summary: `The Claude API returned an error: ${errorText(e)}` };
    }
    hooks.usage(final.model, final.usage as unknown as Usage);
    const content = final.content as BetaContentBlock[];
    history.push({ role: "assistant", content: content as unknown as BetaContentBlockParam[] });
    const text = content
      .filter((b): b is Extract<BetaContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) lastText = text;

    if (final.stop_reason === "refusal") return { status: "failed", summary: "Claude declined this subassembly. Rephrase its brief and run it again." };
    if (final.stop_reason === "max_tokens" && content.some((b) => b.type === "tool_use")) {
      history.pop();
      history.push({ role: "assistant", content: [{ type: "text", text: "(My last step was cut off at the length limit.)" }] });
      history.push({ role: "user", content: [{ type: "text", text: "Your last tool call was cut off at the output limit and did not run. Make smaller edits." }] });
      continue;
    }
    if (final.stop_reason !== "tool_use") {
      // a change the user made during the last request still gets an answer
      const late = hooks.takeSteering();
      if (late && !cfg.signal.aborted) {
        history.push({ role: "user", content: [{ type: "text", text: late }] });
        continue;
      }
      hooks.activity(undefined);
      return { status: "done", summary: lastText || "Finished." };
    }

    const uses = content.filter((b): b is Extract<BetaContentBlock, { type: "tool_use" }> => b.type === "tool_use");
    const results: BetaToolResultBlockParam[] = [];
    for (const u of uses) {
      if (cfg.signal.aborted) {
        results.push({ type: "tool_result", tool_use_id: u.id, content: "Stopped by the user before this ran.", is_error: true });
        continue;
      }
      let r: { content: ResultContent; isError?: boolean };
      try {
        r = await runTool(u.name, u.input, ws, hooks);
      } catch (e) {
        r = { content: `Tool failed: ${errorText(e)}`, isError: true };
      }
      results.push({ type: "tool_result", tool_use_id: u.id, content: r.content, is_error: r.isError || undefined });
    }
    history.push({ role: "user", content: results });
  }
  return { status: "stopped", summary: lastText || `Stopped after ${cfg.maxSteps} steps without finishing.` };
}

async function streamOnce(cfg: AgentConfig, params: Record<string, unknown>, history: BetaMessageParam[], hooks: AgentHooks, onFirst: () => void) {
  let strippedOnce = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const stream = cfg.anthropic.beta.messages.stream(params as never, { signal: cfg.signal });
      let thinking = "";
      stream.on("streamEvent", (ev) => {
        if (ev.type === "message_start") onFirst();
        else if (ev.type === "content_block_start") {
          const b = ev.content_block as { type: string; name?: string };
          if (b.type === "tool_use" && b.name) hooks.activity(TOOL_ACTIVITY[b.name] ?? b.name);
          else if (b.type === "text") hooks.activity("Writing the report");
        } else if (ev.type === "content_block_delta") {
          const d = ev.delta as { type: string; thinking?: string };
          if (d.type === "thinking_delta" && d.thinking) {
            thinking += d.thinking;
            const line = thinking.trim().split(/\n+/).pop() ?? "";
            if (line) hooks.activity(line.length > 140 ? line.slice(0, 139) + "…" : line);
          }
        }
      });
      return await stream.finalMessage();
    } catch (e) {
      if (e instanceof Anthropic.BadRequestError && isThinkingSignatureError(e.message || "")) {
        // a thinking block that no longer belongs to this conversation: resend once without thinking
        if (!strippedOnce && hasThinking(history)) {
          strippedOnce = true;
          stripThinking(history);
          params.messages = withCacheBreakpoint(history);
          continue;
        }
      } else if (e instanceof Anthropic.BadRequestError) {
        const msg = (e.message || "").toLowerCase();
        const feature = msg.includes("effort") || msg.includes("output_config") ? "effort" : msg.includes("block_binding") || msg.includes("thinking-binding") ? "binding" : msg.includes("thinking") ? "thinking" : msg.includes("fallback") || msg.includes("beta") ? "fallbacks" : null;
        if (feature && !unsupported.has(feature)) {
          unsupported.add(feature);
          const dropBeta = (b: string) => {
            const rest = ((params.betas as string[] | undefined) ?? []).filter((x) => x !== b);
            if (rest.length) params.betas = rest;
            else delete params.betas;
          };
          if (feature === "effort") delete params.output_config;
          if (feature === "binding") {
            delete (params.thinking as Record<string, unknown> | undefined)?.block_binding;
            dropBeta(BINDING_BETA);
          }
          if (feature === "thinking") {
            delete params.thinking;
            dropBeta(BINDING_BETA);
          }
          if (feature === "fallbacks") {
            delete params.fallbacks;
            dropBeta(FALLBACK_BETA);
          }
          continue;
        }
      }
      // busy or rate limited after the SDK's own retries: wait and try again
      const busy = e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || (e instanceof Anthropic.APIError && e.status === 529);
      if (busy && attempt < 5 && !cfg.signal.aborted) {
        const after = Number((e as InstanceType<typeof Anthropic.APIError>).headers?.get?.("retry-after")) || 0;
        const wait = Math.min(60, Math.max(after, 10 * (attempt + 1)));
        hooks.activity(e instanceof Anthropic.RateLimitError ? `Rate limited, retrying in ${wait} s` : `Claude is busy, retrying in ${wait} s`);
        await sleep(wait * 1000, cfg.signal);
        continue;
      }
      throw e;
    }
  }
  throw new Error("The request could not be completed.");
}

const TOOL_ACTIVITY: Record<string, string> = {
  write_section: "Writing the section",
  edit_section: "Editing the section",
  check_section: "Checking the geometry",
  look: "Looking at the model",
  read_subassembly: "Reading a neighbouring subassembly",
  request_change: "Requesting a change",
  update_plan: "Updating its steps",
};

// ---------- tools ----------

async function runTool(name: string, input: unknown, ws: Workspace, hooks: AgentHooks): Promise<{ content: ResultContent; isError?: boolean }> {
  switch (name) {
    case "write_section": {
      const p = WriteIn.safeParse(input);
      if (!p.success) return invalid(p.error);
      return saveBody(stripMarkers(p.data.source.replace(/\r\n/g, "\n")), p.data.summary, ws, hooks);
    }
    case "edit_section": {
      const p = EditIn.safeParse(input);
      if (!p.success) return invalid(p.error);
      const { src, errors } = applyTextEdits(ws.body(), p.data.edits);
      if (errors.length) {
        const msg = errors.map((e) => e.replace(/Call get_design[^.]*\./, "Your section is shown in the last write or edit result; copy text from it exactly.")).join("\n");
        hooks.step({ title: "Edit could not be applied", status: "error", detail: errors[0] });
        return { content: `No edits were applied.\n${msg}`, isError: true };
      }
      return saveBody(src, p.data.summary, ws, hooks);
    }
    case "check_section": {
      const id = hooks.step({ title: "Checking the geometry", status: "running" });
      const { src, start, end } = ws.isolated(ws.body());
      const res = await checkIsolated(src, (s) => hooks.activity(s));
      if (!res.report) {
        hooks.updateStep(id, { title: "Geometry check did not finish", status: "error", detail: res.error });
        return { content: res.error ?? "The check did not finish.", isError: true };
      }
      const out = sectionReport(src, res.model, res.report.items, start, end, ws.otherNames());
      ws.onChecks(out.counts);
      hooks.updateStep(id, {
        title: out.counts.fail ? `${out.counts.fail} check${out.counts.fail > 1 ? "s" : ""} failing` : `All ${out.counts.pass} checks pass`,
        status: out.counts.fail ? "error" : "done",
        detail: out.failing.slice(0, 4).join("\n") || `${res.built} solids built in geometry worker ${res.worker}, ${Math.round(res.ms)} ms`,
      });
      return { content: `${out.text}\nBuilt ${res.built} solid(s) in geometry worker ${res.worker} in ${Math.round(res.ms)} ms.${res.error ? `\nChecks error: ${res.error}` : ""}` };
    }
    case "look": {
      const p = LookIn.safeParse(input);
      if (!p.success) return invalid(p.error);
      const id = hooks.step({ title: `Looking at the ${p.data.view} view`, status: "running" });
      const r = await ws.look(p.data.view, p.data.section);
      hooks.updateStep(id, { status: r.image ? "done" : "error", detail: r.image ? undefined : r.text });
      if (!r.image) return { content: r.text, isError: true };
      return {
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: r.image } },
          { type: "text", text: r.text },
        ],
      };
    }
    case "read_subassembly": {
      const p = ReadIn.safeParse(input);
      if (!p.success) return invalid(p.error);
      const src = ws.readOther(p.data.id);
      hooks.step({ title: `Read ${p.data.id}`, status: src === null ? "error" : "done" });
      if (src === null) return { content: `There is no subassembly "${p.data.id}".`, isError: true };
      return { content: src.trim() ? src : "(empty so far)" };
    }
    case "request_change": {
      const p = ReqIn.safeParse(input);
      if (!p.success) return invalid(p.error);
      hooks.step({ title: `Asked to change ${p.data.target}`, status: "done", detail: p.data.change });
      return { content: ws.requestChange(p.data.target, p.data.change, p.data.reason) };
    }
    case "update_plan": {
      const p = PlanIn.safeParse(input);
      if (!p.success) return invalid(p.error);
      const problem = hooks.setSteps(p.data.steps);
      if (problem) return { content: `Your steps were not shown: ${problem}`, isError: true };
      const n = (st: string) => p.data.steps.filter((x) => x.status === st).length;
      return { content: `Steps shown to the user: ${n("done")} done, ${n("doing")} doing, ${n("todo")} to do.` };
    }
  }
  return { content: `Unknown tool ${name}`, isError: true };
}

/** Section markers belong to the orchestrator; an agent that copies them would break the file. */
function stripMarkers(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*\/\/\s*[┌└]─/.test(l))
    .join("\n");
}

function saveBody(body: string, summary: string, ws: Workspace, hooks: AgentHooks): { content: ResultContent; isError?: boolean } {
  const before = ws.body();
  const clean = body.endsWith("\n") || !body ? body : body + "\n";
  if (clean === before) return { content: "No change: the section is identical." };
  ws.setBody(clean, summary);
  const { src, start, end } = ws.isolated(clean);
  const model = evaluate(src);
  const stats = diffStats(before, clean);
  const own = ownDiagnostics(src, model, start, end);
  const collisions = collide(clean, ws.otherNames());
  hooks.step({ title: summary, status: own.errors.length || collisions.length ? "error" : "done", detail: `+${stats.added} −${stats.removed} lines${own.errors.length ? ` · ${own.errors.length} error${own.errors.length > 1 ? "s" : ""}` : ""}` });
  const lines = [
    `Saved your section (${clean.split("\n").length - 1} lines).`,
    own.errors.length ? `Source errors in your section:\n${own.errors.map((e) => `  - ${e}`).join("\n")}` : "No source errors in your section.",
    collisions.length ? `Name collisions (rename yours): ${collisions.join("; ")}` : "",
    own.summary,
    `<your_section note="Line numbers are not part of the text.">\n${numbered(clean)}\n</your_section>`,
    "Next: call check_section to build and check the geometry.",
  ];
  return { content: lines.filter(Boolean).join("\n"), isError: own.errors.length > 0 || undefined };
}

function ownDiagnostics(src: string, model: Model, start: number, end: number) {
  const base = lineCol(src, start).line - 1;
  const inside = (o: number) => o >= start && o < end;
  const errors = model.diagnostics.filter((d) => d.severity === "error" && inside(d.start)).map((d) => `line ${lineCol(src, d.start).line - base}: ${d.message}`);
  const outside = model.diagnostics.filter((d) => d.severity === "error" && !inside(d.start)).length;
  if (outside) errors.push(`${outside} error(s) outside your section (in the layout or a dependency); tell the lead engineer with request_change if they block you.`);
  const parts = model.parts.filter((p) => inside(p.span.start));
  const names = [...new Set(parts.map((p) => (p.id.includes("#") ? p.id.split("#")[0] + "#…" : p.id)))];
  const reqs = model.requirements.filter((r) => inside(r.span.start));
  const ungrouped = [...new Set(parts.filter((p) => !p.group || p.group === "Other").map((p) => p.name))];
  const summary = [
    `Your section defines ${parts.length} solid(s): ${names.slice(0, 40).join(", ") || "none"}.`,
    reqs.length ? `Requirements:\n${reqs.map((r) => `  - [${r.status}${r.level === "soft" ? ", soft" : ""}] ${r.label}: ${r.detail}`).join("\n")}` : "No requirements in your section yet.",
    ungrouped.length ? `Missing group: ${ungrouped.join(", ")} (give every part and component group: "<your subassembly name>").` : "",
  ];
  return { errors, summary: summary.filter(Boolean).join("\n") };
}

function collide(body: string, others: Map<string, string>): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/^\s*(?:param|let|component|interface|part)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
    const owner = others.get(m[1]);
    if (owner) out.push(`${m[1]} is already defined by ${owner}`);
  }
  return out;
}

export function sectionReport(src: string, model: Model, items: CheckItem[], start: number, end: number, others: Map<string, string>) {
  const inside = (o?: number) => o !== undefined && o >= start && o < end;
  const ownParts = new Set(model.parts.filter((p) => inside(p.span.start)).map((p) => p.id));
  const mine = (i: CheckItem) => i.parts?.some((id) => ownParts.has(id)) || inside(i.span?.start);
  const own = items.filter((i) => mine(i) && i.status !== "info");
  const outside = items.filter((i) => !mine(i) && (i.status === "fail" || i.status === "warn"));
  const counts = { pass: 0, fail: 0, warn: 0 };
  for (const i of own) if (i.status === "pass" || i.status === "fail" || i.status === "warn") counts[i.status]++;
  const base = lineCol(src, start).line - 1;
  const line = (i: CheckItem) => (inside(i.span?.start) ? ` (line ${lineCol(src, i.span!.start).line - base})` : "");
  const failing = own.filter((i) => i.status === "fail" || i.status === "warn").map((i) => `[${i.status}] ${i.title}: ${i.detail}${line(i)}`);
  const pending = own.filter((i) => i.status === "pending").map((i) => i.title);
  const passing = own.filter((i) => i.status === "pass").map((i) => i.title);
  const collisions = collide(src.slice(start, end), others);
  const text = [
    `Checks on your parts: ${counts.pass} pass, ${counts.fail} fail, ${counts.warn} warn.`,
    failing.length ? `Problems:\n${failing.map((f) => `  - ${f}`).join("\n")}` : "",
    pending.length ? `Not resolved: ${pending.join("; ")}` : "",
    passing.length ? `Passing: ${passing.slice(0, 40).join("; ")}` : "",
    outside.length ? `${outside.length} problem(s) outside your section (layout or dependencies): ${outside.slice(0, 4).map((i) => i.title).join("; ")}` : "",
    collisions.length ? `Name collisions with other subassemblies (rename yours): ${collisions.join("; ")}` : "",
  ];
  if (collisions.length) counts.fail += collisions.length;
  return { text: text.filter(Boolean).join("\n"), counts, failing: [...failing, ...collisions] };
}

function invalid(e: z.ZodError) {
  return { content: `Invalid tool input: ${e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`, isError: true };
}

const numbered = (src: string) => {
  const lines = src.replace(/\n$/, "").split("\n");
  const w = String(lines.length).length;
  return lines.map((l, i) => `${String(i + 1).padStart(w, " ")}| ${l}`).join("\n");
};

function deliver(history: BetaMessageParam[], text: string | null) {
  if (!text) return;
  const last = history[history.length - 1];
  if (last.role === "user" && typeof last.content !== "string") last.content = [...last.content, { type: "text", text }];
  else history.push({ role: "user", content: [{ type: "text", text }] });
}

function withCacheBreakpoint(h: BetaMessageParam[]): BetaMessageParam[] {
  const out = h.slice();
  const last = out[out.length - 1];
  if (last && last.role === "user" && typeof last.content !== "string" && last.content.length) {
    const blocks = last.content.slice();
    const lb = blocks[blocks.length - 1];
    if (lb.type === "text" || lb.type === "tool_result") blocks[blocks.length - 1] = { ...lb, cache_control: { type: "ephemeral" } } as BetaContentBlockParam;
    out[out.length - 1] = { ...last, content: blocks };
  }
  return out;
}

function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…").slice(0, 300);
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
}
