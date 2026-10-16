// Circuit boards: a realistic two-layer through-hole board (a guitar amp
// with an Arduino Nano and five pots on the bottom) routed end to end, the
// Gerber and drill files checked with a small reader, and small cases for
// the router and the placement check.

import { describe, expect, it } from "vitest";
import { boardHash, boardSvg, checkPlacement, gerberFiles, placedPads, routeBoard, type BoardNet, type BoardSpec, type Footprint, type Pad, type PlacedPart, type RoutedBoard } from "../src/machine/pcb";
import { inRing, ringArea } from "../src/machine/pcb/geom";
import { boardSilk } from "../src/machine/pcb/silk";
import { FONT_CHARS, textBox } from "../src/machine/pcb/font";
import { boardDrc } from "../src/machine/pcb/drc";

// ---------------------------------------------------------------- footprints

const pad = (pin: string, x: number, y: number, d: number, drill: number, shape: Pad["shape"] = "circle", h = d): Pad => ({ pin, x, y, shape, w: d, h, drill });

const axial = (pitch = 10.16, body = 6.3, dia = 2.5): Footprint => ({
  name: `axial-${pitch}`,
  pads: [pad("1", 0, 0, 1.8, 0.9), pad("2", pitch, 0, 1.8, 0.9)],
  body: { shape: "rect", x0: (pitch - body) / 2, y0: -dia / 2, x1: (pitch + body) / 2, y1: dia / 2 },
  height: dia,
});

const do35 = (): Footprint => ({
  name: "DO-35",
  pads: [pad("K", 0, 0, 1.6, 0.8, "rect"), pad("A", 7.62, 0, 1.6, 0.8)],
  body: { shape: "rect", x0: 1.81, y0: -1, x1: 5.81, y1: 1 },
  mark: { x: 2.4, y: 0, kind: "band" },
  height: 2,
});

const filmBox = (): Footprint => ({
  name: "C-box-5.0",
  pads: [pad("1", 0, 0, 1.6, 0.8), pad("2", 5, 0, 1.6, 0.8)],
  body: { shape: "rect", x0: -1.1, y0: -2.25, x1: 6.1, y1: 2.25 },
  height: 9,
});

const ceramic = (): Footprint => ({
  name: "C-disc-5.0",
  pads: [pad("1", 0, 0, 1.6, 0.8), pad("2", 5, 0, 1.6, 0.8)],
  body: { shape: "rect", x0: -0.5, y0: -1.25, x1: 5.5, y1: 1.25 },
  height: 6,
});

const electrolytic = (pitch: 2 | 2.5 | 5, dia: number): Footprint => {
  const d = pitch === 5 ? 2.0 : 1.6;
  const dr = pitch === 5 ? 1.0 : 0.8;
  const r = dia / 2;
  return {
    name: `CP-${pitch}-${dia}`,
    pads: [pad("+", 0, 0, d, dr, "rect"), pad("-", pitch, 0, d, dr)],
    body: { shape: "circle", cx: pitch / 2, cy: 0, r },
    mark: { x: pitch / 2 - r * 0.6, y: r * 0.55, kind: "plus" },
    height: 11,
  };
};

const dip8 = (): Footprint => ({
  name: "DIP-8",
  pads: [0, 1, 2, 3].flatMap((k) => [pad(String(k + 1), 0, -2.54 * k, 1.6, 0.8, k === 0 ? "rect" : "circle"), pad(String(8 - k), 7.62, -2.54 * k, 1.6, 0.8)]),
  body: { shape: "rect", x0: -1.3, y0: -8.92, x1: 8.92, y1: 1.3 },
  mark: { x: 1.3, y: 0.4, kind: "pin1" },
  height: 8,
});

const to220 = (): Footprint => ({
  name: "TO-220-3-vertical",
  pads: ["IN", "GND", "OUT"].map((p, k) => pad(p, 2.54 * k, 0, 1.8, 1.1, "oval", 2.6)),
  body: { shape: "rect", x0: -2.46, y0: -1.6, x1: 7.54, y1: 3.0 },
  height: 20,
});

const header = (n: number): Footprint => ({
  name: `header-1x${n}`,
  pads: Array.from({ length: n }, (_, k) => pad(String(k + 1), 2.54 * k, 0, 1.7, 1.0, k === 0 ? "rect" : "circle")),
  body: { shape: "rect", x0: -1.27, y0: -1.27, x1: 2.54 * (n - 1) + 1.27, y1: 1.27 },
  height: 8.5,
});

