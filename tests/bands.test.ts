import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { bandChecks } from "../src/analysis/bands";
import { fittingPose, freeLength, rubberOf, sectionOf, shoreToE, strandTension, stretchedCord, relaxedShare, type BandCord } from "../src/library/bands";
import { carriedBy, fittingSteps, holdDetails } from "../src/analysis/fitting";
import { vadd, vdot, vlen, vnorm, vscale, vsub, type V3 } from "../src/kernel/recipe";
import type { StructuralSpec } from "../src/analysis/spec";
import { fullCheck, problems } from "./helpers/fullcheck";

const post = `design "t"
part post { process: false  body cylinder(d: 30, h: 200, at: (0, 0, -100)) }
part bracket { body box(40, 6, 20, at: (0, 23, -10)) }
`;
const hooked = (extra = "") => `${post}component b = lib.band("EPDM", id: 30, cs: 2.5, around: post, holds: bracket, from: (-14, 20, 0), to: (14, 20, 0), pin: 4, lip: 2, open: Z${extra})`;

const model = (src: string) => {
  const m = evaluate(src);
  expect(m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  return m;
};

describe("rubber", () => {
  it("follows Gent's law: soft at first, stiffening, and the cord thins as it stretches", () => {
    const epdm = rubberOf("EPDM")!;
    expect(shoreToE(70)).toBeGreaterThan(4);
    expect(shoreToE(70)).toBeLessThan(8);
    const c: BandCord = { rubber: epdm, shore: 70, cs: 2.62, id: 40.87 };
    const t = [1.2, 1.5, 2, 3].map((l) => strandTension(c, l));
    expect(t[0]).toBeGreaterThan(0);
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1]);
    // force per stretch falls off at first and climbs again as the chains run out
    expect((t[1] - t[0]) / 0.3).toBeLessThan(t[0] / 0.2);
    expect(stretchedCord(2.62, 1.53)).toBeCloseTo(2.12, 2);
    expect(freeLength(c)).toBeCloseTo(Math.PI * 43.49, 3);
    // it relaxes while held stretched, more over a year than a day
    const year = relaxedShare(epdm, 525_600);
    expect(year).toBeLessThan(relaxedShare(epdm, 1440));
    expect(year).toBeGreaterThan(0.6);
  });
});

