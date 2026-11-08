// The design's groups of parts (each block's group:), and what showing only
// some of them hides: say the nozzle, or the electronics, on its own.

import type { EvalPart } from "../core/model";

export interface PartGroup {
  name: string;
  ids: string[];
  /** part and component blocks in it */
  blocks: string[];
}

/** The design's groups, in the order they first appear. */
export function partGroups(parts: EvalPart[]): PartGroup[] {
  const out = new Map<string, PartGroup>();
  for (const p of parts) {
    const name = p.group || "Parts";
    let g = out.get(name);
    if (!g) out.set(name, (g = { name, ids: [], blocks: [] }));
    g.ids.push(p.id);
    if (!g.blocks.includes(p.name)) g.blocks.push(p.name);
  }
  return [...out.values()];
}

/** Solids hidden while only `groups` are shown (none: nothing is hidden). Names match any case; ones that match no group are ignored. */
export function soloHidden(parts: EvalPart[], groups: readonly string[]): string[] {
  if (!groups.length) return [];
  const want = new Set(groups.map((g) => g.toLowerCase()));
  if (!parts.some((p) => want.has((p.group || "Parts").toLowerCase()))) return [];
  return parts.filter((p) => !want.has((p.group || "Parts").toLowerCase())).map((p) => p.id);
}
