// What the user asked for in their message, measured after every change.
//
// Before its first change for a message, Claude records each ask with
// record_asks: the user's words and, where Kerf can check it, a condition
// written as in a require statement ("wall == 3", `size(lid, "z") <= 20`) or a
// part that must stay as it is. After each change Kerf reads every condition
// against the built design and compares the parts with how they were when the
// message arrived. The result goes into the change's tool result, the chat's
// checklist and the reviewer's brief, with the parts that changed though no ask
// names them, so Claude can undo what nobody asked for.

import { z } from "zod";
import { evaluateConditions } from "../lang/evaluator";
import type { GeoQuery } from "../lang/values";
import type { Model } from "../core/model";
import type { ChecksResult } from "../kernel/protocol";

export interface Ask {
  /** the user's words, short */
  ask: string;
  /** something that must stay as it is */
  keep?: boolean;
  /** how Kerf measures it: a condition as in a require statement */
  expect?: string;
  /** for a keep: the part or component that must not change */
  part?: string;
}

/** pass and fail are measured; open is not measurable by Kerf; error means the measure itself could not be read */
export type AskStatus = "pass" | "fail" | "open" | "error";

export interface AskResult extends Ask {
  status: AskStatus;
  detail: string;
}

export interface AsksState {
  asks: Ask[];
  results: AskResult[];
  /** parts that changed since the message arrived though no ask names them */
  unasked: string[];
  /** the source the results were measured on */
  measuredOn: string | null;
  /** bumped on every record or measurement */
  version: number;
}

export const MAX_ASKS = 12;

export const ASKS_TOOL = {
  name: "record_asks",
  description:
    "Record what the user asked for in their latest message, so Kerf measures each ask after every change, shows the user a checklist and gives it to the reviewer. Call it once for each message that asks for a change, in the same response as your first change and before it. Call it again with the whole list only to correct it or when the user adds to their message while you work. Not for questions.",
  input_schema: {
    type: "object" as const,
    properties: {
      asks: {
        type: "array",
        maxItems: MAX_ASKS,
        description: "Each distinct thing the user asked for, and each thing they said must stay as it is.",
        items: {
          type: "object",
          properties: {
            ask: { type: "string", description: 'One ask in the user\'s words, short: "walls 3 mm thick", "keep the hole spacing".' },
            keep: { type: "boolean", description: "True when it is something that must stay as it is." },
            expect: {
              type: "string",
              description:
                'How Kerf measures it: a condition as in a require statement, using params, lets, part names and size(), bbox_min(), bbox_max(), min_distance(), volume(), mass(). For example wall == 3, size(lid, "z") <= 20, min_distance(clip, post) >= 0.3. Leave it out when Kerf cannot measure it (a look, a feel, a feature with no number).',
            },
            part: { type: "string", description: "For a keep: the part or component that must not change at all." },
          },
          required: ["ask"],
          additionalProperties: false,
        },
      },
    },
    required: ["asks"],
    additionalProperties: false,
  },
};

export const AsksInput = z.object({
  asks: z
    .array(
      z.object({
        ask: z.string().trim().min(1).max(200),
        keep: z.boolean().optional(),
        expect: z.string().trim().max(300).optional(),
        part: z.string().trim().max(120).optional(),
      }),
    )
    .min(1)
    .max(MAX_ASKS),
});

/** Each part or component as built: name → geometry and placement. */
type Snapshot = Map<string, string>;

export function snapshot(model: Model | null): Snapshot {
  const out = new Map<string, string[]>();
  for (const p of model?.parts ?? []) {
    const list = out.get(p.name) ?? [];
    list.push(`${p.hash}@${JSON.stringify(p.xf)}`);
    out.set(p.name, list);
  }
  return new Map([...out].map(([k, v]) => [k, v.sort().join("|")]));
}

/** Names of the parts and components that differ between two snapshots, added and removed ones included. */
export function changedParts(a: Snapshot, b: Snapshot): string[] {
  const names = new Set([...a.keys(), ...b.keys()]);
  return [...names].filter((n) => a.get(n) !== b.get(n));
}

const words = (s: string) => s.toLowerCase().replace(/_/g, " ");

