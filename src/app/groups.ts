// Putting parts into a named group (`group: "Nozzle"` on each block), so the
// view can show a group on its own, hide it or colour it, and the parts list
// gathers it under one heading. One source edit, so it is one undo.

import type { Model } from "../core/model";
import { setBlockProps } from "../core/sourceEdit";
import { parse } from "../lang/parser";

/** A group name as the source writes it: trimmed, one line, at most 60 characters. */
export function cleanGroupName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 60);
}

/**
 * The source with each block's group set. Blocks are part or component
 * names; a solid's id (screw#2, battery.wrap) counts as its block. Returns the
 * blocks it changed and the ones it could not (not top-level blocks, e.g. made
 * in a loop, or not in the design).
 */
export function withGroup(src: string, model: Model, blocks: string[], group: string): { src: string; changed: string[]; missing: string[] } {
  const name = cleanGroupName(group);
  const wanted = [...new Set(blocks.map((b) => model.parts.find((p) => p.id === b)?.name ?? b))];
  const top = new Set(parse(src).program.stmts.flatMap((s) => (s.k === "part" || s.k === "component" ? [s.name] : [])));
  const changed: string[] = [];
  const missing: string[] = [];
  let out = src;
  for (const b of wanted) {
    if (!top.has(b)) {
      missing.push(b);
      continue;
    }
    if (model.parts.filter((p) => p.name === b).every((p) => p.group === name)) continue;
    out = setBlockProps(out, b, { group: JSON.stringify(name) });
    changed.push(b);
  }
  return { src: out, changed, missing };
}
