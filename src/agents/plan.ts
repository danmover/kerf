// A parallel build plan: which subassemblies to build, what each one is for,
// and which must wait for another. Pure functions, no app state.

import { ID_RE, type SectionMeta } from "./sections";

export type SubPlan = SectionMeta;

export interface PlanCheck {
  errors: string[];
  warnings: string[];
}

/**
 * Validate the subassemblies to run against the ones already in the design.
 * `existing` are ids with a section in the source that are not being re-run;
 * depending on them is fine because their parts already exist.
 */
export function checkPlan(subs: SubPlan[], existing: string[] = []): PlanCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  if (!subs.length) errors.push("The plan has no subassemblies.");
  for (const s of subs) {
    if (!ID_RE.test(s.id)) errors.push(`"${s.id}" is not a valid id: use lower-case letters, digits and underscores, starting with a letter.`);
    if (ids.has(s.id)) errors.push(`The id "${s.id}" is used twice.`);
    ids.add(s.id);
    if (!s.name.trim()) errors.push(`Subassembly "${s.id}" needs a name.`);
    if (s.brief.trim().length < 20) warnings.push(`The brief for "${s.id}" is very short; the agent works only from the layout and this brief.`);
  }
  const known = new Set([...ids, ...existing]);
  for (const s of subs) {
    for (const d of s.after) {
      if (d === s.id) errors.push(`"${s.id}" cannot wait for itself.`);
      else if (!known.has(d)) errors.push(`"${s.id}" waits for "${d}", which is not in the plan or the design.`);
    }
  }
  if (!errors.length) {
    const cyc = findCycle(subs);
    if (cyc) errors.push(`These subassemblies wait for each other in a loop: ${cyc.join(" → ")}. Move the shared numbers into the layout instead.`);
  }
  if (subs.length > 12) warnings.push(`${subs.length} subassemblies is a lot for one run; consider grouping small ones.`);
  return { errors, warnings };
}

function findCycle(subs: SubPlan[]): string[] | null {
  const byId = new Map(subs.map((s) => [s.id, s]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const d of byId.get(id)?.after ?? []) {
      if (!byId.has(d)) continue;
      if (state.get(d) === 1) return [...stack.slice(stack.indexOf(d)), d];
      if (!state.get(d)) {
        const c = visit(d);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const s of subs) {
    if (!state.get(s.id)) {
      const c = visit(s.id);
      if (c) return c;
    }
  }
  return null;
}

/**
 * Group subassemblies into waves that can run together: each wave only waits
 * for earlier waves. Dependencies outside the plan count as already built.
 */
export function waves(subs: SubPlan[]): string[][] {
  const inPlan = new Set(subs.map((s) => s.id));
  const done = new Set<string>();
  const left = subs.slice();
  const out: string[][] = [];
  while (left.length) {
    const ready = left.filter((s) => s.after.every((d) => !inPlan.has(d) || done.has(d)));
    if (!ready.length) throw new Error("The plan has a dependency loop.");
    out.push(ready.map((s) => s.id));
    for (const s of ready) {
      done.add(s.id);
      left.splice(left.indexOf(s), 1);
    }
  }
  return out;
}

/**
 * The order sections appear in the source: a section must come after every
 * section it uses. Keeps the current order where it already works.
 */
export function sectionOrder(current: string[], deps: Map<string, string[]>): string[] {
  const all = [...current, ...[...deps.keys()].filter((k) => !current.includes(k))];
  const placed: string[] = [];
  const pending = all.slice();
  let guard = 0;
  while (pending.length && guard++ < 10_000) {
    const i = pending.findIndex((id) => (deps.get(id) ?? []).every((d) => placed.includes(d) || !all.includes(d)));
    const pick = i < 0 ? 0 : i; // a loop the plan check missed: keep going in the given order
    placed.push(pending.splice(pick, 1)[0]);
  }
  return placed;
}