const screw = (n: number): Footprint => ({
  name: `terminal-1x${n}-5.08`,
  pads: Array.from({ length: n }, (_, k) => pad(String(k + 1), 5.08 * k, 0, 2.4, 1.3, k === 0 ? "rect" : "circle")),
  body: { shape: "rect", x0: -2.54, y0: -4.0, x1: 5.08 * (n - 1) + 2.54, y1: 4.2 },
  height: 10,
});

/** Alpha 9 mm vertical pot: shaft at the origin, pins in a row to its left, tabs above and below. */
const pot9 = (): Footprint => ({
  name: "Alpha-9mm-vertical",
  pads: [
    pad("CCW", -7.5, 2.5, 1.8, 1.0, "rect"),
    pad("W", -7.5, 0, 1.8, 1.0),
    pad("CW", -7.5, -2.5, 1.8, 1.0),
    { pin: "MT", x: 0, y: 4.8, shape: "oval", w: 3.24, h: 2.72, drill: 1.1, slot: 1.8 },
    { pin: "MT", x: 0, y: -4.8, shape: "oval", w: 3.24, h: 2.72, drill: 1.1, slot: 1.8 },
  ],
  body: { shape: "rect", x0: -6.5, y0: -4.75, x1: 4.85, y1: 4.75 },
  height: 11,
});

