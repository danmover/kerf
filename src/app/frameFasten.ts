// Fasten a frame by hand: corner brackets (or joining plates) with their M5
// screws and T-nuts at every joint of 2020/2040 members that nothing holds
// yet, planned by the same fastener planner Claude's place_fasteners uses and
// written into the design as one undoable change. Welded sections need none.

import { useDesign, whenChecked, meshOf, kernelResult } from "../core/engine";
import { applyFastenPlan, planFasteners } from "../core/autoFasten";
import type { CheckReport } from "../core/checks";
import type { Model } from "../core/model";
import { commitSource } from "./project";
import { toast } from "./ui";

/** How many joints of this frame the checks find nothing holding together. */
export function openJoints(report: CheckReport | null | undefined, model: Model, frame: string): number {
  if (!report) return 0;
  const ids = new Set(model.parts.filter((p) => p.frame === frame).map((p) => p.id));
  return report.items.filter((i) => i.status === "fail" && i.id.startsWith("complete:joint:") && (i.parts ?? []).some((p) => ids.has(p))).length;
}

let busy = false;

/** Fastens the joints of these frames (every frame of bought extrusion when left out), as one change of yours. */
export async function fastenFrames(names?: string[]): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    // the planner measures the built members and reads where they touch
    await whenChecked(120_000);
    const { source, model } = useDesign.getState();
    if (!model) return;
    if (model.diagnostics.some((d) => d.severity === "error")) {
      toast({ kind: "error", title: "Fix the errors in the design first", detail: "The brackets go where the members are, so the design has to build." });
      return;
    }
    const frames = (model.frames ?? []).filter((f) => (names ? names.includes(f.name) : !!f.catalogId));
    const parts = frames.flatMap((f) => f.members.map((m) => m.name));
    if (!parts.length) {
      toast({ kind: "info", title: "No frame of 2020 or 2040 extrusion to fasten", detail: "Welded frames are held by their welds." });
      return;
    }
    const plan = planFasteners(model, meshOf, { parts, kernel: kernelResult() });
    const why = plan.skipped.map((s) => `${s.part}: ${s.why}`);
    if (!plan.groups.length) {
      toast(why.length ? { kind: "warn", title: `${why.length} joint${why.length > 1 ? "s" : ""} could not be fastened`, detail: why.slice(0, 3).join("\n") } : { kind: "info", title: "Every joint is already fastened" }, 8000);
      return;
    }
    const label = frames.length === 1 ? frames[0].label : `${frames.length} frames`;
    const count = (kinds: string[]) => plan.groups.filter((g) => kinds.includes(g.kind)).reduce((a, g) => a + g.at.length, 0);
    const n = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;
    const brackets = count(["bracket"]);
    const plates = count(["plate"]);
    const joins = [brackets ? n(brackets, "corner bracket") : "", plates ? n(plates, "joining plate") : ""].filter(Boolean).join(" and ");
    const what = `${joins ? `${joins} with ` : ""}${n(count(["screw"]), "screw")} into T-nuts`;
    commitSource(applyFastenPlan(source, model, plan), "you", `Fastened ${label}: ${what}`);
    toast({ kind: why.length ? "warn" : "success", title: `Fastened ${label}`, detail: [what + ".", ...(why.length ? [`Not fastened: ${why.slice(0, 2).join("; ")}`] : [])].join("\n") }, 8000);
  } finally {
    busy = false;
  }
}
