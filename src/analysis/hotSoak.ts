// Hot soak: what a design left in a hot place (a car in the sun, a loft, a
// window) goes through that the other checks do not cover. Materials
// softening against the brief's temperature are a brief check, fits at
// temperature are in the real-world fit; this pass adds latches that lose
// their grip as the plastic relaxes, batteries past their limits, and a
// nudge when the brief says "car" but its temperatures stop short of one.

import type { CheckItem } from "../core/checks";
import type { Model } from "../core/model";
import { materialRecord } from "../library/materialDb";
import type { ReportContext } from "../core/reportPasses";

/** Above this the pass runs; below it nothing here changes. */
const HOT = 45;
/** A car parked in the sun: 60 to 80 °C inside, more on the dashboard. */
const CAR_HOT = 70;
/** Plastics held bent this close to their softening point relax and take a set. */
const RELAX_WITHIN = 25;
/** Lithium cells: no charging above 45 °C, and damage (swelling, venting) above 60 °C. */
const CHARGE_MAX = 45;
const BATTERY_MAX = 60;

const CAR = /\b(car|cars|vehicle|dashboard|dash|van|truck|lorry|boot|trunk|glovebox|camper|caravan)\b/i;

function briefText(m: Model): string {
  const b = m.brief;
  if (!b) return "";
  return [b.purpose, b.setting, ...b.exposure, ...b.uses.map((u) => u.text)].filter(Boolean).join(" ");
}

/** Plastics that would hold a latch at this temperature, in the order people usually reach for them. */
function hotterPlastics(hi: number, not: string): string[] {
  return ["PETG", "ASA", "Nylon", "PC"].filter((n) => n !== not && (materialRecord(n)?.maxC ?? 0) >= hi + RELAX_WITHIN);
}

export function hotSoakChecks(model: Model): CheckItem[] {
  const out: CheckItem[] = [];
  const b = model.brief;
  const hi = b?.temp?.[1];
  const car = CAR.test(briefText(model));
  if (b && car && (hi === undefined || hi < 60)) {
    out.push({
      id: "knocks:hot-car",
      category: "knocks",
      status: "warn",
      basis: "parameters",
      title: "Hot car: the brief's temperatures stop short",
      detail: `The brief puts it in a vehicle, and a car parked in the sun reaches 60 to 80 °C inside (more on the dashboard), but the brief ${hi === undefined ? "gives no temperatures" : `stops at ${hi} °C`}. The material, fit and latch checks only allow for the temperatures in the brief.`,
      fix: `Set temp: -20C .. ${CAR_HOT}C in the brief so every check allows for a parked car, or say in the brief where it is kept instead.`,
      span: b.span,
      parts: [],
    });
  }
  if (hi === undefined || hi < HOT) return out;

  let found = 0;
  // latches and flexures held bent: the plastic relaxes near its softening point and the latch loosens
  for (const p of model.parts) {
    if (!p.flex?.length) continue;
    const r = materialRecord(p.material);
    if (!r || r.category === "metal" || hi <= r.maxC - RELAX_WITHIN) continue;
    for (const f of p.flex) {
      const held = f.kind === "snap" ? (f.preload ?? 0) > 0 : false;
      if (!held) continue;
      found++;
      const better = hotterPlastics(hi, r.name);
      out.push({
        id: `knocks:relax:${p.id}:${f.name}`,
        category: "knocks",
        status: hi > r.maxC ? "fail" : "warn",
        basis: "calculation",
        title: `Hot soak: ${p.label}'s ${f.name} loosens at ${hi} °C`,
        detail: `It stays bent ${f.preload} mm once latched. At ${hi} °C, ${hi > r.maxC ? "past" : `within ${RELAX_WITHIN} °C of`} ${r.label}'s ${r.maxC} °C softening point, a plastic held bent relaxes and takes a set, so the latch comes back from the heat loose${hi > r.maxC ? " or lets go" : ""}.`,
        fix: `Latch with no preload (preload: 0) and take up the slack with a rib or a foam pad${better.length ? `, or make ${p.label} from ${better.slice(0, 2).join(" or ")}` : ""}.`,
        span: f.span,
        parts: [p.id],
      });
    }
  }

  // batteries
  for (const c of model.machine?.components ?? []) {
    if (c.kind !== "battery" || hi <= CHARGE_MAX) continue;
    found++;
    const part = model.parts.find((p) => p.name === c.name);
    const over = hi > BATTERY_MAX;
    out.push({
      id: `knocks:battery:${c.name}`,
      category: "knocks",
      status: over ? "fail" : "warn",
      basis: "parameters",
      title: `Hot soak: ${c.label} at ${hi} °C`,
      detail: over
        ? `Lithium cells are damaged above about ${BATTERY_MAX} °C: they lose capacity for good, swell, and can vent or catch fire. ${hi} °C is past that.`
        : `Lithium cells must not charge above about ${CHARGE_MAX} °C (most chargers stop, and charging hot ages them fast). Up to ${BATTERY_MAX} °C they survive being stored.`,
      fix: over ? "Keep the battery out of the heat (take it out, or store the device elsewhere), or choose a cell rated for it." : "Do not charge it while hot; let it cool first (a charger with a temperature cut-off does this).",
      span: part?.span ?? b!.span,
      parts: part ? [part.id] : [],
    });
  }

  if (!found)
    out.push({
      id: "knocks:hot",
      category: "knocks",
      status: "pass",
      basis: "parameters",
      title: `Hot soak: holds up at ${hi} °C`,
      detail: `No latch is held bent in a plastic near its softening point and no battery is past its limits at ${hi} °C. Materials against the brief's temperature are under the brief checks, and fits at ${hi} °C under real-world fit.`,
      span: b!.span,
      parts: [],
    });
  return out;
}

export function hotSoakItems(items: CheckItem[], ctx: Pick<ReportContext, "model">): CheckItem[] {
  return [...items, ...hotSoakChecks(ctx.model)];
}
