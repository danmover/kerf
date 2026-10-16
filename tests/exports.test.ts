import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import type { MeshData } from "../src/kernel/build";
import type { CheckItem, CheckReport } from "../src/core/checks";
import { crc32, unzip, zip } from "../src/persist/zip";
import { IDENTITY, layoutPlate, meshBounds, threeMfFiles, threeMfModel, translation, weld, writeObj, type PlacedMesh } from "../src/persist/meshFormats";
import { attention, briefSummary, designStats, massText, sizeText } from "../src/app/designStats";
import { designReportHtml } from "../src/app/report";
import { markSvg } from "../src/ui/logoGeometry";

const enclosure = () => evaluate(readFileSync(new URL("../src/demos/enclosure.kerf", import.meta.url), "utf8"));
const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b);

/** A 10 mm cube the way the kernel meshes it: four vertices per face, so each face keeps its own normal. */
function cube(s = 10): MeshData {
  const faces: [number[], number[]][] = [
    [[0, 0, -1], [0, 0, 0, 0, s, 0, s, s, 0, s, 0, 0]],
    [[0, 0, 1], [0, 0, s, s, 0, s, s, s, s, 0, s, s]],
    [[0, -1, 0], [0, 0, 0, s, 0, 0, s, 0, s, 0, 0, s]],
    [[0, 1, 0], [0, s, 0, 0, s, s, s, s, s, s, s, 0]],
    [[-1, 0, 0], [0, 0, 0, 0, 0, s, 0, s, s, 0, s, 0]],
    [[1, 0, 0], [s, 0, 0, s, s, 0, s, s, s, s, 0, s]],
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  faces.forEach(([n, p], f) => {
    positions.push(...p);
    for (let i = 0; i < 4; i++) normals.push(...n);
    const b = f * 4;
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices), edges: new Float32Array() };
}

describe("zip", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("round-trips stored and deflated entries", async () => {
    const big = "kerf ".repeat(2000);
    for (const compress of [false, true]) {
      const bytes = await zip([{ name: "a.txt", data: "hello" }, { name: "dir/b.txt", data: big }, { name: "bin", data: new Uint8Array([0, 1, 2, 255]) }], { compress });
      expect(text(bytes.subarray(0, 2))).toBe("PK");
      const files = await unzip(bytes);
      expect(text(files.get("a.txt"))).toBe("hello");
      expect(text(files.get("dir/b.txt"))).toBe(big);
      expect([...files.get("bin")!]).toEqual([0, 1, 2, 255]);
      if (compress) expect(bytes.length).toBeLessThan(big.length / 4);
    }
  });

  it("keeps entries with the same name apart", async () => {
    const files = await unzip(await zip([{ name: "lid.stl", data: "1" }, { name: "LID.stl", data: "2" }, { name: "lid.stl", data: "3" }]));
    expect([...files.keys()]).toEqual(["lid.stl", "LID 2.stl", "lid 3.stl"]);
  });
});

