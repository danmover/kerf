// The film maker's plan: which sections a design gets by default, how the
// shots sit on the clock and fade into each other, and that the camera keeps
// the design in the frame.

import { describe, expect, it } from "vitest";
import { defaultFilm, sectionAvailable, sectionChoices, defaultSection, spotlightParts, type Box, type FilmFacts, type FilmPart, type V3 } from "../src/film/facts";
import { buildShare, frameAt, overlayChanges, planFilm, project, shotAt, type FilmPlan } from "../src/film/timeline";
import { CROSSFADE, filmSeconds, filmSize, FilmInput, mergeSpec, sectionInfo, type FilmSpec, type SectionKind } from "../src/film/spec";

const part = (id: string, box: Box, more: Partial<FilmPart> = {}): FilmPart => ({
  id,
  name: id,
  label: id.replace(/_/g, " "),
  kind: "part",
  material: "PETG-CF",
  color: "#888",
  mass: 50,
  box,
  exploded: [(box[0][0] + box[1][0]) / 2, (box[0][1] + box[1][1]) / 2, (box[0][2] + box[1][2]) / 2 + 60],
  moving: false,
  hardware: false,
  group: "",
  ...more,
});

/** A small design: a base, a tower, a motor that turns, a board and two screws. */
function facts(more: Partial<FilmFacts> = {}): FilmFacts {
  const parts = [
    part("base", [
      [-100, -60, 0],
      [100, 60, 12],
    ]),
    part("tower", [
      [-20, -20, 12],
      [20, 20, 150],
    ]),
    part("motor", [[-15, -15, 150], [15, 15, 190]] as Box, { kind: "component", material: "Bought", moving: true }),
    part("board", [[40, -30, 12], [90, 20, 20]] as Box, { kind: "component", material: "Bought" }),
    part("screw_1", [[-90, -50, 0], [-86, -46, 16]] as Box, { hardware: true }),
    part("screw_2", [[86, 46, 0], [90, 50, 16]] as Box, { hardware: true }),
  ];
  return {
    name: "test_rig",
    title: "Test rig",
    purpose: "A rig for testing the film maker. It has a turning motor.",
    box: [
      [-100, -60, 0],
      [100, 60, 190],
    ],
    exploded: [
      [-100, -60, 0],
      [100, 60, 250],
    ],
    parts,
    order: parts.map((p) => p.id),
    size: [200, 120, 190],
    mass: 1250,
    make: 2,
    buy: 4,
    materials: [
      { label: "PETG-CF", mass: 900 },
      { label: "Bought", mass: 350 },
    ],
    cost: { total: 84.5, unpriced: 0 },
    bom: [
      { qty: 1, item: "base", kind: "Make" },
      { qty: 1, item: "tower", kind: "Make" },
      { qty: 1, item: "motor", kind: "Buy", price: 39 },
      { qty: 1, item: "board", kind: "Buy", price: 44 },
      { qty: 2, item: "screw", kind: "Buy", price: 0.75 },
    ],
    checks: { pass: 41, total: 41 },
    wires: 0,
    boards: 1,
    firmware: null,
    airflow: [],
    structural: [],
    sims: [],
    light: false,
    ...more,
  };
}

const kinds = (s: FilmSpec) => s.sections.map((x) => x.kind);

