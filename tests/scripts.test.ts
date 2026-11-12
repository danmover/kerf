// Scripts: the kerf API that a script drives Kerf through, run here with the same API code and messages as in the
// app's sandbox, against a design built with OpenCASCADE in Node.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fullCheck } from "./helpers/fullcheck";
import { runHere } from "../src/scripts/local";
import { ScriptSession, scriptFileName, type DesignRead, type ScriptHost, type ScriptMode } from "../src/scripts/session";
import { exportFilesOf } from "../src/scripts/files";
import { isFromScript } from "../src/scripts/protocol";
import { cleanScripts, nextScriptName, scriptNameProblem } from "../src/scripts/records";
import { projectFile, readImportFile } from "../src/persist/files";
import type { ScriptRecord } from "../src/persist/db";

const SRC = `design "tray"
param width = 60mm "Outer width"
param depth = 45mm
param wall = 2mm range 1.2 .. 4
part tray { body box(width, depth, 20)
  shell(wall, open: facing(Z)) }
require "Fits the drawer": width <= 70

configs "Sizes" {
  show: "Medium"
  config "Small" { width: 40, depth: 30 }
  config "Medium" { width: 60mm, depth: 45 }
  config "Large" { width: 80, depth: 60, wall: 3 }
}

analysis "Drop" {
  fix: face(tray, -Z)
  load: force(face(tray, +X), 10N, dir: -X)
}
`;

/** A host on an in-process kernel: what the app does, with the open design as a plain string. */
function testHost(start = SRC) {
  const state = { shown: start, kept: [] as { before: string; message: string }[], measured: 0 };
  const read = async (source: string): Promise<DesignRead> => {
    const fc = await fullCheck(source);
    return {
      source,
      model: fc.model,
      report: fc.report,
      geom: (h) => {
        const e = fc.core.get(h);
        return e ? { volume: e.volume, bbox: e.bbox } : undefined;
      },
      mesh: (h) => (fc.core.get(h) ? fc.core.mesh(h, "final") : undefined),
    };
  };
  const host: ScriptHost = {
    source: () => state.shown,
    current: () => read(state.shown),
    measure: (source) => {
      state.measured++;
      return read(source);
    },
    show: async (source) => {
      state.shown = source;
      return read(source);
    },
    keep: (before, message) => state.kept.push({ before, message }),
    analyse: async (r, name) => ({ name: name ?? r.model.analyses[0]?.label ?? "?", verdict: "pass", safety: 4 }),
    exportFiles: async (r, format, opts) => {
      const fc = await fullCheck(r.source);
      return exportFilesOf(r, format, opts, {
        name: "tray",
        step: async (items) => fc.core.exportStep(items).arrayBuffer(),
        meshes: async () => (p) => (fc.core.get(p.hash) ? fc.core.mesh(p.hash, "final") : undefined),
      });
    },
    projects: () => [{ name: "tray", updated: 1 }],
  };
  return { host, state };
}

async function run(code: string, opts: { mode?: ScriptMode; start?: string } = {}) {
  const { host, state } = testHost(opts.start);
  const session = new ScriptSession(host, { name: "Test", mode: opts.mode ?? "run" });
  const out = await runHere(code, session);
  return { out, state };
}

