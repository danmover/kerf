// The springs and clips checks: every coil spring (lib.spring), snap hook
// and flexure, worked out by the book. A spring gets its rate, forces,
// stress, coil bind, buckling and fatigue; a snap hook its strain (with the
// print's layers), its push-in and pull-out forces, and whether it latches
// tight or goes slack once real parts are a little off; a flexure its
// stiffness, load and strain over its cycles. Pure, so it runs everywhere.

import type { CheckItem, CheckStatus } from "../../core/checks";
import type { EvalPart, FlexInfo, Model } from "../../core/model";
import { vdot, vnorm, type V3 } from "../../kernel/recipe";
import { materialRecord } from "../../library/materialDb";
import { isPrinted } from "../../library/materials";
import { flexCalc, springCalc, strainLimit, wireGradeOf } from "../../library/springs";
import { positionSigma, sourceOf } from "../fits/scatter";

const n1 = (x: number) => String(Math.round(x * 10) / 10);
const n2 = (x: number) => String(Math.round(x * 100) / 100);
const pc = (x: number) => `${n1(x * 100)} %`;
const big = (x: number) => (x >= 1e6 ? `${n1(x / 1e6)} million` : x.toLocaleString("en"));

/** How much of the material's strain an arm keeps when printed: its layers run across the arm when it rises along the build direction. */
function layerFactor(p: EvalPart, f: FlexInfo): { factor: number; across: boolean } {
  const fdm = p.process ? p.process.id === "fdm" : isPrinted(p.material);
  if (!fdm) return { factor: 1, across: false };
  const s = p.process?.settings ?? {};
  const build = Array.isArray(s.build) && typeof s.build[0] === "number" ? vnorm(s.build as V3) : ([0, 0, 1] as V3);
  // a clip's spine runs across its arm, the way the catch faces, and bends as hard
  const across = Math.abs(vdot(vnorm(f.dir), build)) > 0.7 || (!!f.frame && Math.abs(vdot(vnorm(f.facing), build)) > 0.7);
  return { factor: across ? (materialRecord(p.material)?.mech.layerFactor ?? 0.6) : 1, across };
}

function worst(...s: CheckStatus[]): CheckStatus {
  return s.includes("fail") ? "fail" : s.includes("warn") ? "warn" : "pass";
}

