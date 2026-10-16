// Checks that come from the brief: each use is covered by requirements, the
// materials suit the temperatures, sunlight and wet conditions it names, and
// the whole design stays inside its size and mass limits. The brief's process
// and build volume become each part's process (mfg/spec applyDefaultProcess),
// so the manufacturing checks cover the printer bed and material choice.

import type { CheckItem, CheckStatus } from "./checks";
import type { Brief, EvalPart, Model } from "./model";
import { xformMatrix, type V3, type Xform } from "../kernel/recipe";
import { materialDensity } from "../library/standards";
import { MATERIAL_SERVICE } from "../library/materialService";
import { resolveFinish } from "../library/materials";
import { adviseMaterials } from "../materials/advise";
import { briefFacts } from "../materials/brief";
import { loadText, processInfo } from "./brief";
import { fmtNum } from "../lang/values";

export interface PartGeom {
  /** mm³ */
  volume: number;
  /** in the part's own frame, before placement */
  bbox: [V3, V3];
}

export type GeomLookup = (hash: string) => PartGeom | undefined;

const ORDER: Record<CheckStatus, number> = { fail: 0, warn: 1, pending: 2, pass: 3, info: 4 };
const worst = (xs: CheckStatus[]) => xs.reduce<CheckStatus>((w, s) => (ORDER[s] < ORDER[w] ? s : w), "pass");

function worldBox(b: [V3, V3], xf: Xform[]): [V3, V3] {
  const m = xformMatrix(xf);
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? b[1][0] : b[0][0];
    const y = i & 2 ? b[1][1] : b[0][1];
    const z = i & 4 ? b[1][2] : b[0][2];
    const q = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], q[k]);
      hi[k] = Math.max(hi[k], q[k]);
    }
  }
  return [lo, hi];
}

export interface AssemblyStats {
  /** overall extent along X, Y and Z in mm */
  size?: V3;
  /** grams */
  mass?: number;
  heaviest: { label: string; mass: number }[];
  /** false while some parts have no geometry yet */
  complete: boolean;
}

/** Overall size and mass of the visible design from built geometry. */
export function assemblyStats(model: Model, geom: GeomLookup): AssemblyStats {
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  let mass = 0;
  let complete = true;
  let any = false;
  const byName = new Map<string, number>();
  for (const p of model.parts) {
    if (p.hidden) continue;
    const g = geom(p.hash);
    if (!g) {
      complete = false;
      continue;
    }
    any = true;
    const [a, b] = worldBox(g.bbox, p.xf);
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], a[k]);
      hi[k] = Math.max(hi[k], b[k]);
    }
    const m = (g.volume / 1000) * materialDensity(p.material);
    mass += m;
    byName.set(p.label, (byName.get(p.label) ?? 0) + m);
  }
  const heaviest = [...byName.entries()].map(([label, m]) => ({ label, mass: m })).sort((a, b) => b.mass - a.mass);
  if (!any) return { heaviest: [], complete: false };
  return { size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], mass, heaviest, complete };
}

const made = (model: Model) => model.parts.filter((p) => p.kind === "part" && !p.hidden);

function byMaterial(parts: EvalPart[]) {
  const m = new Map<string, EvalPart[]>();
  for (const p of parts) m.set(p.material, [...(m.get(p.material) ?? []), p]);
  return m;
}

const names = (parts: EvalPart[]) => [...new Set(parts.map((p) => p.name))].join(", ");
const mm = (v: number) => fmtNum(v, 1);

export function briefChecks(model: Model, reqItems: CheckItem[], geom: GeomLookup): CheckItem[] {
  const b = model.brief;
  if (!b) return [];
  const out: CheckItem[] = [];
  const span = b.span;
  out.push(...useChecks(b, model, reqItems));
  out.push(...materialChecks(b, model));
  out.push(...limitChecks(b, model, geom));
  for (const g of b.givens) {
    if (g.usedBy.length) continue;
    out.push({ id: `given:${g.name}`, category: "brief", status: "warn", title: `The design uses ${g.name}`, detail: `${g.name} = ${g.text} is in the brief, but nothing in the design reads it yet`, span: g.span, basis: "parameters" });
  }
  for (const i of out) i.span ??= span;
  return out;
}

/**
 * A use's status from the checks that serve it. Requirements are linked here;
 * later report passes (simulations) link their own items through the same call.
 */
