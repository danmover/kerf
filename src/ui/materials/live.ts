// Live material advice for the views: recomputed as the design, its build
// and its analyses change, previewed on the model, and applied as one
// undoable change.

import { useMemo } from "react";
import { useDesign } from "../../core/engine";
import { useAnalysis } from "../../analysis/runtime";
import { commitSource } from "../../app/project";
import { viewport } from "../../app/viewportApi";
import { FINISHES } from "../../library/materials";
import { adviseFor } from "../../materials/context";
import { blockPart, withMaterial } from "../../materials/apply";
import { processLabel, type Advice, type MaterialOption, type Need } from "../../materials/advise";
import "../../styles/materials.css";

/** The advice for a part block (or the design), recomputed as the design, its build and its analyses change. */
export function useLiveAdvice(part: string | null, needs?: Need[]): Advice | null {
  const model = useDesign((s) => s.model);
  const rev = useDesign((s) => s.reportRev);
  const runs = useAnalysis((s) => s.runs);
  const shown = useAnalysis((s) => s.shown);
  const key = needs?.join(",") ?? "";
  // rev: part volumes arrive with the build; runs and shown: the analysis the estimates scale from
  return useMemo(() => (model ? adviseFor(part, { needs, model }) : null), [part, model, rev, runs, shown, key]);
}

/** Every solid of a part block (all instances), for previews and selection. */
export const blockIds = (block: string) => (useDesign.getState().model?.parts ?? []).filter((p) => p.name === block && !p.id.startsWith(`${block}.`)).map((p) => p.id);

export function previewOption(ids: string[], o: MaterialOption | null) {
  viewport()?.preview(ids, o ? { material: o.name, finish: o.finish, color: o.color } : null);
}

/** Write an option into the design: material, finish, colour, and the process when it needs another. */
export function applyOption(block: string, o: MaterialOption): boolean {
  const { source, model } = useDesign.getState();
  if (!model || !blockPart(model, block)) return false;
  const r = withMaterial(source, model, block, { material: o.name, finish: o.finish, color: o.color, process: o.processChange?.to });
  if (r.src === source) return false;
  commitSource(r.src, "you", `${block}: ${o.label} (${FINISHES[o.finish]?.label.toLowerCase() ?? o.finish})${o.processChange ? `, made by ${processLabel(o.processChange.to)}` : ""}`);
  return true;
}

