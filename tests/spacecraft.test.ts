// A 3U CubeSat's electronics (the boards, panels, switches and harness of the CubeSat design, without its structure):
// the orbit world, gravity as a world setting, the flight software Kerf writes for its flight computer, and that
// software flying the CubeSat Design Specification's launch sequence in the simulator.
import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { generateFirmware } from "../src/machine/firmware";
import { runSpec } from "../src/sim/build";
import { orbitGeometry } from "../src/sim/engine/spacecraft";

const SAT = `design "CubeSat electronics"
param deploy_wait_s = 1800
param rf_wait_s = 2700
param burn_s = 5
component camera = lib.part("simera_multiscape100") { at: (0, 0, 9) }
component adcs = lib.part("cubespace_cubeadcs_3axis_small") { at: (-1.5, 0, 192.5) }
component star_tracker = lib.part("cubespace_cubestar") { at: (3.5, 0, 212.1), rotate: (90, 0, 270) }
component eps = lib.part("gomspace_p31u") { at: (-1.5, 0, 247.1) }
component battery = lib.part("gomspace_bp4_1p4s") { at: (-1.5, 0, 263.7) }
component obc = lib.part("endurosat_obc") { at: (-1.5, 0, 290.3) }
component uhf = lib.part("endurosat_uhf_ii") { at: (-1.5, 0, 306.9) }
component sband = lib.part("endurosat_sband_tx") { at: (-1.5, 0, 323.5) }
component ants = lib.part("isis_ants_uhf") { at: (0, 0, 334.1) }
component patch = lib.part("endurosat_sband_patch") { at: (0, 0, 334.1) }
component body_py = lib.part("gomspace_dsp_body") { at: (0, 49.3, 154), rotate: (0, 270, 270) }
component wing1_py = lib.part("gomspace_dsp_wing") { at: (0, 51.7, 154), rotate: (0, 270, 270) }
component wing2_py = lib.part("gomspace_dsp_wing") { at: (0, 56.2, 154), rotate: (0, 270, 90) }
component body_my = lib.part("gomspace_dsp_body") { at: (0, -49.3, 154), rotate: (0, 270, 90) }
component wing1_my = lib.part("gomspace_dsp_wing") { at: (0, -51.7, 154), rotate: (0, 270, 90) }
component wing2_my = lib.part("gomspace_dsp_wing") { at: (0, -56.2, 154), rotate: (0, 270, 270) }
component panel_px = lib.part("gomspace_p110_3u") { at: (49.3, 0, 166), rotate: (0, 270, 180) }
component panel_mx = lib.part("gomspace_p110_3u_tracker") { at: (-49.3, 0, 166), rotate: (0, 270, 0) }
component holddown_py = lib.part("gomspace_dsp_holddown") { at: (14, 49.3, 316.5), rotate: (90, 180, 180) }
component deploy_sense_py = lib.part("omron_d2f_f") { at: (-15.7, 52.2, 310.6), rotate: (0, 270, 180) }
component holddown_my = lib.part("gomspace_dsp_holddown") { at: (14, -49.3, 316.5), rotate: (90, 0, 0) }
component deploy_sense_my = lib.part("omron_d2f_f") { at: (-15.7, -52.2, 310.6), rotate: (0, 270, 180) }
component deploy_sw_1 = lib.part("omron_d2f_f") { at: (41.2, 43.6, 20.5), rotate: (0, 180, 0) }
component deploy_sw_4 = lib.part("omron_d2f_f") { at: (43.6, -41.2, 20.5), rotate: (0, 180, 270) }
component rbf_switch = lib.part("omron_d2f_f") { at: (-39.3, -16.9, 239), rotate: (90, 180, 270) }
wire battery.POS -> rbf_switch.COM { gauge: 24, color: "red" }
wire rbf_switch.NC -> deploy_sw_1.COM { gauge: 24, color: "red" }
wire deploy_sw_1.NC -> deploy_sw_4.COM { gauge: 24, color: "red" }
wire deploy_sw_4.NC -> eps.VBAT { gauge: 24, color: "red" }
wire battery.NEG -> eps.GND { gauge: 24, color: "black" }
net STACK_GND: eps.GND, obc.GND, uhf.GND, sband.GND, adcs.GND { gauge: 24, color: "black" }
net V3V3: eps.V3V3, obc.V3V3, uhf.V3V3, adcs.V3V3 { gauge: 24, color: "orange" }
net V5: eps.V5, adcs.V5, sband.V5 { gauge: 24, color: "red" }
net I2C_SDA: obc.SDA, eps.SDA, adcs.SDA, uhf.SDA, sband.SDA, ants.SDA { gauge: 28, color: "blue" }
net I2C_SCL: obc.SCL, eps.SCL, adcs.SCL, uhf.SCL, sband.SCL, ants.SCL { gauge: 28, color: "yellow" }
wire eps.OUT1 -> camera.V5 { gauge: 24, color: "red" }
net BURN: eps.OUT3, holddown_py.BURN, holddown_my.BURN { gauge: 26, color: "violet" }
wire eps.OUT6 -> ants.V3V3 { gauge: 26, color: "orange" }
net OUT_RET: eps.GND_OUT, camera.GND, holddown_py.GND, holddown_my.GND, ants.GND { gauge: 24, color: "black" }
wire adcs.SENS_3V3 -> star_tracker.VIN { gauge: 28, color: "orange" }
wire adcs.GND -> star_tracker.GND { gauge: 28, color: "black" }
wire adcs.SENS_SDA -> star_tracker.SDA { gauge: 28, color: "blue" }
wire adcs.SENS_SCL -> star_tracker.SCL { gauge: 28, color: "yellow" }
wire obc.TX -> camera.RX { gauge: 28, color: "green" }
wire camera.TX -> obc.RX { gauge: 28, color: "white" }
wire deploy_sense_py.COM -> obc.DEP1 { gauge: 28, color: "grey" }
wire deploy_sense_my.COM -> obc.DEP2 { gauge: 28, color: "grey" }
net DEP_RET: obc.GND_IO, deploy_sense_py.NO, deploy_sense_my.NO { gauge: 28, color: "black" }
wire uhf.RF -> ants.RF { gauge: 28, color: "brown", cable: "RG178 coax, U.FL to MMCX" }
wire sband.RF -> patch.RF { gauge: 28, color: "brown", cable: "RG178 coax, SMP to MMCX" }
wire panel_px.POS -> eps.SOLAR1A { gauge: 26, color: "red" }
wire panel_px.NEG -> eps.GND_1A { gauge: 26, color: "black" }
wire panel_mx.POS -> eps.SOLAR1B { gauge: 26, color: "red" }
wire panel_mx.NEG -> eps.GND_1B { gauge: 26, color: "black" }
wire body_py.WING_POS -> eps.SOLAR2A { gauge: 26, color: "red" }
wire body_py.WING_NEG -> eps.GND_2A { gauge: 26, color: "black" }
wire body_my.POS -> eps.SOLAR2B { gauge: 26, color: "red" }
wire body_my.NEG -> eps.GND_2B { gauge: 26, color: "black" }
wire body_py.POS -> eps.SOLAR3A { gauge: 26, color: "red" }
wire body_py.NEG -> eps.GND_3A { gauge: 26, color: "black" }
wire body_my.WING_POS -> eps.SOLAR3B { gauge: 26, color: "red" }
wire body_my.WING_NEG -> eps.GND_3B { gauge: 26, color: "black" }
firmware flight {
  board: obc
  behaviour: "CubeSat flight software"
  deploy_wait_s: deploy_wait_s
  rf_wait_s: rf_wait_s
  burn_s: burn_s
}
scenario "Launch to first beacon" for flight {
  world: sim.orbit(alt: 525km, ltan: 10.5, tipoff: 5, inertia: 0.06, wings: (1, 0, 0))
  duration: rf_wait_s * 1s + 60s
}
scenario "Later orbit" for flight {
  world: sim.orbit(alt: 525km, start: "eclipse exit", deployed: true)
  duration: 10s
}
scenario "Bench in orbit" for flight {
  world: sim.bench(gravity: 0)
  duration: 1s
}
scenario "Bench" for flight {
  world: sim.bench()
  duration: 1s
}
`;

