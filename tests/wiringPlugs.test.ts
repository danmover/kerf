// Plug-together wiring: a part's own lead or a bought cable wired as a whole
// connector (`wire servo.LEAD -> hub.CH0`) becomes a wire for each contact
// with the lead's own colours, lands on the right contact of the right
// socket in 3D, is a step of its own in the build guide ("what plugs into
// where"), and has to reach.

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { catalogPart, describePart } from "../src/machine/catalog";
import { buildHarness } from "../src/machine/harness/harness";
import { wiringItems } from "../src/machine/harness/checks";
import { plugFor } from "../src/machine/harness/plugs";
import { shortLeads } from "../src/machine/harness/wiringRun";
import type { RouteResult } from "../src/machine/harness/route";
import { buildPack } from "../src/machine/pack";
import { componentPositions, wireList, wiresCsv } from "../src/machine/wiring";
import { awgArea, stepLines, wiringSteps } from "../src/machine/wiringSteps";

const PARTS = `
part plate {
  material: "PETG"
  body box(320, 240, 4, at: (0, 0, -2))
}
component feather = lib.controller("feather_esp32_v2") { at: (0, 0, 5), axis: Z }
component imu = lib.sensor("lsm6dsox_breakout") { at: (50, 0, 5), axis: Z }
component nau = lib.sensor("nau7802_breakout") { at: (90, 0, 5), axis: Z }
component hub = lib.motor_driver("pca9685_servo_16") { at: (40, 50, 5), axis: Z }
component servo_1 = lib.servo("mg90d") { at: (110, 70, 20), axis: Z }
component servo_2 = lib.servo("mg90d") { at: (-40, 70, 20), axis: Z }
component esc = lib.esc("skywalker_60a_v2") { at: (0, -60, 2), axis: Z }
component battery = lib.battery("lipo_6s_1300_xt60") { at: (-110, -60, 2), axis: Z }
component xt60 = lib.connector("xt60_pigtail") { at: (-60, -90, 2), axis: Z }
component wago_p1 = lib.connector("wago_221_612") { at: (-60, -30, 2), axis: Z }
component wago_p2 = lib.connector("wago_221_612") { at: (-40, -30, 2), axis: Z }
component wago_n = lib.connector("wago_221_612") { at: (-20, -30, 2), axis: Z }
component wago_a = lib.connector("wago_221_412") { at: (120, 30, 2), axis: Z }
component wago_b = lib.connector("wago_221_412") { at: (135, 30, 2), axis: Z }
component fuse = lib.fuse("fuse_holder_maxi") { at: (-90, -20, 2), axis: Z }
component estop = lib.switch("estop_jaycar_sp0786") { at: (130, -60, 40), axis: Z }
component load_cell = lib.sensor("beam_cell_1kg") { at: (100, -40, 10), axis: Z }
component edf = lib.bldc("fms_edf_70_12b_3060_1900kv") { at: (60, -90, 60), axis: Z }
`;

const WIRING = `
wire battery.LEAD -> xt60.PLUG
wire xt60.POS_B -> wago_p1.A
wire wago_p1.B -> fuse.IN
wire fuse.OUT -> wago_p2.A
wire wago_p2.B -> esc.B_PLUS
wire xt60.NEG_B -> wago_n.A
wire wago_n.B -> esc.B_MINUS
wire esc.MOTOR -> edf.LEADS
wire servo_1.LEAD -> hub.CH0
wire servo_2.LEAD -> hub.CH1
wire esc.SIGNAL -> hub.CH4
wire feather.QT -> imu.QT1 { cable: "STEMMA QT cable, 50 mm", length: 50 }
wire imu.QT2 -> nau.QT1 { cable: "STEMMA QT cable, 100 mm", length: 100 }
wire nau.QT2_GND -> hub.GND { cable: "STEMMA QT to sockets cable, 150 mm", length: 150, color: "black" }
wire nau.QT2_SCL -> hub.SCL { cable: "STEMMA QT to sockets cable, 150 mm", length: 150, color: "yellow" }
wire nau.QT2_SDA -> hub.SDA { cable: "STEMMA QT to sockets cable, 150 mm", length: 150, color: "blue" }
wire nau.QT2_V -> wago_a.A { cable: "STEMMA QT to sockets cable, 150 mm", length: 150, color: "red", gauge: 28 }
wire wago_a.B -> estop.NC_1 { gauge: 22, color: "red", label: "logic supply, out to the e-stop" }
wire estop.NC_2 -> wago_b.A { gauge: 22, color: "red", label: "and back" }
wire wago_b.B -> hub.VCC { cable: "STEMMA QT to sockets cable, 150 mm", length: 150, color: "red", gauge: 28 }
wire hub.POWER -> feather.USB { cable: "USB-C plug to bare leads, 30 cm", length: 300 }
wire load_cell.LEAD -> nau.CELL
`;

