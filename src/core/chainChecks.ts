// Checks for roller chains (lib.chain): that every sprocket turns at the
// speed the chain gives it, the chain runs in line, wraps enough teeth to
// grip, has a whole number of links that fits the path, and is strong
// enough for the pull. These are the checks a person setting up a chain
// drive goes through, so a model that leaves one out hears about it.

import type { CheckItem } from "./checks";
import type { EvalPart, Model } from "./model";
import { polygonRipple, type ChainInfo } from "../machine/chains";
import { fmtNum } from "../lang/values";

const N = (x: number, d = 1) => fmtNum(x, d);

export function chainChecks(model: Model): CheckItem[] {
  const out: CheckItem[] = [];
  for (const p of model.parts) if (p.chain) out.push(...checksFor(p, p.chain, model));
  return out;
}

function checksFor(p: EvalPart, c: ChainInfo, model: Model): CheckItem[] {
  const out: CheckItem[] = [];
  const ids = (names: string[]) => [p.id, ...model.parts.filter((q) => names.includes(q.name)).map((q) => q.id)];
  const base = { category: "gears" as const, span: p.span, basis: "geometry" as const };
  const title = c.name;
  const all = c.nodes.map((n) => n.name);

  // every sprocket turns at the speed the chain gives it
  const wrong = c.nodes.filter((n) => n.declared !== undefined);
  const dn = c.nodes.find((n) => n.name === c.drive);
  if (wrong.length) {
    const needOf = (n: (typeof c.nodes)[number]) => ((c.linkRate * 360) / (n.z * n.dir)) * n.axisSign;
    out.push({
      ...base,
      basis: "parameters",
      id: `chain:speed:${p.name}`,
      status: "fail",
      title: `${title}: sprockets fight the chain`,
      parts: ids(wrong.map((n) => n.name)),
      detail: wrong.map((n) => `${n.name} is set to turn at ${N(n.declared!, 3)}× the driver, but the chain turns it at ${N(needOf(n), 3)}×${dn ? ` (${dn.z} teeth on ${dn.name} to ${n.z} on ${n.name}${n.outside !== dn.outside ? ", the other way round because the chain wraps it on its back" : ""})` : ""}`).join("; ") + ". A chain cannot slip, so one of them would break.",
      fix: `Leave out ${wrong.map((n) => n.name).join(" and ")}'s spin: and let the chain turn ${wrong.length === 1 ? "it" : "them"}, or give ${wrong.length === 1 ? "it" : "each"} chain: ${c.drive ?? "the driving sprocket"} (only for sprockets the chain wraps the same way round as the driver).`,
    });
  } else if (dn && c.speed) {
    const others = c.nodes.filter((n) => n !== dn && !n.idler);
    out.push({ ...base, basis: "parameters", id: `chain:speed:${p.name}`, status: "pass", title: `${title} turns its sprockets together`, parts: ids(all), detail: `${dn.name} (${dn.z} teeth) drives${others.length ? ` ${others.map((n) => `${n.name} (${n.z} teeth) at ${N(Math.abs(n.rate / dn.rate), 3)}×`).join(", ")}` : " the chain"}${c.nodes.some((n) => n.idler) ? `; the chain turns ${c.nodes.filter((n) => n.idler).map((n) => n.name).join(" and ")} by itself` : ""}.` });
  }

  // chain line: the sprockets in one plane, square to it
  {
    const lim = c.spec.bike ? { pass: 1.8, warn: 2.6 } : { pass: 0.3, warn: 0.6 };
    const bad: string[] = [];
    let worst: "pass" | "warn" | "fail" = "pass";
    const worse = (st: "warn" | "fail") => (worst = worst === "fail" || st === "fail" ? "fail" : "warn");
    const byName = new Map(c.nodes.map((n) => [n.name, n]));
    for (const sp of c.spans) {
      const a = byName.get(sp.from)!;
      const b = byName.get(sp.to)!;
      const deg = (Math.atan2(Math.abs(a.offset - b.offset), Math.max(1, sp.length)) * 180) / Math.PI;
      if (deg > lim.pass + 1e-9) {
        bad.push(`${sp.from} and ${sp.to} are ${N(Math.abs(a.offset - b.offset))} mm out of line over ${N(sp.length, 0)} mm (${N(deg, 2)}°)`);
        worse(deg > lim.warn ? "fail" : "warn");
      }
    }
    for (const n of c.nodes) {
      if (n.tilt > 1) {
        bad.push(`${n.name}'s axle is ${N(n.tilt)}° off square to the chain`);
        worse("fail");
      } else if (n.tilt > 0.3) {
        bad.push(`${n.name}'s axle is ${N(n.tilt)}° off square to the chain (keep it under 0.3°)`);
        worse("warn");
      }
    }
    out.push({
      ...base,
      id: `chain:line:${p.name}`,
      status: worst,
      title: worst === "pass" ? `${title} runs in line` : `${title} runs out of line`,
      parts: ids(all),
      detail: worst === "pass" ? `Every sprocket's teeth are in the chain's plane within ${c.spec.bike ? `${lim.pass}° (a derailleur chain bends sideways a little; cross-chaining past that wears it fast)` : `${lim.pass}°`}, and every axle is square to it.` : `${bad.join("; ")}. ${c.spec.bike ? "Past about 2° a derailleur chain grinds, wears and can drop." : `A ${c.spec.name} wants its sprockets within ${lim.pass}°, or the plates rub the teeth and it wears fast.`}`,
      fix: worst === "pass" ? undefined : "Move the sprockets along their axles (spacers, a different bottom bracket or hub spacing) until their teeth line up, and square the axles.",
    });
  }

  // wrap: enough rollers seated to carry the pull without skipping
  for (const n of c.nodes) {
    const loaded = !n.idler;
    const e = n.engaged;
    const st = loaded ? (e >= 4 && n.wrap >= 120 - 1e-6 ? "pass" : e >= 2.5 ? "warn" : "fail") : e >= 1.5 ? "pass" : "warn";
    out.push({
      ...base,
      id: `chain:wrap:${p.name}:${n.name}`,
      status: st,
      title: `${title}: grip on ${n.name}`,
      parts: ids([n.name]),
      margin: e / (loaded ? 4 : 1.5),
      detail: `The chain wraps ${N(n.wrap, 0)}° of ${n.name}, seating ${N(e)} of its ${n.z} teeth.${loaded ? (st === "pass" ? " Enough to share the pull between teeth." : " Fewer than four seated teeth, or less than 120° of wrap, lets the chain ride up and skip under load.") : st === "pass" ? " It only guides the chain, so that is enough." : " Too little for the chain to turn it reliably."}`,
      fix: st === "pass" ? undefined : loaded ? `Wrap the chain further round ${n.name}: move an idler or the other sprocket, or use a bigger sprocket here.` : `Move ${n.name} so the chain wraps more of it.`,
    });
  }

  // small sprockets
  for (const n of c.nodes) {
    if (n.z < c.spec.minTeeth) out.push({ ...base, id: `chain:teeth:${p.name}:${n.name}`, status: "fail", title: `${title}: ${n.name} is too small`, parts: ids([n.name]), detail: `${n.z} teeth; a ${c.spec.name} needs ${c.spec.minTeeth} or more or the links hinge too sharply and wear through.`, fix: `Give ${n.name} at least ${c.spec.minTeeth} teeth.` });
    else if (!c.spec.bike && !n.idler && n.z < 12) out.push({ ...base, id: `chain:teeth:${p.name}:${n.name}`, status: "warn", title: `${title}: ${n.name} is small`, parts: ids([n.name]), detail: `${n.z} teeth: the chain rides up and down its flats, so the speed ripples by ${N(polygonRipple(n.z) * 100)} % and it runs rough and noisy. 17 teeth or more run smoothly.` });
  }

  // links: a whole, even number that fits the path
  {
    const take = (c.links - c.needLinks) * c.spec.pitch;
    let st: "pass" | "warn" | "fail" = "pass";
    let detail: string;
    let fix: string | undefined;
    if (c.links < c.needLinks - 0.05) {
      st = "fail";
      detail = `The path needs ${N(c.needLinks)} links but the chain has ${c.links}.`;
      fix = `Use ${2 * Math.ceil(c.needLinks / 2)} links, or move the sprockets ${N((-take) / 2)} mm closer.`;
    } else if (c.tensioner) {
      detail = `${c.links} links (${N(c.links * c.spec.pitch, 0)} mm); the path needs ${N(c.needLinks)}, so ${c.nodes.filter((n) => n.idler || n.outside).map((n) => n.name).join(" and ")} take${c.nodes.filter((n) => n.idler || n.outside).length === 1 ? "s" : ""} up ${N(take)} mm of slack (assumed sprung, like a derailleur cage or tensioner).`;
    } else {
      // fixed centres: the chain should fit with only a little sag
      const sag = take;
      st = sag <= 0.25 * c.spec.pitch ? "pass" : sag <= 0.6 * c.spec.pitch ? "warn" : "fail";
      detail = `${c.links} links (${N(c.links * c.spec.pitch, 0)} mm) round a path that needs ${N(c.needLinks)}: ${N(sag)} mm of slack with nothing to take it up.${st === "pass" ? " That is the light sag a chain should run with." : " A slack chain whips and jumps teeth."}`;
      fix = st === "pass" ? undefined : `Move a sprocket ${N(sag / 2)} mm further away (slotted mounts or an eccentric), or add an idler sprocket to take up the slack.`;
    }
    if (c.links % 2) {
      st = st === "fail" ? "fail" : "warn";
      detail += " An odd number of links needs a half link, which is weaker.";
    }
    out.push({ ...base, id: `chain:links:${p.name}`, status: st, title: `${title}: ${c.links} links`, parts: [p.id], detail, ...(fix ? { fix } : {}) });
  }

  // pull against the chain's strength
  if (c.pull !== undefined && dn) {
    const sf = c.spec.breakN / c.pull;
    const want = c.spec.bike ? { pass: 4, warn: 2.5 } : { pass: 7, warn: 4 };
    const st = sf >= want.pass ? "pass" : sf >= want.warn ? "warn" : "fail";
    out.push({
      ...base,
      category: "engineering",
      basis: "calculation",
      id: `chain:pull:${p.name}`,
      status: st,
      title: `${title} carries the pull`,
      parts: ids([dn.name]),
      margin: sf / want.pass,
      detail: `${N(c.torque! / 1000)} N·m on ${dn.name} (${dn.z} teeth, ${N(dn.r * 2, 1)} mm pitch diameter) pulls the chain with ${N(c.pull, 0)} N; it breaks at about ${N(c.spec.breakN, 0)} N, ${N(sf, 1)} times that. ${c.spec.bike ? "Bicycle chains are made to run at about a quarter of their breaking load." : `Industrial practice wants ${want.pass} times or more for shock and fatigue.`}`,
      fix: st === "pass" ? undefined : `Use a bigger ${dn.name} (less pull for the same torque) or a stronger chain.`,
    });
  } else if (c.speed) {
    out.push({ ...base, category: "engineering", basis: "needs analysis", id: `chain:noload:${p.name}`, status: "info", title: `${title}: pull not checked`, parts: [p.id], detail: "Give lib.chain(...) torque: (the torque at the drive sprocket, like torque: 120Nm for a rider's hard effort) to check the chain's strength." });
  }
  return out;
}
