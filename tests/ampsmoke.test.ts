import { describe, expect, it } from "vitest";
import { fullCheck, problems } from "./helpers/fullcheck";

const SRC = `
design "smoke"
component main = lib.circuit_board(w: 120, d: 50, title: "Smoke") { at: (0, 0, 0) }
component r1 = lib.resistor("4.7k") { on: main, at: (20, 20) }
component r2 = lib.resistor("10") { on: main, at: (20, 30), rotate: 90 }
component c1 = lib.capacitor("100n") { on: main, at: (40, 20) }
component c2 = lib.capacitor("470u", v: 35) { on: main, at: (40, 35) }
component c3 = lib.capacitor("470p") { on: main, at: (55, 20) }
component d1 = lib.diode("diode_1n4148") { on: main, at: (55, 35) }
component d2 = lib.diode("diode_1n5822") { on: main, at: (75, 40) }
component u1 = lib.opamp("tl072") { on: main, at: (70, 20) }
component vr = lib.regulator("l7812") { on: main, at: (90, 20) }
component j1 = lib.terminal("terminal_2p") { on: main, at: (105, 20) }
component gain = lib.pot("B500k") { on: main, at: (20, 8), side: "bottom" }
component nano = lib.controller("arduino_nano_clone") { on: main, at: (60, 8), side: "bottom" }
component oled = lib.display("ssd1306_oled_096") { on: main, at: (100, 35), side: "bottom" }
component sw = lib.switch("tact_6x6_12") { on: main, at: (10, 40), side: "bottom" }
component jack = lib.jack("jack_635_mono") { at: (0, -30, 20), axis: (0, -1, 0) }
component spk = lib.speaker("jensen_mod10_35") { at: (0, 200, 0), axis: (0, -1, 0) }
component knob = lib.knob("knob_davies_1900h") { at: gain.bushing_top, axis: gain.axis }
component amp = lib.amplifier("tpa3116_mono") { at: (200, 0, 0) }
component psu = lib.psu("psu_24v_2a") { at: (300, 0, 0) }
component dc = lib.jack("dc_jack_panel") { at: (40, -30, 20), axis: (0, -1, 0) }
component tog = lib.switch("toggle_spst") { at: (60, -30, 20), axis: (0, -1, 0) }
`;

describe("amp smoke", () => {
  it("builds", async () => {
    const r = await fullCheck(SRC);
    console.log(r.model.diagnostics.map((d) => d.message));
    console.log([...r.buildErrors.entries()]);
    console.log(r.model.machine?.components.map((c) => `${c.name} ${c.ref ?? ""} ${c.valueText ?? ""} ${JSON.stringify(c.pcb ?? {})}`).join("\n"));
    console.log(r.model.machine?.items, r.model.machine?.boards);
    console.log(problems(r.report).join("\n"));
    console.log(r.model.parts.length, "parts", r.ms, "ms");
    const g = r.model.parts.find((p) => p.id === "gain");
    console.log(JSON.stringify(g?.xf));
    expect(r.buildErrors.size).toBe(0);
  }, 120000);
});