export function useVerdict(id: string, linked: CheckItem[]): Pick<CheckItem, "status" | "detail" | "basis"> {
  if (!linked.length) return { status: "warn", detail: `No check covers this use yet. Add a requirement or a scenario with “for ${id}”, or ask Claude to.`, basis: "parameters" };
  const status = worst(linked.map((i) => (i.status === "info" ? "pass" : i.status)));
  // failures first, and warnings (often only the pessimistic run of a simulation) counted apart from them
  const fails = linked.filter((i) => i.status === "fail");
  const warns = linked.filter((i) => i.status === "warn");
  const counted = [fails.length ? `${fails.length} ${fails.length === 1 ? "fails" : "fail"}` : "", warns.length ? `${warns.length} ${warns.length === 1 ? "warns" : "warn"}` : ""].filter(Boolean).join(" and ");
  const detail =
    status === "pass"
      ? `${linked.length === 1 ? "Its check passes" : `All ${linked.length} of its checks pass`}: ${linked.map((i) => i.title).join("; ")}`
      : status === "pending"
        ? `Measuring ${linked.filter((i) => i.status === "pending").length} of ${linked.length} checks`
        : `${linked.length === 1 ? "Its check" : `Of its ${linked.length} checks, ${counted}`}${linked.length === 1 ? (fails.length ? " fails" : " warns") : ""}: ${[...fails, ...warns].map((i) => `${i.title} (${i.detail})`).join("; ")}`;
  const basis = linked.some((i) => i.basis === "geometry") ? "geometry" : linked.some((i) => i.basis === "virtual test") ? "virtual test" : "parameters";
  return { status, detail, basis };
}

/** Each use is covered by the requirements that name it; loads also need analysis. */
function useChecks(b: Brief, model: Model, reqItems: CheckItem[]): CheckItem[] {
  const out: CheckItem[] = [];
  for (const u of b.uses) {
    const labels = model.requirements.filter((r) => r.uses.includes(u.id)).map((r) => r.label);
    const linked = reqItems.filter((i) => labels.includes(i.title));
    const parts = u.on ? model.parts.filter((p) => p.name === u.on).map((p) => p.id) : undefined;
    const base = { id: `use:${u.id}`, category: "brief" as const, title: u.text, parts, span: u.span, uses: [u.id] };
    out.push({ ...base, ...useVerdict(u.id, linked) });
    if (u.load !== undefined) {
      out.push({
        id: `use-load:${u.id}`,
        category: "info",
        status: "info",
        title: `Strength under ${loadText(u)}`,
        detail: `From the use “${u.text}”${u.cycles ? `, ${u.cycles} times` : ""}. Geometry checks do not prove strength: run a stress check or load-test a printed part.`,
        parts,
        span: u.span,
        basis: "needs analysis",
      });
    }
  }
  return out;
}

