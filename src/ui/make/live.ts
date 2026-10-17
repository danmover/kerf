// Live manufacturing plans for the make tab: replanned as the design, the
// brief, the processes you have and your labour rate change; a route's
// material and process issues previewed on the model; and routes applied as
// one undoable change.

import { useEffect, useRef, useState } from "react";
import { useDesign } from "../../core/engine";
import { useSettings } from "../../app/settings";
import { commitSource } from "../../app/project";
import { viewport } from "../../app/viewportApi";
import { blockPart, withMaterial } from "../../materials/apply";
import { setPartProcess } from "../../mfg/edit";
import { PROCESSES } from "../../mfg/profiles";
import { planDesign, planPart, type PlannedDesign, type PlannedPart } from "../../mfg/plan";
import type { ManufacturingPlan, Route } from "../../mfg/advisor";
import type { ProcessResult } from "../../mfg/types";
import { useMfgView } from "../mfgView";
import { blockIds } from "../materials/live";

/** What the plan depends on, short of the whole model: this part's shape, material and process, the brief, and your processes. */
function useInputs() {
  const model = useDesign((s) => s.model);
  const rev = useDesign((s) => s.reportRev);
  const access = useSettings((s) => s.processAccess);
  const labour = useSettings((s) => s.labourRate);
  return { model, rev, access, labour };
}

export interface PlanState<T> {
  data: T | null;
  /** the plan is being (re)made; data, if any, is the previous or draft one */
  busy: boolean;
  error: string;
  /** whole-design planning: parts done and total */
  progress?: [number, number];
}

/** The plan for one part block, replanned (debounced) as the design changes. */
export function usePartPlan(block: string | null): PlanState<PlannedPart> {
  const { model, rev, access, labour } = useInputs();
  const [state, setState] = useState<PlanState<PlannedPart>>({ data: null, busy: false, error: "" });
  const part = model && block ? blockPart(model, block) : undefined;
  const key = part ? `${block}|${part.hash}|${part.material}|${part.finish}|${part.color}|${JSON.stringify(part.process ?? null)}|${JSON.stringify(model?.brief ?? null)}|${rev}` : "";
  const prevBlock = useRef(block);
  useEffect(() => {
    if (!block) return setState({ data: null, busy: false, error: "" });
    let live = true;
    // a different part clears the old one's plan; the same part keeps it on screen while it replans
    const fresh = prevBlock.current !== block;
    prevBlock.current = block;
    setState((s) => ({ data: fresh ? null : s.data, busy: true, error: "" }));
    const t = setTimeout(() => {
      planPart(block, {
        onDraft: (plan) => live && fresh && setState((s) => (s.data ? s : { data: { plan, fits: {} }, busy: true, error: "" })),
      }).then(
        (data) => live && setState({ data, busy: false, error: "" }),
        (e) => live && setState({ data: null, busy: false, error: e instanceof Error ? e.message : String(e) }),
      );
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [block, key, access, labour]);
  return state;
}

/** Plans for every made part of the design (each checked on the kernel in turn). */
export function useDesignPlan(on: boolean): PlanState<PlannedDesign> {
  const { model, rev, access, labour } = useInputs();
  const [state, setState] = useState<PlanState<PlannedDesign>>({ data: null, busy: false, error: "" });
  const key = model ? `${model.parts.map((p) => `${p.id}:${p.hash}:${p.material}:${JSON.stringify(p.process ?? null)}`).join(",")}|${JSON.stringify(model.brief ?? null)}|${rev}` : "";
  useEffect(() => {
    if (!on) return;
    let live = true;
    setState((s) => ({ ...s, busy: true, error: "" }));
    const t = setTimeout(() => {
      planDesign({
        onProgress: (done, total) => live && setState((s) => ({ ...s, progress: [done, total] })),
        cancelled: () => !live,
      }).then(
        (data) => live && setState({ data, busy: false, error: "" }),
        (e) => live && setState({ data: null, busy: false, error: e instanceof Error ? e.message : String(e) }),
      );
    }, 500);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [on, key, access, labour]);
  return state;
}

/** Show a route on the model: its material, and the issues its process checks found. */
export function previewRoute(block: string, r: Route | null, fits: PlannedPart["fits"]) {
  const ids = blockIds(block);
  if (!r) {
    viewport()?.preview(ids, null);
    useMfgView.setState({ preview: null });
    return;
  }
  viewport()?.preview(ids, r.materialChange ? { material: r.material, finish: r.finish, color: r.color } : null);
  const result = fits[r.process];
  if (!result || r.current) return useMfgView.setState({ preview: null });
  const preview: Record<string, ProcessResult> = {};
  for (const id of ids) preview[id] = result;
  useMfgView.setState({ preview });
}

const routeText = (r: Route) => `${PROCESSES[r.process].label} in ${r.materialLabel}`;

/** Edits that put one part block on a route: its process, then material, finish and colour. */
function routeEdit(src: string, block: string, r: Route): string {
  const model = useDesign.getState().model;
  const part = model && blockPart(model, block);
  if (!model || !part) return src;
  let out = src;
  let process: Route["process"] | undefined = r.process;
  // a part marked process: false opted out of the brief's process; a route is an explicit choice
  if (part.processNone) {
    out = setPartProcess(out, part, { id: r.process, settings: {} });
    process = undefined;
  }
  return withMaterial(out, model, block, { material: r.material, finish: r.finish, color: r.color, process }).src;
}

/** Make a part block this way, as one undoable change. */
export function applyRoute(block: string, r: Route): boolean {
  const { source } = useDesign.getState();
  const next = routeEdit(source, block, r);
  if (next === source) return false;
  commitSource(next, "you", `${block}: ${routeText(r)}`);
  return true;
}

/** Put every part on its recommended route for one tier, as one undoable change. */
export function applyTier(plans: ManufacturingPlan[], qty: number, label: string): number {
  const { source, model } = useDesign.getState();
  if (!model) return 0;
  // later parts first, so the spans of earlier ones still match the text
  const order = plans
    .map((p) => ({ p, part: blockPart(model, p.part) }))
    .filter((x) => x.part)
    .sort((a, b) => b.part!.span.start - a.part!.span.start);
  let next = source;
  let changed = 0;
  for (const { p } of order) {
    const ti = p.tiers.findIndex((t) => t.qty === qty);
    const r = ti >= 0 ? p.tiers[ti].recommended : undefined;
    if (!r || r.current && !r.materialChange) continue;
    const after = routeEdit(next, p.part, r);
    if (after !== next) changed++;
    next = after;
  }
  if (changed) commitSource(next, "you", `${label}: ${changed} part${changed === 1 ? "" : "s"} set to the recommended way to make them`);
  return changed;
}