describe("the default film", () => {
  it("has the sections the design has something for, in playing order", () => {
    const f = facts();
    const spec = defaultFilm(f);
    expect(kinds(spec)).toEqual(["title", "reveal", "build", "explode", "spotlight", "motion", "specs", "parts", "end"]);
    expect(spec.title).toBe("Test rig");
    expect(spec.tagline).toBe("A rig for testing the film maker");
    // about a minute, and never past the limit
    const secs = filmSeconds(spec.sections);
    expect(secs).toBeGreaterThan(40);
    expect(secs).toBeLessThan(75);
  });

  it("says why a section has nothing to show", () => {
    const f = facts();
    expect(sectionAvailable("airflow", f)).toMatch(/airflow analysis/);
    expect(sectionAvailable("wiring", f)).toMatch(/no wires/);
    expect(sectionAvailable("motion", f)).toBeNull();
    const still = facts({ parts: facts().parts.map((p) => ({ ...p, moving: false })) });
    expect(sectionAvailable("motion", still)).toMatch(/motion/);
    const solid = facts({ exploded: null });
    expect(sectionAvailable("explode", solid)).toMatch(/comes apart/);
    expect(sectionAvailable("title", facts({ parts: [] }))).toBeNull();
    expect(sectionAvailable("reveal", facts({ parts: [] }))).toMatch(/no parts/);
  });

  it("keeps a design that has everything near a minute by leaving out the extras", () => {
    const f = facts({
      wires: 12,
      firmware: { name: "fw", file: "rig.ino", lang: "C++", lines: ["void setup() {}", "void loop() {}"] },
      airflow: [{ label: "Tunnel 30 km/h", cda: 0.012, watts: 4, speed: 30 }],
      structural: [{ label: "Load", safety: 3.2 }],
      sims: [{ label: "Run 1", seconds: 4, box: null }],
    });
    const on = kinds(defaultFilm(f));
    expect(on).toContain("sim");
    expect(on).toContain("airflow");
    expect(on).toContain("wiring");
    expect(on).not.toContain("results");
    expect(on).not.toContain("firmware");
    // still offered, off
    const offered = sectionChoices(f).map((c) => c.section.kind);
    expect(offered).toContain("results");
    expect(offered).toContain("firmware");
    expect(sectionChoices(f).find((c) => c.section.kind === "inside")!.on).toBe(false);
  });

  it("picks the biggest made parts and the dearest bought ones for close-ups, never hardware", () => {
    const ids = spotlightParts(facts());
    expect(ids.length).toBe(3);
    expect(ids).not.toContain("screw_1");
    expect(ids[0]).toBe("base");
    expect(ids).toContain("board");
  });

  it("writes captions from the design", () => {
    const f = facts();
    expect(defaultSection("reveal", f).text).toBe("200 × 120 × 190 mm · 1.25 kg");
    expect(defaultSection("build", f).text).toBe("6 parts: 2 made, 4 bought");
    expect(defaultSection("parts", f).text).toBe("About $84.50 in bought parts");
    expect(defaultSection("inside", f).axis).toBe("y");
  });
});

describe("the assistant's choices", () => {
  it("replace the default sections and fill each from its defaults", () => {
    const f = facts();
    const input = FilmInput.parse({ sections: [{ kind: "reveal", seconds: 25 }, { kind: "inside" }, { kind: "end", text: "Thanks" }], aspect: "9:16", music: "calm" });
    const spec = mergeSpec(defaultFilm(f), input, (k) => defaultSection(k, f));
    expect(kinds(spec)).toEqual(["reveal", "inside", "end"]);
    // clamped to what the picker offers
    expect(spec.sections[0].seconds).toBe(sectionInfo("reveal").max);
    // inside is off by default, so it comes from the fallback with its captions and axis
    expect(spec.sections[1].title).toBe("Inside");
    expect(spec.sections[1].axis).toBe("y");
    expect(spec.sections[2]).toMatchObject({ title: "Test rig", text: "Thanks" });
    expect(spec.aspect).toBe("9:16");
    expect(spec.music).toBe("calm");
    expect(spec.badge).toBe("DESIGNED IN KERF");
  });

  it("are checked before they are used", () => {
    expect(FilmInput.safeParse({ sections: [{ kind: "trailer" }] }).success).toBe(false);
    expect(FilmInput.safeParse({ size: 900 }).success).toBe(false);
    expect(FilmInput.safeParse({ accent: "orange" }).success).toBe(false);
    expect(FilmInput.safeParse({}).success).toBe(true);
  });
});

