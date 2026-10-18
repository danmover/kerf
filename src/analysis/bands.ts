// The band checks: every lib.band (an O-ring or rubber band hooked round a
// tube), worked out from its rubber. Whether it can be put on at all (a closed
// loop cannot go round a post that carries on both ways, and the second hook
// must be reachable by hand), whether the hooks keep it on, how far it is
// stretched while fitting and once seated, how hard it pulls and how much of
// that it keeps after a year, whether the rubber suits the brief's weather and
// temperatures, and whether its grip on the tube holds what it carries over
// bumps. Pure, so it runs everywhere.

import type { CheckItem, CheckStatus } from "../core/checks";
import type { BandInfo, EvalPart, Model } from "../core/model";
import { vadd, vlen, type V3 } from "../kernel/recipe";
import { RUBBERS, breakStretch, fitLimit, holdLimit, relaxedShare, strandTension, type BandCord } from "../library/bands";

const n0 = (x: number) => String(Math.round(x));
const n1 = (x: number) => String(Math.round(x * 10) / 10);
const pc = (x: number) => `${n0(x * 100)} %`;
const YEAR_MIN = 365 * 24 * 60;

function worst(...s: CheckStatus[]): CheckStatus {
  return s.includes("fail") ? "fail" : s.includes("warn") ? "warn" : "pass";
}

const sentence = (s: string[]) => (s.length ? s.map((x, i) => (i ? x : x[0].toUpperCase() + x.slice(1))).join("; ") + "." : undefined);

function cordOf(b: BandInfo): BandCord {
  return { rubber: RUBBERS[b.rubber], shore: b.shore, cs: b.cs, id: b.id };
}

/** Can it be put on by hand, and do its hooks keep it on? */
function fitItem(p: EvalPart, b: BandInfo): CheckItem {
  const L = b.layout;
  const r = RUBBERS[b.rubber];
  const c = cordOf(b);
  const problems: string[] = [];
  const fixes: string[] = [];
  let status: CheckStatus = "pass";
  let detail: string;
  if (L.captive) {
    status = "fail";
    detail = `A closed loop round ${L.captive}, which carries on past the band both ways: there is no end to slide it over, so it cannot be put on without taking the ${L.captive} off.`;
    fixes.push(`hook both ends (from: and to:) onto pins or slots on ${b.holds ?? "the part it holds"}, so the band is hooked on one side, wrapped round ${L.captive} and stretched over a hook on the other`);
  } else if (!L.doubled) {
    detail = `A closed loop round ${b.around.join(" and ")}: it goes on over the end, stretched ${pc(L.stretch - 1)}.`;
  } else {
    const hand = 2 * L.fitTension;
    const lip = L.hooks[1].lip;
    detail = `Hook it over the first pin, wrap it round ${b.around.join(" and ")} and stretch it over the second pin's ${n1(lip)} mm head: that stretches it ${pc(L.fitStretch - 1)} for a moment and takes about ${n0(hand)} N by hand.`;
    if (L.fitStretch >= 0.9 * breakStretch(r)) {
      status = "fail";
      problems.push(`it snaps while being fitted: ${pc(L.fitStretch - 1)} is within 10 % of where ${r.label} breaks (${pc(r.breakStrain)})`);
      fixes.push("use a bigger O-ring (a longer loop), or bring the hooks closer round the tube");
    } else if (L.fitStretch > fitLimit(r)) {
      status = worst(status, "warn");
      problems.push(`fitting stretches it past ${pc(fitLimit(r) - 1)}, three quarters of the way to breaking: it tears after a few fittings`);
      fixes.push("use a bigger O-ring or a lower hook head");
    }
    if (hand > 70) {
      status = "fail";
      problems.push(`about ${n0(hand)} N is more than most hands can stretch over a pin`);
      fixes.push("a thinner cord, a softer rubber, or a bigger ring");
    } else if (hand > 45) {
      status = worst(status, "warn");
      problems.push(`about ${n0(hand)} N is a hard pull for cold or wet fingers`);
      fixes.push("a thinner cord or a slightly bigger ring");
    }
    if (L.pastEnd) {
      status = "fail";
      problems.push(`a hook sits past the end of ${L.pastEnd}, so the band has nothing to wrap there and slips off the end`);
      fixes.push(`move both hooks along ${L.pastEnd} to where it carries on either side of them`);
    }
    L.hooks.forEach((h, i) => {
      const which = i ? "second" : "first";
      if (L.offHook === i) {
        status = "fail";
        problems.push(
          L.skew !== undefined
            ? `the band slants ${n0(L.slant)}° round the tube to the other hook and pulls the loop along the ${which} pin toward its free end, so it slides off`
            : `the band pulls the loop along the ${which} pin toward its free end, so it slides off`,
        );
        fixes.push(L.skew !== undefined ? "put both hooks at the same height on the tube" : `turn the ${which} pin so its free end points across the pull (open:), or give it a deeper head`);
      }
      if (h.lip < 0.4 * c.cs) {
        status = "fail";
        problems.push(`the ${which} pin's ${n1(h.lip)} mm head is too low to keep a ${n1(c.cs)} mm cord on when it is knocked`);
        fixes.push(`give the pins a head (a mushroom or a lip) at least ${n1(0.75 * c.cs)} mm proud of the seat`);
      } else if (h.lip < 0.75 * c.cs) {
        status = worst(status, "warn");
        problems.push(`the ${which} pin's ${n1(h.lip)} mm head is shallow for a ${n1(c.cs)} mm cord: a sharp knock can flick the loop off`);
        fixes.push(`make the head about ${n1(0.75 * c.cs)} mm proud`);
      }
      if (h.pin < 1.5 * c.cs) {
        status = worst(status, "warn");
        problems.push(`the cord bends tightly round the ${which} ${n1(h.pin)} mm pin and wears through there`);
        fixes.push(`make the pins at least ${n1(1.5 * c.cs)} mm across`);
      }
      if (r.tears && h.pin < 3 * c.cs) {
        status = worst(status, "warn");
        problems.push(`silicone tears from small radii: round the ${which} pin to ${n1(3 * c.cs)} mm or use EPDM`);
      }
    });
  }
  if (problems.length) detail += ` Watch out: ${problems.join("; ")}.`;
  return {
    id: `band:${p.name}:fit`,
    category: "springs",
    basis: "calculation",
    status,
    title: `Band ${p.name}: goes on by hand`,
    detail,
    parts: [p.id, ...(b.holds ? [b.holds] : []), ...b.around],
    span: p.span,
    margin: L.captive || L.pastEnd ? -1 : (fitLimit(r) - L.fitStretch) / (fitLimit(r) - 1),
    fix: sentence(fixes),
  };
}