describe("a band hooked on two pins round a post", () => {
  it("wraps the far side of the post and pulls both hooks toward it", () => {
    const m = model(hooked());
    const b = m.parts.find((p) => p.name === "b")!;
    const L = b.band!.layout;
    expect(L.doubled).toBe(true);
    expect(L.wrapDeg).toBeGreaterThan(180);
    // two strands from hook to hook plus a half turn round each pin
    const rA = 2 + L.cord / 2 + 0.05;
    let D = 0;
    for (let i = 1; i < L.route.length; i++) D += vlen(vsub(L.route[i], L.route[i - 1]));
    expect(L.length).toBeCloseTo(2 * D + Math.PI * 2 * rA, 1);
    expect(L.stretch).toBeCloseTo(L.length / L.free, 6);
    expect(L.fitLength).toBeCloseTo(L.length + 4, 6);
    expect(L.tension).toBeGreaterThan(0);
    for (const h of L.hooks) {
      // toward the post, which sits at the origin in front of the hooks
      expect(vdot(vnorm(h.force), vnorm(vsub([0, 0, 0], h.at)))).toBeGreaterThan(0.3);
      expect(vlen(h.force)).toBeCloseTo(2 * L.tension, 6);
    }
    expect(L.captive).toBeUndefined();
    expect(L.offHook).toBeUndefined();
    const items = bandChecks(m);
    expect(items.map((i) => i.status)).not.toContain("fail");
  });

  it("goes on by hand: hooked, pulled round, over the head and seated, reaching the fitting stretch on the way", () => {
    const m = model(hooked());
    const b = m.parts.find((p) => p.name === "b")!;
    const sec = sectionOf(m.parts.find((p) => p.name === "post")!.recipe, []);
    const info = b.band!;
    const cord: BandCord = { rubber: rubberOf(info.rubber)!, shore: info.shore, cs: info.cs, id: info.id };
    const poses = Array.from({ length: 101 }, (_, i) => fittingPose(info.layout, [sec], cord, i / 100));
    expect(poses[0].phase).toBe("hook");
    expect(poses[0].stretch).toBeCloseTo(1, 2);
    expect(new Set(poses.map((p) => p.phase))).toEqual(new Set(["hook", "wrap", "over", "seated"]));
    const peak = Math.max(...poses.map((p) => p.stretch));
    expect(peak).toBeGreaterThan(info.layout.stretch);
    expect(Math.abs(peak / info.layout.fitStretch - 1)).toBeLessThan(0.03);
    const end = poses[100];
    expect(end.loop).toBe(info.layout.loop);
    expect(end.stretch).toBe(info.layout.stretch);
    // the stretch only builds while it is pulled round
    const wrap = poses.filter((p) => p.phase === "wrap").map((p) => p.stretch);
    for (let i = 1; i < wrap.length; i++) expect(wrap[i]).toBeGreaterThanOrEqual(wrap[i - 1] - 1e-6);
  });

  it("says a closed loop round a post that carries on past it cannot be put on", () => {
    const m = model(`${post}component b = lib.band("EPDM", id: 30, cs: 2.5, around: post, holds: bracket)`);
    const L = m.parts.find((p) => p.name === "b")!.band!.layout;
    expect(L.captive).toBe("post");
    const item = bandChecks(m).find((i) => i.status === "fail")!;
    expect(item.detail).toMatch(/cannot be put on/);
    expect(item.fix).toMatch(/from: and to:/);
  });

  it("warns when a hook opens toward the post, so the band's pull drags it off", () => {
    const m = model(hooked().replace("open: Z", "open: -Y"));
    expect(m.parts.find((p) => p.name === "b")!.band!.layout.offHook).toBe(0);
    expect(bandChecks(m).some((i) => i.status !== "pass" && /slide|off/i.test(i.detail))).toBe(true);
  });

  it("reaches both hooks when they sit at different heights, climbing evenly round the post", () => {
    const m = model(hooked().replace("from: (-14, 20, 0), to: (14, 20, 0)", "from: (-14, 20, -10), to: (14, 20, 10)"));
    const L = m.parts.find((p) => p.name === "b")!.band!.layout;
    expect(L.skew).toBeCloseTo(20, 6);
    // the cord goes round each pin, wherever it sits
    for (const h of L.hooks) {
      const nearest = Math.min(...L.loop.map((q) => vlen(vsub(q, h.at))));
      expect(nearest).toBeCloseTo(h.pin / 2 + L.cord / 2, 0);
    }
    // each strand is the slanted route from hook to hook
    let D = 0;
    for (let i = 1; i < L.route.length; i++) D += vlen(vsub(L.route[i], L.route[i - 1]));
    const r = 2 + L.cord / 2 + 0.05;
    expect(L.length).toBeCloseTo(2 * D + Math.PI * 2 * r, 1);
    expect(L.route[L.route.length - 1][2]).toBeCloseTo(10, 6);
    // the first hook is pulled up toward the second, the second down toward the first
    expect(vdot(L.hooks[0].toward, L.n)).toBeGreaterThan(0.1);
    expect(vdot(L.hooks[1].toward, L.n)).toBeLessThan(-0.1);
    expect(L.slant).toBeGreaterThan(5);
    expect(L.offHook).toBeUndefined();
    const items = bandChecks(m);
    expect(items.map((i) => i.status)).not.toContain("fail");
    expect(items.find((i) => i.id === "band:b:hold")!.detail).toMatch(/slant/);
    // and it goes on that way too, reaching its fitting stretch on the way
    const sec = sectionOf(m.parts.find((p) => p.name === "post")!.recipe, []);
    const info = m.parts.find((p) => p.name === "b")!.band!;
    const cord: BandCord = { rubber: rubberOf(info.rubber)!, shore: info.shore, cs: info.cs, id: info.id };
    const poses = Array.from({ length: 101 }, (_, i) => fittingPose(L, [sec], cord, i / 100));
    expect(Math.abs(Math.max(...poses.map((p) => p.stretch)) / L.fitStretch - 1)).toBeLessThan(0.04);
    expect(Math.min(...poses[91].loop.map((q) => vlen(vsub(q, L.hooks[1].at))))).toBeLessThan(L.hooks[1].pin / 2 + L.cord);
  });

  it("fails when the hooks are so far apart along the post that the loop is dragged off its pin", () => {
    const m = model(hooked().replace("from: (-14, 20, 0), to: (14, 20, 0)", "from: (-14, 20, -30), to: (14, 20, 30)"));
    expect(m.parts.find((p) => p.name === "b")!.band!.layout.offHook).toBe(0);
    const item = bandChecks(m).find((i) => i.id === "band:b:fit")!;
    expect(item.status).toBe("fail");
    expect(item.detail).toMatch(/slants \d+° round the tube/);
    expect(item.fix).toMatch(/same height/);
  });

  it("fails when a hook sits past the end of the post", () => {
    const m = model(hooked().replace("from: (-14, 20, 0), to: (14, 20, 0)", "from: (-14, 20, 104), to: (14, 20, 104)"));
    expect(m.parts.find((p) => p.name === "b")!.band!.layout.pastEnd).toBe("post");
    const item = bandChecks(m).find((i) => i.id === "band:b:fit")!;
    expect(item.status).toBe("fail");
    expect(item.detail).toMatch(/past the end of post/);
  });

  it("is too tight to fit by hand when the O-ring is much smaller than the post", () => {
    const m = model(hooked().replace("id: 30", "id: 16"));
    const items = bandChecks(m);
    expect(items.some((i) => i.status !== "pass")).toBe(true);
  });
});