/** Whether an ask names a part, in its words, its measure or its part. */
function names(a: Ask, part: string): boolean {
  const n = words(part);
  const re = new RegExp(`(^|[^a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
  return [a.ask, a.expect ?? "", a.part ?? ""].some((t) => re.test(words(t)));
}

/**
 * Everything built from what the conditions read, through lets and other parts: "wall == 3" covers the base and
 * the lid made with wall, and the board that sits on the floor it thickens.
 */
function builtFrom(model: Model | null, uses: readonly string[]): Set<string> {
  const reached = new Set(uses);
  if (!model || !uses.length) return reached;
  const next = new Map<string, string[]>();
  for (const e of model.graph.edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const todo = [...uses];
  while (todo.length)
    for (const n of next.get(todo.pop()!) ?? [])
      if (!reached.has(n)) {
        reached.add(n);
        todo.push(n);
      }
  return reached;
}

export interface MeasureInput {
  source: string;
  model: Model | null;
  /** the parts when the message arrived */
  start: Snapshot;
  /** the design had no parts when the message arrived: everything is new, so nothing counts as an unasked change */
  startEmpty: boolean;
  /** geometric quantities the conditions use, from the kernel */
  geo: (queries: GeoQuery[]) => Promise<Pick<ChecksResult, "geo" | "geoErrors">>;
}

/** Read every ask against the design. */
export async function measureAsks(asks: Ask[], i: MeasureInput): Promise<{ results: AskResult[]; unasked: string[] }> {
  const conds = asks.filter((a) => a.expect).map((a) => a.expect!);
  let read = conds.length ? evaluateConditions(i.source, conds) : { results: [], queries: [] };
  let geoErrors: Record<string, string> = {};
  if (read.queries.length && i.model) {
    try {
      const g = await i.geo(read.queries);
      geoErrors = g.geoErrors;
      read = evaluateConditions(i.source, conds, { geo: g.geo });
    } catch (e) {
      geoErrors = { kernel: e instanceof Error ? e.message : String(e) };
    }
  }
  const now = snapshot(i.model);
  let at = 0;
  const results = asks.map((a): AskResult => {
    const parts: { ok: boolean; detail: string }[] = [];
    if (a.expect) {
      const r = read.results[at++];
      if (r.error) return { ...a, status: "error", detail: r.error };
      if (r.ok === null) {
        const why = Object.values(geoErrors)[0];
        return { ...a, status: "error", detail: why ? `could not be measured: ${why}` : "could not be measured on the built design" };
      }
      parts.push({ ok: r.ok, detail: r.detail });
    }
    if (a.keep && a.part) {
      const before = i.start.get(a.part);
      const after = now.get(a.part);
      if (before === undefined) return { ...a, status: "error", detail: `there was no part named ${a.part} when the message arrived` };
      parts.push(after === undefined ? { ok: false, detail: `${a.part} is gone` } : { ok: before === after, detail: before === after ? `${a.part} unchanged` : `${a.part} changed` });
    }
    if (!parts.length) return { ...a, status: "open", detail: "not measured" };
    return { ...a, status: parts.every((p) => p.ok) ? "pass" : "fail", detail: parts.map((p) => p.detail).join("; ") };
  });
  // what a change ask's measure reads covers what is built from it; a keep's measure covers nothing
  const measured = asks.filter((a) => a.expect);
  const covered = builtFrom(i.model, read.results.flatMap((r, k) => (r.error || measured[k].keep ? [] : (r.uses ?? []))));
  const unasked = i.startEmpty || !asks.length ? [] : changedParts(i.start, now).filter((n) => !covered.has(n) && !asks.some((a) => names(a, n)));
  return { results, unasked };
}

const MARK: Record<AskStatus, string> = { pass: "✓", fail: "✗", open: "○", error: "!" };

/** The measured asks as Claude and the reviewer read them. */
export function asksText(s: Pick<AsksState, "results" | "unasked">): string {
  const lines = s.results.map((r) => {
    const what = `${MARK[r.status]} ${r.keep ? "keep: " : ""}${r.ask}`;
    if (r.status === "open") return `${what} (not measured: check it yourself)`;
    if (r.status === "error") return `${what} (cannot measure: ${r.detail}; correct its expect with record_asks)`;
    return `${what} (${r.detail})`;
  });
  if (s.unasked.length) {
    const shown = s.unasked.slice(0, 10).join(", ") + (s.unasked.length > 10 ? ` and ${s.unasked.length - 10} more` : "");
    lines.push(`Changed though no ask names them: ${shown}. Keep a change only when an ask needs it (a shared dimension); undo the rest.`);
  }
  return lines.join("\n");
}

// ---------- the asks for the message in hand ----------

let state: AsksState = { asks: [], results: [], unasked: [], measuredOn: null, version: 0 };
let start: { snap: Snapshot; empty: boolean } = { snap: new Map(), empty: true };

export const asksState = (): Readonly<AsksState> => state;

/**
 * A message arrived: what the design is now is what the asks are measured
 * against. carry keeps the asks and the starting point of the message being
 * continued (an answered question, "continue").
 */
export function beginAsks(model: Model | null, carry: boolean) {
  if (carry && state.asks.length) return;
  start = { snap: snapshot(model), empty: !model?.parts.length };
  state = { asks: [], results: [], unasked: [], measuredOn: null, version: state.version + 1 };
}

export function clearAsks() {
  start = { snap: new Map(), empty: true };
  state = { asks: [], results: [], unasked: [], measuredOn: null, version: state.version + 1 };
}

export function setAsks(asks: Ask[]) {
  state = { asks, results: asks.map((a) => ({ ...a, status: "open", detail: "not measured yet" })), unasked: [], measuredOn: null, version: state.version + 1 };
}

/** Measure the asks against the design as it is now. */
export async function remeasure(design: { source: string; model: Model | null }, geo: MeasureInput["geo"]): Promise<Readonly<AsksState>> {
  if (!state.asks.length) return state;
  const asks = state.asks;
  const r = await measureAsks(asks, { source: design.source, model: design.model, start: start.snap, startEmpty: start.empty, geo });
  // a newer record_asks replaced the list while this measured
  if (state.asks !== asks) return state;
  state = { ...state, ...r, measuredOn: design.source, version: state.version + 1 };
  return state;
}

/** The asks for the reviewer, when there are any. */
export function asksForReview(): string | undefined {
  return state.asks.length && state.measuredOn !== null ? asksText(state) : undefined;
}
