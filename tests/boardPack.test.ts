import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "../src/core/model";
import { evaluate } from "../src/lang/evaluator";
import { boardSpecs } from "../src/machine/boards";
import { bareBoard, boardProblems, capCode, partGroups, boardParts } from "../src/machine/boardPack";
import { buildPack, type PackFile } from "../src/machine/pack";
import { routeBoard, type RoutedBoard } from "../src/machine/pcb";

// The Practice Amp template: one through-hole board of 58 parts. It is evaluated
// without geometry and routed once (about a second); every pack below reuses that route.
const AMP = readFileSync(join(__dirname, "../src/demos/practice-amp.kerf"), "utf8");

const text = (files: PackFile[], path: string) => {
  const f = files.find((x) => x.path === path);
  if (!f) throw new Error(`no ${path} in the pack: ${files.map((x) => x.path).join(", ")}`);
  return typeof f.data === "string" ? f.data : new TextDecoder().decode(f.data);
};

/** Names and contents of a STORE zip, read from its central directory. */
function unzip(data: Uint8Array): Map<string, string> {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = data.length - 22;
  while (end >= 0 && dv.getUint32(end, true) !== 0x06054b50) end--;
  const count = dv.getUint16(end + 10, true);
  let o = dv.getUint32(end + 16, true);
  const out = new Map<string, string>();
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    expect(dv.getUint32(o, true)).toBe(0x02014b50);
    const size = dv.getUint32(o + 20, true);
    const nameLen = dv.getUint16(o + 28, true);
    const extra = dv.getUint16(o + 30, true);
    const comment = dv.getUint16(o + 32, true);
    const local = dv.getUint32(o + 42, true);
    const name = dec.decode(data.subarray(o + 46, o + 46 + nameLen));
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    out.set(name, dec.decode(data.subarray(start, start + size)));
    o += 46 + nameLen + extra + comment;
  }
  return out;
}

const LAYERS: [string, string][] = [
  [".GTL", "Copper,L1,Top"],
  [".GBL", "Copper,L2,Bot"],
  [".GTS", "Soldermask,Top"],
  [".GBS", "Soldermask,Bot"],
  [".GTO", "Legend,Top"],
  [".GBO", "Legend,Bot"],
  [".GKO", "Profile,NP"],
  ["-PTH.DRL", "Plated,1,2,PTH"],
  ["-NPTH.DRL", "NonPlated,1,2,NPTH"],
];

