// FastLED on the virtual chip: its 8-bit maths as the library's source computes it, CRGB and CHSV with their C++
// operators, palettes, the EVERY_N timers and function-pointer pattern lists, and show(): brightness, colour
// correction and the power limit folded into the bytes, the frame's time on the wire, and the colours reaching
// NeoPixel boards wired to the data pin, swapped when addLeds names the wrong colour order.

import { describe, expect, it } from "vitest";
import { SimHal } from "../src/sim/engine/hal";
import { Halt, loadFirmware, NANO, CError } from "../src/sim/mcu";
import { Plant } from "../src/sim/engine/plant";
import { Bench, type BenchSpec } from "../src/sim/worlds/bench";
import { evaluate } from "../src/lang/evaluator";
import { rngFrom } from "../src/sim/worlds/common";

const BENCH: BenchSpec = { loads: {}, loadFactor: 1, forces: {}, force: 0, range: 300, ambient: 25 };

const DESIGN = `design "Lights"
component ctrl = lib.controller("arduino_nano") { at: (0, 0, 0) }
component psu = lib.psu("usb_c_power_5v") { at: (200, 0, 0) }
component stick = lib.led("neopixel_stick_8") { at: (100, 0, 0) }
component ring = lib.led("neopixel_ring_16") { at: (100, 100, 0) }
net GND: psu.GND, ctrl.GND, stick.GND, ring.GND
net V5: psu.VBUS, ctrl.V5, stick.V5, ring.V5
wire ctrl.D6 -> stick.DIN
wire stick.DOUT -> ring.DIN`;

