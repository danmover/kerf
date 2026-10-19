// The independent reviewer: a separate Claude conversation that sees only the
// brief, the renders, the measured details, the checks and the source. It can
// ask for close-ups, then submits its findings through a strict tool.

import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlock, BetaContentBlockParam, BetaMessageParam, BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { reviewerPrompt } from "./prompt";
import { recordSpend } from "../spend";
import { MAX_OUTPUT_TOKENS, trimCutOff } from "../history";
import { pause, retryWait } from "../retry";
import type { Usage } from "../../agents/pricing";
import { AREAS, type Brief, type Finding, type ReviewProgress, type ReviewUsage, type ReviewView } from "./types";

// no generated code: the page CSP forbids eval
z.config({ jitless: true });

const VIEWS = ["iso", "front", "back", "top", "bottom", "left", "right"] as const;
const AREA_IDS = AREAS.map((a) => a.id) as [string, ...string[]];
const MAX_CLOSEUPS = 4;
const MAX_STEPS = 8;

const LOOK_CLOSER = {
  name: "look_closer",
  description: "Render a close-up of specific parts, framed to fill the image, with everything else ghosted. Use it when a detail is too small or ambiguous in the overview renders. At most 4 per review; ask for all the close-ups you need in one response, as several calls.",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: {
      parts: { type: "array", items: { type: "string" }, description: "Part or component names as written in the source." },
      view: { type: "string", enum: [...VIEWS], description: "Camera direction; iso is a 3/4 view from the front right." },
      section: { type: "string", enum: ["none", "x", "y", "z"], description: "Cut the model in half across this axis to see inside, or none." },
      why: { type: "string", description: "What you want to check, in a few words. Shown to the user." },
    },
    required: ["parts", "view", "section", "why"],
    additionalProperties: false,
  },
};

const SUBMIT = {
  name: "submit_review",
  description: "Submit the finished review. Call exactly once, at the end.",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: {
      verdict: { type: "string", enum: ["pass", "revise"] },
      summary: { type: "string", description: "One or two plain sentences for the user." },
      assumptions: { type: "string", description: "What you assumed where the brief was silent (use, process, environment). Empty if nothing." },
      checked: {
        type: "array",
        description: "One entry per review area, in the order given.",
        items: {
          type: "object",
          properties: {
            area: { type: "string", enum: AREA_IDS },
            result: { type: "string", enum: ["ok", "issues", "n/a"] },
            note: { type: "string", description: "What you looked at and what you found, one short sentence." },
          },
          required: ["area", "result", "note"],
          additionalProperties: false,
        },
      },
      findings: {
        type: "array",
        description: "New problems, most important first, at most 8. Empty when there is nothing important to fix.",
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["blocker", "major", "minor"] },
            area: { type: "string", enum: AREA_IDS },
            title: { type: "string", description: "Short, in the user's terms, e.g. 'Sharp edges where the lid is gripped'." },
            detail: { type: "string", description: "What is wrong and the evidence (view or measurement)." },
            fix: { type: "string", description: "The specific change in Kerf terms." },
            parts: { type: "array", items: { type: "string" } },
            view: { type: "string", description: "The view where it shows, or 'measured'." },
            needs_user: { type: "boolean" },
          },
          required: ["severity", "area", "title", "detail", "fix", "parts", "view", "needs_user"],
          additionalProperties: false,
        },
      },
      earlier: {
        type: "array",
        description: "On a later round, one entry per earlier finding. Empty on the first round.",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            status: { type: "string", enum: ["resolved", "still_open", "accepted"] },
            note: { type: "string" },
          },
          required: ["id", "status", "note"],
          additionalProperties: false,
        },
      },
    },
    required: ["verdict", "summary", "assumptions", "checked", "findings", "earlier"],
    additionalProperties: false,
  },
};

const LookInput = z.object({ parts: z.array(z.string().max(80)).max(30), view: z.enum(VIEWS), section: z.enum(["none", "x", "y", "z"]), why: z.string().max(300) });

export const Submission = z.object({
  verdict: z.enum(["pass", "revise"]),
  summary: z.string().max(1200),
  assumptions: z.string().max(1200),
  checked: z.array(z.object({ area: z.enum(AREA_IDS), result: z.enum(["ok", "issues", "n/a"]), note: z.string().max(600) })).max(12),
  findings: z
    .array(
      z.object({
        severity: z.enum(["blocker", "major", "minor"]),
        area: z.enum(AREA_IDS),
        title: z.string().min(1).max(200),
        detail: z.string().max(1500),
        fix: z.string().max(1500),
        parts: z.array(z.string().max(80)).max(30),
        view: z.string().max(80),
        needs_user: z.boolean(),
      }),
    )
    .max(12),
  earlier: z.array(z.object({ id: z.string().max(10), status: z.enum(["resolved", "still_open", "accepted"]), note: z.string().max(800) })).max(60),
});
export type Submission = z.infer<typeof Submission>;