const NANO_L = ["TX", "RX", "RST1", "GND1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "D12"];
const NANO_R = ["D13", "3V3", "AREF", "A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "5V", "RST2", "GND2", "VIN"];

/** Two 1 x 15 sockets 15.24 mm apart for an Arduino Nano; pin 1 at the origin, pins run down. */
const nano = (): Footprint => ({
  name: "Arduino-Nano-socket",
  pads: [
    ...NANO_L.map((p, k) => ({ ...pad(p, 0, -2.54 * k, 1.7, 1.0, k === 0 ? "rect" : "circle"), num: String(k + 1) })),
    ...NANO_R.map((p, k) => ({ ...pad(p, 15.24, -2.54 * (14 - k), 1.7, 1.0), num: String(16 + k) })),
  ],
  body: { shape: "rect", x0: -1.4, y0: -38.1, x1: 16.64, y1: 2.54 },
  mark: { x: -1.0, y: 1.6, kind: "pin1" },
  height: 12,
});

// ---------------------------------------------------------------- the amp

function ampBoard(): BoardSpec {
  const parts: PlacedPart[] = [];
  const P = (ref: string, value: string, fp: Footprint, x: number, y: number, rot = 0, side: "top" | "bottom" = "top") => parts.push({ ref, value, fp, x, y, rot, side });
  const R = (ref: string, value: string, x: number, y: number, rot = 0) => P(ref, value, axial(), x, y, rot);

  // power: 12 V in, reverse protection, 9 V for the op-amps, 5 V for the Nano, a 4.5 V reference
  P("J1", "12V", screw(2), 6.5, 42, 90);
  P("D1", "BAT85", do35(), 20.62, 55, 180);
  P("C1", "100µ", electrolytic(2.5, 6.3), 13.5, 44);
  P("C2", "100n", ceramic(), 13, 50);
  P("U3", "7809", to220(), 24, 44);
  P("C3", "47µ", electrolytic(2, 5), 34, 45);
  P("C4", "100n", ceramic(), 24, 51);
  P("U4", "7805", to220(), 41, 44);
  P("C5", "10µ", electrolytic(2, 5), 51, 45);
  P("C6", "100n", ceramic(), 41, 51);
  R("R1", "10k", 31, 55);
  R("R2", "10k", 44, 55);
  P("C7", "47µ", electrolytic(2.5, 6.3), 58, 54);

  // input and gain stage (U1A)
  P("J2", "IN", header(2), 3.5, 24, 90);
  R("R4", "1M", 8, 19.5, 90);
  P("C8", "100n", filmBox(), 12, 31);
  R("R3", "1M", 12, 22);
  P("U1", "TL072", dip8(), 26, 33);
  P("C9", "10µ", electrolytic(2, 5), 8, 36);
  R("R5", "4.7k", 13, 37);
  P("C10", "100p", ceramic(), 19, 40.6);
  R("R7", "10k", 37, 34);
  P("D2", "1N4148", do35(), 37, 30);
  P("D3", "1N4148", do35(), 37, 26.5);
  P("C11", "22n", filmBox(), 50, 30.5);

  // tone stack and buffer (U1B)
  P("C12", "4.7n", filmBox(), 60, 35);
  R("R8", "56k", 59, 26.5);
  P("C13", "22n", filmBox(), 58, 20);
  P("C14", "22n", filmBox(), 68, 20);
  R("R9", "1M", 70, 32);
  P("C15", "100n", filmBox(), 73, 26.5);

  // output stage (U2A) and level detector (U2B)
  P("U2", "TL072", dip8(), 100, 33);
  P("C19", "100n", ceramic(), 84, 21);
  R("R11", "100k", 84, 25);
  R("R13", "10k", 84, 29);
  R("R12", "22k", 84, 33);
  P("C16", "100n", filmBox(), 85, 37.5);
  P("C17", "10µ", electrolytic(2, 5), 93, 38);
  R("R14", "100R", 111, 37.5);
  R("R18", "100k", 111, 21.5);
  R("R17", "10k", 111, 25.5);
  R("R16", "100k", 111, 29.5);
  P("D4", "1N4148", do35(), 118.62, 33.5, 180);
  P("C18", "220µ", electrolytic(5, 10), 126, 29);
  P("J3", "SPK", screw(2), 143.5, 26, 90);
  R("R15", "10k", 136.5, 21, 90);
  P("C20", "4.7µ", electrolytic(2, 5), 139.5, 17);
  R("R19", "1M", 124, 37.5);
  R("R20", "1k", 145.5, 37, 90);
  P("C21", "100n", ceramic(), 26, 20.5);
  P("C22", "100n", ceramic(), 99, 20.5);

  // the Nano: level in, footswitch, two LEDs, a display header, a tuner input
  P("A1", "Nano", nano(), 104, 41, 90);
  R("R21", "1k", 66, 41.5);
  R("R22", "10k", 66, 45.5);
  R("R24", "100k", 80, 41.5);
  R("R23", "470R", 80, 45.5);
  R("R25", "10k", 80, 49.5);
  P("J4", "SW LED", header(4), 66, 57.5);
  P("J5", "DISPLAY", header(6), 80, 57.5);

  // pots on the bottom, shafts 26 mm apart along the front edge
  ["GAIN", "BASS", "MID", "TREBLE", "VOLUME"].forEach((v, k) => P(`RV${k + 1}`, v === "GAIN" || v === "VOLUME" ? `${v} 100k` : `${v} 25k`, pot9(), 23 + 26 * k, 6.5, 90, "bottom"));

  const N = (name: string, pins: string, width?: number, pour?: boolean): BoardNet => ({
    name,
    pins: pins.split(/\s+/).map((s) => {
      const i = s.lastIndexOf(".");
      return { ref: s.slice(0, i), pin: s.slice(i + 1) };
    }),
    ...(width ? { width } : {}),
    ...(pour ? { pour } : {}),
  });
  const nets: BoardNet[] = [
    N("V12IN", "J1.1 D1.A", 0.6),
    N("VIN", "D1.K C1.+ C2.1 U3.IN U4.IN", 0.6),
    N("V9", "U3.OUT C3.+ C4.1 R1.1 U1.8 U2.8 C21.1 C22.1", 0.6),
    N("V5", "U4.OUT C5.+ C6.1 A1.5V R22.2 J5.1", 0.6),
    N("VREF", "R1.2 R2.1 C7.+ R3.2 D2.K D3.A R9.2 R11.2 R17.2 R18.2"),
    N(
      "GND",
      "J1.2 C1.- C2.2 U3.GND C3.- C4.2 U4.GND C5.- C6.2 R2.2 C7.- J2.2 R4.2 C9.- U1.4 U2.4 C17.- J3.2 R15.2 C20.- R19.2 C21.2 C22.2 A1.GND1 A1.GND2 J4.4 J5.6 RV3.W RV3.CW RV5.CCW R25.2 RV1.MT RV2.MT RV3.MT RV4.MT RV5.MT",
      0.5,
      true,
    ),
    N("INPUT", "J2.1 R4.1 C8.1"),
    N("IN1", "C8.2 R3.1 U1.3"),
    N("FB1", "U1.2 R5.1 C10.1 RV1.CCW"),
    N("FBG", "R5.2 C9.+"),
    N("PRE1", "U1.1 C10.2 RV1.W RV1.CW R7.1"),
    N("CLIP", "R7.2 D2.A D3.K C11.1"),
    N("TS_IN", "C11.2 C12.1 R8.1"),
    N("TS_T", "C12.2 RV4.CCW"),
    N("TS_R", "R8.2 C13.1 C14.1"),
    N("BASS_TOP", "C13.2 RV2.CCW RV4.CW"),
    N("MID_TOP", "C14.2 RV2.W RV2.CW RV3.CCW"),
    N("TONE", "RV4.W U1.5 R9.1"),
    N("BUF", "U1.6 U1.7 C15.1 R24.1"),
    N("VOL_IN", "C15.2 RV5.CW"),
    N("VOL_W", "RV5.W C16.1"),
    N("OUTIN", "C16.2 R11.1 U2.3"),
    N("OFB", "U2.2 R12.1 R13.1"),
    N("OFBG", "R13.2 C17.+"),
    N("OUTA", "U2.1 R12.2 R14.1 C19.1"),
    N("OUT_R", "R14.2 C18.+"),
    N("SPK", "C18.- J3.1 R15.1"),
    N("DETIN", "C19.2 R18.1 U2.5"),
    N("DFB", "U2.6 R16.1 R17.1"),
    N("DOUT", "U2.7 R16.2 D4.A"),
    N("ENV", "D4.K C20.+ R19.1 R20.1"),
    N("LEVEL", "R20.2 A1.A0"),
    N("TUNER", "R24.2 R25.1 A1.A6"),
    N("PWM", "A1.D3 R21.1"),
    N("LED1", "R21.2 J4.2"),
    N("STAT", "A1.D13 R23.1"),
    N("LED2", "R23.2 J4.3"),
    N("FSW", "A1.D2 R22.1 J4.1"),
    N("SDA", "A1.A4 J5.2"),
    N("SCL", "A1.A5 J5.3"),
    N("BTN1", "A1.D5 J5.4"),
    N("BTN2", "A1.D6 J5.5"),
  ];
  return {
    name: "Guitar Amp",
    w: 150,
    h: 60,
    corner: 2,
    holes: [
      { x: 3.5, y: 3.5, d: 3.2 },
      { x: 146.5, y: 3.5, d: 3.2 },
      { x: 3.5, y: 56.5, d: 3.2 },
      { x: 146.5, y: 56.5, d: 3.2 },
    ],
    parts,
    nets,
  };
}

// ---------------------------------------------------------------- file checks

const W = 150;
const H = 60;

/** Just enough of RS-274X to check a file is whole: header, apertures defined before use, coordinates on the board, regions closed. */
function parseGerber(src: string, w: number, h: number) {
  const errors: string[] = [];
  if (!src.includes("%FSLAX46Y46*%")) errors.push("no 4.6 format statement");
  if (!src.includes("%MOMM*%")) errors.push("not in millimetres");
  if (!src.trimEnd().endsWith("M02*")) errors.push("does not end with M02*");
  const defined = new Set<number>();
  const used = new Set<number>();
  let regions = 0;
  let open = false;
  let draws = 0;
  let flashes = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const blocks = src.match(/%[^%]*%|[^%*\n]+\*/g) ?? [];
  for (const b of blocks) {
    const ad = b.match(/^%ADD(\d+)([CRO]),([\d.X]+)\*%$/);
    if (ad) {
      defined.add(Number(ad[1]));
      for (const v of ad[3].split("X")) if (!(Number(v) > 0)) errors.push(`aperture D${ad[1]} has size ${v}`);
      continue;
    }
    if (b.startsWith("%")) continue;
    const st = b.slice(0, -1);
    if (st === "G36") {
      if (open) errors.push("nested region");
      open = true;
      regions++;
      continue;
    }
    if (st === "G37") {
      if (!open) errors.push("G37 without G36");
      open = false;
      continue;
    }
    const sel = st.match(/^D(\d+)$/);
    if (sel && Number(sel[1]) >= 10) {
      if (!defined.has(Number(sel[1]))) errors.push(`D${sel[1]} used before it is defined`);
      used.add(Number(sel[1]));
      continue;
    }
    const c = st.match(/^(?:G0[123])?X(-?\d+)Y(-?\d+)(?:I(-?\d+)J(-?\d+))?D0([123])$/);
    if (c) {
      const x = Number(c[1]) / 1e6;
      const y = Number(c[2]) / 1e6;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      if (c[5] === "3") flashes++;
      else if (c[5] === "1") draws++;
      continue;
    }
    if (!/^(G01|G04 .*|G75|M02|D0?[123])$/.test(st)) errors.push(`unexpected statement ${st}`);
  }
  if (open) errors.push("region left open");
  if (x0 < -1e-6 || y0 < -1e-6 || x1 > w + 1e-6 || y1 > h + 1e-6) errors.push(`coordinates leave the board: ${x0},${y0} to ${x1},${y1}`);
  return { errors, defined, used, regions, draws, flashes };
}

/** Excellon: header, tools, hits per tool (a G85 slot counts once), end. */
function parseDrill(src: string, w: number, h: number) {
  const errors: string[] = [];
  const lines = src.trim().split("\n");
  if (lines[0] !== "M48") errors.push("no M48 header");
  if (!lines.includes("METRIC")) errors.push("not metric");
  if (lines[lines.length - 1] !== "M30") errors.push("does not end with M30");
  const tools = new Map<string, number>();
  const hits = new Map<string, number>();
  let tool = "";
  let slots = 0;
  for (const l of lines) {
    const t = l.match(/^(T\d+)C([\d.]+)$/);
    if (t) {
      tools.set(t[1], Number(t[2]));
      continue;
    }
    if (/^T\d+$/.test(l)) {
      if (!tools.has(l)) errors.push(`tool ${l} not defined`);
      tool = l;
      continue;
    }
    const xy = l.match(/^X(-?[\d.]+)Y(-?[\d.]+)(?:G85X(-?[\d.]+)Y(-?[\d.]+))?$/);
    if (xy) {
      if (!tool) errors.push("hit before any tool");
      hits.set(tool, (hits.get(tool) ?? 0) + 1);
      if (xy[3]) slots++;
      for (const [x, y] of [
        [xy[1], xy[2]],
        [xy[3], xy[4]],
      ])
        if (x !== undefined && (Number(x) < 0 || Number(x) > w || Number(y) < 0 || Number(y) > h)) errors.push(`hole off the board at ${x},${y}`);
    }
  }
  const total = [...hits.values()].reduce((a, b) => a + b, 0);
  return { errors, tools, hits, total, slots };
}

let routed: RoutedBoard | undefined;
const amp = () => (routed ??= routeBoard(ampBoard()));

describe("circuit board: the guitar amp", () => {
  it("is a realistic board", () => {
    const spec = ampBoard();
    expect(spec.parts.length).toBeGreaterThanOrEqual(60);
    expect(spec.nets.length).toBeGreaterThanOrEqual(40);
    expect(spec.parts.filter((p) => p.side === "bottom").map((p) => p.ref)).toEqual(["RV1", "RV2", "RV3", "RV4", "RV5"]);
  });

  it("has a clean placement, checked well within a frame", () => {
    const spec = ampBoard();
    expect(checkPlacement(spec)).toEqual([]);
    // warm up the way an editor does when a part is dragged, then time it
    for (let k = 0; k < 20; k++) checkPlacement(spec);
    let best = Infinity;
    for (let k = 0; k < 5; k++) {
      const t = performance.now();
      checkPlacement(spec);
      best = Math.min(best, performance.now() - t);
    }
    // the editor checks on every frame of a drag: one 60 fps frame is the budget
    // (about 2 ms on a desktop, 6 ms on a busy CI runner)
    expect(best).toBeLessThan(16);
  });

  it("routes completely with a clean rule check in under 2 s", () => {
    const t = performance.now();
    const b = amp();
    const ms = performance.now() - t;
    expect(b.unrouted).toEqual([]);
    expect(b.stats.routed).toBe(b.stats.connections);
    expect(b.stats.connections).toBeGreaterThan(100);
    expect(b.drc).toEqual([]);
    expect(ms).toBeLessThan(2000);
    expect(b.stats.ms).toBeLessThan(2000);
    // ground poured on both layers
    expect(b.pours.map((p) => `${p.net}:${p.layer}`).sort()).toEqual(["GND:B", "GND:F"]);
    for (const t of b.tracks) expect(t.w).toBe(b.spec.nets.find((n) => n.name === t.net)?.width ?? b.rules.track);
  });

  it("writes Gerbers and drill files a board house can read", () => {
    const b = amp();
    const files = gerberFiles(b);
    const names = files.map((f) => f.path).sort();
    expect(names).toEqual(["Guitar-Amp-NPTH.DRL", "Guitar-Amp-PTH.DRL", "Guitar-Amp.GBL", "Guitar-Amp.GBO", "Guitar-Amp.GBS", "Guitar-Amp.GKO", "Guitar-Amp.GTL", "Guitar-Amp.GTO", "Guitar-Amp.GTS", "README.txt"]);
    for (const f of files.filter((f) => /\.G[TBK][LSOK]$/.test(f.path))) {
      const g = parseGerber(f.content, W, H);
      expect(g.errors, f.path).toEqual([]);
      for (const d of g.used) expect(g.defined.has(d), `${f.path} D${d}`).toBe(true);
      expect(g.draws + g.flashes, f.path).toBeGreaterThan(0);
    }
    // pours are regions on both copper layers
    expect(parseGerber(files.find((f) => f.path.endsWith(".GTL"))!.content, W, H).regions).toBeGreaterThan(0);
    expect(parseGerber(files.find((f) => f.path.endsWith(".GBL"))!.content, W, H).regions).toBeGreaterThan(0);
    const readme = files.find((f) => f.path === "README.txt")!.content;
    for (const s of ["2", "1.6 mm", "HASL lead-free", "1 oz", "Guitar-Amp.GTL", "tented"]) expect(readme).toContain(s);
  });

  it("keeps the board's name from breaking out of Gerber and drill comments", () => {
    const b = amp();
    const files = gerberFiles({ ...b, spec: { ...b.spec, name: "Preamp *v2* 100%\nG01*X0Y0D01*" } });
    for (const f of files.filter((f) => /\.(G[TBK][LSOK]|DRL)$/.test(f.path))) {
      const lines = f.content.split("\n");
      expect(lines.filter((l) => l.includes("Preamp")), f.path).toHaveLength(1);
      expect(lines.some((l) => l.startsWith("G01*X0Y0")), f.path).toBe(false);
      if (f.path.endsWith(".DRL")) expect(parseDrill(f.content, W, H).errors, f.path).toEqual([]);
      else {
        expect(lines[0], f.path).toMatch(/^G04 [^*%]*\*$/);
        expect(parseGerber(f.content, W, H).errors, f.path).toEqual([]);
      }
    }
  });

  it("drills a hole for every pad and via", () => {
    const b = amp();
    const files = gerberFiles(b);
    const pth = parseDrill(files.find((f) => f.path.endsWith("-PTH.DRL"))!.content, W, H);
    const npth = parseDrill(files.find((f) => f.path.endsWith("-NPTH.DRL"))!.content, W, H);
    expect(pth.errors).toEqual([]);
    expect(npth.errors).toEqual([]);
    const pads = placedPads(b.spec);
    expect(pth.total).toBe(pads.length + b.vias.length);
    expect(pth.slots).toBe(pads.filter((p) => p.slot).length);
    expect(pth.slots).toBe(10);
    expect(npth.total).toBe(b.spec.holes.length);
    // every pad's drill size has a tool
    const sizes = new Set([...pth.tools.values()]);
    for (const p of pads) expect(sizes.has(p.drill)).toBe(true);
  });

  it("previews both sides as SVG", () => {
    const b = amp();
    for (const side of ["top", "bottom"] as const) {
      const { svg, width, height } = boardSvg(b, { side, highlightNet: "GND", highlightRef: "U1" });
      expect(svg.startsWith("<svg ")).toBe(true);
      expect(svg.endsWith("</svg>")).toBe(true);
      expect(svg).toContain('viewBox="');
      expect(width).toBeGreaterThan(height);
      expect(svg.length).toBeLessThan(1_000_000);
      expect((svg.match(/<path|<circle|<rect/g) ?? []).length).toBeGreaterThan(200);
    }
    // labels: references and values on the silkscreen, bottom parts on the bottom
    const silk = boardSilk(b.spec);
    expect(silk.F.labels.map((l) => l.lines.join(" "))).toContain("R4 1M");
    expect(silk.B.labels.map((l) => l.ref).sort()).toEqual(["RV1", "RV2", "RV3", "RV4", "RV5"]);
  });

  it("hashes what routing depends on", () => {
    const a = ampBoard();
    const h = boardHash(a);
    expect(boardHash(ampBoard())).toBe(h);
    const renamed = ampBoard();
    renamed.parts[0].value = "15V";
    expect(boardHash(renamed)).toBe(h);
    const moved = ampBoard();
    moved.parts[0].x += 0.5;
    expect(boardHash(moved)).not.toBe(h);
  });
});

// ---------------------------------------------------------------- small boards

const one = (ref: string, x: number, y: number, extra: Partial<PlacedPart> = {}): PlacedPart => ({ ref, value: "", fp: header(1), x, y, rot: 0, side: "top", ...extra });
const small = (w: number, h: number, parts: PlacedPart[], nets: BoardNet[]): BoardSpec => ({ name: "test", w, h, holes: [], parts, nets });

describe("circuit board: routing small cases", () => {
  it("joins two pads on the grid with one straight track", () => {
    // 5.08 and 15.24 mm are grid points (16 and 48 steps of 0.3175 mm)
    const spec = small(20, 10, [one("J1", 5.08, 5.08), one("J2", 15.24, 5.08)], [{ name: "A", pins: [{ ref: "J1", pin: "1" }, { ref: "J2", pin: "1" }] }]);
    const b = routeBoard(spec);
    expect(b.unrouted).toEqual([]);
    expect(b.drc).toEqual([]);
    expect(b.vias).toEqual([]);
    expect(b.tracks).toHaveLength(1);
    expect(b.tracks[0].pts).toEqual([
      [5.08, 5.08],
      [15.24, 5.08],
    ]);
    expect(b.stats).toMatchObject({ connections: 1, routed: 1, vias: 0, trackLength: 10.2 });
  });

  it("goes through a via when two crossing nets fence a third in", () => {
    // H runs edge to edge across, V edge to edge up; D must cross both
    const parts = [one("H1", 1.5, 10), one("H2", 28.5, 10), one("V1", 15, 1.5), one("V2", 15, 18.5), one("D1", 6, 4), one("D2", 24, 16)];
    const nets: BoardNet[] = ["H", "V", "D"].map((n) => ({ name: n, pins: [{ ref: `${n}1`, pin: "1" }, { ref: `${n}2`, pin: "1" }] }));
    const spec = small(30, 20, parts, nets);
    expect(checkPlacement(spec)).toEqual([]);
    const b = routeBoard(spec);
    expect(b.unrouted).toEqual([]);
    expect(b.drc).toEqual([]);
    expect(b.vias.length).toBeGreaterThanOrEqual(1);
  });

  it("reports a pad boxed in by other pads as unrouted", () => {
    const block: Footprint = { name: "3x3", pads: Array.from({ length: 9 }, (_, k) => ({ pin: String(k + 1), x: (k % 3) * 2.54, y: Math.floor(k / 3) * 2.54, shape: "circle", w: 1.7, h: 1.7, drill: 1 })), body: { shape: "rect", x0: -1.3, y0: -1.3, x1: 6.4, y1: 6.4 }, height: 8 };
    const spec = small(30, 20, [{ ref: "J1", value: "", fp: block, x: 5, y: 7, rot: 0, side: "top" }, one("J2", 22, 10)], [{ name: "X", pins: [{ ref: "J1", pin: "5" }, { ref: "J2", pin: "1" }] }]);
    const b = routeBoard(spec, { maxMs: 500 });
    expect(b.unrouted).toHaveLength(1);
    expect(b.unrouted[0].net).toBe("X");
    expect([b.unrouted[0].a, b.unrouted[0].b].map((p) => `${p.ref}.${p.pin}`).sort()).toEqual(["J1.5", "J2.1"]);
    expect(b.stats.routed).toBe(b.stats.connections - 1);
    expect(b.drc.some((d) => d.kind === "unrouted" && d.nets?.includes("X"))).toBe(true);
  });

  it("rule-checks the real copper: shorts, clearance, edge, drills, pours", () => {
    const spec = small(20, 10, [one("J1", 5.08, 5.08), one("J2", 15.24, 5.08), one("J3", 10, 8.5)], [
      { name: "A", pins: [{ ref: "J1", pin: "1" }, { ref: "J2", pin: "1" }] },
      { name: "B", pins: [{ ref: "J3", pin: "1" }] },
    ]);
    const b = routeBoard(spec);
    expect(b.drc).toEqual([]);
    const kinds = (extra: Partial<RoutedBoard>) => new Set(boardDrc({ ...b, ...extra }).map((d) => d.kind));
    // a B track down through A's track, and a tiny via half off the board
    const cross = kinds({ tracks: [...b.tracks, { net: "B", layer: "F", w: 0.4, pts: [[10, 8.5], [10, 2]] }], vias: [{ net: "B", x: 10, y: 0.3, pad: 0.6, drill: 0.2 }] });
    expect(cross).toContain("short");
    expect(cross).toContain("drill");
    expect(cross).toContain("offboard");
    // a B track running 0.2 mm from A's
    expect(kinds({ tracks: [...b.tracks, { net: "B", layer: "F", w: 0.4, pts: [[7, 5.68], [13, 5.68]] }] })).toContain("clearance");
    // the same track on the other layer is fine
    expect(kinds({ tracks: [...b.tracks, { net: "B", layer: "B", w: 0.4, pts: [[7, 5.68], [13, 5.68]] }] }).size).toBe(0);
    // A's track removed: unrouted
    expect(kinds({ tracks: [] })).toContain("unrouted");
    // a pour of B over A's track
    const pour = { net: "B", layer: "F" as const, polys: [[[1, 1], [19, 1], [19, 9], [1, 9]] as [number, number][]] };
    expect(kinds({ pours: [pour] })).toContain("short");
  });

  it("pours ground round other nets with thermal spokes on its own pads", () => {
    const spec = small(30, 20, [one("J1", 5, 10), one("J2", 25, 10), one("J3", 15, 4), one("J4", 15, 16)], [
      { name: "GND", pins: [{ ref: "J1", pin: "1" }, { ref: "J2", pin: "1" }], pour: true },
      { name: "S", pins: [{ ref: "J3", pin: "1" }, { ref: "J4", pin: "1" }] },
    ]);
    const b = routeBoard(spec);
    expect(b.unrouted).toEqual([]);
    expect(b.drc).toEqual([]);
    expect(b.pours.map((p) => p.layer).sort()).toEqual(["B", "F"]);
    for (const p of b.pours) {
      const [outline, ...holes] = p.polys;
      // the outline runs counter-clockwise inside the edge keep-out, holes clockwise
      expect(ringArea(outline)).toBeGreaterThan(400);
      for (const h of holes) expect(ringArea(h)).toBeLessThan(0);
      for (const [x, y] of outline) {
        expect(x).toBeGreaterThanOrEqual(b.rules.edge);
        expect(y).toBeLessThanOrEqual(20 - b.rules.edge);
      }
      // ground pads sit in a cleared ring the spokes cross: the pour doesn't cover the pad's centre...
      for (const pad of placedPads(spec).filter((q) => q.net === "GND")) expect(inRing(outline, pad.x, pad.y) && !holes.some((h) => inRing(h, pad.x, pad.y))).toBe(false);
      // ...but reaches into the pad along the spokes
      const pad = placedPads(spec)[0];
      expect(holes.some((h) => inRing(h, pad.x, pad.y))).toBe(true);
      expect(inRing(outline, pad.x + 0.75, pad.y) && !holes.some((h) => inRing(h, pad.x + 0.75, pad.y))).toBe(true);
      expect(inRing(outline, pad.x + 0.75, pad.y + 0.75) && !holes.some((h) => inRing(h, pad.x + 0.75, pad.y + 0.75))).toBe(false);
    }
  });

  it("finds parts on top of each other and pins the footprint lacks", () => {
    const spec = small(40, 20, [{ ref: "R1", value: "1k", fp: axial(), x: 5, y: 10, rot: 0, side: "top" }, { ref: "R2", value: "1k", fp: axial(), x: 8, y: 10.5, rot: 0, side: "top" }], [
      { name: "A", pins: [{ ref: "R1", pin: "1" }, { ref: "R2", pin: "3" }] },
    ]);
    const items = checkPlacement(spec);
    expect(items.some((i) => i.kind === "overlap" && i.refs?.includes("R1") && i.refs.includes("R2"))).toBe(true);
    expect(items.some((i) => i.kind === "pin" && i.message.includes("R2.3"))).toBe(true);
    // R2 has no pin in a net now
    expect(items.some((i) => i.kind === "pin" && i.refs?.[0] === "R2" && i.message.includes("no net"))).toBe(true);
  });

  it("mirrors bottom-side parts left-right before turning them", () => {
    const fp: Footprint = { name: "t", pads: [{ pin: "1", x: 5, y: 0, shape: "rect", w: 1, h: 2, drill: 0.5 }, { pin: "2", x: 0, y: 2, shape: "circle", w: 1, h: 1, drill: 0.5 }], body: { shape: "rect", x0: -1, y0: -1, x1: 6, y1: 3 }, height: 1 };
    const at = (rot: number, side: "top" | "bottom") => placedPads(small(100, 60, [{ ref: "U1", value: "", fp, x: 50, y: 30, rot, side }], [])).map((p) => [p.x, p.y]);
    expect(at(0, "top")).toEqual([
      [55, 30],
      [50, 32],
    ]);
    expect(at(0, "bottom")).toEqual([
      [45, 30],
      [50, 32],
    ]);
    // mirror x, then 90° counter-clockwise: (5, 0) → (−5, 0) → (0, −5)
    expect(at(90, "bottom")).toEqual([
      [50, 25],
      [48, 30],
    ]);
    // the amp's pots: pins in a row above the shaft, counter-clockwise end on the left
    const pads = placedPads(ampBoard()).filter((p) => p.ref === "RV1");
    expect(pads.map((p) => [p.pin, p.x, p.y])).toEqual([
      ["CCW", 20.5, 14],
      ["W", 23, 14],
      ["CW", 25.5, 14],
      ["MT", 18.2, 6.5],
      ["MT", 27.8, 6.5],
    ]);
  });

  it("has every character the silkscreen needs", () => {
    for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+−-.,/()µΩkM#") expect(FONT_CHARS.includes(ch), ch).toBe(true);
    const box = textBox("R4 10k", 1);
    expect(box.w).toBeGreaterThan(4);
    expect(box.w).toBeLessThan(7);
  });
});