function materialChecks(b: Brief, model: Model): CheckItem[] {
  const out: CheckItem[] = [];
  const groups = byMaterial(made(model));
  const sun = b.outdoor === true || b.exposure.some((e) => /sun|uv/i.test(e));
  const wet = b.outdoor === true || b.exposure.some((e) => /rain|water|humid|wet|salt/i.test(e));
  const impact = b.exposure.some((e) => /impact|drop/i.test(e));
  const food = b.exposure.some((e) => /food/i.test(e));
  const facts = briefFacts(b);
  for (const [mat, parts] of groups) {
    const svc = MATERIAL_SERVICE[mat];
    const ids = parts.map((p) => p.id);
    const span = parts[0].span;
    // materials that do better on one condition, made the way these parts are, best overall first
    let ranked: ReturnType<typeof adviseMaterials> | null = null;
    const better = (key: string) => {
      ranked ??= adviseMaterials({ brief: facts && { ...facts, process: parts[0].process?.id ?? facts.process } });
      return ranked.options.filter((o) => o.name !== mat && !o.otherWay && o.verdict !== "unsuitable" && o.criteria.some((k) => k.key === key && k.grade === "good")).map((o) => o.name);
    };
    if (b.temp) {
      const [lo, hi] = b.temp;
      const title = `${mat} handles ${fmtNum(lo, 1)} to ${fmtNum(hi, 1)} °C`;
      if (!svc) out.push({ id: `brief-temp:${mat}`, category: "brief", status: "info", title, detail: `No temperature data for ${mat}. Check its datasheet against the brief.`, parts: ids, span, basis: "parameters" });
      else {
        const hotter = hi > svc.maxC - 10 ? better("heat") : [];
        let status: CheckStatus = "pass";
        let detail = `${mat} is good to about ${svc.maxC} °C and stays tough down to ${svc.minC} °C (${names(parts)})`;
        if (hi > svc.maxC) {
          status = "fail";
          detail = `${mat} softens around ${svc.maxC} °C, below the ${fmtNum(hi, 1)} °C in the brief (${names(parts)}).${hotter.length ? ` ${hotter.slice(0, 2).join(" or ")} would hold up.` : ""}`;
        } else if (hi > svc.maxC - 10) {
          status = "warn";
          detail = `${mat} softens around ${svc.maxC} °C, within 10 °C of the ${fmtNum(hi, 1)} °C in the brief. Loaded parts may creep.${hotter.length ? ` ${hotter[0]} leaves more margin.` : ""}`;
        } else if (lo < svc.minC) {
          status = "warn";
          detail = `${mat} turns brittle below about ${svc.minC} °C, and the brief goes down to ${fmtNum(lo, 1)} °C (${names(parts)})`;
        }
        out.push({ id: `brief-temp:${mat}`, category: "brief", status, title, detail, parts: ids, span, margin: svc.maxC - hi, basis: "parameters" });
      }
    }
    if (sun && svc) {
      const sunny = svc.sunlight === "poor" ? better("sun") : [];
      out.push({
        id: `brief-sun:${mat}`,
        category: "brief",
        status: svc.sunlight === "poor" ? "warn" : "pass",
        title: `${mat} holds up in sunlight`,
        detail:
          svc.sunlight === "poor"
            ? `${mat} fades and turns brittle in sunlight (${names(parts)}).${sunny.length ? ` ${sunny.slice(0, 2).join(" or ")} ${sunny.length > 1 ? "last" : "lasts"} longer outside.` : " Paint it or keep it shaded."}`
            : svc.sunlight === "fair"
              ? `${mat} is fair in sunlight; a UV-stable or dark colour lasts longer`
              : `${mat} resists sunlight well`,
        parts: ids,
        span,
        basis: "parameters",
      });
    }
    if (wet && svc?.wet) {
      // a coating that keeps water off the metal turns the warning into a note about keeping it intact
      const coat = [...new Set(parts.map((p) => resolveFinish(p.material, p.finish)))];
      const sealed = coat.length === 1 && ["anodized", "powder-coated", "zinc-plated"].includes(coat[0]);
      out.push({ id: `brief-wet:${mat}`, category: "brief", status: sealed ? "pass" : "warn", title: `${mat} copes with getting wet`, detail: sealed ? `${svc.wet}; the ${coat[0].replace("-", " ")} finish protects it while it is intact (${names(parts)})` : `${svc.wet} (${names(parts)})`, parts: ids, span, basis: "parameters" });
    }
    if (impact && svc?.impact) {
      const tough = better("impact");
      out.push({ id: `brief-impact:${mat}`, category: "brief", status: "warn", title: `${mat} survives impacts`, detail: `${svc.impact} (${names(parts)}).${tough.length ? ` ${tough.slice(0, 2).join(" or ")} ${tough.length > 1 ? "are" : "is"} tougher.` : ""}`, parts: ids, span, basis: "parameters" });
    }
  }
  if (food && processInfo(b.process)?.print) {
    out.push({ id: "brief-food", category: "brief", status: "warn", title: "Safe for food contact", detail: "Printed layer lines trap food and bacteria. Seal the surface with a food-safe coating, or keep printed parts away from food.", basis: "parameters" });
  }
  return out;
}

function limitChecks(b: Brief, model: Model, geom: GeomLookup): CheckItem[] {
  if (!b.maxSize && !b.maxMass) return [];
  const stats = assemblyStats(model, geom);
  const out: CheckItem[] = [];
  if (b.maxSize) {
    const lim = b.maxSize;
    const title = `Fits within ${lim.map(mm).join(" × ")} mm`;
    if (!stats.size) out.push({ id: "brief-size", category: "brief", status: "pending", title, detail: "Waiting for the geometry", basis: "geometry" });
    else {
      const s = stats.size;
      const over = [0, 1, 2].filter((k) => s[k] > lim[k] + 1e-6);
      const margin = Math.min(...[0, 1, 2].map((k) => lim[k] - s[k]));
      out.push({
        id: "brief-size",
        category: "brief",
        status: over.length ? "fail" : "pass",
        title,
        detail: `Now ${s.map(mm).join(" × ")} mm${over.length ? `: ${over.map((k) => `${"XYZ"[k]} is ${mm(s[k] - lim[k])} mm over`).join(", ")}` : ""}`,
        margin,
        basis: "geometry",
      });
    }
  }
  if (b.maxMass) {
    const title = `Weighs at most ${fmtNum(b.maxMass, 1)} g`;
    if (stats.mass === undefined) out.push({ id: "brief-mass", category: "brief", status: "pending", title, detail: "Waiting for the geometry", basis: "geometry" });
    else {
      const top = stats.heaviest.slice(0, 3).map((h) => `${h.label} ${fmtNum(h.mass, 1)} g`).join(", ");
      out.push({
        id: "brief-mass",
        category: "brief",
        status: stats.mass > b.maxMass ? "fail" : "pass",
        title,
        detail: `Now ${fmtNum(stats.mass, 1)} g${top ? ` (heaviest: ${top})` : ""}`,
        margin: b.maxMass - stats.mass,
        basis: "geometry",
      });
    }
  }
  return out;
}