export class ReviewError extends Error {}

export interface ReviewerInput {
  client: Anthropic;
  model: string;
  effort: string;
  brief: Brief;
  round: number;
  /** model and check summaries, as the designer sees them */
  designSummary: string;
  inventory: string;
  /** source with line numbers */
  source: string;
  views: ReviewView[];
  earlier: Finding[];
  /** what changed in the source since the work began (round 1) or since the last round */
  changes?: string;
  focus?: string;
  scope?: string[];
  closeup: (req: { parts: string[]; view: (typeof VIEWS)[number]; section?: "x" | "y" | "z"; why: string }) => Promise<ReviewView | null>;
  signal?: AbortSignal;
  onProgress?: (p: ReviewProgress) => void;
}

export interface ReviewerOutput {
  submission: Submission;
  closeups: ReviewView[];
  usage: ReviewUsage;
  model: string;
}

/** request features a model rejected this session */
const unsupported = new Set<"effort" | "thinking" | "fallbacks">();

function firstMessage(i: ReviewerInput): BetaContentBlockParam[] {
  const blocks: BetaContentBlockParam[] = [];
  const text = (t: string) => blocks.push({ type: "text", text: t });
  text(`<brief from="${i.brief.from}">\n${i.brief.text || "(The user gave no description beyond the design itself. Infer the purpose from the design's name, notes and requirements.)"}\n</brief>`);
  if (i.scope?.length) text(`Review only this subassembly: ${i.scope.join(", ")}. Other parts are context.`);
  text(`<design>\n${i.designSummary}\n</design>`);
  text(`<detail_inventory>\n${i.inventory}\n</detail_inventory>`);
  text(`<source>\n${i.source}\n</source>`);
  if (i.earlier.length) {
    text(
      `<earlier_findings round="${i.round - 1}">\n${i.earlier
        .map((f) => {
          const said = f.status === "fixed" ? "fixed it" : f.status === "declined" ? "kept it" : f.status === "needs_user" ? "left it for the user" : "did not respond";
          return `${f.id} [${f.severity}, ${f.area}] ${f.title}. Fix asked: ${f.fix}\n   Designer ${said}${f.response ? `: ${f.response}` : ""}${f.note ? `\n   You said last round: ${f.note}` : ""}`;
        })
        .join("\n")}\n</earlier_findings>`,
    );
  }
  if (i.changes) text(`<changes since="${i.round > 1 ? "the last review round" : "the start of this piece of work"}">\n${i.changes}\n</changes>`);
  if (i.focus) text(`The designer asks you to look especially at: ${i.focus}`);
  for (const v of i.views) {
    text(`View: ${v.label}`);
    blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: v.image.split(",")[1] ?? "" } });
  }
  text(`This is review round ${i.round}. Review the design against the brief, then call submit_review.`);
  // the renders, source and inventory are sent again with every close-up the reviewer asks for: read them from the cache
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: "ephemeral" } } as BetaContentBlockParam;
  return blocks;
}

/** The messages with a cache breakpoint on the newest user turn, so each step reads the one before from the cache. */
function withRollingCache(messages: BetaMessageParam[]): BetaMessageParam[] {
  if (messages.length < 2) return messages;
  const out = messages.slice();
  const last = out[out.length - 1];
  if (last.role !== "user" || typeof last.content === "string" || !last.content.length) return out;
  const blocks = last.content.slice();
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: "ephemeral" } } as BetaContentBlockParam;
  out[out.length - 1] = { ...last, content: blocks };
  return out;
}

