import { describe, expect, it } from "vitest";
import { fixture } from "./occt";
import { projectFile, backupFile, readImportFile } from "../src/persist/files";
import { gzip, sha256Hex, toBase64 } from "../src/persist/assets";
import { IMPORT_META_VERSION, type ImportMeta, type ProjectImport } from "../src/kernel/imports";
import { evaluate } from "../src/lang/evaluator";
import { importsReference } from "../src/ai/importTools";

const file = (name: string, text: string) => new File([text], name);
const step = fixture("devboard.step");

const meta: ImportMeta = {
  version: IMPORT_META_VERSION,
  file: "devboard.step",
  bytes: step.byteLength,
  title: "DevBoard",
  bodies: [{ name: "PCB‮ evil", product: "PCB", kind: "solid", color: "#006626", volume: 3788, area: 5000, faces: 10, bbox: [[-30, -20, 0], [30, 20, 1.6]], center: [0, 0, 0.8] }],
  cylinders: [{ body: 0, d: 3.2, hole: true, start: [26, 16, 0], end: [26, 16, 1.6], sweep: 1 }],
  bbox: [[-30, -20, 0], [30, 20, 1.6]],
  warnings: [],
  ms: 10,
};

async function packed() {
  const hash = await sha256Hex(step);
  const imp: ProjectImport = { name: "devboard", hash, file: "devboard.step", size: step.byteLength, addedAt: 1, meta };
  return { hash, imp, asset: { hash, encoding: "gzip" as const, data: toBase64(await gzip(step)) } };
}

describe("project files with imported STEP files", () => {
  it("round-trips the file bytes and the analysis", async () => {
    const { hash, imp, asset } = await packed();
    const text = projectFile("Case", 'design "Case"', "blank", 1, [], [imp], [asset]);
    expect(JSON.parse(text).version).toBe(2);
    const r = await readImportFile(file("case.kerfproj", text));
    expect(r.warnings).toEqual([]);
    expect(r.assets.get(hash)).toEqual(step);
    const [p] = r.projects;
    expect(p.imports).toHaveLength(1);
    expect(p.imports[0].meta?.bodies[0].name).toBe("PCB evil");
    expect(p.imports[0].meta?.cylinders[0].d).toBe(3.2);
  });

  it("writes version 1 when nothing is imported, so older Kerf builds can open it", () => {
    expect(JSON.parse(projectFile("A", "", "blank", 1, [])).version).toBe(1);
  });

  it("drops an embedded file whose bytes do not match its hash", async () => {
    const { imp, asset } = await packed();
    const other = "0".repeat(64);
    const text = projectFile("Case", "", "blank", 1, [], [{ ...imp, hash: other }], [{ ...asset, hash: other }]);
    const r = await readImportFile(file("case.kerfproj", text));
    expect(r.assets.size).toBe(0);
    expect(r.projects[0].imports).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/damaged/);
  });

  it("recomputes analysis from another version instead of trusting it", async () => {
    const { imp, asset } = await packed();
    const text = projectFile("Case", "", "blank", 1, [], [{ ...imp, meta: { ...meta, version: 999 } }], [asset]);
    const r = await readImportFile(file("case.kerfproj", text));
    expect(r.projects[0].imports[0].meta).toBeNull();
  });

  it("shares one copy of a file between projects in a backup", async () => {
    const { hash, imp, asset } = await packed();
    const one = JSON.parse(projectFile("A", "", "blank", 1, [], [imp], []));
    const text = backupFile([one, { ...one, name: "B" }], [asset]);
    const r = await readImportFile(file("all.kerfbackup", text));
    expect(r.projects.map((p) => p.imports.length)).toEqual([1, 1]);
    expect([...r.assets.keys()]).toEqual([hash]);
  });
});

describe("the assistant's reference for imports", () => {
  it("has an example that evaluates", () => {
    const example = importsReference().split("Example:\n")[1];
    const src = `design "x"\ncomponent board = step("devboard") { at: (0, 0, 10) }\n${example}`;
    const m = evaluate(src, { imports: { devboard: { name: "devboard", hash: "h", meta } } });
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(m.parts.find((p) => p.id === "tray")?.recipe.ops.length).toBe(2);
  });
});