describe("the orbit world", () => {
  it("is a bench with no gravity, the orbit's sun and a start at eclipse exit", () => {
    const m = evaluate(SAT);
    const later = m.scenarios!.find((s) => s.label === "Later orbit")!.spec.world;
    expect(later.kind).toBe("bench");
    if (later.kind !== "bench") return;
    expect(later.bench.gravity).toBe(0);
    expect(later.bench.orbit).toMatchObject({ alt: 525, startAt: "eclipse_exit", deployed: true });
  });

  it("works out a 525 km sun-synchronous orbit's period, inclination and eclipse", () => {
    const g = orbitGeometry({ alt: 525, ltan: 10.5, decl: 0, start: 0, tipoff: 0, inertia: 0.05, wings: [1, 0, 0], deployed: false });
    expect(g.period / 60).toBeCloseTo(95.1, 1);
    expect(g.incl).toBeGreaterThan(97.4);
    expect(g.incl).toBeLessThan(97.6);
    expect(g.eclipse).toBeGreaterThan(0.33);
    expect(g.eclipse).toBeLessThan(0.38);
  });

  it("takes gravity as a world setting, Earth's when it is left out", () => {
    const m = evaluate(SAT);
    const w = (label: string) => m.scenarios!.find((s) => s.label === label)!.spec.world;
    const space = w("Bench in orbit");
    const earth = w("Bench");
    expect(space.kind === "bench" && space.bench.gravity).toBe(0);
    expect(earth.kind === "bench" && earth.bench.gravity).toBeUndefined();
  });

  it("reads orbit heights in km", () => {
    const errors = evaluate(SAT.replace("alt: 525km, ltan", "alt: 52km, ltan")).diagnostics.filter((d) => d.severity === "error");
    expect(errors.map((d) => d.message).join(" ")).toMatch(/from 160 km/);
  });
});