export async function callReviewer(i: ReviewerInput): Promise<ReviewerOutput> {
  const messages: BetaMessageParam[] = [{ role: "user", content: firstMessage(i) }];
  const usage: ReviewUsage = { input: 0, output: 0, cacheRead: 0, calls: 0 };
  const closeups: ReviewView[] = [];
  let model = i.model;
  let nudged = false;
  const system = [{ type: "text" as const, text: reviewerPrompt(), cache_control: { type: "ephemeral" as const } }];

  for (let step = 0; step < MAX_STEPS; step++) {
    i.onProgress?.({ stage: step === 0 ? "reviewing" : "writing", detail: step === 0 ? "Reviewer is looking at the renders" : "Reviewer is writing up" });
    const params: Record<string, unknown> = { model: i.model, max_tokens: MAX_OUTPUT_TOKENS, system, tools: [LOOK_CLOSER, SUBMIT], messages: withRollingCache(messages) };
    if (!unsupported.has("thinking")) params.thinking = { type: "adaptive", display: "omitted" };
    if (!unsupported.has("effort")) params.output_config = { effort: i.effort };
    if (!unsupported.has("fallbacks")) {
      params.fallbacks = "default";
      params.betas = ["server-side-fallback-2026-07-01"];
    }
    const final = await streamWithRetry(i.client, params, i.signal);
    recordSpend("review", final.model, final.usage as unknown as Usage);
    usage.calls++;
    usage.input += (final.usage.input_tokens ?? 0) + (final.usage.cache_creation_input_tokens ?? 0) + (final.usage.cache_read_input_tokens ?? 0);
    usage.output += final.usage.output_tokens ?? 0;
    usage.cacheRead += final.usage.cache_read_input_tokens ?? 0;
    model = final.model;
    // cut off at the length limit: what it was writing (half a call, unsigned thinking) cannot be sent back
    const cut = final.stop_reason === "max_tokens";
    const content = cut ? trimCutOff(final.content as BetaContentBlock[]).content : (final.content as BetaContentBlock[]);
    messages.push({ role: "assistant", content: content as unknown as BetaContentBlockParam[] });

    if (final.stop_reason === "refusal") throw new ReviewError("The reviewer declined to review this design.");
    const uses = content.filter((b): b is Extract<BetaContentBlock, { type: "tool_use" }> => b.type === "tool_use");
    const submit = uses.find((u) => u.name === "submit_review");
    if (submit) {
      const p = Submission.safeParse(submit.input);
      if (p.success) return { submission: p.data, closeups, usage, model };
      // answer every tool call, then ask for a corrected submission
      const results: BetaToolResultBlockParam[] = uses.map((u) =>
        u.id === submit.id
          ? { type: "tool_result", tool_use_id: u.id, is_error: true, content: `Invalid submission: ${p.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}. Call submit_review again.` }
          : { type: "tool_result", tool_use_id: u.id, content: "Skipped: the review was being submitted." },
      );
      messages.push({ role: "user", content: results });
      continue;
    }
    if (uses.length) {
      const results: BetaToolResultBlockParam[] = [];
      for (const u of uses) {
        if (i.signal?.aborted) throw new Anthropic.APIUserAbortError();
        if (u.name !== "look_closer") {
          results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: `Unknown tool ${u.name}.` });
          continue;
        }
        const p = LookInput.safeParse(u.input);
        if (!p.success) {
          results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: "Invalid input." });
          continue;
        }
        if (closeups.length >= MAX_CLOSEUPS) {
          results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: "Close-up limit reached. Finish the review with what you have." });
          continue;
        }
        i.onProgress?.({ stage: "closeup", detail: `Close-up of ${p.data.parts.join(", ") || "the model"}: ${p.data.why}` });
        const v = await i.closeup({ parts: p.data.parts, view: p.data.view, section: p.data.section === "none" ? undefined : p.data.section, why: p.data.why });
        if (!v) {
          results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: `No parts matched ${p.data.parts.join(", ")}. Use names from the source.` });
          continue;
        }
        closeups.push(v);
        results.push({
          type: "tool_result",
          tool_use_id: u.id,
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: v.image.split(",")[1] ?? "" } },
            { type: "text", text: v.label },
          ],
        });
      }
      messages.push({ role: "user", content: cut ? [...results, { type: "text", text: "You ran out of room. Finish with submit_review, keeping each field short." }] : results });
      continue;
    }
    // ended without submitting: ask once more
    if (nudged) break;
    nudged = true;
    messages.push({ role: "user", content: [{ type: "text", text: final.stop_reason === "max_tokens" ? "You ran out of room. Call submit_review now, keeping each field short." : "Call submit_review now with your review." }] });
  }
  throw new ReviewError("The reviewer did not submit a review.");
}

async function streamWithRetry(client: Anthropic, params: Record<string, unknown>, signal?: AbortSignal) {
  let busy = 0;
  for (let attempt = 0; attempt < 7; attempt++) {
    try {
      return await client.beta.messages.stream(params as never, { signal }).finalMessage();
    } catch (e) {
      // a model that rejects an optional feature: drop it and retry
      if (e instanceof Anthropic.BadRequestError) {
        const msg = (e.message || "").toLowerCase();
        const feature = msg.includes("effort") || msg.includes("output_config") ? "effort" : msg.includes("thinking") ? "thinking" : msg.includes("fallback") || msg.includes("beta") ? "fallbacks" : null;
        if (feature && !unsupported.has(feature)) {
          unsupported.add(feature);
          if (feature === "effort") delete params.output_config;
          if (feature === "thinking") delete params.thinking;
          if (feature === "fallbacks") {
            delete params.fallbacks;
            delete params.betas;
          }
          continue;
        }
      }
      // busy or cut off part-way: wait and send it again rather than lose the review
      const wait = retryWait(e, busy);
      if (wait !== null && !signal?.aborted) {
        busy++;
        await pause(wait * 1000, signal);
        continue;
      }
      throw e;
    }
  }
  throw new ReviewError("The review request could not be completed.");
}
