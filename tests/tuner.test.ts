// The guitar tuner firmware, run for real: the generated sketch is compiled
// into a host harness (tests/fixtures/tuner/harness.cpp) that simulates the
// Nano's ADC, clock, button, EEPROM, Serial and the SSD1306 OLED, and is fed
// synthesized guitar notes through a model of the amp's analog stage. It is
// also compiled for the ATmega328P with clang to catch what AVR rejects.

import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tunerSketch } from "../src/machine/firmware/tuner";

const MOCK_CORE = join(__dirname, "fixtures/arduino");
const HARNESS_SRC = join(__dirname, "fixtures/tuner/harness.cpp");
/** ADC sample rate with a nominal 16 MHz clock: 16e6 / 128 / 13 */
const FS = 16e6 / 128 / 13;

/** Whether this compiler is installed and can build for the target at all. */
const canCompile = (cmd: string, args: string[]) => {
  try {
    execFileSync(cmd, [...args, "-fsyntax-only", "-x", "c++", "-"], { input: "#include <stdint.h>\nint main() { return 0; }\n", stdio: ["pipe", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
};
const HAVE_GPP = canCompile("g++", ["-std=gnu++17"]);
const AVR_ARGS = ["--target=avr", "-mmcu=atmega328p", "-std=gnu++17", "-ffreestanding"];
const HAVE_AVR = canCompile("clang++", AVR_ARGS);
const HAVE_SIZE = (() => {
  try {
    execFileSync("llvm-size", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// Synthesized guitar
// ---------------------------------------------------------------------------

/** A small deterministic generator, so every run hears the same notes. */
function rng(seed: number) {
  let s = seed >>> 0 || 0x9e3779b9;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  const gauss = () => {
    const u = Math.max(next(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  return { next, gauss };
}

interface Pluck {
  /** seconds from power-up */
  at: number;
  /** true frequency of the first partial, Hz */
  hz: number;
  /** loudest swing at the ADC around the 2.5 V bias, volts (0.1 soft, 3.5 clips hard on the rails) */
  peak: number;
  /** decay time of the fundamental, s */
  tau?: number;
  /** stiff-string inharmonicity: partial n at n f0 sqrt(1 + B n^2) */
  b?: number;
  /** where the string is plucked, as a fraction of its length from the bridge */
  pick?: number;
  /** where the pickup sits, the same way */
  pickup?: number;
  /** muted at this time, s from power-up */
  stop?: number;
  /** pitch glide, cents from `from` to `to`, starting `start` s after the pluck and taking `over` s */
  bend?: { start: number; over: number; from: number; to: number };
  seed?: number;
}

interface Scene {
  seconds: number;
  plucks: Pluck[];
  /** clock error of the Nano: +0.004 = its resonator runs 0.4 % fast */
  clock?: number;
  /** white noise at the guitar input, scaled to this rms at the ADC, volts */
  noise?: number;
  seed?: number;
}

const OS = 4; // the analog stage is simulated at 4x the ADC rate, so the ADC aliases what it would
const LP_HZ = 720; // the op-amp stage's low-pass
const HP_HZ = 3.2; // AC coupling into the 100k/100k divider

/** One-pole low-pass in place. */
function lowPass(x: Float64Array, hz: number, rate: number) {
  const a = 1 - Math.exp((-2 * Math.PI * hz) / rate);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    y += a * (x[i] - y);
    x[i] = y;
  }
}

/** One-pole high-pass in place (the coupling capacitor). */
function highPass(x: Float64Array, hz: number, rate: number) {
  const a = 1 - Math.exp((-2 * Math.PI * hz) / rate);
  let lp = 0;
  for (let i = 0; i < x.length; i++) {
    lp += a * (x[i] - lp);
    x[i] -= lp;
  }
}

/**
 * The pickup voltage of one plucked string, as an additive model: partials of
 * a stiff string (inharmonic), weighted by where it is plucked and where the
 * pickup is (a magnetic pickup senses velocity: amplitude ~ sin(n pi p) sin(n pi q) / n),
 * each decaying faster the higher it is, starting with a 2.5 ms noisy pick attack.
 */
function renderPluck(p: Pluck, n: number, rate: number, freqScale: number, r: ReturnType<typeof rng>): Float64Array {
  const out = new Float64Array(n);
  const i0 = Math.round(p.at * rate);
  const iEnd = p.stop ? Math.min(n, Math.round(p.stop * rate) + Math.round(0.08 * rate)) : n;
  const B = p.b ?? 1e-4;
  const pick = p.pick ?? 0.18;
  const pickup = p.pickup ?? 0.12;
  const tau = p.tau ?? 2;
  const f1 = p.hz * freqScale;
  const f0 = f1 / Math.sqrt(1 + B);
  for (let k = 1; k <= 60; k++) {
    const fk = k * f0 * Math.sqrt(1 + B * k * k);
    if (fk > 7000) break;
    const amp = (Math.sin(k * Math.PI * pick) * Math.sin(k * Math.PI * pickup)) / k;
    if (Math.abs(amp) < 1e-4) continue;
    const alpha = 1 / tau + 3e-6 * fk * fk; // 1/s
    const decay = Math.exp(-alpha / rate);
    let env = amp;
    let phase = 0.3 * r.gauss();
    for (let i = i0; i < iEnd; i++) {
      const t = (i - i0) / rate;
      let f = fk;
      if (p.bend) {
        const u = Math.min(1, Math.max(0, (t - p.bend.start) / p.bend.over));
        f = fk * 2 ** ((p.bend.from + (p.bend.to - p.bend.from) * u) / 1200);
      }
      phase += (2 * Math.PI * f) / rate;
      out[i] += env * Math.sin(phase) * (1 - Math.exp(-t / 0.0004));
      env *= decay;
    }
  }
  // the pick: a short burst of noise
  let peak = 0;
  for (let i = i0; i < Math.min(iEnd, i0 + Math.round(0.03 * rate)); i++) peak = Math.max(peak, Math.abs(out[i]));
  const burst = Math.round(0.0025 * rate);
  for (let i = 0; i < burst && i0 + i < n; i++) out[i0 + i] += 0.35 * peak * r.gauss() * (1 - i / burst);
  // muting: a fast fade
  if (p.stop) {
    const is = Math.round(p.stop * rate);
    for (let i = is; i < n; i++) out[i] *= Math.exp(-(i - is) / (0.01 * rate));
  }
  return out;
}

/**
 * The 8-bit samples the Nano's ADC reads, one per 104 us conversion from power-up:
 * guitar -> op-amp (gain -22, 720 Hz low-pass) -> AC coupling -> 2.5 V bias ->
 * clipping at the rails -> 10-bit ADC with half an LSB of noise -> ADCH (top 8 bits).
 * The Nano's clock error is simulated by scaling every frequency against the nominal rate.
 */
function synth(scene: Scene): Uint8Array {
  const rate = FS * OS;
  const n = Math.round(scene.seconds * rate);
  const freqScale = 1 / (1 + (scene.clock ?? 0));
  const r = rng(scene.seed ?? 1);
  const ac = new Float64Array(n);
  for (const p of scene.plucks) {
    const v = renderPluck(p, n, rate, freqScale, rng(p.seed ?? Math.round(p.hz * 1000 + p.at * 10)));
    for (let i = 0; i < n; i++) v[i] *= -22; // the op-amp's gain (the level is set below)
    lowPass(v, LP_HZ, rate);
    highPass(v, HP_HZ, rate);
    // `peak` is the swing of the ringing string just after the pick (10-60 ms), not of the pick's click
    let peak = 0;
    const b0 = Math.round((p.at + 0.01) * rate);
    const b1 = Math.min(n, Math.round((p.at + 0.06) * rate));
    for (let i = b0; i < b1; i++) peak = Math.max(peak, Math.abs(v[i]));
    const g = peak > 0 ? p.peak / peak : 0;
    for (let i = 0; i < n; i++) ac[i] += v[i] * g;
  }
  if (scene.noise) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = r.gauss();
    lowPass(w, LP_HZ, rate);
    let ss = 0;
    for (let i = 0; i < n; i++) ss += w[i] * w[i];
    const g = scene.noise / Math.sqrt(ss / n);
    for (let i = 0; i < n; i++) ac[i] += w[i] * g;
  }
  const out = new Uint8Array(Math.floor(n / OS));
  for (let k = 0; k < out.length; k++) {
    let v = 2.5 + ac[k * OS] + 0.5 * (5 / 1024) * r.gauss();
    v = Math.min(5, Math.max(0, v));
    const code = Math.min(1023, Math.max(0, Math.floor((v / 5) * 1024)));
    out[k] = code >> 2;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Running the harness
// ---------------------------------------------------------------------------

interface Line {
  ms: number;
  text: string;
}
interface Reading {
  ms: number;
  note: string;
  cents: number;
  hz: number;
}
interface RunResult {
  lines: Line[];
  readings: Reading[];
  frames: { ms: number; rows: string[] }[];
  info: Record<string, string>;
}

let work = "";
let harness = "";
let sketchPath = "";
let sketchSource = "";
let runCount = 0;

const READING = /^([A-G]#?\d) ([+-]\d+\.\d)c (\d+\.\d\d)Hz$/;

function runHarness(signal: Uint8Array | null, args: string[] = []): RunResult {
  const sig = join(work, `sig${runCount++}.u8`);
  if (signal) writeFileSync(sig, signal);
  const out = execFileSync(harness, [...(signal ? ["--signal", sig] : []), ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (signal) rmSync(sig, { force: true });
  const res: RunResult = { lines: [], readings: [], frames: [], info: {} };
  const rows = out.split("\n");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.startsWith("S ")) {
      const sp = row.indexOf(" ", 2);
      const line = { ms: Number(row.slice(2, sp)), text: row.slice(sp + 1) };
      res.lines.push(line);
      const m = READING.exec(line.text);
      if (m) res.readings.push({ ms: line.ms, note: m[1], cents: Number(m[2]), hz: Number(m[3]) });
    } else if (row.startsWith("F ")) {
      res.frames.push({ ms: Number(row.slice(2)), rows: rows.slice(i + 1, i + 65) });
      i += 64;
    } else if (row.startsWith("I ")) {
      const parts = row.slice(2).split(" ");
      for (let j = 0; j + 1 < parts.length; j += 2) res.info[parts[j]] = parts[j + 1];
    }
  }
  return res;
}

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteHz = (name: string, ref = 440) => {
  const m = /^([A-G]#?)(\d)$/.exec(name)!;
  const midi = NAMES.indexOf(m[1]) + 12 * (Number(m[2]) + 1);
  return ref * 2 ** ((midi - 69) / 12);
};

// ---------------------------------------------------------------------------
// The OLED picture
// ---------------------------------------------------------------------------

/** Kerf's 5x7 glyphs for what the big note area shows, drawn independently of the sketch's table. */
const GLYPHS: Record<string, string[]> = {
  A: [".###.", "#...#", "#...#", "#...#", "#####", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["###..", "#..#.", "#...#", "#...#", "#...#", "#..#.", "###.."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "###..", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#....", "#..##", "#...#", ".###."],
  "#": [".#.#.", ".#.#.", "#####", ".#.#.", "#####", ".#.#.", ".#.#."],
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
};

/** Is the glyph drawn at (x, y), each pixel scale x scale, in the frame? inverted: dark on light. */
function glyphAt(rows: string[], ch: string, x: number, y: number, scale: number, inverted = false): boolean {
  const g = GLYPHS[ch];
  for (let gy = 0; gy < 7 * scale; gy++)
    for (let gx = 0; gx < 5 * scale; gx++) {
      const want = (g[Math.floor(gy / scale)][Math.floor(gx / scale)] === "#") !== inverted;
      if ((rows[y + gy]?.[x + gx] === "#") !== want) return false;
    }
  return true;
}

/** Where the glyph is drawn inside a region of the frame, or undefined. */
function findGlyph(rows: string[], ch: string, scale: number, region: { x0: number; x1: number; y0: number; y1: number }, inverted = false) {
  for (let y = region.y0; y <= region.y1; y++) for (let x = region.x0; x <= region.x1; x++) if (glyphAt(rows, ch, x, y, scale, inverted)) return { x, y };
  return undefined;
}

/** The needle: a 3-pixel bar through rows 44..59; returns its offset from the centre column (64) in pixels = cents. */
function needleOffset(rows: string[]): number | undefined {
  const row = rows[46];
  const xs: number[] = [];
  for (let x = 10; x < 120; x++) if (row[x] === "#") xs.push(x);
  if (xs.length !== 3 || xs[2] - xs[0] !== 2) return undefined;
  return xs[1] - 64;
}

const frameAt = (r: RunResult, ms: number) => r.frames.find((f) => f.ms === ms)!.rows;

// ---------------------------------------------------------------------------

const STRINGS: { name: string; tau: number }[] = [
  { name: "B1", tau: 4 },
  { name: "E2", tau: 3.5 },
  { name: "A2", tau: 3 },
  { name: "D3", tau: 2.5 },
  { name: "G3", tau: 2 },
  { name: "B3", tau: 1.8 },
  { name: "E4", tau: 1.5 },
  { name: "F#4", tau: 1.4 },
  { name: "A4", tau: 1.2 },
  { name: "E5", tau: 1 },
];
const OFFSETS = [-30, -7, 0, 4, 25];
const AMPS = [
  { label: "soft", peak: 0.1 },
  { label: "hard", peak: 3.5 },
];

describe("tuner firmware generator", () => {
  it("writes a sketch folder named after the design, with the pins as constants at the top", () => {
    const r = tunerSketch({ designName: "Kerf Amp v2 (practice)", adcPin: "A3", buttonPin: "4", oledAddr: 0x3d, refHz: 442 });
    expect(r.warnings).toEqual([]);
    expect(r.files.map((f) => f.path)).toEqual(["Kerf_Amp_v2_practice/Kerf_Amp_v2_practice.ino", "Kerf_Amp_v2_practice/README.md"]);
    const ino = r.files[0].content;
    expect(ino).toMatch(/const uint8_t SIGNAL_PIN = A3;/);
    expect(ino).toMatch(/const uint8_t BUTTON_PIN = 4;/);
    expect(ino).toMatch(/const uint8_t OLED_ADDR = 0x3D;/);
    expect(ino).toMatch(/const uint8_t DEFAULT_REF = 2;\s+\/\/ A4 = 442 Hz/);
    expect(ino).toContain("ISR(ADC_vect)");
    expect(ino).toContain("const uint8_t FONT[] PROGMEM");
    expect(ino).not.toMatch(/#include <(?!Arduino|Wire|EEPROM|avr\/)/); // nothing to install
    expect(r.pinTable.map((p) => `${p.signal} ${p.pin}`)).toEqual(expect.arrayContaining(["GUITAR_IN A3", "BUTTON D4", "OLED_SDA A4", "OLED_SCL A5"]));
    const readme = r.files[1].content;
    expect(readme).toContain("Arduino Nano");
    expect(readme).toContain("Old Bootloader");
    expect(readme).toMatch(/Calibrat/);
  });

  it("says what it changed when the options cannot work on a Nano", () => {
    const r = tunerSketch({ designName: "", adcPin: "D5", buttonPin: "A4", oledAddr: 0x99, refHz: 437 });
    expect(r.files[0].path).toBe("tuner/tuner.ino");
    expect(r.warnings.join("\n")).toMatch(/analog input A0..A7/);
    expect(r.warnings.join("\n")).toMatch(/I2C pins/);
    expect(r.warnings.join("\n")).toMatch(/7-bit I2C address/);
    expect(r.warnings.join("\n")).toMatch(/starts at 438 Hz/);
    const ino = r.files[0].content;
    expect(ino).toMatch(/SIGNAL_PIN = A0;/);
    expect(ino).toMatch(/BUTTON_PIN = 2;/);
    expect(tunerSketch({ designName: "x", adcPin: "A7", buttonPin: "A6" }).warnings.join()).toMatch(/analog-only/);
    expect(tunerSketch({ designName: "x", adcPin: "A0", buttonPin: "A0" }).warnings.join()).toMatch(/signal input/);
  });

  it("keeps its font table in step with the glyphs the tests draw", () => {
    const ino = tunerSketch({ designName: "t", adcPin: "A0" }).files[0].content;
    const table = /const uint8_t FONT\[\] PROGMEM = \{([\s\S]*?)\};/.exec(ino)![1];
    const bytes = [...table.replace(/\/\/.*$/gm, "").matchAll(/0x([0-9A-F]{2})/g)].map((m) => parseInt(m[1], 16));
    expect(bytes.length).toBe(95 * 5);
    for (const [ch, art] of Object.entries(GLYPHS)) {
      const cols = bytes.slice((ch.charCodeAt(0) - 32) * 5, (ch.charCodeAt(0) - 32) * 5 + 5);
      const drawn = art.map((_, row) => cols.map((c) => ((c >> row) & 1 ? "#" : ".")).join(""));
      expect(drawn, ch).toEqual(art);
    }
  });
});

describe("tuner firmware compiles", () => {
  const compilers = [
    { name: "g++", ok: HAVE_GPP, cmd: "g++", args: ["-std=gnu++17"] },
    { name: "clang for AVR", ok: HAVE_AVR, cmd: "clang++", args: AVR_ARGS },
  ];
  for (const c of compilers) {
    it.skipIf(!c.ok)(`with ${c.name} against the mock Arduino core, warnings as errors`, { timeout: 60_000 }, () => {
      const dir = mkdtempSync(join(tmpdir(), "kerf-tuner-"));
      try {
        for (const opts of [
          { designName: "KERF AMP", adcPin: "A0" },
          { designName: "seven", adcPin: "A7", buttonPin: "A2", oledAddr: 0x3d, refHz: 432 },
        ]) {
          const f = tunerSketch(opts).files[0];
          const p = join(dir, f.path);
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, f.content);
          execFileSync(c.cmd, [...c.args, "-fsyntax-only", "-Wall", "-Wextra", "-Werror", "-x", "c++", "-include", join(MOCK_CORE, "Arduino.h"), `-I${MOCK_CORE}`, p], { stdio: "pipe" });
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it.skipIf(!HAVE_AVR || !HAVE_SIZE)("fits the ATmega328P's flash and leaves RAM for the stack", { timeout: 60_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "kerf-tuner-"));
    try {
      const f = tunerSketch({ designName: "KERF AMP", adcPin: "A0" }).files[0];
      const p = join(dir, "t.ino");
      writeFileSync(p, f.content);
      const obj = join(dir, "t.o");
      execFileSync("clang++", [...AVR_ARGS, "-Os", "-c", "-x", "c++", "-include", join(MOCK_CORE, "Arduino.h"), `-I${MOCK_CORE}`, p, "-o", obj], { stdio: "pipe" });
      const sizes: Record<string, number> = {};
      for (const line of execFileSync("llvm-size", ["-A", obj], { encoding: "utf8" }).split("\n")) {
        const m = /^(\.\S+)\s+(\d+)/.exec(line);
        if (m) sizes[m[1]] = (sizes[m[1]] ?? 0) + Number(m[2]);
      }
      // .rodata here is the F() and PSTR() text, which avr-gcc keeps in flash (the mock core cannot)
      const flash = (sizes[".text"] ?? 0) + (sizes[".progmem.data"] ?? 0) + (sizes[".data"] ?? 0) + (sizes[".rodata.str1.1"] ?? 0);
      const ram = (sizes[".bss"] ?? 0) + (sizes[".data"] ?? 0);
      // The Arduino core, Serial and Wire add about 4 KB of flash and 340 bytes of RAM; soft floats about 2 KB of flash.
      console.log(`tuner on the ATmega328P (clang -Os): sketch ${flash} bytes of flash (+~6 KB core, Wire, Serial, floats) of 30720; ${ram} bytes of RAM (+~340 core) of 2048`);
      expect(flash + 6500).toBeLessThan(30720);
      expect(ram + 340).toBeLessThan(2048 - 300); // at least 300 bytes left for the stack
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


/** One plucked string, in tune unless `cents` says otherwise. */
const pluck = (note: string, at: number, extra: Partial<Pluck> & { cents?: number; ref?: number } = {}): Pluck => {
  const { cents = 0, ref = 440, ...rest } = extra;
  const tau = STRINGS.find((s) => s.name === note)?.tau ?? 2;
  return { at, hz: noteHz(note, ref) * 2 ** (cents / 1200), peak: 3.5, tau, ...rest };
};
const readingsFrom = (r: RunResult, ms: number) => r.readings.filter((x) => x.ms >= ms);
const lineAt = (r: RunResult, re: RegExp) => r.lines.find((l) => re.test(l.text));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
/**
 * Soft notes (0.1 V) on the three lowest strings, under 120 Hz, are where 8-bit samples run out of
 * detail: the fundamental is a few ADC steps high, and a note picked near the bridge is mostly a
 * narrow spike once a period, whose timing carries the sharp upper partials (inharmonicity) into
 * the reading. Each of their readings is held to 2 cents and the note's average to 1.5 cents;
 * every other reading to 1 cent.
 */
const SOFT_LOW_STRINGS = ["B1", "E2", "A2"];
const SOFT_LOW_LIMIT = 2.0;
const SOFT_LOW_MEAN_LIMIT = 1.5;

describe.skipIf(!HAVE_GPP)("tuner firmware on simulated hardware", { timeout: 20_000 }, () => {
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "kerf-tuner-run-"));
    const f = tunerSketch({ designName: "KERF AMP", adcPin: "A0", buttonPin: "2" }).files[0];
    sketchPath = join(work, f.path);
    sketchSource = f.content;
    mkdirSync(dirname(sketchPath), { recursive: true });
    writeFileSync(sketchPath, f.content);
    harness = join(work, "harness");
    execFileSync("g++", ["-std=gnu++17", "-O2", "-Wall", `-I${MOCK_CORE}`, `-DKERF_SKETCH="${sketchPath}"`, HARNESS_SRC, "-o", harness], { stdio: "pipe" });
    return () => rmSync(work, { recursive: true, force: true });
  }, 120_000);

  it("starts with the ADC, button, I2C and display set up as the hardware needs", () => {
    expect(sketchSource).toContain("SIGNAL_PIN = A0");
    const r = runHarness(null, ["--ms", "1500", "--snap", "1000"]);
    expect(r.info.baud).toBe("115200");
    expect(r.info.button_mode).toBe("2"); // INPUT_PULLUP
    expect(r.info.adc_wrong_setup).toBe("0"); // A0, AVcc reference, every conversion
    expect(r.info.didr0).toBe("1"); // A0's digital input buffer off
    expect(r.info.twbr).toBe("12"); // 400 kHz
    expect(r.info.wire_overflows).toBe("0");
    expect(r.info.oled_on).toBe("1");
    expect(r.info.remap).toBe("1");
    expect(r.info.com_flip).toBe("1");
    expect(r.info.charge_pump).toBe("1");
    expect(r.lines[0].text).toBe("KERF AMP tuner: A4=440Hz, clock calibration +0.00%");
    expect(r.readings).toEqual([]);
    // idle screen: "KERF AMP" at 2x, "A4=440Hz" small at the bottom left
    const rows = frameAt(r, 1000);
    expect(findGlyph(rows, "A", 2, { x0: 0, x1: 120, y0: 12, y1: 12 })).toBeDefined();
    expect(glyphAt(rows, "A", 0, 56, 1) && glyphAt(rows, "4", 6, 56, 1)).toBe(true);
  });

  it("reads every string within 1 cent, soft and hard, within 300 ms of the pluck", { timeout: 120_000 }, () => {
    // (soft notes on the lowest three strings: every reading within 2 cents, their average within 1.5)
    const table: string[] = [];
    const worst: Record<string, { err: number; what: string }> = { hard: { err: 0, what: "" }, soft: { err: 0, what: "" } };
    let worstSoftLow = { err: 0, what: "" };
    let slowest = { ms: 0, what: "" };
    let maxAnalysisMs = 0;
    let maxPairs = 0;
    let readings = 0;
    let overOne = 0;
    const failures: string[] = [];
    let caseNo = 0;
    for (const s of STRINGS) {
      for (const amp of AMPS) {
        const row: string[] = [];
        for (const off of OFFSETS) {
          caseNo++;
          const at = 0.2 + ((caseNo * 0.037) % 0.2); // pluck at varied points of the capture cycle
          const hz = noteHz(s.name) * 2 ** (off / 1200);
          const sig = synth({
            seconds: at + 1.3,
            plucks: [{ at, hz, peak: amp.peak, tau: s.tau, pick: [0.13, 0.18, 0.25][caseNo % 3], pickup: caseNo % 2 ? 0.08 : 0.24 }],
            seed: caseNo,
          });
          const r = runHarness(sig, ["--ms", String(Math.round((at + 1.3) * 1000))]);
          maxAnalysisMs = Math.max(maxAnalysisMs, Number(r.info.max_analysis_ms));
          maxPairs = Math.max(maxPairs, Number(r.info.max_pairs));
          const after = readingsFrom(r, at * 1000);
          const what = `${s.name} ${off >= 0 ? "+" : ""}${off}c ${amp.label}`;
          if (!after.length) {
            failures.push(`${what}: no reading`);
            row.push("none".padEnd(20));
            continue;
          }
          const first = after[0].ms - at * 1000;
          if (first > slowest.ms) slowest = { ms: first, what };
          if (first > 300) failures.push(`${what}: first reading after ${first} ms`);
          let caseWorst = 0;
          for (const x of after) {
            if (x.note !== s.name) failures.push(`${what}: read ${x.note} ${x.cents}c at ${x.ms} ms`);
            const err = x.cents - off;
            if (Math.abs(err) > Math.abs(caseWorst)) caseWorst = err;
            if (Math.abs(err) > 1.0) overOne++;
          }
          readings += after.length;
          const errMean = mean(after.map((x) => x.cents)) - off;
          if (amp.label === "soft" && SOFT_LOW_STRINGS.includes(s.name)) {
            if (Math.abs(caseWorst) > Math.abs(worstSoftLow.err)) worstSoftLow = { err: caseWorst, what };
            if (Math.abs(caseWorst) > SOFT_LOW_LIMIT) failures.push(`${what}: off by ${caseWorst.toFixed(1)} cents`);
            if (Math.abs(errMean) > SOFT_LOW_MEAN_LIMIT) failures.push(`${what}: off by ${errMean.toFixed(2)} cents on average`);
          } else {
            if (Math.abs(caseWorst) > Math.abs(worst[amp.label].err)) worst[amp.label] = { err: caseWorst, what };
            if (Math.abs(caseWorst) > 1.0) failures.push(`${what}: off by ${caseWorst.toFixed(1)} cents`);
          }
          const sign = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
          row.push(`${sign(errMean).padStart(4)} ${sign(caseWorst).padStart(4)} ${String(Math.round(first)).padStart(3)}ms n${after.length}`.padEnd(20));
        }
        table.push(`${s.name.padEnd(4)}${amp.label.padEnd(5)}| ${row.join(" | ")}`);
      }
    }
    console.log(
      [
        "tuner accuracy: per true offset, mean error and worst error of the readings (cents), time to the first reading, number of readings",
        `         | ${OFFSETS.map((o) => `${o >= 0 ? "+" : ""}${o}c`.padEnd(20)).join(" | ")}`,
        ...table,
        `worst error: hard ${worst.hard.err.toFixed(1)} cents (${worst.hard.what}), soft D3 and up ${worst.soft.err.toFixed(1)} cents (${worst.soft.what}), soft B1/E2/A2 ${worstSoftLow.err.toFixed(1)} cents (${worstSoftLow.what})`,
        `${overOne} of ${readings} readings more than 1 cent off; slowest first reading ${Math.round(slowest.ms)} ms (${slowest.what})`,
        `analysis per buffer at worst: ${maxPairs} sample pairs, ${maxAnalysisMs.toFixed(1)} ms of AVR time (26 cycles a pair + 7.5 ms overhead)`,
      ].join("\n"),
    );
    expect(failures).toEqual([]);
    expect(maxAnalysisMs).toBeLessThan(120);
  });

  it("gives its first reading within 300 ms wherever the pluck falls in the capture cycle", { timeout: 60_000 }, () => {
    const delays: number[] = [];
    for (const [note, peak] of [["B1", 0.1], ["E2", 3.5], ["E2", 0.1], ["G3", 0.3], ["E5", 1]] as const) {
      for (let i = 0; i < 12; i++) {
        const at = 0.3 + i * 0.0131; // 12 phases across one 157 ms capture and analysis cycle
        const r = runHarness(synth({ seconds: at + 0.6, plucks: [pluck(note, at, { peak, pickup: 0.1 + 0.01 * i })], seed: 50 + i }), ["--ms", String(Math.round((at + 0.6) * 1000))]);
        const first = readingsFrom(r, at * 1000)[0];
        expect(first?.note, `${note} at ${at}`).toBe(note);
        delays.push(first.ms - at * 1000);
      }
    }
    console.log(`time from pluck to first reading over 60 plucks: ${Math.min(...delays).toFixed(0)}..${Math.max(...delays).toFixed(0)} ms`);
    expect(Math.max(...delays)).toBeLessThanOrEqual(300);
  });

  it("stays silent on silence and on noise", () => {
    const quiet = runHarness(synth({ seconds: 3, plucks: [], seed: 3 }), ["--ms", "3000"]);
    expect(quiet.readings).toEqual([]);
    expect(quiet.lines.filter((l) => l.text === "-").length).toBeGreaterThanOrEqual(2); // "-" once a second
    for (const rms of [0.01, 0.05, 0.3, 1.0]) {
      const r = runHarness(synth({ seconds: 3, plucks: [], noise: rms, seed: 7 }), ["--ms", "3000", "--snap", "2500"]);
      expect(r.readings, `white noise at ${rms} V rms`).toEqual([]);
      expect(findGlyph(frameAt(r, 2500), "A", 2, { x0: 0, x1: 120, y0: 12, y1: 12 }), `idle screen with ${rms} V of noise`).toBeDefined();
    }
  });

  it("follows a note as it decays, holds it 1 s after it stops, then shows the idle screen", () => {
    // a hard E2 that rings for 3.5 s and is then muted
    const r = runHarness(synth({ seconds: 6, plucks: [pluck("E2", 0.3, { cents: -12, stop: 3.8 })], seed: 11 }), ["--ms", "6000", "--snap", "4300", "--snap", "5300"]);
    const rd = readingsFrom(r, 300);
    expect(rd.length).toBeGreaterThan(20);
    for (const x of rd) {
      expect(x.note).toBe("E2");
      expect(Math.abs(x.cents + 12), `${x.ms} ms`).toBeLessThanOrEqual(1.0);
    }
    for (let i = 1; i < rd.length; i++) expect(rd[i].ms - rd[i - 1].ms).toBeLessThan(200); // no gaps while it rings
    const last = rd[rd.length - 1].ms;
    expect(last).toBeGreaterThan(3750);
    expect(last).toBeLessThan(4000);
    const dash = r.lines.find((l) => l.text === "-" && l.ms > last)!;
    expect(dash.ms - last).toBeGreaterThanOrEqual(900);
    expect(dash.ms - last).toBeLessThanOrEqual(1200);
    // during the hold the note is still shown; after it the idle screen
    expect(glyphAt(frameAt(r, 4300), "E", 22, 10, 4)).toBe(true);
    expect(findGlyph(frameAt(r, 5300), "A", 2, { x0: 0, x1: 120, y0: 12, y1: 12 })).toBeDefined();
    expect(glyphAt(frameAt(r, 5300), "E", 22, 10, 4)).toBe(false);
  });

  it("tracks a bend from 30 cents flat up to pitch", () => {
    // G3 plucked 30 cents flat at 0.3 s, bent up to pitch from 0.8 s to 1.3 s
    const at = 0.3;
    const bend = { start: 0.5, over: 0.5, from: -30, to: 0 };
    const r = runHarness(synth({ seconds: 2.2, plucks: [pluck("G3", at, { bend })], seed: 13 }), ["--ms", "2200", "--snap", "1600"]);
    const truth = (sec: number) => bend.from + (bend.to - bend.from) * Math.min(1, Math.max(0, (sec - at - bend.start) / bend.over));
    const rd = readingsFrom(r, at * 1000);
    const lines: string[] = [];
    for (const x of rd) {
      expect(x.note).toBe("G3");
      // a reading describes the buffer that ended about 40 ms before it (the analysis) and began 106 ms before that
      const expected = truth((x.ms - 95) / 1000);
      lines.push(`${x.ms}ms ${x.cents.toFixed(1)} (${expected.toFixed(1)})`);
      expect(Math.abs(x.cents - expected), `${x.ms} ms`).toBeLessThanOrEqual(x.ms < 800 || x.ms > 1500 ? 1.0 : 4.0);
    }
    console.log(`bend: reading (bend at the buffer's middle): ${lines.join(", ")}`);
    const during = rd.filter((x) => x.ms > 900 && x.ms < 1350);
    expect(during.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < during.length; i++) expect(during[i].cents).toBeGreaterThan(during[i - 1].cents);
    // the needle has caught up 0.3 s after the bend ends
    const needle = needleOffset(frameAt(r, 1600));
    expect(Math.abs(needle!)).toBeLessThanOrEqual(1);
  });

  it("draws the note, the cents and the needle", () => {
    const shot = (note: string, cents: number) => {
      const r = runHarness(synth({ seconds: 1.2, plucks: [pluck(note, 0.3, { cents })], seed: 17 }), ["--ms", "1200", "--snap", "1000"]);
      return { r, rows: frameAt(r, 1000) };
    };
    // E2, 30 cents flat: big E, small 2, needle 30 pixels left of the centre
    let { r, rows } = shot("E2", -30);
    expect(glyphAt(rows, "E", 22, 10, 4)).toBe(true);
    expect(glyphAt(rows, "2", 46, 24, 2)).toBe(true);
    expect(findGlyph(rows, "3", 2, { x0: 64, x1: 127, y0: 17, y1: 17 })).toBeDefined(); // "-30c"
    expect(needleOffset(rows)).toBeGreaterThanOrEqual(-31);
    expect(needleOffset(rows)).toBeLessThanOrEqual(-29);
    expect(glyphAt(rows, "A", 0, 0, 1) && glyphAt(rows, "4", 6, 0, 1)).toBe(true); // "A4=440" top left
    expect(r.info.wire_overflows).toBe("0");
    // A4, 25 cents sharp: needle right
    ({ r, rows } = shot("A4", 25));
    expect(glyphAt(rows, "A", 22, 10, 4)).toBe(true);
    expect(glyphAt(rows, "4", 46, 24, 2)).toBe(true);
    expect(needleOffset(rows)).toBeGreaterThanOrEqual(24);
    expect(needleOffset(rows)).toBeLessThanOrEqual(26);
    // A4 in tune: the note box is lit (the letter dark on light), the needle centred
    ({ r, rows } = shot("A4", 0));
    expect(glyphAt(rows, "A", 22, 10, 4, true)).toBe(true);
    expect(needleOffset(rows)).toBe(0);
    // F#4: big F, small sharp and octave
    ({ r, rows } = shot("F#4", 7));
    expect(glyphAt(rows, "F", 22, 10, 4)).toBe(true);
    expect(glyphAt(rows, "#", 46, 10, 2)).toBe(true);
    expect(glyphAt(rows, "4", 46, 24, 2)).toBe(true);
  });

  it("never blanks the note while redrawing (no flicker)", () => {
    const snaps: string[] = [];
    for (let ms = 600; ms <= 1400; ms += 10) snaps.push("--snap", String(ms));
    const r = runHarness(synth({ seconds: 1.5, plucks: [pluck("D3", 0.3, { cents: 9 })], seed: 19 }), ["--ms", "1500", ...snaps]);
    expect(r.frames.length).toBe(81);
    for (const f of r.frames) expect(glyphAt(f.rows, "D", 22, 10, 4), `${f.ms} ms`).toBe(true);
  });

  it("steps the reference with short presses and keeps it in EEPROM", () => {
    const presses: string[] = [];
    for (let i = 0; i < 10; i++) presses.push("--press", `${1000 + 400 * i}:${1100 + 400 * i}`);
    const r = runHarness(null, ["--ms", "6000", ...presses, "--snap", "1300"]);
    const refs = r.lines.filter((l) => l.text.startsWith("REF ")).map((l) => l.text);
    expect(refs).toEqual(["441", "442", "443", "444", "445", "432", "435", "438", "439", "440"].map((h) => `REF A4=${h}Hz`));
    // shown big: "441" at 4x
    const rows = frameAt(r, 1300);
    const four = findGlyph(rows, "4", 4, { x0: 0, x1: 80, y0: 18, y1: 18 });
    expect(four).toBeDefined();
    expect(glyphAt(rows, "1", four!.x + 48, 18, 4)).toBe(true);
    // two presses, power off, power on: 442, and an A at 440 Hz reads 7.85 cents flat
    const ee = join(work, "ref.eeprom");
    runHarness(null, ["--ms", "2500", "--press", "1000:1100", "--press", "1500:1600", "--eeprom-out", ee]);
    const again = runHarness(synth({ seconds: 1.5, plucks: [pluck("A4", 0.3)], seed: 23 }), ["--ms", "1500", "--eeprom-in", ee]);
    expect(again.lines[0].text).toBe("KERF AMP tuner: A4=442Hz, clock calibration +0.00%");
    const rd = readingsFrom(again, 300);
    expect(rd.length).toBeGreaterThan(3);
    for (const x of rd) {
      expect(x.note).toBe("A4");
      expect(Math.abs(x.cents - 1200 * Math.log2(440 / 442))).toBeLessThanOrEqual(1.0);
    }
  });

  it("calibrates a clock that runs 0.4 % fast on a held A, keeps it, and forgets it when asked", { timeout: 30_000 }, () => {
    const clock = 0.004; // the resonator runs 0.4 % fast: every note reads 6.9 cents flat
    const flat = 1200 * Math.log2(1 / (1 + clock));
    const a2 = synth({ seconds: 5, plucks: [pluck("A2", 0.3)], clock, seed: 29 });
    const before = runHarness(a2, ["--ms", "2000"]);
    const beforeMean = mean(readingsFrom(before, 300).map((x) => x.cents));
    expect(Math.abs(beforeMean - flat)).toBeLessThanOrEqual(1.0);

    // hold the button 3 s while the A rings
    const ee = join(work, "cal.eeprom");
    const cal = runHarness(a2, ["--ms", "5000", "--press", "800:4300", "--eeprom-out", ee, "--snap", "4200"]);
    const done = lineAt(cal, /^CALIBRATED /);
    expect(done, cal.lines.map((l) => l.text).join("\n")).toBeDefined();
    const pct = Number(/^CALIBRATED ([+-]\d+\.\d\d)%$/.exec(done!.text)![1]);
    expect(Math.abs(pct - 0.4)).toBeLessThanOrEqual(0.03);
    expect(done!.ms).toBeGreaterThanOrEqual(3800);
    expect(done!.ms).toBeLessThanOrEqual(3900);
    expect(findGlyph(frameAt(cal, 4200), "A", 2, { x0: 0, x1: 127, y0: 12, y1: 12 })).toBeDefined(); // "CALIBRATED" at 2x
    for (const x of readingsFrom(cal, 4000)) expect(Math.abs(x.cents)).toBeLessThanOrEqual(1.0);
    expect([...readFileSync(ee).subarray(0, 2)]).toEqual([0x4b, 0x54]); // "KT"

    // after a power cycle every string reads true
    const after: string[] = [];
    for (const note of ["E2", "D3", "B3", "E4"]) {
      const r = runHarness(synth({ seconds: 1.5, plucks: [pluck(note, 0.3, { cents: 3 })], clock, seed: 31 }), ["--ms", "1500", "--eeprom-in", ee]);
      expect(r.lines[0].text).toMatch(/^KERF AMP tuner: A4=440Hz, clock calibration \+0\.(3[7-9]|4[0-3])%$/);
      const rd = readingsFrom(r, 300);
      expect(rd.length).toBeGreaterThan(3);
      for (const x of rd) {
        expect(x.note).toBe(note);
        expect(Math.abs(x.cents - 3), `${note} after calibration`).toBeLessThanOrEqual(1.0);
      }
      after.push(`${note} ${(mean(rd.map((x) => x.cents)) - 3 >= 0 ? "+" : "")}${(mean(rd.map((x) => x.cents)) - 3).toFixed(2)}`);
    }
    console.log(`calibration, clock 0.4 % fast: an in-tune A2 read ${beforeMean.toFixed(2)} cents; "${done!.text}" at ${done!.ms} ms; then notes 3 cents sharp read, on average, ${after.join(", ")} cents off`);

    // holding the button at power-up forgets it
    const ee2 = join(work, "reset.eeprom");
    const reset = runHarness(synth({ seconds: 1.5, plucks: [pluck("A4", 0.5)], clock, seed: 37 }), ["--ms", "1500", "--eeprom-in", ee, "--eeprom-out", ee2, "--press", "0:400"]);
    expect(reset.lines.map((l) => l.text)).toContain("CALIBRATION RESET");
    expect(reset.lines.find((l) => l.text.startsWith("KERF AMP"))!.text).toBe("KERF AMP tuner: A4=440Hz, clock calibration +0.00%");
    expect([...readFileSync(ee2).subarray(3, 7)]).toEqual([0, 0, 0, 0]);
    expect(Math.abs(mean(readingsFrom(reset, 500).map((x) => x.cents)) - flat)).toBeLessThanOrEqual(1.0);
    expect(reset.lines.filter((l) => l.text.startsWith("REF "))).toEqual([]); // letting go is not a press
  });

  it("refuses to calibrate on a note that is not an A, or on silence", () => {
    const b2 = runHarness(synth({ seconds: 5, plucks: [pluck("B2", 0.3)], seed: 41 }), ["--ms", "5000", "--press", "800:4300"]);
    expect(lineAt(b2, /^CALIBRATION FAILED/)).toBeDefined();
    expect(b2.info.eeprom_writes).toBe("0");
    const quiet = runHarness(null, ["--ms", "5000", "--press", "800:4300"]);
    expect(lineAt(quiet, /^CALIBRATION FAILED/)).toBeDefined();
    expect(quiet.info.eeprom_writes).toBe("0");
    expect(lineAt(quiet, /^CALIBRATED/)).toBeUndefined();
  });

  it("keeps tuning on Serial when the OLED is missing", () => {
    for (const args of [["--no-oled"], ["--oled-addr", "0x3D"]]) {
      const r = runHarness(synth({ seconds: 2, plucks: [pluck("A2", 0.3, { cents: 5 })], seed: 43 }), ["--ms", "2000", ...args]);
      expect(r.lines.map((l) => l.text)).toContain("OLED not found: readings on Serial only");
      const rd = readingsFrom(r, 300);
      expect(rd.length).toBeGreaterThan(5);
      for (const x of rd) expect(Math.abs(x.cents - 5)).toBeLessThanOrEqual(1.0);
    }
  });
});