describe("the flight software", () => {
  it("is written from the wiring: the boards' addresses, the EPS outputs and the hinge switches' pins", () => {
    const m = evaluate(SAT);
    const [fw] = generateFirmware(m.machine!, "CubeSat electronics");
    expect(fw.target).toBe("arduino");
    expect(fw.warnings).toEqual([]);
    const ino = fw.files[0].content;
    expect(ino).toContain("const uint8_t EPS_ADDR = 0x02;");
    expect(ino).toContain("const uint8_t ADCS_ADDR = 0x57;");
    expect(ino).toContain("const uint8_t ANTS_ADDR = 0x31;");
    // the imager on OUT1, the hold-downs on OUT3 and the antenna system on OUT6
    expect(ino).toContain("const int CH_IMAGER = 0;");
    expect(ino).toContain("const int CH_BURN = 2;");
    expect(ino).toContain("const int CH_ANTS = 5;");
    expect(ino).toMatch(/const int DEP_PIN\[2\] = \{ PC0, PC1 \};/);
    expect(ino).toContain("const uint32_t DEPLOY_WAIT_S = 1800;");
    expect(ino).toContain("const uint32_t RF_WAIT_S = 2700;");
  });

  it("never lets the waits be set shorter than the CDS allows", () => {
    const m = evaluate(SAT.replace("param deploy_wait_s = 1800", "param deploy_wait_s = 60"));
    const [fw] = generateFirmware(m.machine!, "CubeSat electronics");
    expect(fw.files[0].content).toContain("const uint32_t DEPLOY_WAIT_S = 1800;");
    expect(fw.warnings.join(" ")).toMatch(/deploy_wait_s/);
  });

  it("flies the launch sequence: detumbles, deploys after 30 minutes and beacons after 45", () => {
    const m = evaluate(SAT);
    const def = m.scenarios!.find((s) => s.label === "Launch to first beacon")!;
    const v = runSpec({ ...def.spec, variants: ["expected"] }, m.machine!, m.name ?? "sat").variants[0];
    expect(v.error).toBeUndefined();
    const r = v.results as Record<string, number>;
    expect(r.detumbled_at).toBeGreaterThan(0);
    expect(r.detumbled_at).toBeLessThan(1800);
    expect(r["holddown_py.released_at"]).toBeGreaterThanOrEqual(1800);
    expect(r["holddown_my.released_at"]).toBeGreaterThanOrEqual(1800);
    expect(r.wings_open_at).toBeGreaterThan(1800);
    expect(r.antenna_deployed_at).toBeGreaterThan(1800);
    expect(r.first_beacon).toBeGreaterThanOrEqual(2700);
    expect(r.first_beacon).toBeLessThan(2720);
    expect(r.beacons).toBeGreaterThanOrEqual(2);
    // the flight computer logged every step to its own microSD card
    const card = v.sdCards?.[0];
    expect(card?.files.some((f) => /FLIGHT\.LOG/.test(f.path))).toBe(true);
  }, 180_000);
});
