// Claude's scripts tool on an open design: it keeps the design's scripts (save, list, read, replace, delete), runs code
// through the kerf API and tells Claude what the run made, and a run waiting for a design that has been closed doesn't
// start. The app runs scripts in a sandboxed frame; here the same prelude and messages run in this thread.

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/app/ui", async (orig) => ({ ...(await orig<typeof import("../src/app/ui")>()), toast: () => 0 }));
vi.mock("../src/scripts/sandbox", async () => {
  const { runHere } = await import("../src/scripts/local");
  return { runInSandbox: (code: string, session: import("../src/scripts/session").ScriptSession) => ({ stop: () => session.finish("stopped"), done: runHere(code, session) }) };
});

import { createProject, openProject, projectScripts, useProject } from "../src/app/project";
import { outputText, runScriptTool } from "../src/ai/scriptTool";
import { runScript, useScripts } from "../src/scripts/runtime";
import type { ScriptOutput } from "../src/scripts/session";

const SRC = ['design "Bracket"', "param width = 40", "param height = 12.5", "", "part arm {", "  body box(width, 10, height)", "}"].join("\n");
const text = (o: { content: unknown } | null) => String(o?.content);
const tool = (input: object) => runScriptTool("scripts", input);

describe("Claude's scripts tool", () => {
  beforeAll(async () => {
    const p = await createProject("blank", "Bracket", SRC);
    await openProject(p.id);
  });

  it("keeps the design's scripts: save, list, read, replace by name and delete", async () => {
    expect(text(await tool({ action: "list" }))).toBe("The design has no scripts yet.");
    const saved = await tool({ action: "save", name: "Widths", code: "return 1" });
    expect(saved?.isError).toBeFalsy();
    expect(text(saved)).toBe("Saved “Widths” (1 line) in the design's Scripts tab.");
    expect(projectScripts().map((s) => s.name)).toEqual(["Widths"]);
    // the same name in other letters replaces it, keeping its name
    const again = await tool({ action: "save", name: "widths", code: "const d = await kerf.design();\nreturn d.name", on_change: true });
    expect(text(again)).toMatch(/^Replaced “Widths” \(2 lines\).*runs after each change/);
    expect(projectScripts()).toHaveLength(1);
    expect(projectScripts()[0]).toMatchObject({ name: "Widths", onChange: true, code: "const d = await kerf.design();\nreturn d.name" });
    expect(text(await tool({ action: "list" }))).toBe("The design's scripts:\n- “Widths”: 2 lines, runs after each change");
    expect(text(await tool({ action: "read", name: "Widths" }))).toBe("“Widths” (runs after each change):\nconst d = await kerf.design();\nreturn d.name");
    // off again when asked; kept as it was when not said
    await tool({ action: "save", name: "Widths", code: "return 3", on_change: false });
    expect(projectScripts()[0].onChange).toBeUndefined();
    const missing = await tool({ action: "read", name: "Lengths" });
    expect(missing?.isError).toBe(true);
    expect(text(missing)).toContain("No script called “Lengths”");
    expect((await tool({ action: "save", name: "Empty", code: "  " }))?.isError).toBe(true);
    expect(text(await tool({ action: "delete", name: "widths" }))).toBe("Deleted the script “Widths”.");
    expect(projectScripts()).toEqual([]);
    expect(useProject.getState().current?.scripts).toBeUndefined();
  });

  it("runs code through the kerf API and tells Claude what it made", async () => {
    const out = await tool({
      action: "run",
      name: "Sizes",
      code: [
        "const p = await kerf.params();",
        'console.log("width " + p.width);',
        'console.warn("just a warning");',
        'await kerf.table([{ width: p.width, height: p.height }], "Sizes");',
        'await kerf.check("Narrow", p.width < 50, p.width + " mm");',
        'await kerf.file("sizes.json", JSON.stringify(p));',
        "return p.width * 2;",
      ].join("\n"),
    });
    expect(out?.isError).toBeFalsy();
    const t = text(out);
    expect(t).toMatch(/^Ran “Sizes” in \d+ (ms|\.\d s): done\./);
    expect(t).toContain("Returned: 80");
    expect(t).toContain("Checks:\n- pass: Narrow (40 mm)");
    expect(t).toContain("Table “Sizes”, 1 row:\nwidth,height\n40,12.5");
    expect(t).toMatch(/Files, which the user downloads from the Scripts tab .*: sizes\.json \(1 kB\)\./);
    expect(t).toContain("Log (2 lines):\nwidth 40\n[warn] just a warning");
    expect(out?.card).toMatchObject({ title: "Ran the script “Sizes”", detail: "1 table, 1 file, 1 check" });
    // the run shows in the Scripts tab as Claude's, with its code
    const st = useScripts.getState();
    expect(st).toMatchObject({ opened: true, selected: "claude", claude: { name: "Sizes" } });
    expect(st.outputs.claude.status).toBe("done");
    // and nothing in the design changed
    expect(useProject.getState().current?.source).toBe(SRC);
  });

  it("gives the error and the line it came from, and runs a saved script by name", async () => {
    const bad = await tool({ action: "run", code: "const a = 1;\nawait kerf.variant({ length: a });" });
    expect(bad?.isError).toBe(true);
    expect(text(bad)).toContain('Error at line 2: The design has no parameter called "length". Its parameters: width, height.');
    expect(bad?.card).toMatchObject({ title: "The script “Claude's script” stopped", status: "error" });

    await tool({ action: "save", name: "Mass", code: "const d = await kerf.params();\nreturn Object.keys(d).join(' ');" });
    const ran = await tool({ action: "run", name: "mass" });
    expect(text(ran)).toContain("Returned: width height");
    const id = projectScripts()[0].id;
    expect(useScripts.getState().selected).toBe(`script:${id}`);
    expect(useScripts.getState().outputs[`script:${id}`].status).toBe("done");
    expect((await tool({ action: "run", name: "Nothing like it" }))?.isError).toBe(true);
    expect((await tool({ action: "run" }))?.isError).toBe(true);
  });

  it("doesn't start a run for a design that is no longer open", async () => {
    const o = await runScript("script:x", "Late", "kerf.log('ran'); return 1", { project: "prj_closed" });
    expect(o).toMatchObject({ status: "stopped", lines: [], calls: 0 });
  });

  it("says when a run made nothing, and cuts a long log down to its start and end", () => {
    const base: ScriptOutput = { status: "done", lines: [], tables: [], files: [], checks: [], calls: 0, builds: 0, startedAt: 0, ms: 1500 };
    expect(outputText("Quiet", base)).toBe("Ran “Quiet” in 1.5 s: done.\n\nIt made no output: log with console.log, show rows with kerf.table, or return a value.");
    const long = outputText("Chatty", { ...base, builds: 3, changed: true, lines: Array.from({ length: 200 }, (_, i) => ({ level: "log" as const, text: `line ${i}` })) });
    expect(long).toContain("It built 3 other readings of the design.");
    expect(long).toContain("It changed the design, kept as one version the user can undo.");
    expect(long).toContain("line 59\n… 120 lines left out …\nline 180");
    expect(long).not.toContain("line 60\n");
  });
});