const design = (wiring = WIRING) => evaluate(PARTS + wiring);
const errors = (m: ReturnType<typeof evaluate>) => m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);

describe("wiring a whole connector", () => {
  const model = design();
  const m = model.machine!;
  const rows = wireList(m, componentPositions(model));
  const row = (from: string, to: string) => rows.find((r) => `${r.from.comp}.${r.from.spot ?? r.from.pin}` === from && `${r.to.comp}.${r.to.spot ?? r.to.pin}` === to)!;

  it("evaluates without errors", () => {
    expect(errors(model)).toEqual([]);
  });

  it("makes a wire for each contact, with the lead's own colours and wire size", () => {
    const lead = [row("servo_1.GND", "hub.G0"), row("servo_1.V_PLUS", "hub.V0"), row("servo_1.SIG", "hub.P0")];
    expect(lead.map((r) => r.color)).toEqual(["brown", "red", "orange"]);
    expect(lead.every((r) => r.gauge === 26 && !r.gaugeSuggested && !r.colorSuggested)).toBe(true);
    // the channel's own ground and supply pins, not the board's control header
    expect(lead[0].to.label).toBe("channel 0: GND");
    expect(lead[0].to.conn).toBe("CH0");
    // nothing to cut: the lead is as long as it is
    expect(lead.every((r) => r.lead === "servo_1's own lead" && r.fixedMm === 180 && r.lengthMm === 180)).toBe(true);
    expect(lead[2].own).toEqual(["from"]);
  });

  it("takes a made-up cable's colours from the socket it plugs into", () => {
    const qt = rows.filter((r) => r.bought === "STEMMA QT cable, 50 mm");
    expect(qt.map((r) => r.color).sort()).toEqual(["black", "blue", "red", "yellow"]);
    expect(qt.every((r) => r.gauge === 28 && r.fixedMm === 50 && !r.own)).toBe(true);
    // the socket's supply contact is the board's switched 3.3 V, its ground the board's ground
    expect(qt.find((r) => r.color === "red")!.from.pin).toBe("QT_3V");
    expect(qt.find((r) => r.color === "black")!.from.pin).toBe("GND");
  });

  it("joins two leads as one run, as long as both together", () => {
    const motor = row("esc.PHASE_A", "edf.PHASE_A");
    expect(motor.own).toEqual(["from", "to"]);
    expect(motor.fixedMm).toBe(250);
    expect(motor.lead).toBe("esc's own lead into edf's own lead");
  });

  it("reads a connector's name before a pin's printed label", () => {
    // the Feather's 5 V pin is labelled USB; feather.USB is its USB-C socket, with power and ground
    const usb = rows.filter((r) => r.bought === "USB-C plug to bare leads, 30 cm");
    expect(usb.map((r) => `${r.from.spot}>${r.to.spot}`).sort()).toEqual(["T_GND>USB_GND", "T_VP>USB_5V"]);
  });

  it("says what is wrong when the contacts do not pair up", () => {
    expect(errors(design("wire servo_1.LEAD -> feather.QT\n"))[0]).toMatch(/lead has 3 wires and .*STEMMA QT socket has 4/);
    expect(errors(design("wire servo_1.LEED -> hub.CH0\n"))[0]).toMatch(/has no pin "LEED"\. Did you mean "LEAD"\?/);
  });

  it("keeps a wire the design sizes itself as one to make, joined to the lead", () => {
    const made = wireList(design("wire feather.D14 -> servo_1.SIG { gauge: 24, color: \"orange\" }\n").machine!);
    expect(made[0].lead).toBeUndefined();
    expect(made[0].own).toBeUndefined();
    expect(made[0].note).toMatch(/joins servo_1's own lead \(180 mm, 3-way servo plug\)/);
  });

  it("counts an extension cable with the lead it extends", () => {
    const ext = wireList(design("wire servo_1.LEAD -> hub.CH0 { cable: \"servo extension lead, 300 mm\", length: 300 }\n").machine!);
    expect(ext.every((r) => r.fixedMm === 480 && r.lead === "servo_1's own lead and the servo extension lead, 300 mm")).toBe(true);
  });

  it("lists leads and cables in the wires file as not cut from a reel", () => {
    const csv = wiresCsv(rows);
    expect(csv).toMatch(/servo_1\.GND,GND \(brown\),hub\.G0,channel 0: GND,.*In servo_1's own lead: not cut from a reel/);
    expect(csv).toMatch(/"One wire of the STEMMA QT cable, 50 mm: not cut from a reel"/);
  });

  it("tells Claude about a part's connectors and leads", () => {
    const text = describePart(catalogPart("mg90d")!);
    expect(text).toMatch(/LEAD "lead": GND, V_PLUS, SIG \(its own 180 mm lead, 26 AWG brown\/red\/orange, 3-way servo plug/);
    expect(describePart(catalogPart("nau7802_breakout")!)).toMatch(/QT1_GND = GND/);
  });
});

describe("plugs on sockets", () => {
  const hub = catalogPart("pca9685_servo_16")!;
  const nau = catalogPart("nau7802_breakout")!;

  it("puts a channel's three wires in one housing on its three pins", () => {
    const g = plugFor(hub, "GND", undefined, "G3")!;
    const v = plugFor(hub, "VP", undefined, "V3")!;
    const p = plugFor(hub, "P3")!;
    expect([g.kind, v.kind, p.kind]).toEqual(["dupont", "dupont", "dupont"]);
    expect(g.at).toEqual(v.at);
    expect(g.at).toEqual(p.at);
    expect([g.used, v.used, p.used]).toEqual([[0], [1], [2]]);
    expect(g.ways).toBe(3);
    // channels are four blocks of four with a pin's gap between blocks
    const x = (k: number) => plugFor(hub, `P${k}`)!.at[0];
    expect(x(1) - x(0)).toBeCloseTo(2.54, 5);
    expect(x(4) - x(3)).toBeCloseTo(5.08, 5);
    // the board's own ground pin is on the control header at its end, not on a channel
    expect(plugFor(hub, "GND")!.at[0]).toBeLessThan(-30);
  });

  it("puts a STEMMA QT cable's four wires in one small plug", () => {
    const ends = ["QT2_GND", "QT2_V", "QT2_SDA", "QT2_SCL"].map((s) => plugFor(nau, nau.spots!.find((x) => x.id === s)!.pin, undefined, s)!);
    expect(ends.every((e) => e.kind === "sh" && e.ways === 4)).toBe(true);
    expect(new Set(ends.map((e) => e.at.join(","))).size).toBe(1);
    expect(ends.map((e) => e.used![0])).toEqual([0, 1, 2, 3]);
    // the two sockets are at the two ends of the board, facing out
    expect(plugFor(nau, "GND", undefined, "QT1_GND")!.out[0]).toBe(-1);
    expect(ends[0].out[0]).toBe(1);
  });

  it("clamps bare ends in lever connectors and screw terminals", () => {
    expect(plugFor(catalogPart("wago_221_612")!, "A")!.kind).toBe("lever");
    expect(plugFor(nau, "E_PLUS")!.kind).toBe("bare");
    expect(plugFor(catalogPart("estop_jaycar_sp0786")!, "NC_1")!.kind).toBe("bare");
  });

  it("gives every wire of the design a plug in 3D, the shared ones in the same place", () => {
    const model = design();
    const h = buildHarness(model);
    expect(h.wires.length).toBe(wireList(model.machine!).length);
    const at = (comp: string, pin: string) => h.wires.flatMap((w) => w.ends).find((e) => e.comp === comp && e.pin === pin)!;
    const o = (e: { frame: { o: number[] } }) => e.frame.o.map((x) => x.toFixed(2)).join(",");
    const ch0 = h.wires.filter((w) => w.ends.some((e) => e.comp === "servo_1")).map((w) => w.ends.find((e) => e.comp === "hub")!);
    expect(ch0.length).toBe(3);
    expect(new Set(ch0.map(o)).size).toBe(1);
    // the other servo's plug is one channel along
    const ch1 = h.wires.find((w) => w.ends.some((e) => e.comp === "servo_2"))!.ends.find((e) => e.comp === "hub")!;
    expect(Math.abs(ch1.frame.o[0] - ch0[0].frame.o[0])).toBeCloseTo(2.54, 5);
    expect(at("wago_a", "A").spec.kind).toBe("lever");
  });
});

describe("the build guide's wiring steps", () => {
  const model = design();
  const rows = wireList(model.machine!, componentPositions(model));
  const ws = wiringSteps(model.machine!, rows);
  const step = (what: RegExp) => ws.steps.find((s) => what.test(`${s.what} → ${s.where}`))!;

  it("makes a step of each lead and cable, and leaves only the wires to cut", () => {
    expect(ws.steps.length).toBe(16);
    expect(ws.cut.map((r) => `${r.from.comp}>${r.to.comp}`)).toEqual(["wago_a>estop", "estop>wago_b"]);
    expect(ws.fits.get(ws.cut[0].id)).toEqual(["stripped end in the lever", "stripped end under the screw"]);
    // every row is in exactly one step or in the wires to cut
    const ids = [...ws.steps.flatMap((s) => s.wires), ...ws.cut.map((r) => r.id)].sort();
    expect(ids).toEqual(rows.map((r) => r.id).sort());
  });

  it("says which wire goes on which pin where a plug could go on the wrong way round", () => {
    const s = step(/^servo_1's lead/);
    expect(`${s.what} → ${s.where}`).toBe("servo_1's lead (3-way servo plug) → hub's channel 0");
    expect(s.contacts.map((c) => `${c.color} → ${c.to}`).sort()).toEqual(["brown → GND", "orange → PWM 0", "red → V+"]);
    expect(s.notes.join(" ")).toMatch(/dark wire .* by the board's edge/);
    expect(s.fixedMm).toBe(180);
  });

  it("leaves the wires of a plug that only fits one way untold", () => {
    const s = step(/^STEMMA QT cable, 50 mm/);
    expect(s.where).toBe("feather's STEMMA QT socket and imu's left STEMMA QT socket");
    expect(s.contacts).toEqual([]);
    expect(step(/^battery's lead/).contacts).toEqual([]);
  });

  it("keeps a cable's loose ends with its plug, wherever they go", () => {
    const s = step(/^STEMMA QT to sockets cable/);
    expect(s.where).toBe("nau's right STEMMA QT socket");
    expect(s.wires.length).toBe(5);
    expect(s.contacts.map((c) => `${c.color}${c.from ? ` from ${c.from}` : ""} → ${c.to}`).sort()).toEqual([
      "black → hub's GND",
      "blue → hub's SDA",
      "red from wago_b's B → hub's VCC",
      "red → wago_a's A",
      "yellow → hub's SCL",
    ]);
    // a 28 AWG wire is under the small lever connector's 0.14 mm²: folded double
    expect(awgArea(28)).toBeLessThan(0.14);
    expect(s.notes.join(" ")).toMatch(/thinner than the lever connector wago_a is made for: strip 22 mm and fold/);
  });

  it("tells how each bare end is clamped", () => {
    const s = step(/^xt60's pigtail, the red wire/);
    expect(s.where).toBe("wago_p1's A");
    expect(s.notes.join(" ")).toMatch(/Strip 12 mm, lift wago_p1's lever/);
    expect(step(/^USB-C plug to bare leads/).contacts.map((c) => `${c.color} → ${c.to}`).sort()).toEqual(["black → hub's power terminal, GND", "red → hub's power terminal, V+"]);
    expect(step(/^load_cell's four wires/).contacts.map((c) => `${c.color} → ${c.to}`).sort()).toEqual(["black → E−", "green → A+", "red → E+", "white → A−"]);
  });

  it("plugs in the thin leads first and the battery last", () => {
    const names = ws.steps.map((s) => s.what);
    expect(names[0]).toMatch(/^servo_1's lead/);
    expect(names[names.length - 1]).toMatch(/^battery's lead/);
    expect(ws.steps.filter((s) => s.power).length).toBe(1);
    expect(names.findIndex((n) => /pigtail/.test(n))).toBeGreaterThan(names.findIndex((n) => /STEMMA QT/.test(n)));
  });

  it("writes the steps into the build pack", () => {
    const text = buildPack(model, null).find((f) => f.path === "assembly.md")!.data as string;
    expect(text).toContain("### Leads and cables that plug in");
    expect(text).toContain("- [ ] **servo_1's lead (3-way servo plug) → hub's channel 0**");
    expect(text).toMatch(/ {2}- orange → PWM 0 \(W\d+\)/);
    expect(text).toContain("### Power, last");
    // the two wires to cut say what goes on their ends
    expect(text).toMatch(/\*\*W\d+\*\*: wago_a\.B → estop\.NC_1 \("NC 1"\).*; stripped end in the lever → stripped end under the screw\./);
    expect(text.indexOf("### Power, last")).toBeGreaterThan(text.indexOf("Before connecting any power"));
    for (const s of ws.steps) expect(text).toContain(stepLines(s)[0]);
  });
});

describe("a lead has to reach", () => {
  const far = PARTS.replace('lib.servo("mg90d") { at: (110, 70, 20)', 'lib.servo("mg90d") { at: (110, 370, 20)');
  // a route result with each wire's run as long as the straight line between its plugs
  const straightRuns = (h: ReturnType<typeof buildHarness>): RouteResult => ({
    wires: h.wires.map((w) => {
      const a = w.ends[0].frame.o;
      const b = w.ends[1].frame.o;
      return { id: w.id, points: [a, b], length: Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), through: 0, straight: false, r: w.d / 2 };
    }),
    cell: 3,
    ms: 0,
    stages: {},
  });

  it("passes leads that cover their runs", () => {
    const h = buildHarness(evaluate(PARTS + "wire servo_1.LEAD -> hub.CH0\n"));
    expect(shortLeads(h, straightRuns(h))).toEqual([]);
  });

  it("fails a lead that is too short, once, with the lengths", () => {
    const model = evaluate(far + "wire servo_1.LEAD -> hub.CH0\n");
    const h = buildHarness(model);
    const short = shortLeads(h, straightRuns(h));
    expect(short.length).toBe(3);
    expect(short[0].have).toBe(180);
    expect(short[0].need).toBeGreaterThan(300);
    const none = { cableHits: [], crossings: [], plugHits: [], plugClashes: [], pullBlocked: [], leadBlocked: [], splices: [], openings: [], ties: [], freeSpans: [], outside: [], unrouted: [], ms: 0 };
    const items = wiringItems(h, { ...none, reach: short }, [], model).filter((i) => i.id.startsWith("wiring:reach:"));
    expect(items.length).toBe(1);
    expect(items[0].status).toBe("fail");
    expect(items[0].title).toBe("servo_1's lead does not reach from servo_1 to hub");
  });

  it("passes it with an extension cable that makes up the length", () => {
    const h = buildHarness(evaluate(far + 'wire servo_1.LEAD -> hub.CH0 { cable: "servo extension lead, 300 mm", length: 300 }\n'));
    expect(shortLeads(h, straightRuns(h))).toEqual([]);
  });

  it("does not hold a wire the builder makes to the lead's length", () => {
    const h = buildHarness(evaluate(far + 'wire hub.P0 -> servo_1.SIG { gauge: 24, color: "orange" }\n'));
    expect(shortLeads(h, straightRuns(h))).toEqual([]);
  });
});
