// Tutorials and feature samples: each is a starting point on the home screen, each sample is a design that builds and
// passes its checks, a step's check isn't already true when the lesson starts, and the changes Write it for me makes
// are ones its step's check takes as done.

import { describe, expect, it } from "vitest";
import { LESSONS, SAMPLES, TUTORIALS, lessonById, nextTutorial, type LearnState, type Lesson } from "../src/learn/lessons";
import { TEMPLATES, templateById } from "../src/demos/templates";
import { evaluate } from "../src/lang/evaluator";
import type { Model } from "../src/core/model";
import type { CheckReport } from "../src/core/checks";
import { fullCheck, problems } from "./helpers/fullcheck";

const state = (source: string, model: Model, report: CheckReport | null = null): LearnState => ({
  source,
  model,
  report,
  params: Object.fromEntries(model.params.map((p) => [p.name, p.value])),
  view: { dockTab: "overview", dockOpen: true, leftTab: "structure", selected: [], xray: false, section: false, explode: 0 },
  drawings: false,
  sketch: null,
  analyses: {},
  claudeVersions: 0,
  scripts: { count: 0, onChange: 0, done: [] },
});

describe("tutorials and feature samples", () => {
  it("are starting points on the home screen, kept apart from the examples", () => {
    expect(TUTORIALS.length).toBeGreaterThanOrEqual(6);
    expect(SAMPLES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(LESSONS.map((l) => l.id)).size).toBe(LESSONS.length);
    for (const l of LESSONS) {
      const t = templateById(l.id);
      expect(t, l.id).toBeTruthy();
      expect(t!.category).toBe(l.kind === "tutorial" ? "learn" : "samples");
      expect(t!.source).toBe(l.source);
      expect(t!.stats).toMatch(/^\d+ min · \d+ steps?$/);
      expect(l.steps.length, l.id).toBeGreaterThan(0);
      expect(l.shows.length, l.id).toBeGreaterThan(0);
      // the project is named after the lesson, from its design line
      if (l.kind === "tutorial") expect(/design\s+"([^"]+)"/.exec(l.source)?.[1], l.id).toBeTruthy();
      for (const s of l.steps) expect(s.body.split("`").length % 2, `${l.id}: ${s.title} has an unclosed backtick`).toBe(1);
    }
    expect(TEMPLATES.filter((t) => t.category === "learn" || t.category === "samples")).toHaveLength(LESSONS.length);
    expect(lessonById("learn-basics")?.name).toBe("Kerf in five minutes");
    expect(nextTutorial("learn-basics")?.id).toBe("learn-first-part");
    expect(nextTutorial(TUTORIALS.at(-1)!.id)).toBeUndefined();
  });

  it("doesn't start a lesson on a step that is already done", () => {
    for (const l of LESSONS) {
      const m = evaluate(l.source);
      const first = l.steps.find((s) => s.done);
      if (first) expect(first.done!(state(l.source, m)), `${l.id}: ${first.title}`).toBe(false);
    }
  });

  it("builds every lesson's design with no errors and no failing checks", async () => {
    const seen = new Set<string>();
    for (const l of LESSONS) {
      if (seen.has(l.source)) continue;
      seen.add(l.source);
      const r = await fullCheck(l.source);
      expect([...r.buildErrors.values()], l.id).toEqual([]);
      expect(r.model.diagnostics.filter((d) => d.severity === "error").map((d) => d.message), l.id).toEqual([]);
      expect(problems(r.report, ["fail"]), l.id).toEqual([]);
    }
  }, 600_000);

  it("takes each change Write it for me makes as its step done, one after another", async () => {
    const withApply = TUTORIALS.filter((l) => l.steps.some((s) => s.apply));
    expect(withApply.map((l) => l.id)).toContain("learn-first-part");
    for (const l of withApply) await walk(l);
  }, 300_000);
});

async function walk(l: Lesson) {
  let src = l.source;
  for (const s of l.steps) {
    if (!s.apply) continue;
    const before = src;
    // not done before it is done: the step would show as done when it is reached
    const was = await fullCheck(src);
    expect(s.done?.(state(src, was.model, was.report)), `${l.id}: ${s.title} is done before its change`).toBe(false);
    src = s.apply(src);
    expect(src, `${l.id}: ${s.title} changed nothing`).not.toBe(before);
    const r = await fullCheck(src);
    expect([...r.buildErrors.values()], `${l.id}: ${s.title}`).toEqual([]);
    expect(r.model.diagnostics.filter((d) => d.severity === "error").map((d) => d.message), `${l.id}: ${s.title}`).toEqual([]);
    expect(s.done?.(state(src, r.model, r.report)), `${l.id}: ${s.title}\n${src}`).toBe(true);
    expect(problems(r.report, ["fail"]), `${l.id}: ${s.title}`).toEqual([]);
  }
}
