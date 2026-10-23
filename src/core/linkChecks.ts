// Checks on connecting rods, run through a whole turn of the driver: every
// part that slides or swings has a rod driving it, the rod spans its pins
// all the way round (or the linkage locks), it does not push so far across
// the follower's travel that it binds, and its pins are on the parts they
// join. Passing rods report the follower's stroke or swing.

import type { EvalPart, Model } from "./model";
import type { CheckItem } from "./checks";
import { sweepLink } from "./kinematics";
import { worldBox } from "./holds";
import { fmtNum } from "../lang/values";
import type { V3 } from "../kernel/recipe";

/** Below this transmission angle the rod pushes the follower more sideways than along: it binds and wears. */
const BINDS = 30;

const near = (b: [V3, V3] | null, p: V3, tol: number) => !b || p.every((x, i) => x >= b[0][i] - tol && x <= b[1][i] + tol);
const overlap = (a: [V3, V3] | null, b: [V3, V3] | null) => !!a && !!b && a[0].every((_, i) => a[0][i] <= b[1][i] + 0.5 && b[0][i] <= a[1][i] + 0.5);

export function linkChecks(model: Model): CheckItem[] {
  const out: CheckItem[] = [];
  const byName = (n: string) => model.parts.filter((p) => p.name === n);
  const rods = new Map<string, EvalPart>();
  for (const p of model.parts) if (p.motion?.kind === "rod" && p.motion.link && !rods.has(p.motion.link.id)) rods.set(p.motion.link.id, p);
  const seen = new Set<string>();
  for (const p of model.parts) {
    const m = p.motion;
    if (!m || (m.kind !== "slide" && m.kind !== "swing") || m.link || seen.has(p.name)) continue;
    seen.add(p.name);
    out.push({
      id: `link:none:${p.name}`,
      category: "motion",
      status: "fail",
      title: `${p.name} ${m.kind === "slide" ? "slides" : "swings"} but no rod drives it`,
      detail: `${p.name} has ${m.kind === "slide" ? "slides:" : "swings:"}, so it moves only as a connecting rod pushes it, and none does: it stays put while the rest turns.`,
      fix: `Add the rod: a part with links: [<the turning part>, ${p.name}] and pins: [<its pin on the turning part>, <its pin on ${p.name}>], both where they are drawn.`,
      parts: [p.id],
      span: p.span,
      basis: "geometry",
    });
  }
  for (const rod of rods.values()) {
    const l = rod.motion!.link!;
    const follower = byName(l.follower.name)[0];
    const driver = model.parts.find((q) => q.motion === l.driver || (q.motion && q.motion === l.driver.parent));
    const parts = [rod.id, ...(follower ? [follower.id] : []), ...(driver ? [driver.id] : [])];
    const base = { category: "motion" as const, parts, span: rod.span, basis: "geometry" as const };
    // the pins should be on the parts they join, or on a pin, boss or sleeve fixed to them (a crank pin pressed into its web)
    const on = (q: EvalPart, p: V3) => {
      const b = worldBox(q);
      return near(b, p, 1) || model.parts.some((o) => o !== q && o !== rod && overlap(worldBox(o), b) && near(worldBox(o), p, 0.5));
    };
    const off = [driver && !on(driver, l.p0) ? `${fmtNumV(l.p0)} is not on ${driver.name}` : "", follower && !on(follower, l.w0) ? `${fmtNumV(l.w0)} is not on ${follower.name}` : ""].filter(Boolean);
    if (off.length) out.push({ ...base, id: `link:pins:${l.name}`, status: "warn", title: `${l.name}'s pins are off the parts they join`, detail: `${off.join("; ")}, so the rod would be pinned to thin air there.`, fix: `Give pins: the centres of the holes the rod's pins go through: the crank pin on the driver, the wrist or rocker pin on ${l.follower.name}.` });
    const sw = sweepLink(l);
    if (sw.stuck.length) {
      out.push({
        ...base,
        id: `link:reach:${l.name}`,
        status: "fail",
        title: `${l.name} cannot reach ${l.follower.name} all the way round`,
        detail: `At ${fmtNum(sw.stuck[0], 0)}° of the driver's turn (and ${sw.stuck.length - 1} more of 72 positions) the ${fmtNum(l.length, 1)} mm rod is too short or too long to span its pins, so the linkage locks there.`,
        fix: l.follower.kind === "slide" ? `Make the rod longer than the crank throw (pin to crank centre) and keep the slide's line through near the crank centre.` : `Keep the crank shorter than the rocker, the rod and the frame distance between the pivots, so the crank turns all the way (Grashof): shorten the crank or lengthen the rod.`,
      });
      continue;
    }
    const range = l.follower.kind === "slide" ? `strokes ${fmtNum(sw.max - sw.min, 1)} mm` : `swings ${fmtNum(sw.max - sw.min, 0)}° (from ${fmtNum(sw.min, 0)}° to ${fmtNum(sw.max, 0)}°)`;
    if (sw.worst < BINDS) {
      out.push({
        ...base,
        id: `link:binds:${l.name}`,
        status: "warn",
        title: `${l.name} pushes ${l.follower.name} almost square across its travel`,
        detail: `At ${fmtNum(sw.worstAt, 0)}° of the driver's turn the rod meets ${l.follower.name}'s travel at a transmission angle of ${fmtNum(sw.worst, 0)}° (under ${BINDS}°), so most of its push goes sideways into the ${l.follower.kind === "slide" ? "slide" : "pivot"}: it binds and wears.`,
        fix: l.follower.kind === "slide" ? `Lengthen the rod (3 to 4 times the crank throw is usual) or shorten the throw.` : `Move the pivots so the rod meets the rocker nearer square at the ends of the swing: a shorter crank or a longer rocker.`,
      });
    } else out.push({ ...base, id: `link:ok:${l.name}`, status: "pass", title: `${l.name} drives ${l.follower.name} all the way round`, detail: `${l.follower.name} ${range}; the transmission angle stays above ${fmtNum(sw.worst, 0)}°.` });
  }
  return out;
}

const fmtNumV = (p: V3) => `(${p.map((x) => fmtNum(x, 1)).join(", ")})`;