function snapItem(p: EvalPart, f: FlexInfo): CheckItem {
  const { factor, across } = layerFactor(p, f);
  const r = flexCalc(f, p.material, factor);
  const cycles = f.cycles ?? 10;
  const plain = strainLimit(p.material, cycles);
  const problems: string[] = [];
  const fixes: string[] = [];
  let status: CheckStatus = "pass";
  let detail = `Bends ${pc(r.strain)} passing its ${n2(f.deflection)} mm catch${f.frame ? `, its ${n1(f.frame)} mm spine bending with it` : ""}; ${p.material} takes about ${pc(plain)} for ${big(cycles)} snap${cycles === 1 ? "" : "s"}`;
  detail += across ? `, and ${pc(r.limit)} printed with its layers across the ${f.frame ? "clip" : "arm"}.` : ".";
  if (r.strain > r.limit) {
    status = "fail";
    problems.push(across && r.strain <= plain ? "it breaks along a layer line when pushed in" : "it cracks or bends for good when pushed in");
    fixes.push(
      across && r.strain <= plain
        ? `print the part so the ${f.frame ? "clip" : "arm"} lies along the bed (its layers then run along the ${f.frame ? "clip" : "arm"})`
        : f.frame
          ? "make the spine longer or thinner, or give it a shallower catch"
          : `make the arm longer (strain falls with length²: about ${n1(f.length * Math.sqrt(r.strain / r.limit) + 0.5)} mm), thinner, or give it a shallower catch`,
    );
  }
  const push = r.push!;
  detail += ` Push-in force about ${n1(push)} N on its ${f.leadIn ?? 30}° lead-in`;
  if (f.peg) {
    // a round peg in a hole lets go only when the peg shears off (or the hole tears): shear strength ≈ 0.6 × yield
    const m = materialRecord(p.material);
    const shear = m ? 0.6 * m.mech.yield * ((Math.PI * f.peg * f.peg) / 4) : NaN;
    detail += `; its Ø${n2(f.peg)} mm peg clicks into the hole and holds until it shears${Number.isFinite(shear) ? ` at about ${n1(shear)} N` : ""}, or the hole tears.`;
  } else detail += Number.isFinite(r.pull!) ? `; it pulls apart at about ${n1(r.pull!)} N on its ${f.retain}° catch face.` : "; its square catch does not let go without a tool.";
  if (push > 50) {
    status = worst(status, "warn");
    problems.push("it is hard to push together by hand (over 50 N)");
    fixes.push("use a longer or thinner arm, or a shallower lead-in");
  }
  // once latched: the catch sits on the other part's ledge, and both are a little off along the arm
  const sigma = Math.SQRT2 * positionSigma(sourceOf(p), f.length);
  const play = 3 * sigma;
  const retain = f.retain ?? 90;
  const preload = f.preload ?? 0;
  const takeUp = retain >= 89.9 ? 0 : preload / Math.tan((retain * Math.PI) / 180);
  if (preload > 0) {
    const m = materialRecord(p.material);
    const creep = m?.creepLimit !== undefined && m.mech.E ? m.creepLimit * (m.mech.yield / m.mech.E) : Infinity;
    if (takeUp < play) {
      // share of builds whose ledges sit further apart than the sloped catch can take up
      const z = takeUp / sigma;
      const slack = 0.5 * erfc(z / Math.SQRT2);
      if (slack >= 0.01) {
        status = worst(status, "warn");
        problems.push(`it goes slack in ${pc(slack)} of builds: the catch takes up ${n2(takeUp)} mm but the parts come out up to ${n2(play)} mm off`);
        fixes.push(retain >= 89.9 ? "slope the catch face (retain: 45) so the preload pulls the parts together" : `give it more preload (about ${n2(play * Math.tan((retain * Math.PI) / 180))} mm)`);
      } else detail += ` Latched, its preload and ${retain}° catch face take up the ${n2(play)} mm the parts can be off, so it stays tight.`;
    } else detail += ` Latched, its preload and ${retain}° catch face take up the ${n2(play)} mm the parts can be off, so it stays tight.`;
    if (r.holdStrain > creep) {
      status = worst(status, "warn");
      problems.push(`held bent at ${pc(r.holdStrain)}, ${p.material} creeps and the latch goes slack over months`);
      fixes.push("reduce the preload or lengthen the arm");
    }
  } else detail += ` Latched with no preload, it has up to ${n2(play)} mm of play along the arm (slope the catch face and give it preload to latch tight).`;
  // the catch must still overlap its ledge when the parts are off sideways
  const side = 3 * Math.SQRT2 * positionSigma(sourceOf(p), f.length / 2);
  if (f.deflection - preload < side + 0.15) {
    status = worst(status, "warn");
    problems.push(`its ${n2(f.deflection - preload)} mm of catch can slip off a ledge that is up to ${n2(side)} mm off sideways`);
    fixes.push("make the catch deeper");
  }
  if (problems.length) detail += ` Watch out: ${problems.join("; ")}.`;
  return {
    id: `spring:${p.id}:${f.name}`,
    category: "springs",
    basis: "calculation",
    status,
    title: `Snap fit ${f.name} on ${p.name}`,
    detail,
    parts: [p.id],
    span: f.span,
    margin: r.limit / r.strain,
    fix: fixes.length ? fixes.map((s, i) => (i ? s : s[0].toUpperCase() + s.slice(1))).join("; ") + "." : undefined,
  };
}