describe("a band on two double hooks, the way a rear light holds", () => {
  const dbl = (spread: number | string = 12) => hooked().replace("open: Z", `spread: ${spread}, open: [(-1, 0, 0), (1, 0, 0)]`);

  it("runs a strand round the post above and below, each end round both prongs of its hook", () => {
    const m = model(dbl());
    const L = m.parts.find((p) => p.name === "b")!.band!.layout;
    expect(L.spread).toBe(12);
    // two strands from hook to hook, a quarter turn round each of the four prongs and down behind each hook between them
    const r = 2 + L.cord / 2 + 0.05;
    let D = 0;
    for (let i = 1; i < L.route.length; i++) D += vlen(vsub(L.route[i], L.route[i - 1]));
    expect(L.length).toBeCloseTo(2 * D + 2 * 12 + Math.PI * 2 * r, 1);
    // the cord passes round every prong, and its strands run round the post above and below them
    for (const h of L.hooks)
      for (const up of [1, -1]) {
        const prong = vadd(h.at, vscale(L.n, up * 6));
        expect(Math.min(...L.loop.map((q) => vlen(vsub(q, prong))))).toBeCloseTo(r, 0);
      }
    const across = L.loop.filter((q) => Math.abs(q[0]) < 1);
    expect(Math.max(...across.map((q) => vdot(q, L.n)))).toBeGreaterThan(6);
    expect(Math.min(...across.map((q) => vdot(q, L.n)))).toBeLessThan(-6);
    expect(L.offHook).toBeUndefined();
    const items = bandChecks(m);
    expect(items.map((i) => i.status)).not.toContain("fail");
    expect(items.find((i) => i.id === "band:b:fit")!.detail).toMatch(/double hook \(prongs 12 mm apart\)/);
  });

  it("pulls each prong toward the post and toward the other prong", () => {
    const m = model(
      dbl() +
        `
analysis "Held" {
  parts: [bracket]
  fix: contact(zone(at: (0, 0, -10), d: 32, axis: Z, length: 20), mu: 0.3, grip: [b])
  load: pull(b)
}`,
    );
    const L = m.parts.find((p) => p.name === "b")!.band!.layout;
    const a = m.analyses[0] as StructuralSpec;
    expect(a.loads).toHaveLength(4);
    const f = a.loads.map((l) => (l.t === "force" ? l.f : ([0, 0, 0] as V3)));
    for (const v of f) expect(vlen(v)).toBeCloseTo(Math.SQRT2 * L.tension, 3);
    // the end's pull between the prongs cancels: each hook takes both strands' pull toward the post
    for (const k of [0, 2]) {
      const sum = vadd(f[k], f[k + 1]);
      expect(vlen(sum)).toBeCloseTo(2 * L.tension, 3);
      expect(Math.abs(vdot(sum, L.n))).toBeLessThan(1e-6);
    }
  });

  it("needs room for a prong and the cord between the prongs, and both ends hooked", () => {
    const e = (src: string) => evaluate(src).diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
    expect(e(dbl(5)).join(" ")).toMatch(/spread: a double hook's prongs must be at least a prong and a cord apart/);
    expect(e(`${post}component b = lib.band("EPDM", id: 30, cs: 2.5, around: post, holds: bracket, spread: 12)`).join(" ")).toMatch(/needs from: and to:/);
  });
});

describe("the seatpost number bracket", () => {
  const src = readFileSync(new URL("../src/demos/seatpost-number.kerf", import.meta.url), "utf8");

  it("builds, prints without support and passes every check", async () => {
    const r = await fullCheck(src);
    expect([...r.buildErrors.values()]).toEqual([]);
    expect(problems(r.report, ["fail", "warn"])).toEqual([]);
    const bands = r.report.items.filter((i) => i.id.startsWith("band:"));
    expect(bands.length).toBeGreaterThanOrEqual(3);
    expect(bands.every((i) => i.status === "pass")).toBe(true);
  }, 120_000);

  it("plays the bracket and its pad on, the O-ring, the number pinned in with its print and each load it is checked for, the tilt dial riding with them", async () => {
    const r = await fullCheck(src);
    const steps = fittingSteps(r.model, (p) => r.core.get(p.hash)?.bbox as never);
    expect(steps.map((s) => s.kind)).toEqual(["seat", "band", "slide", "hold", "hold", "hold", "hold"]);
    const name = (id: string) => r.model.parts.find((p) => p.id === id)!.name;
    const seat = steps[0];
    if (seat.kind !== "seat") throw new Error("no seat step");
    expect(name(seat.part)).toBe("bracket");
    expect(seat.riders.map(name)).toEqual(["pad"]);
    expect(steps[1].title).toBe("Fit O-ring");
    const slide = steps.find((s) => s.kind === "slide")!;
    if (slide.kind !== "slide") throw new Error("no slide step");
    expect(name(slide.part)).toBe("number");
    // the print and the transponder sticker go in with it
    expect(slide.riders.map(name).sort()).toEqual(["number_print", "number_stripe", "transponder"]);
    expect(slide.caption).toMatch(/^Pull the arm back \(about \d+(\.\d)? N\), slide Race number \(4004\) in and let go: the pin goes through its hole and on into the far side/);
    // the pin is found where it passes through the number, not in the cheek it starts from or the dial round it
    const numberBox = r.core.get(r.model.parts.find((p) => p.name === "number")!.hash)!.bbox;
    expect(Math.abs(slide.peg[0])).toBeLessThan(numberBox[1][0] + 1);
    // it slides in along its own length, tilted up with it, point first
    const rise = (30 * Math.PI) / 180;
    expect(vdot(vnorm(slide.from), [0, Math.cos(rise), Math.sin(rise)])).toBeCloseTo(1, 6);
    // in the stress results the bracket carries its pad, the number and the dial its pin reaches into, and the number its
    // print, so they move with it
    const carried = carriedBy(r.model, (p) => r.core.get(p.hash)?.bbox as never);
    expect(carried.get(seat.part)!.map(name).sort()).toEqual(["dial", "number", "pad"]);
    expect(carried.get(slide.part)!.map(name).sort()).toEqual(["number_print", "number_stripe", "transponder"]);
    const gust = steps.find((s) => s.kind === "hold" && s.title === "Crosswind gust")!;
    if (gust.kind !== "hold") throw new Error("no gust step");
    const d = holdDetails(gust, undefined);
    // one arrow, square to the number, on its middle rather than the jaw that carries it in
    expect(d.arrows).toHaveLength(1);
    expect(d.arrows[0].dir[0]).toBeCloseTo(1, 6);
    const number = r.model.parts.find((p) => p.name === "number")!;
    const box = r.core.get(number.hash)!.bbox;
    expect(d.arrows[0].at[1]).toBeGreaterThan(box[0][1] + 40);
    expect(d.caption).toMatch(/still running/);
  }, 120_000);
});