describe("scripts", () => {
  it("read the design: parameters, parts with their mass and size, checks and requirements", async () => {
    const { out } = await run(`
      const d = await kerf.design();
      console.log("parts:", d.parts.length);
      return { name: d.name, config: d.config, width: d.params.width, part: d.parts[0], fits: d.requirements[0] };
    `);
    expect(out.status).toBe("done");
    expect(out.lines).toEqual([{ level: "log", text: "parts: 1" }]);
    const v = JSON.parse(out.value!);
    expect(v).toMatchObject({ name: "tray", config: "Medium", width: 60, part: { name: "tray", made: true, size: [60, 45, 20] }, fits: { name: "Fits the drawer", status: "pass" } });
    // a 60 × 45 × 20 box with 2 mm walls and an open top, in its material
    expect(v.part.mass).toBeGreaterThan(5);
    expect(out.changed).toBeUndefined();
  }, 60_000);

  it("try other values and configurations without touching the design, and show a table", async () => {
    const { out, state } = await run(`
      const rows = [];
      for (const width of [40, 60, 80]) {
        const v = await kerf.variant({ width });
        rows.push({ width, mass: v.mass, fits: v.requirements[0].status });
      }
      const large = await kerf.variant({}, { config: "Large" });
      rows.push({ width: large.params.width, mass: large.mass, fits: large.requirements[0].status });
      kerf.table(rows, "Mass by width");
      return (await kerf.params()).width;
    `);
    expect(out.status).toBe("done");
    expect(out.value).toBe("60");
    const t = out.tables[0];
    expect(t.title).toBe("Mass by width");
    expect(t.columns).toEqual(["width", "mass", "fits"]);
    expect(t.rows.map((r) => r[0])).toEqual([40, 60, 80, 80]);
    const masses = t.rows.map((r) => r[1] as number);
    expect(masses[0]).toBeLessThan(masses[1]);
    expect(masses[1]).toBeLessThan(masses[2]);
    expect(t.rows.map((r) => r[2])).toEqual(["pass", "pass", "fail", "fail"]);
    // the open design is as it was, and nothing was kept as a version
    expect(state.shown).toBe(SRC);
    expect(state.kept).toEqual([]);
    // 60 is the open design itself; the rest were built apart
    expect(out.builds).toBe(3);
    expect(ScriptSession.csv(t).split("\n")[0]).toBe("width,mass,fits");
  }, 120_000);

  it("change the design, kept as one version when the run ends", async () => {
    const { out, state } = await run(`
      await kerf.set({ width: 50 });
      const d = await kerf.set({ depth: 40, wall: 2.4 });
      return d.parts[0].size;
    `);
    expect(out.status).toBe("done");
    expect(JSON.parse(out.value!)).toEqual([50, 40, 20]);
    // the configuration shown takes the values its row sets; the wall goes on its own line
    expect(state.shown).toContain('config "Medium" { width: 50mm, depth: 40 }');
    expect(state.shown).toContain("param wall = 2.4mm range 1.2 .. 4");
    expect(state.kept).toEqual([{ before: SRC, message: "Script “Test”" }]);
    expect(out.changed).toBe(true);
  }, 60_000);

  it("say what went wrong: unknown names, errors with their line, and code that does not read", async () => {
    let r = await run(`await kerf.set({ height: 3 });`);
    expect(r.out.status).toBe("error");
    expect(r.out.error).toBe('The design has no parameter called "height". Its parameters: width, depth, wall.');
    expect(r.state.kept).toEqual([]);
    r = await run(`const a = 1;\nconst b = 2;\nthrow new Error("stop " + (a + b));`);
    expect(r.out).toMatchObject({ status: "error", error: "stop 3", line: 3 });
    // a call that fails points at the line that made it
    r = await run(`const a = 1;\n\nawait kerf.variant({ nope: a });`);
    expect(r.out).toMatchObject({ status: "error", line: 3 });
    r = await run(`await kerf.variant({}, { config: "Huge" });`);
    expect(r.out.error).toBe('The design has no configuration called "Huge". Its configurations: Small, Medium, Large.');
    r = await run(`const = 4;`);
    expect(r.out.status).toBe("error");
    expect(r.out.error).toMatch(/^The script does not read as JavaScript: /);
    r = await run(`await kerf.nope();`);
    expect(r.out.error).toMatch(/kerf.nope is not a function/);
    // a call the API doesn't have, sent by hand, is refused by the session
    const { host } = testHost();
    await expect(new ScriptSession(host, { name: "x", mode: "run" }).call("deleteEverything", [])).rejects.toThrow("kerf.deleteEverything is not part of the API.");
  }, 60_000);

  it("after each change, only look: checks of the user's own, and no edits", async () => {
    const { out, state } = await run(
      `
      const d = await kerf.design();
      await kerf.check("Tray under 40 g", d.mass < 40, d.mass.toFixed(1) + " g");
      await kerf.check("Walls at least 2 mm", d.params.wall >= 2 ? true : "warn");
      await kerf.set({ width: 10 });
    `,
      { mode: "check" },
    );
    expect(out.status).toBe("error");
    expect(out.error).toMatch(/^kerf.set can't be used in a script that runs after each change/);
    expect(out.checks.map((c) => [c.name, c.status])).toEqual([
      ["Tray under 40 g", "pass"],
      ["Walls at least 2 mm", "pass"],
    ]);
    expect(out.checks[0].detail).toMatch(/^\d+\.\d g$/);
    expect(state.shown).toBe(SRC);
  }, 60_000);

  it("export files: STL a part, the parts list, STEP and the source, for the design or another reading", async () => {
    const { out } = await run(`
      const made = [];
      made.push(...await kerf.export("stl", { each: true }));
      made.push(...await kerf.export("stl", { values: { width: 40 }, name: "tray 40" }));
      made.push(...await kerf.export("csv"));
      made.push(...await kerf.export("step"));
      made.push(...await kerf.export("kerf"));
      made.push(await kerf.file("notes/sizes.csv", "width,mass\\n40,1\\n"));
      made.push(await kerf.file("notes/sizes.csv", "again"));
      return made;
    `);
    expect(out.error).toBeUndefined();
    expect(out.status).toBe("done");
    expect(JSON.parse(out.value!)).toEqual(["tray.stl", "tray-40.stl", "tray-parts-list.csv", "tray.step", "tray.kerf", "notes/sizes.csv", "notes/sizes (2).csv"]);
    const stl = out.files[0].data as Uint8Array;
    // binary STL: an 80 byte header, a count, 50 bytes a triangle
    const n = new DataView(stl.buffer, stl.byteOffset).getUint32(80, true);
    expect(stl.byteLength).toBe(84 + 50 * n);
    expect(new TextDecoder().decode(out.files[3].data as Uint8Array)).toMatch(/^ISO-10303-21;/);
    expect(out.files[4].data).toBe(SRC);
    expect(out.files.find((f) => f.name === "notes/sizes.csv")?.mime).toBe("text/csv");
    expect(scriptFileName("../../etc/passwd", "txt")).toBe("etc/passwd.txt");
  }, 120_000);

  it("run strength analyses through the host, and list the user's designs", async () => {
    const { out } = await run(`
      const a = await kerf.analyze("Drop");
      const b = await kerf.analyse(undefined, { width: 70 });
      return [a, b.safety, (await kerf.projects())[0].name];
    `);
    expect(JSON.parse(out.value!)).toEqual([{ name: "Drop", verdict: "pass", safety: 4 }, 4, "tray"]);
  }, 60_000);

  it("keep output within bounds", async () => {
    const { out } = await run(`
      for (let i = 0; i < 2100; i++) console.log("line " + i);
      kerf.table([[1, "a".repeat(600)], [2]]);
      return "ok";
    `);
    expect(out.lines.length).toBe(2001);
    expect(out.lines[2000].text).toMatch(/More output was left out/);
    expect(out.tables[0].columns).toEqual(["1", "2"]);
    expect(String(out.tables[0].rows[0][1]).length).toBeLessThan(510);
    expect(out.tables[0].rows[1]).toEqual([2, null]);
  }, 60_000);
});

describe("scripts saved with a project", () => {
  const s = (over: Partial<ScriptRecord>): ScriptRecord => ({ id: "scr_abcd1234", name: "Sizes", code: "return 1", updatedAt: 1, ...over });

  it("have names of their own", () => {
    const list = [s({}), s({ id: "scr_efgh5678", name: "Script" })];
    expect(scriptNameProblem("  sizes ", list)).toBe("There is already a script called “sizes”.");
    expect(scriptNameProblem("sizes", list, "scr_abcd1234")).toBeNull();
    expect(nextScriptName(list)).toBe("Script 2");
  });

  it("travel in project files, but don't run after each change on someone else's computer", async () => {
    const text = projectFile("Tray", SRC, "blank", 1, [], { scripts: [s({ onChange: true }), s({ id: "scr_zzzz9999", name: "Export" })] });
    const back = (await readImportFile(new File([text], "Tray.kerfproj"))).projects[0];
    expect(back.scripts!.map((x) => [x.name, x.onChange])).toEqual([
      ["Sizes", undefined],
      ["Export", undefined],
    ]);
    // from the user's own account they keep it; bad entries and repeats are dropped
    expect(cleanScripts([s({ onChange: true }), s({ name: "sizes" }), { id: "bad", name: "x", code: "" }, null], { keepOnChange: true })).toEqual([s({ onChange: true })]);
  });
});

describe("the sandbox", () => {
  it("passes on only messages a script could send", () => {
    expect(isFromScript({ kind: "call", id: 1, method: "design", args: [] })).toBe(true);
    expect(isFromScript({ kind: "call", id: "1", method: "design", args: [] })).toBe(false);
    expect(isFromScript({ kind: "log", level: "shout", text: "x" })).toBe(false);
    expect(isFromScript("done")).toBe(false);
  });

  it("is a page with no network and no origin, framed by Kerf only", () => {
    const page = readFileSync(new URL("../public/script-sandbox.html", import.meta.url), "utf8");
    expect(page).toContain(`content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:"`);
    const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
    expect(headers).toMatch(/\/script-sandbox\.html\n\s+Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; frame-ancestors 'self'/);
    const vite = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
    expect(vite).toContain('path === "/script-sandbox.html") res.setHeader("Content-Security-Policy", SCRIPT_SANDBOX_CSP)');
    const runner = readFileSync(new URL("../src/scripts/sandbox.ts", import.meta.url), "utf8");
    expect(runner).toContain('frame.setAttribute("sandbox", "allow-scripts")');
  });
});