describe("the film's clock", () => {
  const f = facts();
  const spec = defaultFilm(f);
  const plan: FilmPlan = planFilm(spec, f, 16 / 9);

  it("starts each shot as the one before fades out", () => {
    expect(plan.shots[0].start).toBe(0);
    for (let i = 1; i < plan.shots.length; i++) expect(plan.shots[i].start).toBeCloseTo(plan.shots[i - 1].end - CROSSFADE, 9);
    expect(plan.duration).toBeCloseTo(filmSeconds(spec.sections), 9);
    // chapters count the middle sections only
    expect(plan.shots.map((s) => s.chapter)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 0]);
  });

  it("draws one shot at a time, two in a crossfade, their weights adding up to one", () => {
    for (let t = 0; t <= plan.duration; t += 0.05) {
      const fr = frameAt(plan, t);
      expect(fr.layers.length).toBeGreaterThanOrEqual(1);
      expect(fr.layers.length).toBeLessThanOrEqual(2);
      expect(fr.layers.reduce((s, l) => s + l.weight, 0)).toBeCloseTo(1, 9);
    }
    const mid = plan.shots[1].start + CROSSFADE / 2;
    const fr = frameAt(plan, mid);
    expect(fr.layers.map((l) => l.shot)).toEqual([0, 1]);
    expect(fr.layers[0].weight).toBeCloseTo(0.5, 6);
  });

  it("fades in from black and out to black, with the badge off the title and end cards", () => {
    expect(frameAt(plan, 0).fade).toBe(1);
    expect(frameAt(plan, 1).fade).toBe(0);
    expect(frameAt(plan, plan.duration).fade).toBe(1);
    expect(frameAt(plan, 1).badge).toBe(0);
    const reveal = plan.shots[1];
    expect(frameAt(plan, reveal.start + reveal.section.seconds / 2).badge).toBe(1);
    expect(frameAt(plan, plan.duration / 2).progress).toBeCloseTo(0.5, 6);
  });

  it("brings every part home by the end of the assembly, in order", () => {
    for (const n of [1, 2, 6, 40]) {
      for (let i = 0; i < n; i++) {
        let last = -1;
        for (let u = 0; u <= 1.0001; u += 0.02) {
          const k = buildShare(i, n, u);
          expect(k).toBeGreaterThanOrEqual(last - 1e-12);
          last = k;
        }
        expect(buildShare(i, n, 0.92)).toBeCloseTo(1, 6);
      }
      // later parts never lead earlier ones
      if (n > 1) expect(buildShare(0, n, 0.3)).toBeGreaterThanOrEqual(buildShare(n - 1, n, 0.3));
    }
  });

  it("keeps the whole design in frame through the reveal, in every shape", () => {
    for (const aspect of ["16:9", "1:1", "4:5", "9:16"] as const) {
      const { width, height } = filmSize(aspect, 1080);
      const p = planFilm(spec, f, width / height);
      const reveal = p.shots[1];
      for (let k = 0; k <= 1; k += 0.1) {
        const { view } = shotAt(p, reveal, k * reveal.section.seconds);
        for (let i = 0; i < 8; i++) {
          const c: V3 = [i & 1 ? f.box[1][0] : f.box[0][0], i & 2 ? f.box[1][1] : f.box[0][1], i & 4 ? f.box[1][2] : f.box[0][2]];
          const q = project(view.camera, width / height, c);
          expect(q.front).toBe(true);
          expect(q.x).toBeGreaterThan(0.02);
          expect(q.x).toBeLessThan(0.98);
          expect(q.y).toBeGreaterThan(0.02);
          expect(q.y).toBeLessThan(0.98);
        }
      }
    }
  });

  it("puts the right picture and cards in each section", () => {
    const at = (k: SectionKind, u = 0.6) => {
      const s = plan.shots.find((x) => x.section.kind === k)!;
      return shotAt(plan, s, u * s.section.seconds);
    };
    expect(at("title").graphics.map((g) => g.g)).toEqual(["titleCard"]);
    expect(at("build", 0).view.build).toBe(0);
    expect(at("build", 1).view.build).toBe(1);
    expect(at("explode", 0).view.explode).toBe(0);
    expect(at("explode", 0.8).view.explode).toBe(1);
    expect(at("explode", 0.8).graphics.find((g) => g.g === "callouts")).toBeTruthy();
    expect(at("motion", 0.5).view.angle).toBeGreaterThan(0);
    expect(at("spotlight", 0.2).view.focus).toEqual([spotlightParts(f)[0]]);
    const tiles = at("specs").graphics.find((g) => g.g === "tiles");
    expect(tiles && tiles.g === "tiles" && tiles.items.map((t) => t.label)).toEqual(["Size", "Mass", "Parts", "Bought parts", "Checks passing", "Materials"]);
    const table = at("parts").graphics.find((g) => g.g === "table");
    expect(table && table.g === "table" && table.rows[0].item).toBe("board");
    expect(at("end").graphics.map((g) => g.g)).toEqual(["endCard"]);
    // captions off: pictures only, but the title and end cards stay
    const quiet = planFilm({ ...spec, captions: false }, f, 16 / 9);
    const reveal = quiet.shots[1];
    expect(shotAt(quiet, reveal, 3).graphics).toEqual([]);
    expect(frameAt(quiet, reveal.start + 3).badge).toBe(0);
  });

  it("switches each overlay on once for the shots that need it", () => {
    const f2 = facts({ wires: 8, airflow: [{ label: "Tunnel", cda: 0.01 }] });
    const s2: FilmSpec = { ...defaultFilm(f2), sections: ["reveal", "airflow", "wiring", "end"].map((k) => defaultSection(k as SectionKind, f2)) };
    const p2 = planFilm(s2, f2, 16 / 9);
    expect(overlayChanges(p2).map((c) => c.need?.kind ?? null)).toEqual([null, "airflow", "wiring", null]);
    const inside = planFilm({ ...s2, sections: [defaultSection("inside", f2)] }, f2, 16 / 9);
    const sec = (u: number) => shotAt(inside, inside.shots[0], u * inside.shots[0].section.seconds).view.section!;
    // from the uncut side to the middle
    expect([0, 1]).toContain(sec(0).t);
    expect(sec(1).t).toBeCloseTo(0.5, 6);
  });
});