describe("mesh formats", () => {
  it("welds a kernel cube into one closed surface", () => {
    const { positions, triangles } = weld(cube());
    expect(positions.length / 3).toBe(8);
    expect(triangles.length / 3).toBe(12);
    // closed: every edge is shared by exactly two triangles
    const edges = new Map<string, number>();
    for (let t = 0; t < triangles.length; t += 3)
      for (let k = 0; k < 3; k++) {
        const a = triangles[t + k];
        const b = triangles[t + ((k + 1) % 3)];
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    expect([...edges.values()].every((n) => n === 2)).toBe(true);
  });

  it("measures a mesh's bounds", () => {
    expect(meshBounds(cube(12))).toEqual({ min: [0, 0, 0], max: [12, 12, 12] });
    expect(meshBounds({ ...cube(), positions: new Float32Array() })).toEqual({ min: [0, 0, 0], max: [0, 0, 0] });
  });

  it("writes a 3MF with one object per mesh, colours and placements", async () => {
    const mesh = cube();
    const items: PlacedMesh[] = [
      { name: "foot", color: "#ff8800", material: "PETG", mesh, matrix: translation(0, 0, 0) },
      { name: "foot", color: "#ff8800", material: "PETG", mesh, matrix: translation(20, 5, 0) },
      { name: "cap <top>", color: "#08f", material: "PLA", mesh: cube(5), matrix: IDENTITY },
    ];
    const xml = threeMfModel(items, "Feet & caps");
    expect(xml.match(/<object /g)).toHaveLength(2);
    expect(xml.match(/<item /g)).toHaveLength(3);
    expect(xml).toContain('displaycolor="#FF8800FF"');
    expect(xml).toContain('displaycolor="#0088FFFF"');
    expect(xml).toContain('transform="1 0 0 0 1 0 0 0 1 20 5 0"');
    expect(xml).toContain('name="cap &lt;top&gt;"');
    expect(xml).toContain("<metadata name=\"Title\">Feet &amp; caps</metadata>");
    expect(xml.match(/<vertex /g)).toHaveLength(16);

    const files = await unzip(await zip(threeMfFiles(items, "t")));
    expect([...files.keys()]).toEqual(["[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model"]);
    expect(text(files.get("_rels/.rels"))).toContain('Target="/3D/3dmodel.model"');
  });

  it("writes OBJ in assembly coordinates with a material per look", () => {
    const { obj, mtl } = writeObj(
      [
        { name: "a part", color: "#ffffff", material: "PLA", mesh: cube(), matrix: translation(100, 0, 0) },
        { name: "b", color: "#ffffff", material: "PLA", mesh: cube(), matrix: IDENTITY },
      ],
      "design.mtl",
      "Test",
    );
    expect(obj).toContain("mtllib design.mtl");
    expect(obj).toContain("o a_part");
    expect(obj).toContain("v 110 10 10");
    expect(obj.match(/^v /gm)).toHaveLength(48);
    expect(obj.match(/^f /gm)).toHaveLength(24);
    // the second object's faces point past the first object's 24 vertices
    expect(obj.split("o b")[1]).toMatch(/^f 25\/\/25 /m);
    expect(mtl.match(/^newmtl /gm)).toHaveLength(1);
    expect(mtl).toContain("Kd 1 1 1");
  });

  it("lays parts out on a plate in rows, deepest first, without overlaps", () => {
    const sizes = [
      { w: 100, d: 40 },
      { w: 100, d: 80 },
      { w: 50, d: 20 },
      { w: 300, d: 10 },
    ];
    const at = layoutPlate(sizes, 220, 5);
    expect(at[1]).toEqual({ x: 0, y: 0 });
    expect(at[0]).toEqual({ x: 105, y: 0 });
    expect(at[2]).toEqual({ x: 0, y: 85 });
    // wider than the bed: it still gets a row of its own
    expect(at[3].x).toBe(0);
    for (let i = 0; i < sizes.length; i++)
      for (let j = i + 1; j < sizes.length; j++) {
        const a = { ...at[i], ...sizes[i] };
        const b = { ...at[j], ...sizes[j] };
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.d <= b.y || b.y + b.d <= a.y;
        expect(apart).toBe(true);
      }
  });
});

describe("design stats", () => {
  const model = enclosure();

  it("counts what is made and bought, and sums mass and size", () => {
    const s = designStats(model, () => ({ volume: 1000, bbox: [[0, 0, 0], [10, 10, 10]] }));
    expect(s.make).toBe(2);
    expect(s.buy).toBeGreaterThanOrEqual(6);
    expect(s.pending).toBe(0);
    expect(s.mass).toBeGreaterThan(0);
    expect(s.size).not.toBeNull();
    expect(s.materials.map((m) => m.mass)).toEqual([...s.materials.map((m) => m.mass)].sort((a, b) => b - a));
    expect(s.materials.find((m) => m.name.toLowerCase().includes("petg"))?.count).toBe(2);
  });

  it("counts solids still building and leaves the size unknown", () => {
    const s = designStats(model, () => undefined);
    expect(s.size).toBeNull();
    expect(s.mass).toBe(0);
    expect(s.pending).toBe(model.parts.filter((p) => !p.hidden).length);
  });

  it("restricts to a selection", () => {
    const s = designStats(model, () => ({ volume: 1000, bbox: [[0, 0, 0], [10, 10, 10]] }), (p) => p.id === "lid");
    expect([s.make, s.buy]).toEqual([1, 0]);
  });

  it("reads each brief use's status from the checks", () => {
    const item = (id: string, status: CheckItem["status"]): CheckItem => ({ id, status, category: "brief", title: id, detail: "", basis: "geometry" });
    const report: CheckReport = { items: [item("use:power", "fail"), item("use:hold_board", "pass"), item("bed", "fail")], counts: { pass: 1, fail: 2, warn: 0, pending: 0, info: 0 }, ms: 1 };
    const b = briefSummary(model, report)!;
    const by = Object.fromEntries(b.uses.map((u) => [u.id, u]));
    expect(by.power.status).toBe("fail");
    expect(by.hold_board.status).toBe("pass");
    expect(by.printable.status).toBe("unchecked");
    expect(by.service.assumed).toBe(true);
    expect(b.fails.map((f) => f.id)).toEqual(["bed"]);
    expect(b.toConfirm).toBeGreaterThan(0);
    expect(briefSummary(evaluate('design "x"\npart a = box(1, 1, 1)'), null)).toBeNull();
  });

  it("puts failures before warnings and hard limits before soft ones", () => {
    const item = (id: string, status: CheckItem["status"], level?: "soft"): CheckItem => ({ id, status, level, category: "requirement", title: id, detail: "", basis: "parameters" });
    const report: CheckReport = { items: [item("w-soft", "warn", "soft"), item("ok", "pass"), item("w", "warn"), item("f", "fail")], counts: { pass: 1, fail: 1, warn: 2, pending: 0, info: 0 }, ms: 1 };
    expect(attention(report).map((i) => i.id)).toEqual(["f", "w", "w-soft"]);
    expect(attention(report, 1).map((i) => i.id)).toEqual(["f"]);
    expect(attention(null)).toEqual([]);
  });

  it("writes sizes and masses the way people read them", () => {
    expect(sizeText([92.04, 70, 34.56])).toBe("92 × 70 × 34.6");
    expect(sizeText([120.4, 8, 0.25])).toBe("120 × 8 × 0.3");
    expect(sizeText(null)).toBe("—");
    expect(massText(4.25)).toBe("4.3 g");
    expect(massText(48.4)).toBe("48 g");
    expect(massText(1320)).toBe("1.32 kg");
    expect(massText(0)).toBe("—");
  });
});

describe("design report", () => {
  const model = enclosure();
  const stats = designStats(model, () => ({ volume: 1000, bbox: [[0, 0, 0], [10, 10, 10]] }));
  const base = { model, report: null, stats, brief: briefSummary(model, null), bom: [], versions: 3, appVersion: "0.1.0", date: new Date("2026-10-16T00:00:00Z"), views: [] };

  it("is one self-contained page with no scripts", () => {
    const html = designReportHtml(base);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("Design report · 2026-10-16 · 3 versions");
    expect(html).toContain("Holds the board on screws");
  });

  it("escapes what the design says and only embeds images Kerf rendered", () => {
    const html = designReportHtml({
      ...base,
      model: { ...model, name: '<img src=x onerror="alert(1)">' },
      hero: "javascript:alert(1)",
      views: [
        { label: "front", url: "data:image/png;base64,iVBORw0KGgo=" },
        { label: "top", url: "data:image/svg+xml;base64,PHN2Zz4=" },
      ],
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(html).not.toContain("image/svg+xml");
  });
});

describe("logo", () => {
  it("draws the mark as a standalone SVG with its own gradient ids", () => {
    const a = markSvg(40, 0.06, "a");
    expect(a.startsWith("<svg")).toBe(true);
    expect(a).toContain('width="40"');
    expect(a).toContain("url(#a-");
    expect(markSvg(40, 0.06, "b")).not.toContain("url(#a-");
  });
});
