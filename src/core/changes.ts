// What changed between two versions of a design, in the user's terms.

import { evaluateOnly } from "./engine";
import { sameValue, type SetValue } from "./decisions";
import type { Model } from "./model";

export interface PartChange {
  id: string;
  label: string;
  kind: "added" | "removed" | "changed" | "moved";
}

export interface ParamChange {
  name: string;
  from?: SetValue;
  to: SetValue;
}

/** Parts that appeared, disappeared, changed shape or moved. */
export function partChanges(a: Model, b: Model): PartChange[] {
  const before = new Map(a.parts.map((p) => [p.id, p]));
  const after = new Map(b.parts.map((p) => [p.id, p]));
  const out: PartChange[] = [];
  for (const p of b.parts) {
    const q = before.get(p.id);
    if (!q) out.push({ id: p.id, label: p.label, kind: "added" });
    else if (q.hash !== p.hash) out.push({ id: p.id, label: p.label, kind: "changed" });
    else if (JSON.stringify(q.xf) !== JSON.stringify(p.xf)) out.push({ id: p.id, label: p.label, kind: "moved" });
  }
  for (const q of a.parts) if (!after.has(q.id)) out.push({ id: q.id, label: q.label, kind: "removed" });
  return out;
}

/** Parameters whose values differ. */
export function paramChanges(a: Model, b: Model): ParamChange[] {
  const out: ParamChange[] = [];
  for (const p of b.params) {
    const q = a.params.find((x) => x.name === p.name);
    if (!q) out.push({ name: p.name, to: p.value });
    else if (!sameValue(q.value, p.value)) out.push({ name: p.name, from: q.value, to: p.value });
  }
  return out;
}

const cache = new Map<string, { parts: PartChange[]; params: ParamChange[] }>();

/** Both kinds of change between two sources (cached; evaluating is cheap but not free). */
export function changesBetween(before: string, after: string) {
  const k = `${before.length}:${after.length}:${hash(before)}:${hash(after)}`;
  let c = cache.get(k);
  if (!c) {
    const a = evaluateOnly(before);
    const b = evaluateOnly(after);
    c = { parts: partChanges(a, b), params: paramChanges(a, b) };
    if (cache.size > 40) cache.clear();
    cache.set(k, c);
  }
  return c;
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
