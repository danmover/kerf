// Marks one bench case: its own expectations, plus whether the design builds
// and whether any check fails that passed before. The design and the kernel
// come in as a view, so the same marking runs in the app and in tests.

import { evaluateConditions } from "../lang/evaluator";
import type { GeoQuery } from "../lang/values";
import type { Model } from "../core/model";
import type { V3 } from "../kernel/recipe";
import type { BenchCase, Expect } from "./cases";

export interface Mark {
  label: string;
  ok: boolean;
  detail: string;
}

export interface BenchView {
  startSource: string;
  source: string;
  model: Model | null;
  /** ids of the checks failing before the message */
  startFailing: ReadonlySet<string>;
  /** the checks failing now */
  failing: { id: string; title: string }[];
  /** parts the kernel could not build */
  buildErrors: number;
  /** Claude's last reply */
  reply: string;
  /** geometric quantities and every placed part's box, from the kernel */
  measure: (queries: GeoQuery[]) => Promise<{ geo: Record<string, number>; geoErrors: Record<string, string>; boxes?: Record<string, [V3, V3]> }>;
}

const isCond = (e: Expect): e is Expect & { cond: string } => "cond" in e;

/** The marks for a case, in its order: the general ones first. */
export async function grade(c: BenchCase, v: BenchView): Promise<Mark[]> {
  const marks: Mark[] = [];
  const errors = v.model?.diagnostics.filter((d) => d.severity === "error") ?? [];
  if (c.kind === "question") {
    marks.push({ label: "Leaves the design as it was", ok: v.source === v.startSource, detail: v.source === v.startSource ? "unchanged" : "the source changed" });
  } else {
    marks.push({ label: "Changed the design", ok: v.source !== v.startSource, detail: v.source !== v.startSource ? "changed" : "nothing changed" });
    const builds = !!v.model && errors.length === 0 && v.buildErrors === 0;
    marks.push({ label: "Builds without errors", ok: builds, detail: !v.model ? "no design" : errors.length ? errors[0].message : v.buildErrors ? `${v.buildErrors} part(s) failed to build` : "builds" });
    const fresh = v.failing.filter((f) => !v.startFailing.has(f.id));
    marks.push({ label: v.startFailing.size ? "No check fails that passed before" : "No checks fail", ok: fresh.length === 0, detail: fresh.length ? fresh.slice(0, 3).map((f) => f.title).join("; ") + (fresh.length > 3 ? ` and ${fresh.length - 3} more` : "") : "none" });
  }

  // conditions, read in two passes: the second with the geometric quantities the first asked for
  const conds = c.expect.filter(isCond).map((e) => e.cond);
  let read = evaluateConditions(v.source, conds);
  let boxes: Record<string, [V3, V3]> | undefined;
  let geoErrors: Record<string, string> = {};
  const needsBoxes = c.expect.some((e) => "overall" in e);
  if (v.model && (read.queries.length || needsBoxes)) {
    try {
      const m = await v.measure(read.queries);
      boxes = m.boxes;
      geoErrors = m.geoErrors;
      if (read.queries.length) read = evaluateConditions(v.source, conds, { geo: m.geo });
    } catch (e) {
      geoErrors = { kernel: e instanceof Error ? e.message : String(e) };
    }
  }

  let at = 0;
  for (const e of c.expect) {
    if (isCond(e)) {
      const r = read.results[at++];
      if (r.error) marks.push({ label: e.label, ok: false, detail: r.error });
      else if (r.ok === null) marks.push({ label: e.label, ok: false, detail: Object.values(geoErrors)[0] ?? "could not be measured" });
      else marks.push({ label: e.label, ok: r.ok, detail: r.detail });
    } else if ("source" in e) {
      const n = (v.source.match(new RegExp(e.source.source, e.source.flags.includes("g") ? e.source.flags : e.source.flags + "g")) ?? []).length;
      const min = e.min ?? 1;
      marks.push({ label: e.label, ok: n >= min, detail: `${n} in the source` });
    } else if ("reply" in e) {
      const ok = e.reply.test(v.reply);
      marks.push({ label: e.label, ok, detail: ok ? "said" : v.reply ? `reply: ${v.reply.replace(/\s+/g, " ").slice(0, 120)}` : "no reply" });
    } else if ("parts" in e) {
      const n = new Set(v.model?.parts.map((p) => p.name) ?? []).size;
      marks.push({ label: e.label, ok: n >= (e.parts.min ?? 0) && n <= (e.parts.max ?? Infinity), detail: `${n} parts and components` });
    } else {
      const ext = overall(boxes);
      const ok = ext !== null && ext >= (e.overall.min ?? 0) && ext <= (e.overall.max ?? Infinity);
      marks.push({ label: e.label, ok, detail: ext === null ? "nothing built to measure" : `${Math.round(ext)} mm` });
    }
  }
  return marks;
}

/** The largest extent of everything built, in mm. */
export function overall(boxes: Record<string, [V3, V3]> | undefined): number | null {
  const all = Object.values(boxes ?? {});
  if (!all.length) return null;
  const lo = [0, 1, 2].map((k) => Math.min(...all.map((b) => b[0][k])));
  const hi = [0, 1, 2].map((k) => Math.max(...all.map((b) => b[1][k])));
  return Math.max(...[0, 1, 2].map((k) => hi[k] - lo[k]));
}