function flexureItem(p: EvalPart, f: FlexInfo, model?: Model): CheckItem {
  const { factor, across } = layerFactor(p, f);
  const r = flexCalc(f, p.material, factor);
  const cycles = f.cycles ?? 1000;
  const hinge = f.angle !== undefined;
  let detail = hinge
    ? `Living hinge ${n2(f.t)} mm thick and ${n2(f.length)} mm long, bent ${n1(f.angle!)}°: stiffness ${n1(r.stiffness!)} N·mm/rad, ${n1(r.load!)} N·mm at full bend.`
    : `Blade ${n2(f.t)} × ${n2(f.w)} mm, ${n2(f.length)} mm long, moved ${n2(f.deflection)} mm: ${n2(r.stiffness!)} N/mm, ${n1(r.load!)} N at full travel.`;
  detail += ` It strains ${pc(r.strain)}; ${p.material} takes about ${pc(r.limit)} ${hinge && r.limit >= 0.2 ? "folded as a living hinge" : `over ${big(cycles)} cycles`}${across ? " printed with its layers across the blade" : ""}.`;
  if (f.peg && !hinge) {
    // a pin held in a hole on both sides of what it holds lets go only when it shears through twice: 2 × 0.6 × yield × area
    const m = materialRecord(p.material);
    const shear = m ? 2 * 0.6 * m.mech.yield * ((Math.PI * f.peg * f.peg) / 4) : NaN;
    // a cantilever's deflection at a from its root, for its tip moved δ: δ a²(3L − a) / 2L³
    const a = f.pinAt ?? f.length;
    const back = (f.deflection * a * a * (3 * f.length - a)) / (2 * f.length ** 3);
    detail += ` Its Ø${n2(f.peg)} mm pin, ${n2(a)} mm from the root, stands ${n2(f.reach ?? 0)} mm out of the blade; full travel draws it back ${n2(back)} mm. Held on both sides of what it goes through, it lets go only by shearing twice${Number.isFinite(shear) ? `, at about ${n1(shear)} N` : ""}.`;
  }
  let status: CheckStatus = "pass";
  let fix: string | undefined;
  if (f.preload && !hinge) {
    // drawn unbent where it presses on its mate: it stays bent by the preload, so it pushes with k × preload for good,
    // and a plastic held strained creeps (relaxes) unless the strain is small
    const m = materialRecord(p.material);
    const creep = m?.creepLimit !== undefined && m.mech.E ? m.creepLimit * (m.mech.yield / m.mech.E) : Infinity;
    detail += ` Bent ${n2(f.preload)} mm pressing on ${f.against}, it pushes on it with about ${n1(r.stiffness! * f.preload)} N, held at ${pc(r.holdStrain)} strain`;
    if (r.holdStrain > creep) {
      status = "warn";
      detail += `, more than the ${pc(creep)} ${p.material} holds for good: it creeps and the squeeze fades over months.`;
      fix = "Make the blade longer or thinner, or give it less preload, so it holds less strain.";
    } else detail += Number.isFinite(creep) ? `, under the ${pc(creep)} ${p.material} holds for good without creeping.` : ".";
    if (model && !model.parts.some((q) => q.name === f.against)) {
      status = "warn";
      detail += ` No part is called ${f.against}, so its overlap with what it presses on is checked as a clash.`;
      fix = "Name the part the blade presses on in against:, as it is called in the design.";
    }
  }
  if (r.strain > r.limit) {
    status = "fail";
    detail += hinge ? " It cracks at the fold." : " It cracks or takes a set.";
    fix = across
      ? "Print the part so the blade lies along the bed, make it thinner, or longer."
      : hinge
        ? `Make it thinner or longer (strain is t·θ / 2L)${(materialRecord(p.material)?.mech.elongation ?? 0) >= 100 ? "" : ", or make the part in PP or TPU, which make hinges that last"}.`
        : `Make it longer (strain falls with length²) or thinner.`;
  } else if (r.strain > 0.8 * r.limit) {
    status = "warn";
    detail += " Little margin.";
    fix = fix ?? "Make it a little longer or thinner.";
  }
  return { id: `spring:${p.id}:${f.name}`, category: "springs", basis: "calculation", status, title: `${hinge ? "Living hinge" : "Flexure"} ${f.name} on ${p.name}`, detail, parts: [p.id], span: f.span, margin: r.limit / r.strain, fix };
}

