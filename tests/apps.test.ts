// Apps: control rooms and live views declared in the design file. The app
// block's language, the signal expressions, reading the firmware's lines,
// the signal store, the simulated twin and the standalone export.

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { compile, ExprError } from "../src/apps/expr";
import { lineReader, parseColumns } from "../src/apps/lines";

const MACHINE = `design "Fan rig"
component ctrl = lib.controller("arduino_uno") { at: (0, 0, 0) }
firmware brain { board: ctrl }
`;

describe("the app block", () => {
  it("reads an app with telemetry, values, panels and controls", () => {
    const m = evaluate(`${MACHINE}
app "Bench" {
  baud: 57600
  hello: "log on"
  telemetry: [csv("T", "ms mode x:µm y:µm rpm")]
  derive: [derive("r", "hypot(x, y)", unit: "µm")]
  commands: ["start", "stop"]
  panels: [
    readout("Now", [signal("rpm", max: 6000, warn: "rpm > 5000"), "r"], big: true),
    chart("Position", ["x", "y"], window: 20s),
    scope("Top", "x", "y", range: 500),
    controls("Run", [button("Start", "start", tone: "accent", key: "s"), slider("Speed", "speed {}", max: 100, unit: "%"), toggle("Log", "log on", "log off")]),
    lamps("Status", [lamp("Running", "mode == 2", color: "green", off: "stopped")]),
    console(),
    custom("Mine", code: """
      function draw(g) {
        g.ctx.fillRect(0, 0, g.w, g.h);
      }
    """, uses: ["x"]),
  ]
}`);
    const errs = m.diagnostics.filter((d) => d.severity === "error");
    expect(errs).toEqual([]);
    const app = m.apps![0];
    expect(app.name).toBe("Bench");
    expect(app.baud).toBe(57600);
    expect(app.hello).toEqual(["log on"]);
    expect(app.telemetry[0]).toEqual({ kind: "csv", prefix: "T", sep: ",", columns: [{ name: "ms" }, { name: "mode" }, { name: "x", unit: "µm" }, { name: "y", unit: "µm" }, { name: "rpm" }] });
    expect(app.derive[0]).toMatchObject({ name: "r", expr: "hypot(x, y)", unit: "µm" });
    expect(app.panels.map((p) => p.kind)).toEqual(["readout", "chart", "scope", "controls", "lamps", "console", "custom"]);
    const ro = app.panels[0];
    expect(ro.kind === "readout" && ro.signals[0]).toMatchObject({ expr: "rpm", max: 6000, warn: "rpm > 5000" });
    const ch = app.panels[1];
    expect(ch.kind === "chart" && ch.window).toBe(20);
    const cu = app.panels[6];
    expect(cu.kind === "custom" && cu.code).toBe("function draw(g) {\n  g.ctx.fillRect(0, 0, g.w, g.h);\n}");
    // each panel knows where it is written, for the builder's edits
    const src = m.blocks.find((b) => b.kind === "app");
    expect(src?.name).toBe("Bench");
    for (const p of app.panels) expect(p.span!.end).toBeGreaterThan(p.span!.start);
    // no scenario, so no twin
    expect(app.twin).toBeNull();
  });

  it("explains mistakes in the block", () => {
    const bad = (body: string) =>
      evaluate(`${MACHINE}app "A" {\n${body}\n}`)
        .diagnostics.filter((d) => d.severity === "error")
        .map((d) => d.message)
        .join("\n");
    expect(bad(`panels: [readout("X", "rpm +")]`)).toMatch(/readout\(\): signals "rpm \+": the expression stops too soon/);
    expect(bad(`panels: [readout("X", "foo(rpm)")]`)).toMatch(/there is no function "foo"/);
    expect(bad(`colour: 1\npanels: []`)).toMatch(/Unknown app property "colour"/);
    expect(bad(`telemetry: [csv("T", "a a")]\npanels: []`)).toMatch(/named twice/);
    expect(bad(`twin: "Nope"\npanels: []`)).toMatch(/twin: there is no scenario "Nope"/);
    expect(bad(`panels: [chart("C", [])]`)).toMatch(/empty list/);
    expect(bad("")).toMatch(/needs panels/);
    expect(bad(`panels: [custom("C", code: "1 + 1")]`)).toMatch(/function draw\(g\)/);
  });
});

