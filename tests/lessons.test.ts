// Lessons Claude saves when the user corrects it, and the slimmer prompt that
// leaves the specialist reference sections for read_reference.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LESSON_TOOL, lessonsPrompt, saveLesson } from "../src/ai/lessons";
import { cleanLessons, updateSettings, useSettings, MAX_LESSONS } from "../src/app/settings";
import { DEFERRED, REFERENCE_TOOL, leanReference, referenceText } from "../src/ai/leanReference";
import { languageReference } from "../src/ai/reference";
import { systemPrompt } from "../src/ai/prompt";

describe("lessons", () => {
  beforeEach(() => updateSettings({ lessons: [], useLessons: true }));

  it("saves a rule once, rewords one in place, and drops the oldest when the list is full", () => {
    expect(saveLesson("Prints in PETG on a 0.4 mm nozzle.")).toMatchObject({ saved: true });
    expect(saveLesson("prints in petg on a 0.4 mm nozzle.")).toEqual({ text: "You already have this lesson.", saved: false });
    const r = saveLesson("Prints in PETG on a 0.6 mm nozzle.", "Prints in PETG on a 0.4 mm nozzle.");
    expect(r.text).toContain('in place of "Prints in PETG on a 0.4 mm nozzle."');
    expect(useSettings.getState().lessons).toEqual(["Prints in PETG on a 0.6 mm nozzle."]);

    updateSettings({ lessons: Array.from({ length: MAX_LESSONS }, (_, i) => `Rule ${i + 1}.`) });
    const full = saveLesson("Use M4 screws for anything that carries weight.");
    expect(full.text).toContain('the oldest lesson went: "Rule 1."');
    const list = useSettings.getState().lessons;
    expect(list).toHaveLength(MAX_LESSONS);
    expect(list[0]).toBe("Rule 2.");
    expect(list.at(-1)).toBe("Use M4 screws for anything that carries weight.");
  });

  it("saves nothing while lessons are switched off", () => {
    updateSettings({ useLessons: false });
    expect(saveLesson("No fillets on edges nobody sees.")).toMatchObject({ saved: false });
    expect(useSettings.getState().lessons).toEqual([]);
  });

  it("keeps a clean list: trimmed, at most 200 characters, no repeats, the newest 40", () => {
    const many = Array.from({ length: 45 }, (_, i) => `Rule ${i}.`);
    expect(cleanLessons([" A rule. ", "A rule.", 7, "x".repeat(300), ""])).toEqual(["A rule.", "x".repeat(200)]);
    expect(cleanLessons(many)).toEqual(many.slice(-40));
    expect(cleanLessons("not a list")).toEqual([]);
  });

  it("gives Claude the lessons as a list in the system prompt, or nothing", () => {
    expect(lessonsPrompt([])).toBe("");
    expect(lessonsPrompt(["Prints in PETG."])).toMatch(/^\n\n## Lessons this user taught you\n.*\n- Prints in PETG\.$/s);
    expect(LESSON_TOOL.input_schema.required).toEqual(["lesson"]);
    expect(systemPrompt()).toContain("call save_lesson");
  });
});

describe("saved settings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const withStored = async (entries: [string, unknown][]) => {
    const store = new Map(entries.map(([k, v]) => [k, JSON.stringify(v)]));
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    vi.resetModules();
    return { s: (await import("../src/app/settings")).useSettings.getState(), store };
  };

  it("cleans the saved lessons, and starts with lessons on and the slimmer prompt off", async () => {
    const { s } = await withStored([["kerf.settings.v1", { lessons: ["  Prints in PETG.", "Prints in PETG.", 3] }]]);
    expect(s.lessons).toEqual(["Prints in PETG."]);
    expect(s.useLessons).toBe(true);
    expect(s.leanPrompt).toBe(false);
  });

  it("puts back the settings a bench run changed when Kerf closed before it finished", async () => {
    const { s, store } = await withStored([
      ["kerf.settings.v1", { model: "claude-sonnet-5-5", leanPrompt: true, useLessons: false, lessons: ["Prints in PETG."] }],
      ["kerf.bench.restore", { model: "claude-opus-5-5", leanPrompt: false, useLessons: true }],
    ]);
    expect(s).toMatchObject({ model: "claude-opus-5-5", leanPrompt: false, useLessons: true, lessons: ["Prints in PETG."] });
    expect(store.has("kerf.bench.restore")).toBe(false);
  });
});

describe("the slimmer prompt", () => {
  it("leaves each specialist section as a note that says to read it, and keeps the rest word for word", () => {
    const full = systemPrompt();
    const lean = systemPrompt({ lean: true });
    expect(lean.length).toBeLessThan(full.length * 0.6);
    for (const d of DEFERRED) {
      const sec = referenceText(d.id);
      expect(sec.startsWith(d.heading)).toBe(true);
      expect(sec.length).toBeGreaterThan(1000);
      expect(full).toContain(sec);
      expect(lean).not.toContain(sec);
      expect(lean).toMatch(new RegExp(`${d.heading}[^\\n]*\\n[^\\n]+call read_reference with section "${d.id}"`));
    }
    for (const kept of ["## Part blocks", "## Detailed modelling", "## Components", "## Materials and finishes", "hinge("]) expect(lean).toContain(kept);
    expect(leanReference().length).toBeLessThan(languageReference().length / 2);
  });

  it("offers read_reference for exactly the sections it leaves out", () => {
    expect(REFERENCE_TOOL.input_schema.properties.section.enum).toEqual(DEFERRED.map((d) => d.id));
  });
});