function springItem(p: EvalPart): CheckItem {
  const s = p.spring!;
  const r = springCalc(s, p.material);
  const grade = wireGradeOf(p.material);
  const problems: string[] = [];
  const fixes: string[] = [];
  let status: CheckStatus = "pass";
  let detail = `${grade.label[0].toUpperCase()}${grade.label.slice(1)}, Ø${n2(s.d)} mm wire, OD ${n2(s.od)} mm, ${n1(s.coils)} active coils: rate ${n2(r.k)} N/mm. `;
  detail += `${s.installed < s.free ? `Preload ${n1(r.preload)} N at ${n2(s.installed)} mm` : "No preload when assembled"}, ${n1(r.force)} N at its working length of ${n2(s.working)} mm (solid at ${n2(r.solid)} mm). `;
  detail += `Stress ${Math.round(r.tauWorking)} MPa at working length; the wire takes ${Math.round(r.Ssy)} MPa before it sets.`;
  if (s.working <= r.solid + 1e-6) {
    status = "fail";
    problems.push("it goes solid (coil bind) before reaching its working length");
    fixes.push("use fewer coils, thinner wire or a longer spring");
  } else if (s.working - r.solid < 0.15 * (s.free - s.working)) {
    status = worst(status, "warn");
    problems.push(`only ${n2(s.working - r.solid)} mm above solid at working length, less than the 15 % of travel springs need to stay off coil bind`);
    fixes.push("leave more room above solid");
  }
  if (r.tauWorking > r.Ssy) {
    status = "fail";
    problems.push("it takes a permanent set (shortens) at its working length");
    fixes.push("use thicker wire, a larger diameter or more coils to lower the stress");
  } else if (r.tauSolid > r.Ssy) detail += " Squeezed solid it would take a set, so keep its stop.";
  if (r.C < 4 || r.C > 12) {
    status = worst(status, "warn");
    problems.push(r.C < 4 ? `the coil is tight for the wire (D/d ${n1(r.C)}): hard to wind and highly stressed inside` : `the coil is wide for the wire (D/d ${n1(r.C)}): it tangles and is hard to hold to size`);
    fixes.push("keep the mean diameter between 4 and 12 wire diameters");
  }
  if (r.slenderness > r.buckleAt) {
    status = worst(status, "warn");
    problems.push(`it is long for its diameter (free length ${n1(r.slenderness)} × mean diameter) and buckles sideways when compressed`);
    fixes.push("guide it on a rod or in a bore, or use a wider spring");
  }
  if (s.cycles >= 1e4 && s.working < s.installed) {
    detail += ` Fatigue safety factor ${n2(r.fatigue)} over ${big(s.cycles)} cycles.`;
    if (r.fatigue < 1) {
      status = "fail";
      problems.push(`it breaks from fatigue before ${big(s.cycles)} cycles`);
      fixes.push("lower the stress range: more coils, thicker wire or less travel");
    } else if (r.fatigue < 1.2) {
      status = worst(status, "warn");
      problems.push("little margin against fatigue");
      fixes.push("add a coil or use slightly thicker wire");
    }
  }
  detail += ` Surges (rings) at ${Math.round(r.surgeHz)} Hz.`;
  if (problems.length) detail += ` Watch out: ${problems.join("; ")}.`;
  return {
    id: `spring:${p.id}`,
    category: "springs",
    basis: "calculation",
    status,
    title: `Spring ${p.name}: ${n2(r.k)} N/mm`,
    detail,
    parts: [p.id],
    span: p.span,
    margin: r.Ssy / r.tauWorking,
    fix: fixes.length ? fixes.map((s, i) => (i ? s : s[0].toUpperCase() + s.slice(1))).join("; ") + "." : undefined,
  };
}

/** Every spring, snap hook and flexure in the model. */
export function springChecks(model: Model): CheckItem[] {
  const out: CheckItem[] = [];
  const springsDone = new Set<string>();
  for (const p of model.parts) {
    if (p.hidden) continue;
    for (const f of p.flex ?? []) out.push(f.kind === "snap" ? snapItem(p, f) : flexureItem(p, f, model));
    // a spring placed several times is one design: check it once
    if (p.spring && !springsDone.has(p.name)) {
      springsDone.add(p.name);
      out.push(springItem(p));
    }
  }
  return out;
}

/** Report pass: adds the springs and clips checks. */
export function springItems(items: CheckItem[], ctx: { model: Model }): CheckItem[] {
  return [...items.filter((i) => !i.id.startsWith("spring:")), ...springChecks(ctx.model)];
}

/** Complementary error function (Abramowitz and Stegun 7.1.26). */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
