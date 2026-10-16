// Claude's self-review, as one self-contained stage: render the design from
// several angles, measure its details, have an independent reviewer judge it
// against the brief, and return findings with fixes. The chat calls it after
// a design changes; other orchestrators (one agent per subassembly) can call
// runReview directly with their own scope and session.

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { useDesign, whenChecked, whenRefined, meshes } from "../../core/engine";
import type { Model } from "../../core/model";
import type { CheckReport } from "../../core/checks";
import { kernel } from "../../kernel/client";
import type { PartInspection } from "../../kernel/inspect";
import type { V3 } from "../../kernel/recipe";
import { viewport } from "../../app/viewportApi";
import { useSettings } from "../../app/settings";
import { modelSummary, numbered, reportSummary } from "../tools";
import { buildInventory, inventoryText } from "./inventory";
import { captureCloseup, captureViews, contactSheet, type Capture } from "./renders";
import { callReviewer, ReviewError } from "./reviewer";
import { verdictOf } from "./session";
import type { Brief, Finding, ReviewProgress, ReviewResult } from "./types";

export { ReviewSession, designerReport, verdictOf } from "./session";
export { REVIEW_TOOL, ReviewInput } from "./tool";
export { ReviewError } from "./reviewer";
export { inventoryDigest } from "./inventory";
export * from "./types";

// no generated code: the page CSP forbids eval
z.config({ jitless: true });

// ---------- the brief ----------

let briefProvider: (() => Brief | null) | null = null;

/**
 * Where reviews get the brief. The chat registers the conversation so far;
 * a saved project brief, when there is one, should register itself here and
 * take precedence.
 */
export function registerBriefProvider(fn: (() => Brief | null) | null) {
  briefProvider = fn;
}
export const currentBrief = (): Brief => briefProvider?.() ?? { text: "", from: "conversation" };

// ---------- dependencies ----------

export interface ReviewDeps {
  client: () => Anthropic | null;
  model: () => string;
  effort: () => string;
  capture: () => Capture | null;
  /** waits until the current design is built and checked */
  design: () => Promise<{ source: string; model: Model | null; report: CheckReport | null; kernelError: string }>;
  inspect: (hashes: string[]) => Promise<Record<string, PartInspection | { error: string }>>;
  bbox: (hash: string) => [V3, V3] | undefined;
}

export function appDeps(client: () => Anthropic | null): ReviewDeps {
  return {
    client,
    model: () => useSettings.getState().model,
    effort: () => useSettings.getState().effort,
    capture: () => {
      const vp = viewport();
      return vp ? (o) => vp.capture(o) : null;
    },
    design: async () => {
      const s = await whenChecked(60_000);
      // captures should show exact meshes, not the coarse first pass
      await whenRefined(30_000);
      const now = useDesign.getState();
      return { source: now.source, model: now.model, report: now.report, kernelError: s.kernelStatus === "error" ? s.kernelError : "" };
    },
    inspect: (hashes) => kernel.inspect(hashes),
    bbox: (hash) => meshes.get(hash)?.bbox,
  };
}

// ---------- the stage ----------

export interface ReviewRequest {
  brief: Brief;
  /** 1 for the first review of this piece of work */
  round: number;
  /** findings from earlier rounds with the designer's responses */
  earlier: Finding[];
  /** number for the next new finding (R1, R2…) */
  nextId: number;
  /** what the designer wants looked at especially */
  focus?: string;
  /** limit the review to these part and component names (a subassembly) */
  scope?: string[];
  signal?: AbortSignal;
  onProgress?: (p: ReviewProgress) => void;
}

export async function runReview(req: ReviewRequest, deps: ReviewDeps): Promise<ReviewResult> {
  const t0 = performance.now();
  const client = deps.client();
  if (!client) throw new ReviewError("Add your Claude API key to run a review.");
  const capture = deps.capture();
  if (!capture) throw new ReviewError("The 3D view is not available, so there is nothing to render.");

  req.onProgress?.({ stage: "waiting", detail: "Waiting for the build and checks" });
  const d = await deps.design();
  if (d.kernelError) throw new ReviewError(`The geometry kernel is unavailable: ${d.kernelError}`);
  if (!d.model) throw new ReviewError("There is no design to review yet.");
  const errors = d.model.diagnostics.filter((x) => x.severity === "error");
  if (errors.length) throw new ReviewError(`The design has ${errors.length} source error${errors.length > 1 ? "s" : ""}; fix ${errors.length > 1 ? "them" : "it"} before reviewing.`);
  if (!d.model.parts.length) throw new ReviewError("The design has no parts to review yet.");
  abortIf(req.signal);

  const scopeIds = req.scope?.length ? idsFor(d.model, req.scope) : undefined;
  req.onProgress?.({ stage: "rendering", detail: "Rendering 7 views" });
  const views = await captureViews(capture, scopeIds, (v) => req.onProgress?.({ stage: "rendering", detail: `Rendering views (${v.label})` }));
  req.onProgress?.({ stage: "measuring", detail: "Measuring edges, walls and overhangs", views });
  abortIf(req.signal);

  const inventory = await buildInventory(d.model, d.source, deps.inspect, deps.bbox, req.scope);
  abortIf(req.signal);

  const out = await callReviewer({
    client,
    model: deps.model(),
    effort: deps.effort(),
    brief: req.brief,
    round: req.round,
    designSummary: `${modelSummary(d.model)}\n\n${reportSummary(d.report)}`,
    inventory: inventoryText(inventory),
    source: numbered(d.source),
    views,
    earlier: req.earlier,
    focus: req.focus,
    scope: req.scope,
    closeup: async ({ parts, view, section, why }) => {
      const ids = idsFor(d.model!, parts);
      if (!ids.length) return null;
      return captureCloseup(capture, ids, view, section, why, parts);
    },
    signal: req.signal,
    onProgress: (p) => req.onProgress?.({ ...p, views }),
  });

  const s = out.submission;
  const earlier: Finding[] = req.earlier.map((f) => {
    const v = s.earlier.find((e) => e.id.trim().toUpperCase() === f.id);
    if (!v) return f;
    return { ...f, status: v.status === "resolved" ? "verified" : v.status === "accepted" ? "accepted" : "still_open", note: v.note || f.note };
  });
  const findings: Finding[] = s.findings.slice(0, 8).map((x, i) => ({
    id: `R${req.nextId + i}`,
    round: req.round,
    severity: x.severity,
    area: x.area as Finding["area"],
    title: x.title,
    detail: x.detail,
    fix: x.fix,
    parts: x.parts,
    view: x.view,
    needsUser: x.needs_user,
    status: x.needs_user ? "needs_user" : "open",
  }));
  const allViews = [...views, ...out.closeups];
  return {
    round: req.round,
    verdict: verdictOf([...earlier, ...findings]),
    summary: s.summary,
    assumptions: s.assumptions,
    checked: s.checked.map((c) => ({ area: c.area as Finding["area"], result: c.result, note: c.note })),
    findings,
    earlier,
    views: allViews,
    sheet: await contactSheet(views),
    inventory,
    source: d.source,
    model: out.model,
    usage: out.usage,
    ms: Math.round(performance.now() - t0),
  };
}

function abortIf(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
}

/** Part instance ids for part or component names as written in the source. */
export function idsFor(model: Model, names: string[]): string[] {
  return model.parts.filter((p) => names.some((n) => p.name === n || p.id === n || p.id.startsWith(n + "#") || p.id.startsWith(n + "."))).map((p) => p.id);
}