/** How it pulls once seated, after a year, in the weather. */
function holdItem(p: EvalPart, b: BandInfo, model: Model): CheckItem {
  const L = b.layout;
  const r = RUBBERS[b.rubber];
  const c = cordOf(b);
  const problems: string[] = [];
  const fixes: string[] = [];
  let status: CheckStatus = "pass";
  const keep = relaxedShare(r, YEAR_MIN);
  let detail = `Seated it is stretched ${pc(L.stretch - 1)} (${n0(L.length)} mm round a ${n0(L.free)} mm ring; the cord thins from ${n1(c.cs)} to ${n1(L.cord)} mm) and pulls ${n1(L.tension)} N in each strand`;
  detail += L.doubled ? `, ${n1(2 * L.tension)} N on each hook. ` : ". ";
  detail += `It wraps ${n0(L.wrapDeg)}° of ${b.around.join(" and ")} and presses on it with ${n0(L.squeeze)} N in all. Rubber relaxes while held stretched: after a year it keeps about ${pc(keep)} of its pull (${n1(L.tension * keep)} N).`;
  if (L.stretch < 1.05) {
    status = "fail";
    problems.push("it is barely stretched, so it hangs slack and holds nothing");
    fixes.push(`use a smaller O-ring: about ${n0((L.length / 1.4 / Math.PI) - c.cs)} mm inside diameter stretches it 40 %`);
  } else if (L.stretch < 1.15) {
    status = worst(status, "warn");
    problems.push(`at ${pc(L.stretch - 1)} it pulls only lightly and goes slack as it relaxes and the tube's paint wears`);
    fixes.push(`a smaller ring (about ${n0((L.length / 1.4 / Math.PI) - c.cs)} mm inside) stretches it a healthier 40 %`);
  }
  if (L.stretch > holdLimit(r)) {
    status = worst(status, "warn");
    problems.push(`held at ${pc(L.stretch - 1)}, more than half of the ${pc(r.breakStrain)} ${r.label} takes before breaking, it relaxes fast and cracks early`);
    fixes.push("use a bigger ring or a thicker cord at less stretch");
  }
  const brief = model.brief;
  const sunny = !!brief && (brief.outdoor === true || brief.exposure.some((e) => /sun|uv|outdoor|weather|rain/i.test(e)));
  if (sunny && r.weather === "poor") {
    status = worst(status, "warn");
    problems.push(`${r.label} held stretched outdoors cracks across the stretch from ozone and sunlight within a season`);
    fixes.push("use EPDM (or silicone) O-rings outdoors");
  }
  if (brief?.temp) {
    const [lo, hi] = brief.temp;
    if (lo < r.temp[0] || hi > r.temp[1]) {
      status = worst(status, "warn");
      problems.push(`the brief's ${n0(lo)}..${n0(hi)} °C is outside ${r.label}'s ${n0(r.temp[0])}..${n0(r.temp[1])} °C`);
      fixes.push(lo < r.temp[0] ? "silicone stays elastic colder" : "silicone or EPDM takes more heat");
    }
  }
  if (L.skew !== undefined) {
    status = worst(status, "warn");
    problems.push(`its hooks are ${n1(L.skew)} mm apart along the tube, so it runs round at a ${n0(L.slant)}° slant: it pulls each loop ${n1(2 * L.tension * Math.sin((L.slant * Math.PI) / 180))} N along the tube and twists ${b.holds ?? "what it holds"} on it`);
    fixes.push("put both hooks at the same height on the tube");
  }
  if (problems.length) detail += ` Watch out: ${problems.join("; ")}.`;
  const lo = (L.stretch - 1.15) / 0.35;
  const hi = (holdLimit(r) - L.stretch) / (holdLimit(r) - 1);
  return {
    id: `band:${p.name}:hold`,
    category: "springs",
    basis: "calculation",
    status,
    title: `Band ${p.name}: ${n1(L.tension)} N, stretched ${pc(L.stretch - 1)}`,
    detail,
    parts: [p.id],
    span: p.span,
    margin: Math.min(lo, hi),
    fix: sentence(fixes),
  };
}