describe("build pack: circuit boards", () => {
  let model: Model;
  let routed: RoutedBoard;
  let files: PackFile[];
  const dir = "boards/Practice-Amp";

  beforeAll(() => {
    model = evaluate(AMP, { skipGeometry: true });
    expect(model.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const [{ spec }] = boardSpecs(model.machine!);
    routed = routeBoard(spec);
    files = buildPack(model, null, { boards: [routed], date: new Date(2026, 9, 16) });
  });

  it("routes the template's board cleanly", () => {
    expect(routed.unrouted).toEqual([]);
    expect(routed.drc).toEqual([]);
    expect(boardProblems(routed.spec, routed)).toEqual([]);
  });

  it("writes Gerbers and drill files for every layer, loose and zipped", () => {
    for (const [ext, fn] of LAYERS) {
      const g = text(files, `${dir}/gerbers/Practice-Amp${ext}`);
      expect(g).toContain(`TF.FileFunction,${fn}`);
      if (!ext.endsWith(".DRL")) expect(g.trimEnd().endsWith("M02*")).toBe(true);
    }
    // the copper of the route that was handed in, with tracks on both layers
    expect(text(files, `${dir}/gerbers/Practice-Amp.GTL`)).toMatch(/D01\*/);
    expect(text(files, `${dir}/gerbers/Practice-Amp.GBL`)).toMatch(/D01\*/);
    expect(text(files, `${dir}/gerbers/README.txt`)).toContain("HOW TO ORDER");

    const z = files.find((f) => f.path === `${dir}/Practice-Amp-gerbers.zip`)!;
    expect(z.data).toBeInstanceOf(Uint8Array);
    const inZip = unzip(z.data as Uint8Array);
    // files at the root of the zip, as board houses expect
    expect([...inZip.keys()].sort()).toEqual([...LAYERS.map(([ext]) => `Practice-Amp${ext}`), "README.txt"].sort());
    expect(inZip.get("Practice-Amp.GTL")).toBe(text(files, `${dir}/gerbers/Practice-Amp.GTL`));
  });

  it("previews both sides", () => {
    for (const side of ["top", "bottom"]) {
      const svg = text(files, `${dir}/${side}.svg`);
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain(`<title>Practice Amp (${side})</title>`);
      expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    }
  });

  it("lists every part on the board in the parts CSV, grouped by value and part", () => {
    const m = model.machine!;
    const onBoard = m.components.filter((c) => c.pcb?.board === "pcb");
    expect(onBoard.length).toBe(58);
    const csv = text(files, `${dir}/parts.csv`).trim().split("\n");
    expect(csv[0]).toBe("References,Qty,Value,Part,Maker part no.,Footprint,Side,Notes");
    const rows = csv.slice(1).map((l) => {
      const refs = l.split(",")[0].split(" ");
      return { refs, qty: Number(l.split(",")[1]), line: l };
    });
    const listed = new Set(rows.flatMap((r) => r.refs));
    for (const c of onBoard) expect(listed, c.name).toContain(c.ref);
    // three 100k resistors on one line; the 100n film and ceramic capacitors apart
    const r100k = rows.find((r) => r.line.includes(",100k,"))!;
    expect(r100k.refs).toEqual(["R9", "R11", "R12"]);
    expect(r100k.qty).toBe(3);
    const c100n = rows.filter((r) => r.line.includes(",100n,"));
    expect(c100n).toHaveLength(2);
    // the sockets and headers that go with the chips and the Nano
    expect(rows.some((r) => r.line.includes("DIP-8 IC socket") && r.qty === 2)).toBe(true);
    expect(rows.some((r) => r.line.includes("Female header 1 × 15") && r.qty === 2)).toBe(true);
    // a part on one line only (sockets aside)
    const main = rows.filter((r) => !/socket|header/i.test(r.line.split(",")[3]));
    expect(main.reduce((n, r) => n + r.qty, 0)).toBe(58);
  });

  it("writes a soldering guide that names every part, lowest first, with polarity notes", () => {
    const md = text(files, `${dir}/assembly.md`);
    const m = model.machine!;
    for (const c of m.components.filter((x) => x.pcb)) expect(md, c.ref).toMatch(new RegExp(`\\b${c.ref}\\b`));
    // the stages in height order
    const at = (s: string) => {
      const i = md.indexOf(s);
      expect(i, s).toBeGreaterThan(0);
      return i;
    };
    const order = ["Resistors and diodes", "Small capacitors", "IC sockets", "Terminals and switches", "Regulators", "Electrolytic capacitors", "Potentiometers", "Display and modules", "Check the board", "First power-up"].map((h) => at(`. ${h}`));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // polarity and orientation
    expect(md).toContain("**D1, D2** 1N4148 small-signal diode. Band (cathode) toward the square pad");
    expect(md).toMatch(/\*\*C11, C12, C23\*\* 10µ\/16V\. \+ lead \(the longer one\)/);
    expect(md).toMatch(/\*\*U1, U2\*\* DIP-8 IC socket for the TL072[^\n]*Notch toward the pin 1 dot/);
    expect(md).toMatch(/\*\*U3\*\* L7812[^\n]*metal tab/);
    expect(md).toContain("**R9, R11, R12** 100k (brown, black, black, orange, brown)");
    expect(md).toContain("100n ceramic, marked 104");
    // bottom-side parts and the first power-up with the chips out
    expect(md).toMatch(/\*\*RV1\*\* A500k\. \*\*Bottom side\.\*\*/);
    expect(md).toContain("U3 (L7812): pin 3 (OUT) to GND reads about 12 V");
    expect(md).toContain("U1 socket: pin 8 (V+) to pin 4 (V−) reads about 12 V");
    expect(md).not.toContain("PROBLEMS.txt");
    expect(files.some((f) => f.path === `${dir}/PROBLEMS.txt`)).toBe(false);
  });

  it("points the pack's README and assembly guide at the board", () => {
    const readme = text(files, "README.md");
    expect(readme).toContain("| `boards/Practice-Amp/` |");
    expect(readme).toContain("| Circuit boards | Practice Amp: 150 × 80 mm, 58 parts |");
    expect(readme).toContain("`boards/Practice-Amp/Practice-Amp-gerbers.zip`");
    const guide = text(files, "assembly.md");
    expect(guide).toContain("Solder the circuit board");
    expect(guide).toContain("`boards/Practice-Amp/assembly.md`");
    expect(guide).toContain("upload `boards/Practice-Amp/Practice-Amp-gerbers.zip`");
  });

  it("uses a route that is handed in, matched by the copper", () => {
    // a board with no copper stands in for a finished route: the pack must not route again
    const bare = bareBoard(routed.spec);
    const fs = buildPack(model, null, { boards: [bare] });
    expect(text(fs, `${dir}/gerbers/Practice-Amp.GTL`)).not.toMatch(/D01\*/);
  });

  it("names the groups' codes and sockets the way the parts are marked", () => {
    expect(capCode(100e-12)).toBe("101");
    expect(capCode(4.7e-9)).toBe("472");
    expect(capCode(100e-9)).toBe("104");
    expect(capCode(1e-6)).toBe("105");
    expect(capCode(4.7e-12)).toBeUndefined();
    const m = model.machine!;
    const groups = partGroups(boardParts(m, routed.spec, "pcb"));
    expect(groups.find((g) => g.refs.includes("J1") && !g.extra)?.refs).toEqual(["J1", "J2", "J3", "J4", "J5"]);
  });
});

describe("build pack: a board with problems", () => {
  const TINY = `
design "Tiny"
component pcb = lib.circuit_board(w: 30, d: 20, holes: [], title: "Tiny Board")
component r1 = lib.resistor("10k") { on: pcb, at: (12, 10) }
component r2 = lib.resistor("10k") { on: pcb, at: (12, 11) }
component j1 = lib.terminal("terminal_2p") { on: pcb, at: (25, 10), rotate: 90 }
net A: j1.P1, r1.A, r2.A
net B: j1.P2, r1.B, r2.B
`;

  it("still gets its files, and a PROBLEMS.txt listing what to fix", () => {
    const model = evaluate(TINY, { skipGeometry: true });
    expect(model.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const files = buildPack(model, null);
    const dir = "boards/Tiny-Board";
    for (const f of ["Tiny-Board-gerbers.zip", "gerbers/Tiny-Board.GTL", "gerbers/Tiny-Board-PTH.DRL", "top.svg", "bottom.svg", "parts.csv", "assembly.md", "PROBLEMS.txt"]) expect(files.map((x) => x.path)).toContain(`${dir}/${f}`);
    const problems = text(files, `${dir}/PROBLEMS.txt`);
    expect(problems).toContain("do not order this board");
    expect(problems).toMatch(/PLACEMENT \(\d+\)/);
    expect(problems).toContain("R1 and R2 overlap");
    expect(text(files, `${dir}/assembly.md`)).toContain("Not ready to order");
    expect(text(files, "README.md")).toContain("Do not order it until they are fixed");
    expect(text(files, "assembly.md")).toContain("**Do not order the Tiny Board yet:**");
  });
});
