// When Kerf reviews a change on its own, without Claude asking for it.

import { diffStats } from "../../core/sourceEdit";

/** Block names that appear in only one of two sources: parts or components added or removed. */
function blockNames(src: string) {
  return new Set([...src.matchAll(/^\s*(?:part|component)\s+([A-Za-z_]\w*)/gm)].map((m) => m[1]));
}

/** A change big enough to review on "Big changes": a new design, parts added or removed, or a dozen changed lines. */
export function isSubstantial(before: string, after: string): boolean {
  if (!before.trim()) return true;
  const st = diffStats(before, after);
  if (st.added + st.removed >= 12) return true;
  const a = blockNames(before);
  const b = blockNames(after);
  return a.size !== b.size || [...a].some((n) => !b.has(n));
}