/** The bands holding one part on a tube: does their grip hold what it carries over bumps? */
function gripItem(holds: string, bands: { p: EvalPart; b: BandInfo }[], model: Model): CheckItem | null {
  const carrier = bands.find((x) => x.b.carries !== undefined);
  if (!carrier) return null;
  const grams = carrier.b.carries!;
  const shock = Math.max(...bands.map((x) => x.b.shock ?? 0));
  const need = (grams / 1000) * 9.81 * (1 + shock);
  let bandGrip = 0;
  let seat = 0;
  for (const { b } of bands) {
    const r = RUBBERS[b.rubber];
    const keep = relaxedShare(r, YEAR_MIN);
    bandGrip += r.mu[1] * b.layout.squeeze * keep;
    // the hooks' pull presses the holding part's seat onto the tube
    const net: V3 = b.layout.hooks.reduce((s, h) => vadd(s, h.force), [0, 0, 0] as V3);
    seat += b.saddleMu * vlen(net) * keep;
  }
  const hold = bandGrip + seat;
  const margin = hold / need;
  const status: CheckStatus = margin >= 1.5 ? "pass" : margin >= 1 ? "warn" : "fail";
  const detail =
    `${holds} and what it carries (${n0(grams)} g) weigh ${n1((grams / 1000) * 9.81)} N; over ${n0(shock)} g bumps that is ${n1(need)} N along the tube. ` +
    `Wet and a year relaxed, the bands' grip holds ${n1(bandGrip)} N and the seat pressed on by their pull ${n1(seat)} N: ${n1(hold)} N, ${n1(margin)} times what it needs.` +
    (status === "pass" ? "" : status === "warn" ? " That is under the 1.5× a rough road wants: it can creep down the tube over potholes." : " It slides down the tube on the first big bump.");
  return {
    id: `band:${holds}:grip`,
    category: "springs",
    basis: "calculation",
    status,
    title: `Bands hold ${holds} on ${bands[0].b.around.join(" and ")}`,
    detail,
    parts: [holds, ...bands.map((x) => x.p.id)],
    span: carrier.p.span,
    margin: margin - 1.5,
    fix: status === "pass" ? undefined : "Stretch the bands more (a smaller ring), add a band, or give the seat a rubber pad.",
  };
}

/** Every band in the model. */
export function bandChecks(model: Model): CheckItem[] {
  const out: CheckItem[] = [];
  const seen = new Set<string>();
  const groups = new Map<string, { p: EvalPart; b: BandInfo }[]>();
  for (const p of model.parts) {
    if (p.hidden || !p.band || seen.has(p.name)) continue;
    seen.add(p.name);
    out.push(fitItem(p, p.band), holdItem(p, p.band, model));
    if (p.band.holds) groups.set(p.band.holds, [...(groups.get(p.band.holds) ?? []), { p, b: p.band }]);
  }
  for (const [holds, bands] of groups) {
    const g = gripItem(holds, bands, model);
    if (g) out.push(g);
  }
  return out;
}

/** Report pass: adds the band checks. */
export function bandItems(items: CheckItem[], ctx: { model: Model }): CheckItem[] {
  return [...items.filter((i) => !i.id.startsWith("band:")), ...bandChecks(ctx.model)];
}

/** Pull of one strand at a given stretch, for the fitting animation's captions. */
export function bandPullAt(b: BandInfo, stretch: number): number {
  return strandTension(cordOf(b), stretch);
}
