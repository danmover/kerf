// Edits to the brief from the UI. Each one rewrites the brief block in the
// source as one undoable version, and is refused when it would break the
// design (a given the parts still read, a name that clashes) so a click can
// never leave the file in an error state.

import { useDesign, evaluateOnly } from "../core/engine";
import { commitSource } from "../app/project";
import { briefData, briefHasErrors, emptyBrief, writeBrief, type BriefData } from "../core/brief";
import { toast } from "../app/ui";

export const currentBriefData = (): BriefData | null => briefData(useDesign.getState().model?.brief);

/** Apply an edit to the brief. Returns why it could not apply, or null. */
export function editBrief(fn: (d: BriefData) => void, message: string, opts: { quiet?: boolean } = {}): string | null {
  const { source, model } = useDesign.getState();
  const fail = (why: string) => {
    if (!opts.quiet) toast({ kind: "warn", title: "The brief was not changed", detail: why });
    return why;
  };
  if (briefHasErrors(source, model)) return fail("The brief has a typing error in the code. Fix it there first.");
  const d = structuredClone(briefData(model?.brief) ?? emptyBrief());
  fn(d);
  const next = writeBrief(source, model, d);
  if (next === source) return null;
  const before = new Set((model?.diagnostics ?? []).filter((x) => x.severity === "error").map((x) => x.message));
  const after = evaluateOnly(next).diagnostics.find((x) => x.severity === "error" && !before.has(x.message));
  if (after) return fail(after.message);
  commitSource(next, "you", `Brief: ${message}`);
  return null;
}

/** "12.5" → 12.5; blank or nonsense → undefined. */
export function numOrUndef(s: string): number | undefined {
  const t = s.trim().replace(",", ".");
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}
