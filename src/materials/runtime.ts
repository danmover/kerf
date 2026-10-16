// Adds the material checks to every report: threads in printed plastic
// straight away, creep once a part's analysis has a result, and galvanic
// corrosion once the kernel confirms that two different metals really touch
// (their boxes meeting is only a hint).

import { meshes, refreshReport } from "../core/engine";
import { registerReportPass, type ReportContext } from "../core/reportPasses";
import type { CheckItem } from "../core/checks";
import type { EvalPart, Model } from "../core/model";
import { kernel } from "../kernel/client";
import { blockPart } from "./apply";
import { analysisFacts } from "./context";
import { creepItem, galvanicItems, galvanicLimit, heldLoads, metalPairs, placedBox, threadItems, type MetalPair } from "./checks";

/** Smallest gap between two placed solids, by solid and placement; null when the kernel could not measure. */
const gaps = new Map<string, number | null>();
const queue: { key: string; pair: MetalPair }[] = [];
let measuring = false;
/** Solids closer than this touch. */
const CONTACT = 0.05;

const placement = (p: EvalPart) => `${p.hash}@${JSON.stringify(p.xf)}`;
const pairKey = (pr: MetalPair) => [placement(pr.a), placement(pr.b)].sort().join("|");

async function drain() {
  if (measuring) return;
  measuring = true;
  try {
    while (queue.length) {
      const { key, pair } = queue.shift()!;
      if (gaps.has(key)) continue;
      try {
        const r = await kernel.measure([{ hash: pair.a.hash, xf: pair.a.xf }], [{ hash: pair.b.hash, xf: pair.b.xf }]);
        gaps.set(key, r.distance);
      } catch {
        gaps.set(key, null);
      }
    }
  } finally {
    measuring = false;
  }
  refreshReport();
}

function galvanic(model: Model, ctx: ReportContext): CheckItem[] {
  const limit = galvanicLimit(model.brief);
  if (!limit) return [];
  const pairs = metalPairs(
    model,
    (p) => {
      const m = meshes.get(p.hash);
      return m && !ctx.buildErrors.has(p.hash) ? placedBox(m.bbox, p.xf) : null;
    },
    limit.volts,
  );
  const touching: MetalPair[] = [];
  let waiting = false;
  for (const pr of pairs) {
    const key = pairKey(pr);
    if (!gaps.has(key)) {
      if (!queue.some((q) => q.key === key)) queue.push({ key, pair: pr });
      waiting = true;
      continue;
    }
    const d = gaps.get(key);
    if (d !== null && d !== undefined && d < CONTACT) touching.push(pr);
  }
  if (waiting) void drain();
  if (gaps.size > 4000) gaps.clear();
  return galvanicItems(touching, limit);
}

function creep(model: Model): CheckItem[] {
  const out: CheckItem[] = [];
  for (const [name, loads] of heldLoads(model.brief)) {
    const part = blockPart(model, name);
    if (!part || part.kind !== "part") continue;
    const a = analysisFacts(model, name);
    if (!a) continue;
    const item = creepItem(model, part, loads, a);
    if (item) out.push(item);
  }
  return out;
}

function materialItems(items: CheckItem[], ctx: ReportContext): CheckItem[] {
  const out = [...items, ...threadItems(ctx.model)];
  // the live design only: these read the analysis runtime and the kernel's cached solids
  if (ctx.live) out.push(...creep(ctx.model), ...galvanic(ctx.model, ctx));
  return out;
}

let started = false;

/** Hook the material checks into the report (after the analyses, whose results creep reads). */
export function startMaterialChecks() {
  if (started) return;
  started = true;
  registerReportPass("materials", materialItems, 30);
  refreshReport();
}