function run(sketch: string, seconds: number, withPlant = true) {
  let plant: Plant | null = null;
  const hal = new SimHal(NANO, { seed: 3 });
  if (withPlant) {
    const m = evaluate(DESIGN, { skipGeometry: true });
    expect(m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    plant = new Plant(m.machine!, "ctrl", NANO, hal, new Bench(m.machine!, BENCH, "expected"), { rng: rngFrom(11) });
  }
  hal.endCyc = Math.round(seconds * NANO.fcpu);
  const fw = loadFirmware({ "t.ino": sketch }, NANO, hal).fw;
  hal.bindVectors(fw);
  fw.reset();
  try {
    fw.call("setup");
    for (;;) {
      const c0 = hal.cyc;
      fw.call("loop");
      const used = hal.cyc - c0;
      if (used < hal.stepCycles) hal.spend(hal.stepCycles - used);
      else if (hal.cyc >= hal.nextEvt) hal.service();
    }
  } catch (e) {
    if (!(e instanceof Halt)) throw e;
  }
  hal.finishSerial();
  const ch: Record<string, number> = {};
  plant?.channels(ch);
  const hex = (comp: string, n: number) => Array.from({ length: n }, (_, i) => (ch[`${comp}.led${i}`] ?? 0).toString(16).padStart(6, "0"));
  return {
    out: hal.serial.filter((l) => l.dir === "out").map((l) => l.text),
    faults: hal.faults.map((f) => f.msg),
    warns: (plant?.events ?? []).filter((e) => e.kind === "warn").map((e) => e.text),
    stick: hex("stick", 8),
    ring: hex("ring", 16),
    amps: ch["stick.amps"] ?? 0,
    hal,
  };
}

const printOnly = (body: string, globals = "") =>
  run(
    `#include <FastLED.h>
${globals}
void setup() {
  Serial.begin(115200);
${body}
}
void loop() {}`,
    0.5,
    false,
  );

describe("FastLED maths", () => {
  it("scales, adds and waves as lib8tion does", () => {
    const { out, faults } = printOnly(`
  Serial.println(scale8(255, 128));
  Serial.println(scale8_video(1, 1));
  Serial.println(qadd8(200, 100));
  Serial.println(qsub8(20, 100));
  Serial.println(sin8(64));
  Serial.println(sin8(0));
  Serial.println(sin16(16384));
  Serial.println(cubicwave8(64));
  Serial.println(ease8InOutCubic(64));
  Serial.println(sqrt16(10000));
  Serial.println(lerp8by8(0, 200, 128));
  Serial.println(map8(128, 10, 20));`);
    expect(faults).toEqual([]);
    // sin16(16384) is the top of the curve's last section, 32137 + 4 × 127; ease8InOutCubic(64) = 3 × 16 − 2 × 4
    expect(out).toEqual(["128", "1", "255", "0", "255", "128", "32645", "128", "40", "100", "100", "15"]);
  });

  it("draws random8 from the library's seed", () => {
    // rand16seed = 1337; each step seed * 2053 + 13849 (mod 2^16); random8 adds the two bytes
    let seed = 1337;
    const want: number[] = [];
    for (let i = 0; i < 4; i++) {
      seed = (seed * 2053 + 13849) & 0xffff;
      want.push(((seed & 0xff) + (seed >> 8)) & 0xff);
    }
    const { out } = printOnly(`for (int i = 0; i < 4; i++) Serial.println(random8());`);
    expect(out.map(Number)).toEqual(want);
  });

  it("turns HSV into the rainbow's RGB", () => {
    const { out } = printOnly(`
  CRGB a = CHSV(0, 255, 255);
  CRGB b = CHSV(HUE_GREEN, 255, 255);
  CRGB c(CHSV(HUE_BLUE, 255, 128));
  Serial.print(a.r); Serial.print(','); Serial.print(a.g); Serial.print(','); Serial.println(a.b);
  Serial.print(b.r); Serial.print(','); Serial.print(b.g); Serial.print(','); Serial.println(b.b);
  Serial.print(c.r); Serial.print(','); Serial.print(c.g); Serial.print(','); Serial.println(c.b);`);
    // a value below 255 goes through scale8_video(v, v) first: 128 lights the LED at about a quarter
    expect(out).toEqual(["255,0,0", "0,255,0", "0,0,65"]);
  });
});

describe("CRGB and CHSV", () => {
  it("has the library's operators, members and conversions", () => {
    const { out, faults } = printOnly(
      `
  CRGB c = CRGB::Red;
  c += CRGB(0, 10, 300);
  Serial.println(c.g);
  Serial.println(c.blue);
  c.fadeToBlackBy(128);
  Serial.println(c.r);
  c |= 5;
  Serial.println(c.g);
  CRGB d = c;
  d *= 2;
  Serial.println(d[0]);
  Serial.println(d.raw[2]);
  Serial.println(d == c ? "same" : "different");
  Serial.println(-CRGB(250, 0, 5) == CRGB(5, 255, 250) ? "yes" : "no");
  leds[1] = CRGB::Blue;
  leds[1]--;
  Serial.println(leds[1].b);
  if (!leds[0]) Serial.println("dark");
  leds[2].setRGB(1, 2, 3).nscale8(128);
  Serial.println(leds[2].g);
  CHSV h(10, 20, 30);
  h.hue += 5;
  Serial.println(h.h);
  Serial.println(CRGB(100, 100, 100).getLuma());`,
      "CRGB leds[3];",
    );
    expect(faults).toEqual([]);
    // CRGB(0, 10, 300) keeps 300's low byte (44); fadeToBlackBy(128) is scale8 by 127, so 255 becomes 127;
    // |= 5 takes the byte overload (g = max(5, 5)); *= 2 is qmul8, so 127 becomes 254 and b 22 becomes 44
    expect(out).toEqual(["10", "44", "127", "5", "254", "44", "different", "yes", "254", "dark", "1", "15", "99"]);
  });

  it("calls patterns through an array of function pointers, as DemoReel100 does", () => {
    const { out, faults } = printOnly(
      `
  for (uint8_t i = 0; i < ARRAY_SIZE(gPatterns) + 1; i++) {
    gPatterns[i % ARRAY_SIZE(gPatterns)]();
  }
  void (*one)() = &two;
  (*one)();
  Serial.println(ARRAY_SIZE(gPatterns));
  Serial.println(gPatterns[0] == one ? "same" : "other");`,
      `#define ARRAY_SIZE(A) (sizeof(A) / sizeof((A)[0]))
void one() { Serial.println("one"); }
void two() { Serial.println("two"); }
typedef void (*SimplePatternList[])();
SimplePatternList gPatterns = { one, two };`,
    );
    expect(faults).toEqual([]);
    expect(out).toEqual(["one", "two", "one", "two", "2", "other"]);
  });

  it("asks for the header when a sketch uses CRGB without it", () => {
    expect(() => loadFirmware({ "t.ino": "CRGB leds[8];\nvoid setup() {}\nvoid loop() {}" }, NANO, new SimHal(NANO, { seed: 1 }))).toThrow(CError);
  });
});

describe("FastLED.show()", () => {
  it("sends the frame to the stick and the ring after it, in their GRB order", () => {
    const { stick, ring, warns, faults, out } = run(
      `#include <FastLED.h>
#define NUM_LEDS 24
CRGB leds[NUM_LEDS];
void setup() {
  Serial.begin(115200);
  FastLED.addLeds<WS2812B, 6, GRB>(leds, NUM_LEDS);
  leds[0] = CRGB::Red;
  leds[1] = CRGB(0, 255, 0);
  leds[2] = CHSV(HUE_BLUE, 255, 255);
  leds[8] = CRGB::White;
  fill_solid(leds + 9, 3, CRGB(10, 20, 30));
  delay(5);   // show() waits until 2.5 ms after the last frame, and the first counts from power-up
  unsigned long t0 = micros();
  FastLED.show();
  Serial.println(micros() - t0);
}
void loop() {}`,
      0.2,
    );
    expect(faults).toEqual([]);
    expect(warns).toEqual([]);
    expect(stick.slice(0, 3)).toEqual(["ff0000", "00ff00", "0000ff"]);
    expect(ring.slice(0, 4)).toEqual(["ffffff", "0a141e", "0a141e", "0a141e"]);
    // 24 LEDs × 24 bits at 1.25 µs, plus the latch
    const us = Number(out[0]);
    expect(us).toBeGreaterThan(24 * 30);
    expect(us).toBeLessThan(24 * 30 + 150);
  });

  it("swaps red and green when addLeds names RGB for a GRB strip, and says so", () => {
    const { stick, warns } = run(
      `#include <FastLED.h>
CRGB leds[8];
void setup() {
  FastLED.addLeds<WS2812B, 6, RGB>(leds, 8);
  leds[0] = CRGB::Red;
  FastLED.show();
}
void loop() {}`,
      0.1,
    );
    expect(stick[0]).toBe("00ff00");
    expect(warns.some((w) => w.includes("swapped"))).toBe(true);
  });

  it("folds brightness and colour correction into the bytes it sends", () => {
    const { stick } = run(
      `#include <FastLED.h>
CRGB leds[8];
void setup() {
  FastLED.addLeds<NEOPIXEL, 6>(leds, 8).setCorrection(TypicalLEDStrip);
  FastLED.setBrightness(128);
  FastLED.setDither(DISABLE_DITHER);
  leds[0] = CRGB::White;
  FastLED.show();
}
void loop() {}`,
      0.1,
    );
    // TypicalLEDStrip = FFB0F0: computeAdjustment makes each channel's scale (correction + 1) × 256 × 128 / 65536,
    // and the byte sent is scale8(255, that)
    const adj = (c: number) => Math.floor(((c + 1) * 256 * 128) / 65536);
    const want = [0xff, 0xb0, 0xf0].map((c) => (255 * (adj(c) + 1)) >> 8);
    expect(stick[0]).toBe(want.map((x) => x.toString(16).padStart(2, "0")).join(""));
  });

  it("dims the frame to keep under the power limit", () => {
    const { stick, amps } = run(
      `#include <FastLED.h>
CRGB leds[24];
void setup() {
  FastLED.addLeds<WS2812B, 6, GRB>(leds, 24);
  FastLED.setMaxPowerInVoltsAndMilliamps(5, 500);
  fill_solid(leds, 24, CRGB::White);
  FastLED.show();
}
void loop() {}`,
      0.1,
    );
    const v = parseInt(stick[0].slice(0, 2), 16);
    expect(v).toBeGreaterThan(40);
    expect(v).toBeLessThan(140);
    expect(amps).toBeLessThan(0.48);
  });

  it("caps one-wire strips at 400 frames a second", () => {
    const { out } = run(
      `#include <FastLED.h>
CRGB leds[8];
void setup() {
  Serial.begin(115200);
  FastLED.addLeds<WS2812B, 6, GRB>(leds, 8);
  unsigned long t0 = millis();
  for (int i = 0; i < 100; i++) FastLED.show();
  Serial.println(millis() - t0);
}
void loop() {}`,
      1,
    );
    expect(Number(out[0])).toBeGreaterThanOrEqual(245);
    expect(Number(out[0])).toBeLessThan(270);
  });

  it("runs EVERY_N_MILLISECONDS blocks on their own timers", () => {
    const { out } = run(
      `#include <FastLED.h>
int a = 0, b = 0;
void setup() { Serial.begin(115200); }
void loop() {
  EVERY_N_MILLISECONDS(100) { a++; }
  EVERY_N_MILLISECONDS_I(slow, 250) { b++; }
  if (millis() >= 1000) {
    Serial.println(a);
    Serial.println(b);
    while (1) {}
  }
}`,
      1.2,
      false,
    );
    expect(Number(out[0])).toBeGreaterThanOrEqual(9);
    expect(Number(out[0])).toBeLessThanOrEqual(10);
    expect(Number(out[1])).toBeGreaterThanOrEqual(3);
    expect(Number(out[1])).toBeLessThanOrEqual(4);
  });

  it("blends a palette as ColorFromPalette does", () => {
    const { out, faults } = printOnly(`
  CRGBPalette16 pal = RainbowColors_p;
  CRGB c = ColorFromPalette(pal, 0, 255, LINEARBLEND);
  Serial.print(c.r); Serial.print(','); Serial.print(c.g); Serial.print(','); Serial.println(c.b);
  c = ColorFromPalette(RainbowColors_p, 8, 255, LINEARBLEND);
  Serial.print(c.r); Serial.print(','); Serial.print(c.g); Serial.print(','); Serial.println(c.b);
  CRGB h = HeatColor(200);
  Serial.print(h.r); Serial.print(','); Serial.print(h.g); Serial.print(','); Serial.println(h.b);
  CRGBPalette16 two(CRGB::Black, CRGB::White);
  Serial.println(two[15].r);
  Serial.println(two[0].r);`);
    expect(faults).toEqual([]);
    // halfway between RainbowColors_p's first two entries, FF0000 and D52A00, with the library's scale8 maths
    expect(out[0]).toBe("255,0,0");
    expect(out[1]).toBe("234,21,0");
    // HeatColor: scale8_video(200, 191) = 150, in the hottest third, blue ramping at (150 & 63) × 4
    expect(out[2]).toBe("255,255,88");
    expect(out.slice(3)).toEqual(["255", "0"]);
  });

  it("runs a DemoReel100-style pattern list on the ring and keeps it under 500 mA", () => {
    const { faults, ring, out, warns } = run(
      `#include <FastLED.h>
#define DATA_PIN 6
#define NUM_LEDS 24
#define BRIGHTNESS 96
#define FRAMES_PER_SECOND 120
#define ARRAY_SIZE(A) (sizeof(A) / sizeof((A)[0]))
CRGB leds[NUM_LEDS];
uint8_t gHue = 0;
uint8_t gCurrentPatternNumber = 0;
unsigned long frames = 0;

void rainbow() { fill_rainbow(leds, NUM_LEDS, gHue, 7); }
void addGlitter(fract8 chance) { if (random8() < chance) leds[random16(NUM_LEDS)] += CRGB::White; }
void rainbowWithGlitter() { rainbow(); addGlitter(80); }
void confetti() {
  fadeToBlackBy(leds, NUM_LEDS, 10);
  int pos = random16(NUM_LEDS);
  leds[pos] += CHSV(gHue + random8(64), 200, 255);
}
void sinelon() {
  fadeToBlackBy(leds, NUM_LEDS, 20);
  int pos = beatsin16(13, 0, NUM_LEDS - 1);
  leds[pos] += CHSV(gHue, 255, 192);
}
void bpm() {
  uint8_t BeatsPerMinute = 62;
  CRGBPalette16 palette = PartyColors_p;
  uint8_t beat = beatsin8(BeatsPerMinute, 64, 255);
  for (int i = 0; i < NUM_LEDS; i++) leds[i] = ColorFromPalette(palette, gHue + (i * 2), beat - gHue + (i * 10));
}
void juggle() {
  fadeToBlackBy(leds, NUM_LEDS, 20);
  uint8_t dothue = 0;
  for (int i = 0; i < 8; i++) {
    leds[beatsin16(i + 7, 0, NUM_LEDS - 1)] |= CHSV(dothue, 200, 255);
    dothue += 32;
  }
}
typedef void (*SimplePatternList[])();
SimplePatternList gPatterns = { rainbow, rainbowWithGlitter, confetti, sinelon, juggle, bpm };

void nextPattern() { gCurrentPatternNumber = (gCurrentPatternNumber + 1) % ARRAY_SIZE(gPatterns); }

void setup() {
  Serial.begin(115200);
  delay(100);
  FastLED.addLeds<WS2812B, DATA_PIN, GRB>(leds, NUM_LEDS).setCorrection(TypicalLEDStrip);
  FastLED.setMaxPowerInVoltsAndMilliamps(5, 500);
  FastLED.setBrightness(BRIGHTNESS);
}

void loop() {
  gPatterns[gCurrentPatternNumber]();
  FastLED.show();
  FastLED.delay(1000 / FRAMES_PER_SECOND);
  frames++;
  EVERY_N_MILLISECONDS(20) { gHue++; }
  EVERY_N_SECONDS(1) { nextPattern(); }
  EVERY_N_MILLISECONDS(3000) {
    Serial.println(gCurrentPatternNumber);
    Serial.println(frames);
  }
}`,
      3.2,
    );
    expect(faults).toEqual([]);
    expect(warns).toEqual([]);
    // three patterns a second apart: rainbow, rainbowWithGlitter, confetti, then sinelon at 3 s
    expect(out[0]).toBe("3");
    // FastLED.delay(8) shows a frame every millisecond it waits: about 120 loops a second
    expect(Number(out[1])).toBeGreaterThan(300);
    expect(Number(out[1])).toBeLessThan(380);
    expect(ring.some((c) => c !== "000000")).toBe(true);
  });
});