describe("signal expressions", () => {
  const env = (vals: Record<string, number | string>, hist: Record<string, number[]> = {}) => ({
    get: (n: string) => vals[n],
    window: (n: string) => {
      const v = hist[n] ?? [];
      return { t: v.map((_, i) => i * 0.1), v, n: v.length };
    },
  });
  const run = (src: string, vals: Record<string, number | string> = {}, hist?: Record<string, number[]>) => compile(src).run(env(vals, hist));

  it("does arithmetic, comparisons and functions", () => {
    expect(run("drag / 100", { drag: 2000 })).toBe(20);
    expect(run("-x^2", { x: 3 })).toBe(-9);
    expect(run("2 ^ 3 ^ 2")).toBe(512);
    expect(run("hypot(x, y)", { x: 3, y: 4 })).toBe(5);
    expect(run("mode == 2 && z > -500 ? 1 : 0", { mode: 2, z: -10 })).toBe(1);
    expect(run("tunnel.drag * 1000", { "tunnel.drag": 0.02 })).toBeCloseTo(20);
    expect(run("clamp(v, 0, 10)", { v: 14 })).toBe(10);
    expect(run("round(pi, 2)")).toBe(3.14);
  });

  it("reads missing signals as NaN, and comparisons with them as false", () => {
    expect(run("rpm * 2")).toBeNaN();
    expect(run("rpm > 3")).toBe(0);
    expect(run("!(rpm > 3)")).toBe(1);
  });

  it("compares and searches text", () => {
    expect(run("state == 'floating'", { state: "floating" })).toBe(1);
    expect(run("contains(fault, 'sensor')", { fault: "Field sensor not answering" })).toBe(1);
    expect(run("starts(state, 'fault')", { state: "fault (sensor)" })).toBe(1);
  });

  it("works over a signal's recent history", () => {
    expect(run("avg(x, 2)", {}, { x: [1, 2, 3, 4] })).toBe(2.5);
    expect(run("highest(x)", {}, { x: [1, 7, 3] })).toBe(7);
    expect(run("spread(x)", {}, { x: [1, 7, 3] })).toBe(6);
    expect(run("rate(x)", {}, { x: [0, 1, 2, 3] })).toBeCloseTo(10);
    expect(compile("avg(x, 2) + rms(y)").windows).toEqual({ x: 2, y: 1 });
    expect(compile("avg(x, 2) + y").names.sort()).toEqual(["x", "y"]);
  });

  it("points at the mistake", () => {
    const err = (s: string) => {
      try {
        compile(s);
      } catch (e) {
        return e as ExprError;
      }
      throw new Error("compiled");
    };
    expect(err("x +").message).toMatch(/stops too soon/);
    expect(err("x y").message).toMatch(/left over/);
    expect(err("avg(2)").message).toMatch(/signal's name first/);
    expect(err("x $ 2").at).toBe(2);
  });
});

describe("reading the firmware's lines", () => {
  it("reads csv lines by their first word", () => {
    const read = lineReader([{ kind: "csv", prefix: "T", columns: parseColumns("ms mode x y"), sep: "," }]);
    expect(read("T,1200,2,-31,12")).toEqual({ ms: 1200, mode: 2, x: -31, y: 12, line: "T,1200,2,-31,12" });
    expect(read("S,1,2,3")).toEqual({ line: "S,1,2,3" });
  });

  it("reads key=value pairs, JSON, states and faults", () => {
    const read = lineReader([{ kind: "json", prefix: "" }, { kind: "keys", prefix: "" }]);
    expect(read('{"a": 1, "b": {"c": 2}, "ok": true}')).toMatchObject({ a: 1, "b.c": 2, ok: 1 });
    expect(read("speed: 12.5, rpm=3000 note: hello")).toMatchObject({ speed: 12.5, rpm: 3000 });
    expect(read("state: floating")).toMatchObject({ state: "floating" });
    expect(read("FAULT: field sensor not answering. Coils off")).toMatchObject({ fault: "field sensor not answering. Coils off" });
    // help text with colons but no numbers gives no signals
    expect(read("launch: lift the model")).toEqual({ line: "launch: lift the model" });
  });
});
