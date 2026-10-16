import { describe, expect, it } from "vitest";
import { bomCsv, readImport, MAX_SOURCE_CHARS } from "../src/persist/files";

const file = (name: string, text: string) => new File([text], name);

describe("imports", () => {
  it("reads plain source, naming the project after the file", async () => {
    const [p] = await readImport(file("bracket.kerf", `design "b"\nparam a = 1`));
    expect(p.name).toBe("bracket");
    expect(p.source).toContain("param a");
  });

  it("reads a project file with history", async () => {
    const proj = { format: "kerf-project", version: 1, name: "Box", source: "design \"Box\"", versions: [{ ts: 1, author: "claude", message: "made it", source: "design \"Box\"" }] };
    const [p] = await readImport(file("box.kerfproj", JSON.stringify(proj)));
    expect(p.name).toBe("Box");
    expect(p.versions).toHaveLength(1);
  });

  it("reads a backup of several projects", async () => {
    const one = { format: "kerf-project", version: 1, name: "A", source: "" };
    const backup = { format: "kerf-backup", version: 1, projects: [one, { ...one, name: "B" }] };
    expect((await readImport(file("all.kerfbackup", JSON.stringify(backup)))).map((p) => p.name)).toEqual(["A", "B"]);
  });

  it("rejects malformed and hostile files", async () => {
    await expect(readImport(file("x.json", "{not json"))).rejects.toThrow(/could not be read/);
    await expect(readImport(file("x.json", JSON.stringify({ format: "kerf-project", version: 3, name: "x", source: "" })))).rejects.toThrow(/not a Kerf project/);
    await expect(readImport(file("x.json", JSON.stringify({ format: "kerf-project", version: 1, name: "x", source: "", versions: [{ ts: 1, author: "admin", message: "", source: "" }] })))).rejects.toThrow();
    await expect(readImport(file("big.kerf", "a".repeat(MAX_SOURCE_CHARS + 1)))).rejects.toThrow(/longer/);
    await expect(readImport(file("bin.kerf", "abc\u0000def"))).rejects.toThrow(/binary/);
  });

  it("reads reference files carried by a project file", async () => {
    const asset = { id: "ast_abc123", kind: "image", mime: "image/jpeg", name: "tube.jpg", data: "AAEC" };
    const proj = { format: "kerf-project", version: 1, name: "Bracket", source: "", assets: [asset] };
    const [p] = await readImport(file("b.kerfproj", JSON.stringify(proj)));
    expect(p.assets).toEqual([asset]);
  });

  it("rejects reference files that are not what they claim", async () => {
    const proj = (a: object) => JSON.stringify({ format: "kerf-project", version: 1, name: "x", source: "", assets: [{ id: "ast_abc123", kind: "image", mime: "image/jpeg", name: "a", data: "AAEC", ...a }] });
    await expect(readImport(file("a.kerfproj", proj({ mime: "text/html" })))).rejects.toThrow(/not a Kerf project/);
    await expect(readImport(file("a.kerfproj", proj({ kind: "pdf" })))).rejects.toThrow(/not a Kerf project/);
    await expect(readImport(file("a.kerfproj", proj({ id: "../../etc" })))).rejects.toThrow(/not a Kerf project/);
    await expect(readImport(file("a.kerfproj", proj({ data: "<script>" })))).rejects.toThrow(/not a Kerf project/);
  });

  it("strips control characters from names", async () => {
    const [p] = await readImport(file("p.kerfproj", JSON.stringify({ format: "kerf-project", version: 1, name: "Evil\u0007Name\u001b[31m", source: "" })));
    expect(p.name).toBe("EvilName[31m");
  });
});

describe("bill of materials CSV", () => {
  it("neutralises spreadsheet formulas", () => {
    const part = (id: string, label: string, material: string, description: string) => ({ id, name: label, kind: "part", label, material, bom: { description } });
    const model = { parts: [part("a", "=HYPERLINK(\"http://x\")", "+cmd", "@SUM(A1)"), part("b", "-1", "PLA", "ok")] };
    const csv = bomCsv(model as never);
    for (const line of csv.trim().split("\n").slice(1)) for (const cell of line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) expect(cell.replace(/^"/, "")).not.toMatch(/^[=+\-@]/);
  });
});
