// Claude's firmware tools: reading a block's code (Kerf's or its own) with the compile check, writing and editing
// its own code, with the first mistake and its line coming back after each change, and the report of a debug run:
// breakpoints, watches, logpoints and what the logic analyser saw on the pins.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDesign } from "../src/core/engine";
import { useProject } from "../src/app/project";
import { withOwnCode } from "../src/app/firmwareCode";
import { evaluate } from "../src/lang/evaluator";
import { runFirmwareTool, debugReport, blockNamed } from "../src/ai/firmwareTools";
import { runSpec } from "../src/sim/build";
import type { DebugSpec } from "../src/sim/mcu";
import type { DebugRun } from "../src/sim/debugRuntime";

const SRC = `design "Lights"
component ctrl = lib.controller("arduino_nano") { at: (0, 0, 0) }
component psu = lib.psu("usb_c_power_5v") { at: (200, 0, 0) }
component stick = lib.led("neopixel_stick_8") { at: (100, 0, 0) }
net GND: psu.GND, ctrl.GND, stick.GND
net V5: psu.VBUS, ctrl.V5, stick.V5
wire ctrl.D6 -> stick.DIN
firmware lights { board: ctrl }
scenario "Glow" { world: sim.bench() firmware: lights duration: 2s expect "no mistakes": faults == 0 }`;

const SKETCH = `#include <FastLED.h>
CRGB leds[8];
int frames = 0;
void setup() {
  Serial.begin(115200);
  pinMode(13, OUTPUT);
  FastLED.addLeds<WS2812B, 6, GRB>(leds, 8);
}
void loop() {
  fill_rainbow(leds, 8, frames * 4, 16);
  FastLED.show();
  digitalWrite(13, frames & 1);
  frames++;
  delay(20);
}
`;

const text = (o: { content: unknown }) => String(o.content);

let unsub: (() => void) | null = null;
beforeEach(() => {
  const s = useDesign.getState();
  useDesign.setState({ source: SRC, model: evaluate(SRC), reportRev: s.rev });
  useProject.setState({ current: { id: "p1", name: "Lights", source: SRC, firmware: [] } as never });
  // no geometry kernel here: the checks "finish" as soon as the design changes
  unsub?.();
  unsub = useDesign.subscribe((st) => {
    if (st.rev > st.reportRev) useDesign.setState({ reportRev: st.rev, stage: "done" });
  });
});
afterEach(() => {
  unsub?.();
  unsub = null;
});

describe("read_firmware and edit_firmware", () => {
  it("reads Kerf's code, then writes the block's own and compiles it after each change", async () => {
    const kerf = await runFirmwareTool("read_firmware", {});
    expect(kerf?.isError).toBeFalsy();
    expect(text(kerf!)).toContain("runs the code Kerf generates");
    expect(text(kerf!)).toMatch(/Compiles for Arduino Nano: RAM \d+ of 2048 bytes/);

    const own = await runFirmwareTool("edit_firmware", { block: "lights", action: "use_own" });
    expect(own?.isError).toBeFalsy();
    expect(useDesign.getState().source).toContain('code: "own"');
    expect(blockNamed("lights")).toMatchObject({ own: true });

    const wrote = await runFirmwareTool("edit_firmware", { block: "lights", action: "write", file: "lights.ino", content: SKETCH });
    expect(wrote?.isError).toBeFalsy();
    expect(text(wrote!)).toMatch(/Compiles for Arduino Nano/);
    const ino = useProject.getState().current!.firmware!.find((r) => r.block === "lights")!.files.find((f) => f.path === "lights.ino");
    expect(ino?.content).toBe(SKETCH);

    // a mistake comes back with its line and the lines round it
    const broke = await runFirmwareTool("edit_firmware", { block: "lights", action: "edit", file: "lights.ino", old: "  frames++;", new: "  frame++;" });
    expect(text(broke!)).toMatch(/Does not compile for Arduino Nano: lights\.ino:13: "frame" is not declared/);
    expect(text(broke!)).toContain("13>   frame++;");
    const twice = await runFirmwareTool("edit_firmware", { block: "lights", action: "edit", file: "lights.ino", old: "frame", new: "x" });
    expect(twice?.isError).toBe(true);
    expect(text(twice!)).toMatch(/occurs \d+ times/);
    const fixed = await runFirmwareTool("edit_firmware", { block: "lights", action: "edit", file: "lights.ino", old: "  frame++;", new: "  frames++;" });
    expect(text(fixed!)).toMatch(/^Edited lights\.ino\.\nCompiles/);

    const read = await runFirmwareTool("read_firmware", { block: "lights", from: 9, to: 11 });
    expect(text(read!)).toContain('runs its own code (code: "own")');
    expect(text(read!)).toContain(" 9| void loop() {");
    expect(text(read!)).toContain("11|   FastLED.show();");

    expect((await runFirmwareTool("edit_firmware", { block: "lights", action: "write", file: "../evil.ino", content: "x" }))?.isError).toBe(true);
    expect((await runFirmwareTool("edit_firmware", { block: "nope", action: "use_own" }))?.isError).toBe(true);
    const back = await runFirmwareTool("edit_firmware", { block: "lights", action: "use_kerf" });
    expect(text(back!)).toContain("runs Kerf's code again");
    expect(useDesign.getState().source).not.toContain('code: "own"');
  });
});

describe("debug_firmware's report", () => {
  it("gives the stops with their variables and what the pins did", async () => {
    await runFirmwareTool("edit_firmware", { block: "lights", action: "write", file: "lights.ino", content: SKETCH });
    const model = useDesign.getState().model!;
    const def = model.scenarios!.find((d) => d.label === "Glow")!;
    const spec: DebugSpec = {
      breakpoints: [
        { id: "b1", file: "lights.ino", line: 11, cond: "frames == 5" },
        { id: "b2", file: "lights.ino", line: 13, log: "frame {frames} led0 red {leds[0].r}" },
      ],
      watches: ["leds[0].g", "frames * 2"],
      breakOnFault: true,
      maxStops: 40,
      traceSteps: 300,
    };
    const res = runSpec(def.spec, withOwnCode(model.machine!), model.name, { variants: ["expected"], debug: spec, signals: {} });
    const v = res.variants[0];
    expect(v.error).toBeUndefined();
    const run: DebugRun = { label: "Glow", variant: "expected", block: "lights", key: "k", spec, status: "done", progress: 1, result: v.debug, signals: v.signals, run: v, startedAt: 0 };
    const b = blockNamed("lights");
    if (typeof b === "string") throw new Error(b);
    const report = debugReport(run, b, spec, { pins: ["D13"], buses: ["uart"] });
    expect(report).toContain('Debug run of "Glow" (expected), firmware lights (its own code)');
    expect(report).toMatch(/Breakpoint b1 at lights\.ino:11 if frames == 5: hit 1 times/);
    expect(report).toMatch(/breakpoint b1 at lights\.ino:11 in loop\(\)/);
    expect(report).toMatch(/watches: leds\[0\]\.g = \d+, frames \* 2 = 10/);
    expect(report).toMatch(/globals: .*frames = 5/);
    expect(report).toMatch(/frame 0 led0 red \d+/);
    // D13 toggles every frame: about 20 ms plus the frame's time on the wire, so about 24 rising edges a second
    expect(report).toMatch(/D13: \d+ rising edges, \d+(\.\d+)? a second on average/);
  });
});
