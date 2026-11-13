// FastLED 3.6 on the virtual chip, ported from the library's source: CRGB and CHSV colours with its 8-bit maths
// (scale8 with FASTLED_SCALE8_FIXED, qadd8, hsv2rgb_rainbow, sin8 and sin16, the beat and beatsin waves, random8
// from its 1337 seed), palettes and ColorFromPalette, fills, fades and blends, EVERY_N_MILLISECONDS, and show():
// brightness, colour correction and temperature folded into one scale a channel, binary dithering once it runs at
// 100 frames a second or more, the power limit, the 400 Hz refresh cap and the time the frame takes on the wire
// (30 µs an LED at 800 kHz, with interrupts off on an AVR). The frame goes to the LED boards wired to the data pin
// in the colour order addLeds named, so a WS2812B strip driven as RGB comes out with red and green swapped, as it
// does on the bench.

import type { Pos } from "./ast";
import { BOOL, VOID, intType, isArith, strip, typeName, type CType } from "./ctypes";
import type { C, Ctx, Ev, Frame } from "./ir";
import type { Ptr } from "./vm";
import { argCount, burn, dict, numEv, sumCost, type LibClass, type LibFn, type LibMethod, type LibStruct } from "./libBase";

/** a CRGB or CHSV value: its three bytes */
type Px = number[];

const U16 = intType(16, false, "uint16_t");
const I16 = intType(16, true, "int16_t");

// ---------- the chipsets addLeds takes ----------

/** EOrder: which of r, g, b goes out first, second and third, in octal digits (GRB = 0102) */
const ORDERS: Record<string, number> = { RGB: 0o012, RBG: 0o021, GRB: 0o102, GBR: 0o120, BRG: 0o201, BGR: 0o210 };
const ORDER_NAME = new Map(Object.entries(ORDERS).map(([k, v]) => [v, k]));

interface Chip {
  name: string;
  code: number;
  /** clocked over a data and a clock pin (APA102), or one data wire */
  spi: boolean;
  /** one bit on the wire, µs (one-wire chips), or the default clock, Hz (clocked chips) */
  bitUs: number;
  hz: number;
  /** bits a LED takes */
  bits: number;
  /** NEOPIXEL is GRB whatever addLeds says */
  order?: number;
}

// FastLED's ESPIChipsets enum, then its one-wire chips (template classes there, constants here). Bit times are the
// T1 + T2 + T3 of each controller in chipsets.h, in 125 ns steps.
const SPI_CHIPS: [string, number, number][] = [
  ["LPD6803", 16, 12e6],
  ["LPD8806", 24, 12e6],
  ["WS2801", 24, 1e6],
  ["WS2803", 24, 25e6],
  ["SM16716", 27, 16e6],
  ["P9813", 32, 10e6],
  ["APA102", 32, 12e6],
  ["SK9822", 32, 24e6],
  ["DOTSTAR", 32, 12e6],
];
const ONE_WIRE: [string, number][] = [
  ["NEOPIXEL", 10],
  ["WS2812", 10],
  ["WS2812B", 10],
  ["WS2852", 10],
  ["GS1903", 10],
  ["WS2811", 10],
  ["WS2813", 10],
  ["APA104", 10],
  ["WS2811_400", 20],
  ["SK6812", 10],
  ["SK6822", 14],
  ["APA106", 14],
  ["PL9823", 14],
  ["SM16703", 10],
  ["TM1803", 21],
  ["TM1804", 10],
  ["TM1809", 10],
  ["TM1812", 10],
  ["TM1829", 10],
  ["UCS1903", 20],
  ["UCS1903B", 10],
  ["UCS1904", 10],
  ["UCS2903", 10],
  ["GE8822", 11],
  ["GW6205", 10],
  ["GW6205_400", 19],
  ["LPD1886", 7],
  ["LPD1886_8BIT", 7],
];
const CHIPS = new Map<number, Chip>();
SPI_CHIPS.forEach(([name, bits, hz], i) => CHIPS.set(i, { name, code: i, spi: true, bitUs: 0, hz, bits }));
ONE_WIRE.forEach(([name, units], i) => CHIPS.set(100 + i, { name, code: 100 + i, spi: false, bitUs: units * 0.125, hz: 0, bits: 24, ...(name === "NEOPIXEL" ? { order: ORDERS.GRB } : {}) }));

/** the NEO_* type the board's LED model reads: each of r, g and b's place on the wire */
export function neoType(order: number): number {
  const seq = [(order >> 6) & 3, (order >> 3) & 3, order & 3];
  const r = seq.indexOf(0);
  const g = seq.indexOf(1);
  const b = seq.indexOf(2);
  return (r << 6) | (r << 4) | (g << 2) | b;
}

// ---------- the header ----------

const HTML_COLOURS =
  "AliceBlue F0F8FF Amethyst 9966CC AntiqueWhite FAEBD7 Aqua 00FFFF Aquamarine 7FFFD4 Azure F0FFFF Beige F5F5DC Bisque FFE4C4 Black 000000 BlanchedAlmond FFEBCD Blue 0000FF BlueViolet 8A2BE2 Brown A52A2A BurlyWood DEB887 CadetBlue 5F9EA0 Chartreuse 7FFF00 Chocolate D2691E Coral FF7F50 CornflowerBlue 6495ED Cornsilk FFF8DC Crimson DC143C Cyan 00FFFF DarkBlue 00008B DarkCyan 008B8B DarkGoldenrod B8860B DarkGray A9A9A9 DarkGrey A9A9A9 DarkGreen 006400 DarkKhaki BDB76B DarkMagenta 8B008B DarkOliveGreen 556B2F DarkOrange FF8C00 DarkOrchid 9932CC DarkRed 8B0000 DarkSalmon E9967A DarkSeaGreen 8FBC8F DarkSlateBlue 483D8B DarkSlateGray 2F4F4F DarkSlateGrey 2F4F4F DarkTurquoise 00CED1 DarkViolet 9400D3 DeepPink FF1493 DeepSkyBlue 00BFFF DimGray 696969 DimGrey 696969 DodgerBlue 1E90FF FireBrick B22222 FloralWhite FFFAF0 ForestGreen 228B22 Fuchsia FF00FF Gainsboro DCDCDC GhostWhite F8F8FF Gold FFD700 Goldenrod DAA520 Gray 808080 Grey 808080 Green 008000 GreenYellow ADFF2F Honeydew F0FFF0 HotPink FF69B4 IndianRed CD5C5C Indigo 4B0082 Ivory FFFFF0 Khaki F0E68C Lavender E6E6FA LavenderBlush FFF0F5 LawnGreen 7CFC00 LemonChiffon FFFACD LightBlue ADD8E6 LightCoral F08080 LightCyan E0FFFF LightGoldenrodYellow FAFAD2 LightGreen 90EE90 LightGrey D3D3D3 LightPink FFB6C1 LightSalmon FFA07A LightSeaGreen 20B2AA LightSkyBlue 87CEFA LightSlateGray 778899 LightSlateGrey 778899 LightSteelBlue B0C4DE LightYellow FFFFE0 Lime 00FF00 LimeGreen 32CD32 Linen FAF0E6 Magenta FF00FF Maroon 800000 MediumAquamarine 66CDAA MediumBlue 0000CD MediumOrchid BA55D3 MediumPurple 9370DB MediumSeaGreen 3CB371 MediumSlateBlue 7B68EE MediumSpringGreen 00FA9A MediumTurquoise 48D1CC MediumVioletRed C71585 MidnightBlue 191970 MintCream F5FFFA MistyRose FFE4E1 Moccasin FFE4B5 NavajoWhite FFDEAD Navy 000080 OldLace FDF5E6 Olive 808000 OliveDrab 6B8E23 Orange FFA500 OrangeRed FF4500 Orchid DA70D6 PaleGoldenrod EEE8AA PaleGreen 98FB98 PaleTurquoise AFEEEE PaleVioletRed DB7093 PapayaWhip FFEFD5 PeachPuff FFDAB9 Peru CD853F Pink FFC0CB Plaid CC5533 Plum DDA0DD PowderBlue B0E0E6 Purple 800080 Red FF0000 RosyBrown BC8F8F RoyalBlue 4169E1 SaddleBrown 8B4513 Salmon FA8072 SandyBrown F4A460 SeaGreen 2E8B57 Seashell FFF5EE Sienna A0522D Silver C0C0C0 SkyBlue 87CEEB SlateBlue 6A5ACD SlateGray 708090 SlateGrey 708090 Snow FFFAFA SpringGreen 00FF7F SteelBlue 4682B4 Tan D2B48C Teal 008080 Thistle D8BFD8 Tomato FF6347 Turquoise 40E0D0 Violet EE82EE Wheat F5DEB3 White FFFFFF WhiteSmoke F5F5F5 Yellow FFFF00 YellowGreen 9ACD32 FairyLight FFE42D FairyLightNCC FF9D2A";
const COLOURS = new Map<string, number>();
{
  const w = HTML_COLOURS.split(" ");
  for (let i = 0; i < w.length; i += 2) COLOURS.set(w[i], parseInt(w[i + 1], 16));
}
const col = (name: string) => COLOURS.get(name)!;

/** FastLED's built-in palettes (colorpalettes.cpp), 16 colours each */
const PALETTES: Record<string, number[]> = {
  CloudColors_p: ["Blue", "DarkBlue", "DarkBlue", "DarkBlue", "DarkBlue", "DarkBlue", "DarkBlue", "DarkBlue", "Blue", "DarkBlue", "SkyBlue", "SkyBlue", "LightBlue", "White", "LightBlue", "SkyBlue"].map(col),
  LavaColors_p: ["Black", "Maroon", "Black", "Maroon", "DarkRed", "DarkRed", "Maroon", "DarkRed", "DarkRed", "DarkRed", "Red", "Orange", "White", "Orange", "Red", "DarkRed"].map(col),
  OceanColors_p: ["MidnightBlue", "DarkBlue", "MidnightBlue", "Navy", "DarkBlue", "MediumBlue", "SeaGreen", "Teal", "CadetBlue", "Blue", "DarkCyan", "CornflowerBlue", "Aquamarine", "SeaGreen", "Aqua", "LightSkyBlue"].map(col),
  ForestColors_p: ["DarkGreen", "DarkGreen", "DarkOliveGreen", "DarkGreen", "Green", "ForestGreen", "OliveDrab", "Green", "SeaGreen", "MediumAquamarine", "LimeGreen", "YellowGreen", "LightGreen", "LawnGreen", "MediumAquamarine", "ForestGreen"].map(col),
  RainbowColors_p: [0xff0000, 0xd52a00, 0xab5500, 0xab7f00, 0xabab00, 0x56d500, 0x00ff00, 0x00d52a, 0x00ab55, 0x0056aa, 0x0000ff, 0x2a00d5, 0x5500ab, 0x7f0081, 0xab0055, 0xd5002b],
  RainbowStripeColors_p: [0xff0000, 0, 0xab5500, 0, 0xabab00, 0, 0x00ff00, 0, 0x00ab55, 0, 0x0000ff, 0, 0x5500ab, 0, 0xab0055, 0],
  PartyColors_p: [0x5500ab, 0x84007c, 0xb5004b, 0xe5001b, 0xe81700, 0xb84700, 0xab7700, 0xabab00, 0xab5500, 0xdd2200, 0xf2000e, 0xc2003e, 0x8f0071, 0x5f00a1, 0x2f00d0, 0x0007f9],
  HeatColors_p: [0x000000, 0x330000, 0x660000, 0x990000, 0xcc0000, 0xff0000, 0xff3300, 0xff6600, 0xff9900, 0xffcc00, 0xffff00, 0xffff33, 0xffff66, 0xffff99, 0xffffcc, 0xffffff],
};

const CORRECTIONS: [string, number][] = [
  ["TypicalSMD5050", 0xffb0f0],
  ["TypicalLEDStrip", 0xffb0f0],
  ["Typical8mmPixel", 0xffe08c],
  ["TypicalPixelString", 0xffe08c],
  ["UncorrectedColor", 0xffffff],
];
const TEMPERATURES: [string, number][] = [
  ["Candle", 0xff9329],
  ["Tungsten40W", 0xffc58f],
  ["Tungsten100W", 0xffd6aa],
  ["Halogen", 0xfff1e0],
  ["CarbonArc", 0xfffaf4],
  ["HighNoonSun", 0xfffffb],
  ["DirectSunlight", 0xffffff],
  ["OvercastSky", 0xc9e2ff],
  ["ClearBlueSky", 0x409cff],
  ["WarmFluorescent", 0xfff4e5],
  ["StandardFluorescent", 0xf4fffa],
  ["CoolWhiteFluorescent", 0xd4ebff],
  ["FullSpectrumFluorescent", 0xfff4f2],
  ["GrowLightFluorescent", 0xffeff7],
  ["BlackLightFluorescent", 0xa700ff],
  ["MercuryVapor", 0xd8f7ff],
  ["SodiumVapor", 0xffd1b2],
  ["MetalHalide", 0xf2fcff],
  ["HighPressureSodium", 0xffb74c],
  ["UncorrectedTemperature", 0xffffff],
];

const enumOf = (name: string, items: [string, number][]) => `enum ${name} { ${items.map(([k, v]) => `${k} = ${v}`).join(", ")} };`;

/** FastLED.h as the sketch sees it: the colour types, the chipset and colour-order names, and the timer macros */
export function fastLedHeader(): string {
  return `#pragma once
#define FASTLED_VERSION 3006000
#define FASTLED_INTERNAL
#define FASTLED_USING_NAMESPACE
#define FASTLED_NAMESPACE_BEGIN
#define FASTLED_NAMESPACE_END
#define FASTLED_HAS_CLOCKLESS 1
#define FL_PROGMEM
#define FL_PGM_READ_BYTE_NEAR(x) (*((const uint8_t*)(x)))
#define FL_PGM_READ_WORD_NEAR(x) (*((const uint16_t*)(x)))
#define FL_PGM_READ_DWORD_NEAR(x) (*((const uint32_t*)(x)))
typedef uint8_t fract8;
typedef int8_t sfract7;
typedef uint16_t fract16;
typedef int16_t sfract15;
typedef uint16_t accum88;
typedef int16_t saccum78;
typedef uint32_t accum1616;
typedef int32_t saccum1516;
typedef uint16_t accum124;
typedef int32_t saccum114;
typedef int16_t saccum87;
typedef uint8_t EDitherMode;
struct CRGB { uint8_t r; uint8_t g; uint8_t b; };
struct CHSV { uint8_t h; uint8_t s; uint8_t v; };
struct CRGBPalette16 { CRGB entries[16]; };
typedef uint32_t TProgmemRGBPalette16[16];
typedef TProgmemRGBPalette16 TProgmemPalette16;
typedef uint8_t TProgmemRGBGradientPalette_byte;
typedef const uint8_t* TProgmemRGBGradientPalette_bytes;
typedef const uint8_t* TProgmemRGBGradientPalettePtr;
typedef const uint8_t* TDynamicRGBGradientPalette_bytes;
#define DEFINE_GRADIENT_PALETTE(X) const TProgmemRGBGradientPalette_byte X[] =
#define DECLARE_GRADIENT_PALETTE(X) extern const TProgmemRGBGradientPalette_byte X[]
${enumOf("EOrder", Object.entries(ORDERS))}
${enumOf("ESPIChipsets", SPI_CHIPS.map(([n], i) => [n, i]))}
${enumOf("EClocklessChipsets", ONE_WIRE.map(([n], i) => [n, 100 + i]))}
${enumOf("LEDColorCorrection", CORRECTIONS)}
${enumOf("ColorTemperature", TEMPERATURES)}
enum HSVHue { HUE_RED = 0, HUE_ORANGE = 32, HUE_YELLOW = 64, HUE_GREEN = 96, HUE_AQUA = 128, HUE_BLUE = 160, HUE_PURPLE = 192, HUE_PINK = 224 };
typedef enum { NOBLEND = 0, LINEARBLEND = 1, LINEARBLEND_NOWRAP = 2 } TBlendType;
typedef enum { FORWARD_HUES = 0, BACKWARD_HUES = 1, SHORTEST_HUES = 2, LONGEST_HUES = 3 } TGradientDirectionCode;
#define DISABLE_DITHER 0x00
#define BINARY_DITHER 0x01
#define DATA_RATE_MHZ(X) (1000000 * (X))
#define DATA_RATE_KHZ(X) (1000 * (X))
${"#ifdef MOSI\n#define SPI_DATA MOSI\n#define SPI_CLOCK SCK\n#endif"}
#define memset8 memset
#define memcpy8 memcpy
#define memmove8 memmove
#define CONCAT_HELPER(x, y) x##y
#define CONCAT_MACRO(x, y) CONCAT_HELPER(x, y)
#define EVERY_N_MILLIS(N) if (__fastled_every(0, (N)))
#define EVERY_N_MILLISECONDS(N) EVERY_N_MILLIS(N)
#define EVERY_N_SECONDS(N) if (__fastled_every(1, (N)))
#define EVERY_N_BSECONDS(N) if (__fastled_every(2, (N)))
#define EVERY_N_MINUTES(N) if (__fastled_every(3, (N)))
#define EVERY_N_HOURS(N) if (__fastled_every(4, (N)))
#define EVERY_N_MILLIS_I(NAME, N) static CEveryNMillis NAME(N); if (NAME)
#define EVERY_N_MILLISECONDS_I(NAME, N) EVERY_N_MILLIS_I(NAME, N)
#define EVERY_N_SECONDS_I(NAME, N) static CEveryNSeconds NAME(N); if (NAME)
#define EVERY_N_BSECONDS_I(NAME, N) static CEveryNBSeconds NAME(N); if (NAME)
#define EVERY_N_MINUTES_I(NAME, N) static CEveryNMinutes NAME(N); if (NAME)
#define EVERY_N_HOURS_I(NAME, N) static CEveryNHours NAME(N); if (NAME)
`;
}

// ---------- state ----------

interface Ctl {
  kind: "CLEDController";
  chip: Chip;
  pin: number;
  clock: number;
  order: number;
  /** the hardware SPI pins (fast) or any two pins (bit-banged) */
  hwSpi: boolean;
  hz: number;
  data: Ptr | null;
  n: number;
  correction: Px;
  temperature: Px;
  dither: number;
}

interface Timer {
  prev: number;
  period: number;
}

/** FastLED's globals on one chip: the CFastLED object, the controllers addLeds made and the random seed */
export interface FastLedState {
  seed: number;
  scale: number;
  ctls: Ctl[];
  byKey: Map<string, Ctl>;
  minMicros: number;
  lastShow: number;
  /** setMaxPowerInMilliWatts, 0 when there is no limit */
  powerMw: number;
  powerPin: number;
  fps: number;
  fpsFrames: number;
  fpsLast: number;
  /** PixelController's dither counter (a static it bumps every frame it dithers) */
  ditherR: number;
  /** EVERY_N_* blocks, by the place they are written */
  every: Map<object, Timer>;
  /** frames sent, for the run's notes */
  shows: number;
  limited: number;
}

export function newFastLedState(): FastLedState {
  return { seed: 1337, scale: 255, ctls: [], byKey: new Map(), minMicros: 0, lastShow: 0, powerMw: 0, powerPin: 0, fps: 0, fpsFrames: 0, fpsLast: 0, ditherR: 0, every: new Map(), shows: 0, limited: 0 };
}

// ---------- lib8tion: the 8- and 16-bit maths, as FASTLED_SCALE8_FIXED does it ----------

export const scale8 = (i: number, s: number) => ((i & 255) * (1 + (s & 255))) >> 8;
export const scale8Video = (i: number, s: number) => {
  i &= 255;
  s &= 255;
  return ((i * s) >> 8) + (i && s ? 1 : 0);
};
export const qadd8 = (a: number, b: number) => Math.min(255, (a & 255) + (b & 255));
export const qsub8 = (a: number, b: number) => Math.max(0, (a & 255) - (b & 255));
const qmul8 = (a: number, b: number) => Math.min(255, (a & 255) * (b & 255));
const scale16 = (i: number, s: number) => Math.floor(((i & 0xffff) * (1 + (s & 0xffff))) / 65536);
const scale16by8 = (i: number, s: number) => (((i & 0xffff) * (1 + (s & 255))) >> 8) & 0xffff;
export const blend8 = (a: number, b: number, amt: number) => {
  a &= 255;
  b &= 255;
  return ((((a << 8) | b) + (b - a) * (amt & 255)) >> 8) & 255;
};
const lerp8by8 = (a: number, b: number, frac: number) => {
  a &= 255;
  b &= 255;
  return (b > a ? a + scale8(b - a, frac) : a - scale8(a - b, frac)) & 255;
};
const lerp16by16 = (a: number, b: number, frac: number) => {
  a &= 0xffff;
  b &= 0xffff;
  return (b > a ? a + scale16(b - a, frac) : a - scale16(a - b, frac)) & 0xffff;
};
const s16 = (x: number) => (x << 16) >> 16;
const s8 = (x: number) => (x << 24) >> 24;

const B_M16 = [0, 49, 49, 41, 90, 27, 117, 10];
export function sin8(theta: number): number {
  theta &= 255;
  let offset = theta;
  if (theta & 0x40) offset = 255 - offset;
  offset &= 0x3f;
  let sec = offset & 0x0f;
  if (theta & 0x40) sec++;
  const section = offset >> 4;
  const b = B_M16[section * 2];
  const m16 = B_M16[section * 2 + 1];
  let y = s8((((m16 * sec) >> 4) & 255) + b);
  if (theta & 0x80) y = -y;
  return (y + 128) & 255;
}

const S16_BASE = [0, 6393, 12539, 18204, 23170, 27245, 30273, 32137];
const S16_SLOPE = [49, 48, 44, 38, 31, 23, 14, 4];
export function sin16(theta: number): number {
  theta &= 0xffff;
  let offset = (theta & 0x3fff) >> 3;
  if (theta & 0x4000) offset = 2047 - offset;
  const section = offset >> 8;
  let y = s16(S16_SLOPE[section] * ((offset & 255) >> 1) + S16_BASE[section]);
  if (theta & 0x8000) y = -y;
  return y;
}

/** hsv2rgb_rainbow: FastLED's rainbow, with a wider yellow than the spectrum, as CRGB = CHSV does it */
export function hsv2rgb(hsv: Px): Px {
  const hue = hsv[0] & 255;
  const sat = hsv[1] & 255;
  let val = hsv[2] & 255;
  const offset8 = ((hue & 0x1f) << 3) & 255;
  const third = scale8(offset8, 85);
  let r: number;
  let g: number;
  let b: number;
  if (!(hue & 0x80)) {
    if (!(hue & 0x40)) {
      if (!(hue & 0x20)) [r, g, b] = [255 - third, third, 0];
      else [r, g, b] = [171, 85 + third, 0];
    } else if (!(hue & 0x20)) [r, g, b] = [171 - scale8(offset8, 170), 170 + third, 0];
    else [r, g, b] = [0, 255 - third, third];
  } else if (!(hue & 0x40)) {
    if (!(hue & 0x20)) {
      const twothirds = scale8(offset8, 170);
      [r, g, b] = [0, 171 - twothirds, 85 + twothirds];
    } else [r, g, b] = [third, 0, 255 - third];
  } else if (!(hue & 0x20)) [r, g, b] = [85 + third, 0, 171 - third];
  else [r, g, b] = [170 + third, 0, 85 - third];
  if (sat !== 255) {
    if (sat === 0) r = g = b = 255;
    else {
      const desat = scale8Video(255 - sat, 255 - sat);
      const satscale = 255 - desat;
      r = (scale8(r, satscale) + desat) & 255;
      g = (scale8(g, satscale) + desat) & 255;
      b = (scale8(b, satscale) + desat) & 255;
    }
  }
  if (val !== 255) {
    val = scale8Video(val, val);
    if (val === 0) r = g = b = 0;
    else {
      r = scale8(r, val);
      g = scale8(g, val);
      b = scale8(b, val);
    }
  }
  return [r, g, b];
}

const code = (c: number): Px => [(c >>> 16) & 255, (c >>> 8) & 255, c & 255];
const nscale8x3 = (p: Px, s: number) => {
  p[0] = scale8(p[0], s);
  p[1] = scale8(p[1], s);
  p[2] = scale8(p[2], s);
};
const nscale8x3Video = (p: Px, s: number) => {
  const nz = s & 255 ? 1 : 0;
  for (let k = 0; k < 3; k++) p[k] = p[k] === 0 ? 0 : (((p[k] * (s & 255)) >> 8) + nz) & 255;
};
const setPx = (to: Px, from: Px) => {
  to[0] = from[0] & 255;
  to[1] = from[1] & 255;
  to[2] = from[2] & 255;
};

function rnd16(ctx: Ctx): number {
  const st = ctx.lib.fastled;
  st.seed = (Math.imul(st.seed, 2053) + 13849) & 0xffff;
  return st.seed;
}
function random8(ctx: Ctx): number {
  const s = rnd16(ctx);
  return ((s & 255) + (s >> 8)) & 255;
}

const ms32 = (ctx: Ctx) => ctx.hal.millis() >>> 0;
const beat88 = (ctx: Ctx, bpm88: number, timebase: number) => ((Math.imul(Math.imul((ms32(ctx) - timebase) >>> 0, bpm88 & 0xffff), 280) >>> 0) >>> 16) & 0xffff;
const beat16 = (ctx: Ctx, bpm: number, timebase: number) => beat88(ctx, (bpm & 0xffff) < 256 ? (bpm & 0xffff) << 8 : bpm, timebase);

/** EVERY_N_*: the clock each one reads (millis, seconds16, bseconds16, minutes16, hours8) and its width */
function clockOf(unit: number, ms: number): number {
  switch (unit) {
    case 0:
      return ms >>> 0;
    case 1:
      return Math.floor(ms / 1000) & 0xffff;
    case 2:
      return (ms >>> 10) & 0xffff;
    case 3:
      return Math.floor(ms / 60000) & 0xffff;
    default:
      return Math.floor(ms / 3600000) & 255;
  }
}
const CLOCK_MASK = [0xffffffff, 0xffff, 0xffff, 0xffff, 0xff];
const elapsed = (unit: number, now: number, prev: number) => (unit === 0 ? (now - prev) >>> 0 : (now - prev) & CLOCK_MASK[unit]);

// ---------- arguments ----------

/** cycles on the chip: an AVR does this 8-bit maths in a few instructions each; the ESP32 in about half */
const cy = (ctx: Ctx, avr: number) => ((ctx.hal.arch ?? "avr") !== "avr" ? Math.ceil(avr / 2) : avr);

function fastLedType(ctx: Ctx, name: string, pos: Pos): CType {
  const t = ctx.structType?.(name);
  if (!t) return ctx.error(`${name} comes from FastLED: add #include <FastLED.h> at the top of the sketch`, pos);
  return t;
}
const included = (ctx: Ctx, what: string, pos: Pos) => {
  if (!ctx.structType?.("CRGB")) ctx.error(`${what} comes from FastLED: add #include <FastLED.h> at the top of the sketch`, pos);
};
const isStruct = (t: CType, name: string) => {
  const s = strip(t);
  return s.k === "struct" && s.name === name;
};

/** a colour argument: a CRGB, a CHSV (made RGB with hsv2rgb_rainbow, as CRGB's constructor does) or a colour code */
function rgbArg(c: C, ctx: Ctx, what: string): { ev: Ev; cost: number } {
  const t = strip(c.t);
  if (t.k === "struct" && t.name === "CRGB") return { ev: c.ev, cost: 0 };
  if (t.k === "struct" && t.name === "CHSV") {
    const e = c.ev;
    return { ev: (f) => hsv2rgb(e(f)), cost: cy(ctx, 90) };
  }
  if (isArith(t)) {
    const e = numEv(c, ctx.T.ulong, ctx, what);
    if (c.cv !== undefined) {
      const v = code(c.cv >>> 0);
      return { ev: () => v.slice(), cost: 2 };
    }
    return { ev: (f) => code(e(f)), cost: 6 };
  }
  return ctx.error(`${what} needs a colour here (a CRGB, a CHSV or a code like CRGB::Red), not ${typeName(t)}`, c.pos);
}

/** a CRGB* (an array of them, a pointer into one, or a palette's 16 entries) or a CHSV*: where it points */
function ledsArg(c: C, ctx: Ctx, what: string, elem: "CRGB" | "CHSV"): Ev {
  const t = strip(c.t);
  if (t.k === "arr" && isStruct(t.of, elem)) {
    const e = c.ev;
    return (f) => ({ m: e(f), i: 0 });
  }
  if (t.k === "ptr" && isStruct(t.to, elem)) return c.ev;
  if (elem === "CRGB" && t.k === "struct" && t.name === "CRGBPalette16") {
    const e = c.ev;
    return (f) => ({ m: (e(f) as unknown[])[0], i: 0 });
  }
  return ctx.error(`${what} needs an array of ${elem} here (like leds), not ${typeName(t)}`, c.pos);
}

/** a palette: a CRGBPalette16, or one in flash (TProgmemRGBPalette16, like RainbowColors_p) */
function palArg(c: C, ctx: Ctx, what: string): Ev {
  const t = strip(c.t);
  if (t.k === "struct" && t.name === "CRGBPalette16") {
    const e = c.ev;
    return (f) => (e(f) as unknown[])[0];
  }
  const el = t.k === "arr" ? strip(t.of) : t.k === "ptr" ? strip(t.to) : null;
  if (el && el.k === "int" && el.bits === 32) {
    const e = c.ev;
    return t.k === "arr" ? (f) => ({ m: e(f), i: 0 }) : e;
  }
  return ctx.error(`${what} needs a palette here (a CRGBPalette16 or one like RainbowColors_p), not ${typeName(t)}`, c.pos);
}
/** entry k of a palette from palArg */
function entry(p: unknown, k: number): Px {
  if (Array.isArray(p)) return p[k] as Px;
  const q = p as Ptr;
  return code(Number(q.m[q.i + k] ?? 0) >>> 0);
}

function refArg(c: C, ctx: Ctx, what: string, name: string): Ev {
  if (!isStruct(c.t, name)) return ctx.error(`${what} needs a ${name} variable here, not ${typeName(strip(c.t))}`, c.pos);
  return c.ev;
}

type FK = "u8" | "u16" | "i16" | "int" | "u32" | "bool" | "rgb" | "hsv" | "leds" | "hsvs" | "pal" | "rgbref" | "palref";
type RT = "void" | "u8" | "u16" | "i16" | "u32" | "bool" | "CRGB" | "CHSV" | "CRGBPalette16";

function argEv(k: FK, c: C, ctx: Ctx, what: string): { ev: Ev; cost: number } {
  switch (k) {
    case "u8":
      return { ev: numEv(c, ctx.T.uchar, ctx, what), cost: 0 };
    case "u16":
      return { ev: numEv(c, U16, ctx, what), cost: 0 };
    case "i16":
      return { ev: numEv(c, I16, ctx, what), cost: 0 };
    case "int":
      return { ev: numEv(c, ctx.T.int, ctx, what), cost: 0 };
    case "u32":
      return { ev: numEv(c, ctx.T.ulong, ctx, what), cost: 0 };
    case "bool":
      return { ev: numEv(c, BOOL, ctx, what), cost: 0 };
    case "rgb":
      return rgbArg(c, ctx, what);
    case "hsv":
      return { ev: refArg(c, ctx, what, "CHSV"), cost: 0 };
    case "leds":
      return { ev: ledsArg(c, ctx, what, "CRGB"), cost: 0 };
    case "hsvs":
      return { ev: ledsArg(c, ctx, what, "CHSV"), cost: 0 };
    case "pal":
      return { ev: palArg(c, ctx, what), cost: 0 };
    case "rgbref":
      return { ev: refArg(c, ctx, what, "CRGB"), cost: 0 };
    case "palref":
      return { ev: refArg(c, ctx, what, "CRGBPalette16"), cost: 0 };
  }
}

function retType(r: RT, ctx: Ctx, pos: Pos): CType {
  switch (r) {
    case "void":
      return VOID;
    case "u8":
      return ctx.T.uchar;
    case "u16":
      return U16;
    case "i16":
      return I16;
    case "u32":
      return ctx.T.ulong;
    case "bool":
      return BOOL;
    default:
      return fastLedType(ctx, r, pos);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Run = (v: any[], ctx: Ctx, pos: Pos) => unknown;

/** A FastLED function: parameters converted as C++ would, a cost on the chip, and what it does. */
function fl(name: string, params: FK[], ret: RT, cyc: number, run: Run, defaults: unknown[] = []): LibFn {
  return (args, ctx, pos) => {
    included(ctx, `${name}()`, pos);
    const min = params.length - defaults.length;
    if (args.length < min || args.length > params.length) argCount(name, min, params.length, args.length, ctx, pos);
    const what = `${name}()`;
    const conv = args.map((a, i) => argEv(params[i], a, ctx, what));
    const evs = conv.map((x) => x.ev);
    for (let i = args.length; i < params.length; i++) {
      const d = defaults[i - min];
      evs.push(() => d);
    }
    const t = retType(ret, ctx, pos);
    const n = evs.length;
    const cost = sumCost(args) + conv.reduce((s, x) => s + x.cost, 0) + cy(ctx, cyc);
    return {
      t,
      ev: (f: Frame) => {
        const v = new Array(n);
        for (let i = 0; i < n; i++) v[i] = evs[i](f);
        return run(v, ctx, pos);
      },
      cost,
      pos,
    };
  };
}

/** A method of a FastLED colour type: `run` gets the value it is called on (changed in place) and the arguments. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sm(sname: string, name: string, params: FK[], ret: RT | "self", cyc: number, run: (o: Px, v: any[], ctx: Ctx, pos: Pos) => unknown, defaults: unknown[] = []): LibMethod {
  return (obj, args, ctx, pos) => {
    const min = params.length - defaults.length;
    if (args.length < min || args.length > params.length) argCount(`${sname}.${name}`, min, params.length, args.length, ctx, pos);
    const what = `${sname}.${name}()`;
    const O = obj.lv ? obj.lv.get : obj.ev;
    const conv = args.map((a, i) => argEv(params[i], a, ctx, what));
    const evs = conv.map((x) => x.ev);
    for (let i = args.length; i < params.length; i++) {
      const d = defaults[i - min];
      evs.push(() => d);
    }
    const t = ret === "self" ? fastLedType(ctx, sname, pos) : retType(ret, ctx, pos);
    const n = evs.length;
    return {
      t,
      ev: (f: Frame) => {
        const o = O(f) as Px;
        const v = new Array(n);
        for (let i = 0; i < n; i++) v[i] = evs[i](f);
        const r = run(o, v, ctx, pos);
        return ret === "self" ? o : r;
      },
      cost: obj.cost + sumCost(args) + conv.reduce((s, x) => s + x.cost, 0) + cy(ctx, cyc),
      pos,
    };
  };
}

/** the n LEDs from p, each in place; faults once when the count runs past the end of the array, as the chip would scribble on whatever follows */
function eachLed(ctx: Ctx, pos: Pos, what: string, p: Ptr | null, n: number, fn: (px: Px, i: number) => void) {
  if (!p) return ctx.fault(`${what} was given a NULL pointer`, pos);
  for (let i = 0; i < n; i++) {
    const px = p.m[p.i + i] as Px | undefined;
    if (!px) return ctx.fault(`${what} runs past the end of the array (${p.m.length - p.i} LEDs, told ${n}): on the chip it overwrites the memory after it`, pos);
    fn(px, i);
  }
}

// ---------- fills, gradients and palettes ----------

function fillGradientRGB(ctx: Ctx, pos: Pos, p: Ptr | null, start: number, c0: Px, end: number, c1: Px) {
  start &= 0xffff;
  end &= 0xffff;
  if (end < start) [start, c0, end, c1] = [end, c1, start, c0];
  const dist = end - start;
  const div = s16(dist ? dist : 1);
  const d87 = [0, 1, 2].map((k) => s16(Math.trunc(s16((c1[k] - c0[k]) << 7) / div) * 2));
  const v88 = [c0[0] << 8, c0[1] << 8, c0[2] << 8];
  if (!p) return ctx.fault("fill_gradient_RGB() was given a NULL pointer", pos);
  for (let i = start; i <= end; i++) {
    const px = p.m[p.i + i] as Px | undefined;
    if (!px) return ctx.fault(`fill_gradient_RGB() writes LED ${i}, past the end of the array (${p.m.length - p.i} LEDs): on the chip it overwrites the memory after it`, pos);
    px[0] = v88[0] >> 8;
    px[1] = v88[1] >> 8;
    px[2] = v88[2] >> 8;
    for (let k = 0; k < 3; k++) v88[k] = (v88[k] + d87[k]) & 0xffff;
  }
}

/** fill_gradient with CHSV stops: hue goes the way the direction code says (the shortest way by default) */
function fillGradientHSV(ctx: Ctx, pos: Pos, p: Ptr | null, rgb: boolean, start: number, a: Px, end: number, b: Px, dir: number) {
  start &= 0xffff;
  end &= 0xffff;
  let c0 = a.slice();
  let c1 = b.slice();
  if (end < start) [start, c0, end, c1] = [end, c1, start, c0];
  if (c1[2] === 0 || c1[1] === 0) c1[0] = c0[0];
  if (c0[2] === 0 || c0[1] === 0) c0[0] = c1[0];
  const sat87 = s16((c1[1] - c0[1]) << 7);
  const val87 = s16((c1[2] - c0[2]) << 7);
  const huedelta8 = (c1[0] - c0[0]) & 255;
  if (dir === 2) dir = huedelta8 > 127 ? 1 : 0;
  if (dir === 3) dir = huedelta8 < 128 ? 1 : 0;
  const hue87 = dir === 0 ? s16(huedelta8 << 7) : s16(-(((256 - huedelta8) & 255) << 7));
  const dist = end - start;
  const div = s16(dist ? dist : 1);
  const d = [hue87, sat87, val87].map((x) => s16(Math.trunc(x / div) * 2));
  const v88 = [c0[0] << 8, c0[1] << 8, c0[2] << 8];
  if (!p) return ctx.fault("fill_gradient() was given a NULL pointer", pos);
  for (let i = start; i <= end; i++) {
    const px = p.m[p.i + i] as Px | undefined;
    if (!px) return ctx.fault(`fill_gradient() writes LED ${i}, past the end of the array (${p.m.length - p.i} LEDs): on the chip it overwrites the memory after it`, pos);
    const hsv = [v88[0] >> 8, v88[1] >> 8, v88[2] >> 8];
    setPx(px, rgb ? hsv2rgb(hsv) : hsv);
    for (let k = 0; k < 3; k++) v88[k] = (v88[k] + d[k]) & 0xffff;
  }
}

/** ColorFromPalette for a 16-entry palette: blended between entries unless NOBLEND, then dimmed */
function colorFromPalette(pal: unknown, index: number, brightness: number, blend: number): Px {
  index &= 255;
  brightness &= 255;
  if (blend === 2) index = (scale8(index, 239) + 0) & 255;
  const hi4 = index >> 4;
  const lo4 = index & 0x0f;
  const e1 = entry(pal, hi4);
  let [r, g, b] = e1;
  if (lo4 && blend !== 0) {
    const e2 = entry(pal, hi4 === 15 ? 0 : hi4 + 1);
    const f2 = (lo4 << 4) & 255;
    const f1 = 255 - f2;
    r = (scale8(r, f1) + scale8(e2[0], f2)) & 255;
    g = (scale8(g, f1) + scale8(e2[1], f2)) & 255;
    b = (scale8(b, f1) + scale8(e2[2], f2)) & 255;
  }
  if (brightness !== 255) {
    if (brightness) {
      const bb = brightness + 1;
      if (r) r = scale8(r, bb);
      if (g) g = scale8(g, bb);
      if (b) b = scale8(b, bb);
    } else r = g = b = 0;
  }
  return [r, g, b];
}

/** a CRGBPalette16 value: [entries] */
const newPalette = (fill?: (e: Px[]) => void): unknown[] => {
  const e: Px[] = Array.from({ length: 16 }, () => [0, 0, 0]);
  fill?.(e);
  return [e];
};
const palPtr = (e: Px[]): Ptr => ({ m: e, i: 0 });

/** CRGBPalette16 from a gradient in flash: index, r, g, b entries up to index 255 */
function gradientPalette(ctx: Ctx, pos: Pos, p: Ptr | null): unknown[] {
  const pal = newPalette();
  const e = pal[0] as Px[];
  if (!p) {
    ctx.fault("The gradient palette is a NULL pointer", pos);
    return pal;
  }
  const at = (k: number) => [0, 1, 2, 3].map((j) => Number(p.m[p.i + k * 4 + j] ?? 0) & 255);
  let count = 0;
  for (;;) {
    const u = at(count++);
    if (u[0] === 255 || p.i + count * 4 > p.m.length) break;
  }
  let u = at(0);
  let rgbStart: Px = [u[1], u[2], u[3]];
  let indexStart = 0;
  let last = -1;
  let k = 0;
  while (indexStart < 255) {
    k++;
    if (p.i + k * 4 + 3 >= p.m.length) {
      ctx.fault("The gradient palette has no entry with index 255 to end it", pos);
      break;
    }
    u = at(k);
    const indexEnd = u[0];
    const rgbEnd: Px = [u[1], u[2], u[3]];
    let istart8 = (indexStart / 16) | 0;
    let iend8 = (indexEnd / 16) | 0;
    if (count < 16) {
      if (istart8 <= last && last < 15) {
        istart8 = last + 1;
        if (iend8 < istart8) iend8 = istart8;
      }
      last = iend8;
    }
    fillGradientRGB(ctx, pos, palPtr(e), istart8, rgbStart, iend8, rgbEnd);
    indexStart = indexEnd;
    rgbStart = rgbEnd;
  }
  return pal;
}

/** the conversions into a CRGBPalette16 C++ allows without naming the type (= RainbowColors_p, = some CRGB) */
function paletteFrom(c: C, ctx: Ctx, pos: Pos): Ev | null {
  const t = strip(c.t);
  const e = c.ev;
  const el = t.k === "arr" ? strip(t.of) : t.k === "ptr" ? strip(t.to) : null;
  const ptr = t.k === "arr" ? (f: Frame) => ({ m: e(f), i: 0 }) : e;
  if (el && el.k === "int" && el.bits === 32)
    return (f) => {
      const p = ptr(f) as Ptr | null;
      return newPalette((en) => {
        for (let k = 0; k < 16; k++) setPx(en[k], p ? code(Number(p.m[p.i + k] ?? 0) >>> 0) : [0, 0, 0]);
      });
    };
  if (el && el.k === "int" && el.bits === 8) return (f) => gradientPalette(ctx, pos, ptr(f) as Ptr | null);
  if (el && (isStruct(el, "CRGB") || isStruct(el, "CHSV"))) {
    const hsv = isStruct(el, "CHSV");
    return (f) => {
      const p = ptr(f) as Ptr;
      return newPalette((en) => {
        for (let k = 0; k < 16; k++) {
          const px = (p?.m[p.i + k] as Px | undefined) ?? [0, 0, 0];
          setPx(en[k], hsv ? hsv2rgb(px) : px);
        }
      });
    };
  }
  if (isStruct(t, "CRGB") || isStruct(t, "CHSV")) {
    const hsv = isStruct(t, "CHSV");
    return (f) => {
      const px = e(f) as Px;
      const v = hsv ? hsv2rgb(px) : px;
      return newPalette((en) => en.forEach((x) => setPx(x, v)));
    };
  }
  return null;
}

// ---------- show(): what goes down the wire ----------

/** CLEDController::computeAdjustment: brightness, colour correction and temperature as one scale per channel */
function adjustment(scale: number, cc: Px, ct: Px): Px {
  const adj = [0, 0, 0];
  if (scale > 0)
    for (let i = 0; i < 3; i++) {
      if (cc[i] > 0 && ct[i] > 0) adj[i] = Math.floor(((cc[i] + 1) * (ct[i] + 1) * scale) / 0x10000) & 255;
    }
  return adj;
}

const reverse8 = (x: number) => {
  let q = 0;
  for (let b = 0; b < 8; b++) if (x & (1 << b)) q |= 0x80 >> b;
  return q;
};

/** calculate_unscaled_power_mW: 16, 11 and 15 mA a channel at full and 1 mA dark, at 5 V */
function unscaledMw(p: Ptr | null, n: number): number {
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < n && p; i++) {
    const px = p.m[p.i + i] as Px | undefined;
    if (!px) break;
    r += px[0];
    g += px[1];
    b += px[2];
  }
  return ((r * 80) >>> 8) + ((g * 55) >>> 8) + ((b * 75) >>> 8) + 5 * n;
}

/** calculate_max_brightness_for_power_mW over every controller, with the MCU's own 125 mW */
function maxBrightness(ctx: Ctx, target: number, maxMw: number): number {
  const st = ctx.lib.fastled;
  let total = 125;
  for (const c of st.ctls) total += unscaledMw(c.data, c.n);
  const requested = Math.floor((total * target) / 256);
  const limited = requested >= maxMw;
  if (st.powerPin) ctx.hal.digitalWrite(st.powerPin, limited ? 1 : 0);
  if (!limited) return target;
  st.limited++;
  return Math.floor((target * maxMw) / requested) & 255;
}

/** one controller's frame: scaled, dithered and sent in its colour order, with the time it takes on the wire */
function sendFrame(ctx: Ctx, c: Ctl, brightness: number, dither: number, solid?: Px) {
  const st = ctx.lib.fastled;
  const hal = ctx.hal;
  const adj = adjustment(brightness, c.correction, c.temperature);
  const d = [0, 0, 0];
  const e = [0, 0, 0];
  if (dither === 1) {
    st.ditherR = (st.ditherR + 1) & 7;
    const q = (reverse8(st.ditherR) + 16) & 255;
    for (let k = 0; k < 3; k++) {
      const s = adj[k];
      e[k] = s ? (Math.floor(256 / s) + 1) & 255 : 0;
      d[k] = scale8(q, e[k]);
      if (d[k]) d[k]--;
      if (e[k]) e[k]--;
    }
  }
  const out = new Array<number>(c.n);
  const p = c.data;
  for (let i = 0; i < c.n; i++) {
    const px = solid ?? ((p?.m[p.i + i] as Px | undefined) ?? [0, 0, 0]);
    let v = 0;
    for (let k = 0; k < 3; k++) {
      const b = px[k] & 255;
      v = (v << 8) | scale8(b ? qadd8(b, d[k]) : 0, adj[k]);
      d[k] = (e[k] - d[k]) & 255;
    }
    out[i] = v;
  }
  hal.pixels?.(c.pin, out, neoType(c.order) | (c.chip.bitUs > 2 ? 0x100 : 0));
  st.shows++;
  // on the wire: one-wire chips at their bit rate (the AVR loop adds about 0.6 µs a LED), clocked ones at the SPI clock
  const avr = hal.arch !== "esp32";
  const us = c.chip.spi ? (c.n * c.chip.bits + 64) / (c.hz / 1e6) : c.n * (24 * c.chip.bitUs + (avr ? 0.6 : 0)) + 10;
  if (avr && !c.chip.spi) hal.setInterrupts(false);
  burn(hal, (us * hal.fcpu) / 1e6);
  if (avr && !c.chip.spi) hal.setInterrupts(true);
}

/** CFastLED::show / showColor: the refresh cap, the power limit, then every controller, then the frame counter */
function showAll(ctx: Ctx, scale: number, solid?: Px) {
  const st = ctx.lib.fastled;
  const hal = ctx.hal;
  if (st.minMicros) {
    const gone = ((hal.micros() >>> 0) - st.lastShow) >>> 0;
    if (gone < st.minMicros) burn(hal, ((st.minMicros - gone) * hal.fcpu) / 1e6);
  }
  st.lastShow = hal.micros() >>> 0;
  if (st.powerMw) scale = maxBrightness(ctx, scale & 255, st.powerMw);
  for (const c of st.ctls) sendFrame(ctx, c, scale & 255, st.fps < 100 ? 0 : c.dither, solid);
  // countFPS(25)
  if (st.fpsFrames++ >= 25) {
    let gone = (ms32(ctx) - st.fpsLast) >>> 0;
    if (gone === 0) gone = 1;
    st.fps = Math.floor((st.fpsFrames * 1000) / gone) & 0xffff;
    st.fpsFrames = 0;
    st.fpsLast = ms32(ctx);
  }
}

function delay1(ctx: Ctx) {
  const hal = ctx.hal;
  if (hal.delayMs) hal.delayMs(1);
  else hal.spend(hal.fcpu / 1000);
}

// ---------- the FastLED object, its controllers and the EVERY_N timers ----------

type TPos = Pos & { targs?: number[] };

const CTL_T: CType = { k: "class", name: "CLEDController" };

function addLeds(args: C[], ctx: Ctx, pos: Pos): C {
  included(ctx, "FastLED.addLeds()", pos);
  const targs = (pos as TPos).targs;
  if (!targs?.length) return ctx.error("FastLED.addLeds needs its chipset, data pin and colour order in angle brackets, like FastLED.addLeds<WS2812B, 6, GRB>(leds, NUM_LEDS)", pos);
  const chip = CHIPS.get(targs[0]);
  if (!chip) return ctx.error("FastLED.addLeds<...>: the first template argument must be a chipset, like WS2812B, NEOPIXEL, WS2811, SK6812 or APA102", pos);
  let pin: number;
  let clock = -1;
  let order = ORDERS.RGB;
  let hz = 0;
  let hwSpi = false;
  if (!chip.spi) {
    if (targs.length < 2) return ctx.error(`FastLED.addLeds<${chip.name}, DATA_PIN${chip.order ? "" : ", GRB"}>: give the data pin`, pos);
    pin = targs[1];
    if (chip.order !== undefined) {
      if (targs.length > 2) return ctx.error("NEOPIXEL has GRB built in and takes no colour order: FastLED.addLeds<NEOPIXEL, DATA_PIN>(leds, NUM_LEDS), or name the chip (WS2812B) with one", pos);
      order = chip.order;
    } else {
      if (targs.length > 3) return ctx.error(`FastLED.addLeds<${chip.name}, DATA_PIN, COLOR_ORDER> takes three template arguments`, pos);
      order = targs[2] ?? ORDERS.RGB;
    }
  } else {
    const pins = ctx.hal.spi?.pins;
    // <CHIP>, <CHIP, ORDER>, <CHIP, ORDER, RATE> on the hardware SPI pins, or <CHIP, DATA, CLOCK[, ORDER[, RATE]]>
    if (targs.length === 1 || (targs.length <= 3 && ORDER_NAME.has(targs[1]))) {
      if (!pins) return ctx.error(`FastLED.addLeds<${chip.name}>: the simulator knows no SPI pins on this board; name the data and clock pins`, pos);
      [pin, clock, hwSpi] = [pins.mosi, pins.sck, true];
      order = targs[1] ?? ORDERS.RGB;
      hz = targs[2] ?? chip.hz;
    } else {
      if (targs.length < 3) return ctx.error(`FastLED.addLeds<${chip.name}, DATA_PIN, CLOCK_PIN, COLOR_ORDER>: ${chip.name} needs a clock pin as well as a data pin`, pos);
      [pin, clock] = [targs[1], targs[2]];
      hwSpi = !!pins && pin === pins.mosi && clock === pins.sck;
      order = targs[3] ?? ORDERS.RGB;
      hz = targs[4] ?? chip.hz;
    }
    // hardware SPI tops out at half the CPU clock (8 MHz on a 16 MHz AVR); FastLED's bit-banged SPI at about 2 MHz there
    const top = (ctx.hal.arch ?? "avr") !== "avr" ? (hwSpi ? Math.min(40e6, ctx.hal.fcpu / 2) : 8e6) : hwSpi ? ctx.hal.fcpu / 2 : 2e6;
    hz = Math.max(1, Math.min(hz, top));
  }
  if (!ORDER_NAME.has(order)) return ctx.error("The colour order must be one of RGB, RBG, GRB, GBR, BRG or BGR", pos);
  if (args.length < 2 || args.length > 3) argCount("FastLED.addLeds", 2, 3, args.length, ctx, pos);
  const L = ledsArg(args[0], ctx, "FastLED.addLeds()", "CRGB");
  const A = numEv(args[1], ctx.T.int, ctx, "FastLED.addLeds()");
  const B = args[2] ? numEv(args[2], ctx.T.int, ctx, "FastLED.addLeds()") : () => 0;
  // one static controller for each set of template arguments, as the library's `static CHIPSET<...> c;` is
  const key = `${chip.code}/${pin}/${clock}/${order}/${hz}`;
  const hal = ctx.hal;
  return {
    t: CTL_T,
    ev: (f) => {
      const st = ctx.lib.fastled;
      let c = st.byKey.get(key);
      if (!c) {
        c = { kind: "CLEDController", chip, pin, clock, order, hwSpi, hz, data: null, n: 0, correction: [255, 255, 255], temperature: [255, 255, 255], dither: 1 };
        st.byKey.set(key, c);
        st.ctls.push(c);
      }
      const a = A(f) as number;
      const b = B(f) as number;
      const off = b > 0 ? a : 0;
      const n = b > 0 ? b : a;
      const p = L(f) as Ptr | null;
      hal.pinMode(pin, 1);
      if (clock >= 0) hal.pinMode(clock, 1);
      c.data = p ? { m: p.m, i: p.i + off } : null;
      c.n = Math.max(0, n);
      if (p && p.i + off + c.n > p.m.length) ctx.fault(`FastLED.addLeds() was told ${c.n} LEDs${off ? ` from LED ${off}` : ""} of an array of ${p.m.length - p.i}: show() sends whatever memory follows it`, pos);
      // FastLED.setMaxRefreshRate(getMaxRefreshRate(), true): one-wire chips take at most 400 frames a second
      if (!chip.spi) st.minMicros = Math.max(st.minMicros, 2500);
      burn(hal, 300);
      return c;
    },
    cost: sumCost(args) + 60,
    pos,
  };
}

const flObj = (name: string, params: FK[], ret: RT, cyc: number, run: Run, defaults: unknown[] = []) => fl(`FastLED.${name}`, params, ret, cyc, run, defaults);

const fastLedObject: Record<string, LibFn> = dict<LibFn>({
  addLeds,
  show: flObj("show", ["u8"], "void", 40, ([s], ctx) => showAll(ctx, s ?? ctx.lib.fastled.scale), [undefined]),
  showColor: flObj("showColor", ["rgb", "u8"], "void", 40, ([c, s], ctx) => showAll(ctx, s ?? ctx.lib.fastled.scale, c), [undefined]),
  clear: flObj(
    "clear",
    ["bool"],
    "void",
    30,
    ([write], ctx) => {
      if (write) showAll(ctx, 0, [0, 0, 0]);
      for (const c of ctx.lib.fastled.ctls) clearData(ctx, c);
    },
    [0],
  ),
  clearData: flObj("clearData", [], "void", 30, (_v, ctx) => ctx.lib.fastled.ctls.forEach((c) => clearData(ctx, c))),
  setBrightness: flObj("setBrightness", ["u8"], "void", 6, ([s], ctx) => void (ctx.lib.fastled.scale = s)),
  getBrightness: flObj("getBrightness", [], "u8", 4, (_v, ctx) => ctx.lib.fastled.scale),
  delay: flObj("delay", ["u32"], "void", 30, ([ms], ctx) => {
    const start = ms32(ctx);
    do {
      delay1(ctx);
      showAll(ctx, ctx.lib.fastled.scale);
    } while ((ms32(ctx) - start) >>> 0 < ms);
  }),
  setCorrection: flObj("setCorrection", ["rgb"], "void", 20, ([c], ctx) => ctx.lib.fastled.ctls.forEach((x) => (x.correction = (c as Px).slice()))),
  setTemperature: flObj("setTemperature", ["rgb"], "void", 20, ([c], ctx) => ctx.lib.fastled.ctls.forEach((x) => (x.temperature = (c as Px).slice()))),
  setDither: flObj("setDither", ["u8"], "void", 10, ([d], ctx) => ctx.lib.fastled.ctls.forEach((x) => (x.dither = d)), [1]),
  setMaxRefreshRate: flObj(
    "setMaxRefreshRate",
    ["u16", "bool"],
    "void",
    40,
    ([hz, constrain], ctx) => {
      const st = ctx.lib.fastled;
      if (constrain) {
        if (hz > 0) st.minMicros = Math.max(st.minMicros, Math.floor(1e6 / hz));
      } else st.minMicros = hz > 0 ? Math.floor(1e6 / hz) : 0;
    },
    [0],
  ),
  setMaxPowerInVoltsAndMilliamps: flObj("setMaxPowerInVoltsAndMilliamps", ["u8", "u32"], "void", 20, ([v, ma], ctx) => void (ctx.lib.fastled.powerMw = (v * ma) >>> 0)),
  setMaxPowerInMilliWatts: flObj("setMaxPowerInMilliWatts", ["u32"], "void", 10, ([mw], ctx) => void (ctx.lib.fastled.powerMw = mw >>> 0)),
  getFPS: flObj("getFPS", [], "u16", 4, (_v, ctx) => ctx.lib.fastled.fps),
  countFPS: flObj("countFPS", ["int"], "void", 20, () => undefined, [25]),
  count: flObj("count", [], "u16", 10, (_v, ctx) => ctx.lib.fastled.ctls.length),
  size: flObj("size", [], "u16", 10, (_v, ctx) => ctx.lib.fastled.ctls[0]?.n ?? 0),
  "[]": (args, ctx, pos) => {
    included(ctx, "FastLED[]", pos);
    const I = numEv(args[0], ctx.T.int, ctx, "FastLED[]");
    return {
      t: CTL_T,
      ev: (f) => {
        const st = ctx.lib.fastled;
        const i = I(f) as number;
        const c = st.ctls[i] ?? st.ctls[0];
        if (!c) ctx.fault("FastLED[] before any addLeds(): there is no controller to return", pos);
        return c ?? null;
      },
      cost: args[0].cost + 20,
      pos,
    };
  },
});

function clearData(ctx: Ctx, c: Ctl) {
  const p = c.data;
  for (let i = 0; i < c.n && p; i++) {
    const px = p.m[p.i + i] as Px | undefined;
    if (px) px[0] = px[1] = px[2] = 0;
  }
  burn(ctx.hal, c.n * 3 * 2);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctlM = (name: string, params: FK[], ret: RT | "self", cyc: number, run: (c: Ctl, v: any[], ctx: Ctx, pos: Pos) => unknown, defaults: unknown[] = []): LibMethod =>
  (obj, args, ctx, pos) => {
    const min = params.length - defaults.length;
    if (args.length < min || args.length > params.length) argCount(`CLEDController.${name}`, min, params.length, args.length, ctx, pos);
    const O = obj.lv ? obj.lv.get : obj.ev;
    const conv = args.map((a, i) => argEv(params[i], a, ctx, `CLEDController.${name}()`));
    const evs = conv.map((x) => x.ev);
    for (let i = args.length; i < params.length; i++) {
      const d = defaults[i - min];
      evs.push(() => d);
    }
    return {
      t: ret === "self" ? CTL_T : retType(ret, ctx, pos),
      ev: (f) => {
        const c = O(f) as Ctl | null;
        const v = evs.map((e) => e(f));
        if (!c || c.kind !== "CLEDController") {
          ctx.fault(`CLEDController.${name}() on a controller addLeds() never made`, pos);
          return ret === "self" ? c : 0;
        }
        const r = run(c, v, ctx, pos);
        return ret === "self" ? c : r;
      },
      cost: obj.cost + sumCost(args) + cy(ctx, cyc),
      pos,
    };
  };

const controllerClass: LibClass = {
  methods: dict<LibMethod>({
    setCorrection: ctlM("setCorrection", ["rgb"], "self", 10, (c, [v]) => void (c.correction = (v as Px).slice())),
    setTemperature: ctlM("setTemperature", ["rgb"], "self", 10, (c, [v]) => void (c.temperature = (v as Px).slice())),
    setDither: ctlM("setDither", ["u8"], "self", 4, (c, [d]) => void (c.dither = d), [1]),
    getDither: ctlM("getDither", [], "u8", 4, (c) => c.dither),
    size: ctlM("size", [], "u16", 4, (c) => c.n),
    showLeds: ctlM(
      "showLeds",
      ["u8"],
      "void",
      30,
      (c, [s], ctx) => {
        sendFrame(ctx, c, s, c.dither);
      },
      [255],
    ),
    showColor: ctlM("showColor", ["rgb", "u8"], "void", 30, (c, [v, s], ctx) => sendFrame(ctx, c, s, c.dither, v), [255]),
    clearLedData: ctlM("clearLedData", [], "void", 10, (c, _v, ctx) => clearData(ctx, c)),
  }),
};

interface EveryObj {
  kind: "CEveryN";
  unit: number;
  period: number;
  prev: number | null;
  now: () => number;
}
const everyNow = (o: EveryObj) => {
  const t = clockOf(o.unit, o.now());
  if (o.prev === null) o.prev = t;
  return t;
};
const everyReady = (o: EveryObj) => {
  const t = everyNow(o);
  const ok = elapsed(o.unit, t, o.prev!) >= o.period;
  if (ok) o.prev = t;
  return ok;
};

/** CEveryNMillis and friends: the timer behind EVERY_N_MILLIS_I(name, N), started the first time it is looked at */
function everyClass(cls: string, unit: number): LibClass {
  const mk = (period: number, ctx: Ctx): EveryObj => ({ kind: "CEveryN", unit, period: period & CLOCK_MASK[unit], prev: null, now: () => ctx.hal.millis() >>> 0 });
  const m = (name: string, params: FK[], ret: RT, run: (o: EveryObj, v: number[]) => unknown, defaults: unknown[] = []): LibMethod => (obj, args, ctx, pos) => {
    if (args.length < params.length - defaults.length || args.length > params.length) argCount(`${cls}.${name}`, params.length - defaults.length, params.length, args.length, ctx, pos);
    const O = obj.lv ? obj.lv.get : obj.ev;
    const evs = args.map((a, i) => argEv(params[i], a, ctx, `${cls}.${name}()`).ev);
    return { t: retType(ret, ctx, pos), ev: (f) => run(O(f) as EveryObj, evs.map((e) => e(f))), cost: obj.cost + sumCost(args) + cy(ctx, 40), pos };
  };
  const ty: RT = unit === 0 ? "u32" : unit === 4 ? "u8" : "u16";
  return {
    construct: (args, ctx, pos) => {
      if (args.length > 1) argCount(cls, 0, 1, args.length, ctx, pos);
      const P = args[0] ? numEv(args[0], ctx.T.ulong, ctx, cls) : () => 1;
      return { t: { k: "class", name: cls }, ev: (f) => mk(P(f) as number, ctx), cost: sumCost(args) + 20, pos };
    },
    make: (ctx) => mk(1, ctx),
    truthy: (o) => everyReady(o as EveryObj),
    methods: dict<LibMethod>({
      ready: m("ready", [], "bool", (o) => (everyReady(o) ? 1 : 0)),
      reset: m("reset", [], "void", (o) => void (o.prev = clockOf(o.unit, o.now()))),
      trigger: m("trigger", [], "void", (o) => void (o.prev = (clockOf(o.unit, o.now()) - o.period) & CLOCK_MASK[o.unit])),
      setPeriod: m("setPeriod", ["u32"], "void", (o, [p]) => void (everyNow(o), (o.period = p & CLOCK_MASK[o.unit]))),
      getPeriod: m("getPeriod", [], ty, (o) => o.period),
      getTime: m("getTime", [], ty, (o) => clockOf(o.unit, o.now())),
      getElapsed: m("getElapsed", [], ty, (o) => elapsed(o.unit, everyNow(o), o.prev!)),
      getRemaining: m("getRemaining", [], ty, (o) => (o.period - elapsed(o.unit, everyNow(o), o.prev!)) & CLOCK_MASK[o.unit]),
      getLastTriggerTime: m("getLastTriggerTime", [], ty, (o) => (everyNow(o), o.prev!)),
    }),
  };
}

/** EVERY_N_MILLIS(N) { ... }: each block its own timer, started the first time the code reaches it */
const everyFn: LibFn = (args, ctx, pos) => {
  included(ctx, "EVERY_N_MILLISECONDS", pos);
  const unit = args[0]?.cv ?? 0;
  const N = numEv(args[1], ctx.T.ulong, ctx, "EVERY_N_MILLISECONDS");
  const site = {};
  return {
    t: BOOL,
    ev: (f) => {
      const st = ctx.lib.fastled;
      const now = clockOf(unit, ms32(ctx));
      let tm = st.every.get(site);
      if (!tm) {
        tm = { prev: now, period: (N(f) as number) & CLOCK_MASK[unit] };
        st.every.set(site, tm);
      }
      if (elapsed(unit, now, tm.prev) < tm.period) return 0;
      tm.prev = now;
      return 1;
    },
    cost: args[1].cost + cy(ctx, 40),
    pos,
  };
};

// ---------- the colour types ----------

function rgbBinary(op: string, a: C, b: C, ctx: Ctx, pos: Pos): C | null {
  const T = fastLedType(ctx, "CRGB", pos);
  const isRgb = (c: C) => isStruct(c.t, "CRGB") || isStruct(c.t, "CHSV");
  const res = (ev: Ev, cyc: number): C => ({ t: T, ev, cost: a.cost + b.cost + cy(ctx, cyc), pos });
  const both = () => [rgbArg(a, ctx, `CRGB ${op}`), rgbArg(b, ctx, `CRGB ${op}`)];
  const per = (fn: (x: number, y: number) => number, cyc: number) => {
    const [A, B] = both();
    return { t: T, ev: (f: Frame) => {
      const x = A.ev(f) as Px;
      const y = B.ev(f) as Px;
      return [fn(x[0], y[0]), fn(x[1], y[1]), fn(x[2], y[2])];
    }, cost: a.cost + b.cost + A.cost + B.cost + cy(ctx, cyc), pos } as C;
  };
  const byByte = (fn: (x: number, d: number) => number, cyc: number) => {
    if (!isStruct(a.t, "CRGB")) return null;
    const A = a.ev;
    const D = numEv(b, ctx.T.uchar, ctx, `CRGB ${op}`);
    return res((f) => {
      const x = A(f) as Px;
      const d = D(f) as number;
      return [fn(x[0], d), fn(x[1], d), fn(x[2], d)];
    }, cyc);
  };
  switch (op) {
    case "+":
    case "+=":
      return per(qadd8, 12);
    case "-":
    case "-=":
      return per(qsub8, 12);
    case "*":
    case "*=":
      return byByte(qmul8, 16);
    case "/":
    case "/=":
      return byByte((x, d) => {
        if (!d) {
          ctx.fault("CRGB / 0: dividing a colour by zero", pos);
          return 255;
        }
        return Math.floor(x / d);
      }, 3 * 60);
    case "%":
    case "%=":
      if (!isStruct(a.t, "CRGB")) return null;
      {
        const A = a.ev;
        const D = numEv(b, ctx.T.uchar, ctx, `CRGB ${op}`);
        return res((f) => {
          const x = (A(f) as Px).slice();
          nscale8x3Video(x, D(f) as number);
          return x;
        }, 20);
      }
    case ">>":
    case ">>=":
      return byByte((x, d) => (x >> d) & 255, 12);
    case "|":
    case "&":
    case "|=":
    case "&=": {
      const mx = op[0] === "|";
      // x |= 5 takes the uint8_t overload: a number (even CRGB::Blue) is one byte for every channel, as C++ picks it
      if (op.length === 2 && !isRgb(b) && isArith(strip(b.t))) return byByte((x, d) => (mx ? Math.max(x, d) : Math.min(x, d)), 12);
      return per((x, y) => (mx ? Math.max(x, y) : Math.min(x, y)), 12);
    }
    case "==":
    case "!=":
    case "<":
    case ">":
    case "<=":
    case ">=": {
      const [A, B] = both();
      const sum = (p: Px) => p[0] + p[1] + p[2];
      const cmp: (x: Px, y: Px) => boolean =
        op === "==" ? (x, y) => x[0] === y[0] && x[1] === y[1] && x[2] === y[2] : op === "!=" ? (x, y) => x[0] !== y[0] || x[1] !== y[1] || x[2] !== y[2] : op === "<" ? (x, y) => sum(x) < sum(y) : op === ">" ? (x, y) => sum(x) > sum(y) : op === "<=" ? (x, y) => sum(x) <= sum(y) : (x, y) => sum(x) >= sum(y);
      return { t: BOOL, ev: (f) => (cmp(A.ev(f), B.ev(f)) ? 1 : 0), cost: a.cost + b.cost + A.cost + B.cost + cy(ctx, 10), pos };
    }
  }
  return null;
}

const crgbStruct: LibStruct = {
  from: (c, to, ctx, pos) => {
    const t = strip(c.t);
    if (!(t.k === "struct" && t.name === "CHSV") && !isArith(t)) return null;
    const r = rgbArg(c, ctx, "CRGB");
    return { t: to, ev: r.ev, cost: c.cost + r.cost, pos };
  },
  binary: rgbBinary,
  // explicit operator bool and explicit operator uint32_t (0xFFRRGGBB): only in a cast, as C++ allows them
  to: (c, to, explicit, ctx, pos) => {
    if (!explicit || !isArith(to)) return null;
    const A = c.ev;
    if (to.k === "bool") return { t: BOOL, ev: (f) => ((A(f) as Px).some((x) => x) ? 1 : 0), cost: c.cost + 3, pos };
    const u32: C = { t: ctx.T.ulong, ev: (f) => { const p = A(f) as Px; return (0xff000000 | (p[0] << 16) | (p[1] << 8) | p[2]) >>> 0; }, cost: c.cost + 4, pos };
    return { t: to, ev: numEv(u32, to, ctx, "a cast"), cost: u32.cost, pos };
  },
  unary: (op, a, ctx, pos) => {
    if (op !== "-") return null;
    const A = a.ev;
    return { t: fastLedType(ctx, "CRGB", pos), ev: (f) => (A(f) as Px).map((x) => 255 - x), cost: a.cost + cy(ctx, 8), pos };
  },
  step: (v, d) => (v as Px).map((x) => (d > 0 ? qadd8(x, 1) : qsub8(x, 1))),
  truthy: (v) => {
    const p = v as Px;
    return !!(p[0] || p[1] || p[2]);
  },
  alias: { red: "r", green: "g", blue: "b" },
  index: "self",
  methods: dict<LibMethod>({
    setRGB: sm("CRGB", "setRGB", ["u8", "u8", "u8"], "self", 6, (o, [r, g, b]) => setPx(o, [r, g, b])),
    setHSV: sm("CRGB", "setHSV", ["u8", "u8", "u8"], "self", 90, (o, [h, s, v]) => setPx(o, hsv2rgb([h, s, v]))),
    setHue: sm("CRGB", "setHue", ["u8"], "self", 90, (o, [h]) => setPx(o, hsv2rgb([h, 255, 255]))),
    setColorCode: sm("CRGB", "setColorCode", ["u32"], "self", 6, (o, [c]) => setPx(o, code(c))),
    addToRGB: sm("CRGB", "addToRGB", ["u8"], "self", 10, (o, [d]) => setPx(o, o.map((x) => qadd8(x, d)))),
    subtractFromRGB: sm("CRGB", "subtractFromRGB", ["u8"], "self", 10, (o, [d]) => setPx(o, o.map((x) => qsub8(x, d)))),
    nscale8: (obj, args, ctx, pos) =>
      args.length === 1 && isStruct(args[0].t, "CRGB") ? sm("CRGB", "nscale8", ["rgb"], "self", 14, (o, [s]) => setPx(o, [scale8(o[0], s[0]), scale8(o[1], s[1]), scale8(o[2], s[2])]))(obj, args, ctx, pos) : sm("CRGB", "nscale8", ["u8"], "self", 14, (o, [s]) => nscale8x3(o, s))(obj, args, ctx, pos),
    nscale8_video: sm("CRGB", "nscale8_video", ["u8"], "self", 20, (o, [s]) => nscale8x3Video(o, s)),
    fadeLightBy: sm("CRGB", "fadeLightBy", ["u8"], "self", 20, (o, [s]) => nscale8x3Video(o, 255 - s)),
    fadeToBlackBy: sm("CRGB", "fadeToBlackBy", ["u8"], "self", 14, (o, [s]) => nscale8x3(o, 255 - s)),
    scale8: (obj, args, ctx, pos) =>
      args.length === 1 && isStruct(args[0].t, "CRGB") ? sm("CRGB", "scale8", ["rgb"], "CRGB", 14, (o, [s]) => [scale8(o[0], s[0]), scale8(o[1], s[1]), scale8(o[2], s[2])])(obj, args, ctx, pos) : sm("CRGB", "scale8", ["u8"], "CRGB", 14, (o, [s]) => o.map((x) => scale8(x, s)))(obj, args, ctx, pos),
    getLuma: sm("CRGB", "getLuma", [], "u8", 14, (o) => (scale8(o[0], 54) + scale8(o[1], 183) + scale8(o[2], 18)) & 255),
    getAverageLight: sm("CRGB", "getAverageLight", [], "u8", 14, (o) => (scale8(o[0], 85) + scale8(o[1], 85) + scale8(o[2], 85)) & 255),
    maximizeBrightness: sm(
      "CRGB",
      "maximizeBrightness",
      ["u8"],
      "void",
      3 * 60,
      (o, [limit]) => {
        const max = Math.max(o[0], o[1], o[2]);
        if (max > 0) {
          const factor = Math.floor((limit * 256) / max) & 0xffff;
          setPx(o, o.map((x) => Math.floor((x * factor) / 256)));
        }
      },
      [255],
    ),
    lerp8: sm("CRGB", "lerp8", ["rgb", "u8"], "CRGB", 20, (o, [x, fr]) => [0, 1, 2].map((k) => lerp8by8(o[k], x[k], fr))),
    lerp16: sm("CRGB", "lerp16", ["rgb", "u16"], "CRGB", 40, (o, [x, fr]) => [0, 1, 2].map((k) => lerp16by16(o[k] << 8, x[k] << 8, fr) >> 8)),
    getParity: sm("CRGB", "getParity", [], "u8", 6, (o) => (o[0] + o[1] + o[2]) & 1),
    setParity: sm("CRGB", "setParity", ["u8"], "void", 20, (o, [parity]) => setParity(o, parity)),
  }),
};

function setParity(o: Px, parity: number) {
  if (((o[0] + o[1] + o[2]) & 1) === (parity ? 1 : 0)) return;
  let [r, g, b] = o;
  const same = r === g && g === b;
  if (parity) {
    if (b > 0 && b < 255) {
      if (same) {
        r++;
        g++;
      }
      b++;
    } else if (r > 0 && r < 255) r++;
    else if (g > 0 && g < 255) g++;
    else {
      if (same) {
        r ^= 1;
        g ^= 1;
      }
      b ^= 1;
    }
  } else if (b > 1) {
    if (same) {
      r--;
      g--;
    }
    b--;
  } else if (g > 1) g--;
  else if (r > 1) r--;
  else {
    if (same) {
      r ^= 1;
      g ^= 1;
    }
    b ^= 1;
  }
  setPx(o, [r, g, b]);
}

const chsvStruct: LibStruct = {
  binary: (op, a, b, ctx, pos) => {
    if ((op !== "==" && op !== "!=") || !isStruct(a.t, "CHSV") || !isStruct(b.t, "CHSV")) return null;
    const A = a.ev;
    const B = b.ev;
    const ne = op === "!=";
    return { t: BOOL, ev: (f) => { const x = A(f) as Px; const y = B(f) as Px; return (x[0] === y[0] && x[1] === y[1] && x[2] === y[2]) !== ne ? 1 : 0; }, cost: a.cost + b.cost + cy(ctx, 10), pos };
  },
  alias: { hue: "h", sat: "s", saturation: "s", val: "v", value: "v" },
  index: "self",
  methods: dict<LibMethod>({
    setHSV: sm("CHSV", "setHSV", ["u8", "u8", "u8"], "self", 6, (o, [h, s, v]) => setPx(o, [h, s, v])),
  }),
};

const paletteStruct: LibStruct = {
  // operator CRGB*(): a palette passed where its colours are wanted (fill_solid(palette, 16, CRGB::Black))
  to: (c, to, _explicit, _ctx, pos) => {
    if (to.k !== "ptr" || !(isStruct(to.to, "CRGB") || to.to.k === "void")) return null;
    const A = c.ev;
    return { t: to, ev: (f) => ({ m: (A(f) as unknown[])[0], i: 0 }), cost: c.cost + 2, pos };
  },
  from: (c, to, ctx, pos) => {
    const ev = paletteFrom(c, ctx, pos);
    return ev ? { t: to, ev, cost: c.cost + cy(ctx, 16 * 12), pos } : null;
  },
  binary: (op, a, b, ctx, pos) => {
    if ((op !== "==" && op !== "!=") || !isStruct(a.t, "CRGBPalette16") || !isStruct(b.t, "CRGBPalette16")) return null;
    const A = a.ev;
    const B = b.ev;
    const ne = op === "!=";
    return {
      t: BOOL,
      ev: (f) => {
        const x = (A(f) as Px[][])[0];
        const y = (B(f) as Px[][])[0];
        return x.every((p, k) => p[0] === y[k][0] && p[1] === y[k][1] && p[2] === y[k][2]) !== ne ? 1 : 0;
      },
      cost: a.cost + b.cost + cy(ctx, 48 * 4),
      pos,
    };
  },
  index: 0,
};

export const FASTLED_STRUCTS: Record<string, LibStruct> = dict<LibStruct>({ CRGB: crgbStruct, CHSV: chsvStruct, CRGBPalette16: paletteStruct });

// ---------- constructors ----------

const crgbCtor: LibFn = (args, ctx, pos) => {
  const T = fastLedType(ctx, "CRGB", pos);
  if (args.length === 0) return { t: T, ev: () => [0, 0, 0], cost: 2, pos };
  if (args.length === 3) return fl("CRGB", ["u8", "u8", "u8"], "CRGB", 6, ([r, g, b]) => [r, g, b])(args, ctx, pos);
  if (args.length === 1) {
    const r = rgbArg(args[0], ctx, "CRGB()");
    const e = r.ev;
    return { t: T, ev: (f) => (e(f) as Px).slice(), cost: args[0].cost + r.cost + 4, pos };
  }
  return argCount("CRGB", 0, 3, args.length, ctx, pos);
};

const chsvCtor: LibFn = (args, ctx, pos) => {
  const T = fastLedType(ctx, "CHSV", pos);
  if (args.length === 0) return { t: T, ev: () => [0, 0, 0], cost: 2, pos };
  if (args.length === 1 && isStruct(args[0].t, "CHSV")) {
    const e = args[0].ev;
    return { t: T, ev: (f) => (e(f) as Px).slice(), cost: args[0].cost + 4, pos };
  }
  if (args.length !== 3) return argCount("CHSV", 3, 3, args.length, ctx, pos);
  return fl("CHSV", ["u8", "u8", "u8"], "CHSV", 6, ([h, s, v]) => [h, s, v])(args, ctx, pos);
};

const paletteCtor: LibFn = (args, ctx, pos) => {
  const T = fastLedType(ctx, "CRGBPalette16", pos);
  const n = args.length;
  if (n === 0) return { t: T, ev: () => newPalette(), cost: 2, pos };
  if (n === 1) {
    if (isStruct(args[0].t, "CRGBPalette16")) {
      const e = args[0].ev;
      return { t: T, ev: (f) => newPalette((en) => (e(f) as Px[][])[0].forEach((p, k) => setPx(en[k], p))), cost: args[0].cost + cy(ctx, 48 * 3), pos };
    }
    const ev = paletteFrom(args[0], ctx, pos);
    if (ev) return { t: T, ev, cost: args[0].cost + cy(ctx, 16 * 12), pos };
  }
  // CRGBPalette16(c1) .. (c1, c2, c3, c4): a solid fill or a gradient through them; CHSV stops blend in HSV
  if (n >= 1 && n <= 4) {
    const hsv = args.every((a) => isStruct(a.t, "CHSV"));
    const conv = args.map((a) => (hsv ? { ev: refArg(a, ctx, "CRGBPalette16()", "CHSV"), cost: 0 } : rgbArg(a, ctx, "CRGBPalette16()")));
    return {
      t: T,
      ev: (f) => {
        const cs = conv.map((c) => c.ev(f) as Px);
        return newPalette((en) => {
          const p = palPtr(en);
          if (n === 1) en.forEach((x) => setPx(x, hsv ? hsv2rgb(cs[0]) : cs[0]));
          else {
            const stops = n === 2 ? [0, 15] : n === 3 ? [0, 8, 15] : [0, 5, 10, 15];
            for (let k = 0; k + 1 < n; k++) hsv ? fillGradientHSV(ctx, pos, p, true, stops[k], cs[k], stops[k + 1], cs[k + 1], 2) : fillGradientRGB(ctx, pos, p, stops[k], cs[k], stops[k + 1], cs[k + 1]);
          }
        });
      },
      cost: sumCost(args) + conv.reduce((s, c) => s + c.cost, 0) + cy(ctx, 16 * 30),
      pos,
    };
  }
  if (n === 16) {
    const conv = args.map((a) => rgbArg(a, ctx, "CRGBPalette16()"));
    return { t: T, ev: (f) => newPalette((en) => conv.forEach((c, k) => setPx(en[k], c.ev(f) as Px))), cost: sumCost(args) + conv.reduce((s, c) => s + c.cost, 0) + cy(ctx, 16 * 4), pos };
  }
  return ctx.error(`CRGBPalette16() takes 1 to 4 colours, 16 colours, or a palette; given ${n} arguments`, pos);
};

// ---------- functions ----------

const ledLoop = (name: string) => (ctx: Ctx, pos: Pos, p: Ptr | null, n: number, fn: (px: Px, i: number) => void, perLed: number) => {
  eachLed(ctx, pos, `${name}()`, p, n, fn);
  burn(ctx.hal, cy(ctx, perLed) * Math.max(0, n));
};

const fillSolid: LibFn = (args, ctx, pos) => {
  included(ctx, "fill_solid()", pos);
  if (args.length !== 3) argCount("fill_solid", 3, 3, args.length, ctx, pos);
  const t = strip(args[0].t);
  const hsv = (t.k === "arr" && isStruct(t.of, "CHSV")) || (t.k === "ptr" && isStruct(t.to, "CHSV"));
  const loop = ledLoop("fill_solid");
  return hsv
    ? fl("fill_solid", ["hsvs", "int", "hsv"], "void", 20, ([p, n, c], cx, ps) => loop(cx, ps, p, n, (px) => setPx(px, c), 10))(args, ctx, pos)
    : fl("fill_solid", ["leds", "int", "rgb"], "void", 20, ([p, n, c], cx, ps) => loop(cx, ps, p, n, (px) => setPx(px, c), 10))(args, ctx, pos);
};

const fillRainbow = (circular: boolean): LibFn => (args, ctx, pos) => {
  const name = circular ? "fill_rainbow_circular" : "fill_rainbow";
  included(ctx, `${name}()`, pos);
  const t = args[0] ? strip(args[0].t) : VOID;
  const hsv = (t.k === "arr" && isStruct(t.of, "CHSV")) || (t.k === "ptr" && isStruct(t.to, "CHSV"));
  const loop = ledLoop(name);
  const put = (px: Px, h: number) => setPx(px, hsv ? [h, 240, 255] : hsv2rgb([h, 240, 255]));
  if (!circular)
    return fl(name, [hsv ? "hsvs" : "leds", "int", "u8", "u8"], "void", 20, ([p, n, h0, dh], cx, ps) => loop(cx, ps, p, n, (px, i) => put(px, (h0 + i * dh) & 255), hsv ? 12 : 100), [5])(args, ctx, pos);
  return fl(
    name,
    [hsv ? "hsvs" : "leds", "int", "u8", "bool"],
    "void",
    40,
    ([p, n, h0, rev], cx, ps) => {
      if (n === 0) return;
      const change = Math.floor(65535 / n);
      let hue = (h0 << 8) & 0xffff;
      loop(cx, ps, p, n, (px) => {
        put(px, hue >> 8);
        hue = (rev ? hue - change : hue + change) & 0xffff;
      }, hsv ? 16 : 104);
    },
    [0],
  )(args, ctx, pos);
};

const fillGradient: LibFn = (args, ctx, pos) => {
  included(ctx, "fill_gradient()", pos);
  const t = args[0] ? strip(args[0].t) : VOID;
  const hsvArr = (t.k === "arr" && isStruct(t.of, "CHSV")) || (t.k === "ptr" && isStruct(t.to, "CHSV"));
  const target: FK = hsvArr ? "hsvs" : "leds";
  // (leds, startpos, CHSV, endpos, CHSV[, dir]) or (leds, num, CHSV, CHSV[, CHSV[, CHSV]][, dir])
  const positional = args.length >= 5 && !isStruct(args[3].t, "CHSV");
  if (positional)
    return fl("fill_gradient", [target, "u16", "hsv", "u16", "hsv", "u8"], "void", 60, ([p, s, a, e, b, dir], cx, ps) => {
      fillGradientHSV(cx, ps, p, !hsvArr, s, a, e, b, dir);
      burn(cx.hal, cy(cx, 110) * (Math.abs(e - s) + 1));
    }, [2])(args, ctx, pos);
  const nStops = args.slice(2).filter((a) => isStruct(a.t, "CHSV")).length;
  if (nStops < 2 || nStops > 4) return ctx.error("fill_gradient() takes the LEDs, a count and 2 to 4 CHSV colours (or a start, CHSV, end, CHSV)", pos);
  const params: FK[] = [target, "u16", ...Array<FK>(nStops).fill("hsv"), "u8"];
  return fl("fill_gradient", params, "void", 60, (v, cx, ps) => {
    const [p, n] = v;
    const cs = v.slice(2, 2 + nStops) as Px[];
    const dir = v[2 + nStops] as number;
    const last = (n - 1) & 0xffff;
    const stops = nStops === 2 ? [0, last] : nStops === 3 ? [0, (n / 2) | 0, last] : [0, (n / 3) | 0, ((n * 2) / 3) | 0, last];
    for (let k = 0; k + 1 < nStops; k++) fillGradientHSV(cx, ps, p, !hsvArr, stops[k], cs[k], stops[k + 1], cs[k + 1], dir);
    burn(cx.hal, cy(cx, 110) * n);
  }, [2])(args, ctx, pos);
};

const fillGradientRgb: LibFn = (args, ctx, pos) => {
  included(ctx, "fill_gradient_RGB()", pos);
  // C++ picks (leds, startpos, startcolor, endpos, endcolor) when the fourth argument is a number, CRGB::Red included
  if (args.length === 5 && !isStruct(args[3].t, "CRGB") && !isStruct(args[3].t, "CHSV"))
    return fl("fill_gradient_RGB", ["leds", "u16", "rgb", "u16", "rgb"], "void", 40, ([p, s, a, e, b], cx, ps) => {
      fillGradientRGB(cx, ps, p, s, a, e, b);
      burn(cx.hal, cy(cx, 24) * (Math.abs(e - s) + 1));
    })(args, ctx, pos);
  const nStops = args.length - 2;
  if (nStops < 2 || nStops > 4) argCount("fill_gradient_RGB", 4, 6, args.length, ctx, pos);
  return fl("fill_gradient_RGB", ["leds", "u16", ...Array<FK>(nStops).fill("rgb")], "void", 40, (v, cx, ps) => {
    const [p, n] = v;
    const cs = v.slice(2) as Px[];
    const last = (n - 1) & 0xffff;
    const stops = nStops === 2 ? [0, last] : nStops === 3 ? [0, (n / 2) | 0, last] : [0, (n / 3) | 0, ((n * 2) / 3) | 0, last];
    for (let k = 0; k + 1 < nStops; k++) fillGradientRGB(cx, ps, p, stops[k], cs[k], stops[k + 1], cs[k + 1]);
    burn(cx.hal, cy(cx, 24) * n);
  })(args, ctx, pos);
};

const scaleLeds = (name: string, fn: (px: Px, v: number) => void, map: (x: number) => number, perLed: number) =>
  fl(name, ["leds", "u16", "u8"], "void", 20, ([p, n, x], ctx, pos) => {
    const s = map(x);
    ledLoop(name)(ctx, pos, p, n, (px) => fn(px, s), perLed);
  });

const nblendFn: LibFn = (args, ctx, pos) => {
  included(ctx, "nblend()", pos);
  const blend = (a: Px, b: Px, amt: number) => {
    if (amt === 0) return;
    if (amt === 255) return setPx(a, b);
    setPx(a, [blend8(a[0], b[0], amt), blend8(a[1], b[1], amt), blend8(a[2], b[2], amt)]);
  };
  if (args.length === 4) return fl("nblend", ["leds", "leds", "u16", "u8"], "void", 20, ([a, b, n, amt], cx, ps) => ledLoop("nblend")(cx, ps, a, n, (px, i) => blend(px, ((b as Ptr).m[(b as Ptr).i + i] as Px) ?? [0, 0, 0], amt), 40))(args, ctx, pos);
  return fl("nblend", ["rgbref", "rgb", "u8"], "CRGB", 40, ([a, b, amt]) => (blend(a, b, amt), a))(args, ctx, pos);
};

const hsv2rgbFn: LibFn = (args, ctx, pos) => {
  included(ctx, "hsv2rgb_rainbow()", pos);
  if (args.length === 3) return fl("hsv2rgb_rainbow", ["hsvs", "leds", "int"], "void", 20, ([h, r, n], cx, ps) => ledLoop("hsv2rgb_rainbow")(cx, ps, r, n, (px, i) => setPx(px, hsv2rgb(((h as Ptr).m[(h as Ptr).i + i] as Px) ?? [0, 0, 0])), 90))(args, ctx, pos);
  return fl("hsv2rgb_rainbow", ["hsv", "rgbref"], "void", 90, ([h, r]) => setPx(r, hsv2rgb(h)))(args, ctx, pos);
};

const blurFn = fl("blur1d", ["leds", "u16", "u8"], "void", 30, ([p, n, amt], ctx, pos) => {
  const keep = (255 - amt) & 255;
  const seep = amt >> 1;
  let carry: Px = [0, 0, 0];
  let prev: Px | null = null;
  ledLoop("blur1d")(ctx, pos, p, n, (px) => {
    const cur = px.slice();
    const part = cur.slice();
    nscale8x3(part, seep);
    nscale8x3(cur, keep);
    for (let k = 0; k < 3; k++) cur[k] = qadd8(cur[k], carry[k]);
    if (prev) for (let k = 0; k < 3; k++) prev[k] = qadd8(prev[k], part[k]);
    setPx(px, cur);
    carry = part;
    prev = px;
  }, 70);
});

const heatColor = (t: number): Px => {
  const t192 = scale8Video(t, 191);
  const ramp = ((t192 & 0x3f) << 2) & 255;
  if (t192 & 0x80) return [255, 255, ramp];
  if (t192 & 0x40) return [255, ramp, 0];
  return [ramp, 0, 0];
};

const easeQuad = (ctx: Ctx, i: number) => {
  i &= 255;
  let j = i & 0x80 ? 255 - i : i;
  // the AVR's assembly keeps one more bit of the square than the C version
  if ((ctx.hal.arch ?? "avr") === "avr") j = ((j * (j + 1)) >> 7) & 255;
  else j = (scale8(j, j) << 1) & 255;
  return i & 0x80 ? 255 - j : j;
};
const easeCubic = (i: number) => {
  const ii = scale8(i, i);
  const iii = scale8(ii, i);
  const r1 = (3 * ii - 2 * iii) & 0xffff;
  return r1 & 0x100 ? 255 : r1 & 255;
};
const easeApprox = (i: number) => {
  i &= 255;
  if (i < 64) return i >> 1;
  if (i > 191) return 255 - ((255 - i) >> 1);
  const k = i - 64;
  return (k + (k >> 1) + 32) & 255;
};
const triwave8 = (x: number) => ((x & 0x80 ? 255 - (x & 255) : x & 255) << 1) & 255;
const sqrt16 = (x: number) => {
  x &= 0xffff;
  if (x <= 1) return x;
  let low = 1;
  let hi = x > 7904 ? 255 : (x >> 5) + 8;
  do {
    const mid = (low + hi) >> 1;
    if (((mid * mid) & 0xffff) > x) hi = mid - 1;
    else {
      if (mid === 255) return 255;
      low = mid + 1;
    }
  } while (hi >= low);
  return low - 1;
};

const u8fn = (name: string, cyc: number, f: (...v: number[]) => number, n = 1, defaults: unknown[] = []) => fl(name, Array<FK>(n).fill("u8"), "u8", cyc, (v) => f(...(v as number[])) & 255, defaults);

const flFuncs: Record<string, LibFn> = {
  CRGB: crgbCtor,
  CHSV: chsvCtor,
  CRGBPalette16: paletteCtor,
  __fastled_every: everyFn,
  // lib8tion maths
  scale8: u8fn("scale8", 4, scale8, 2),
  scale8_video: u8fn("scale8_video", 6, scale8Video, 2),
  scale16by8: fl("scale16by8", ["u16", "u8"], "u16", 12, ([i, s]) => scale16by8(i, s)),
  scale16: fl("scale16", ["u16", "u16"], "u16", 30, ([i, s]) => scale16(i, s) & 0xffff),
  qadd8: u8fn("qadd8", 3, qadd8, 2),
  qsub8: u8fn("qsub8", 3, qsub8, 2),
  qmul8: u8fn("qmul8", 6, qmul8, 2),
  add8: u8fn("add8", 2, (a, b) => a + b, 2),
  sub8: u8fn("sub8", 2, (a, b) => a - b, 2),
  mul8: u8fn("mul8", 4, (a, b) => a * b, 2),
  qadd7: fl("qadd7", ["int", "int"], "u8", 4, ([a, b]) => Math.max(-128, Math.min(127, s8(a) + s8(b))) & 255),
  avg8: u8fn("avg8", 3, (a, b) => (a + b) >> 1, 2),
  avg8r: u8fn("avg8r", 4, (a, b) => (a + b + 1) >> 1, 2),
  avg16: fl("avg16", ["u16", "u16"], "u16", 6, ([a, b]) => (a + b) >>> 1),
  avg16r: fl("avg16r", ["u16", "u16"], "u16", 8, ([a, b]) => (a + b + 1) >>> 1),
  avg7: fl("avg7", ["int", "int"], "u8", 5, ([a, b]) => ((s8(a) >> 1) + (s8(b) >> 1) + (a & b & 1)) & 255),
  avg15: fl("avg15", ["i16", "i16"], "i16", 8, ([a, b]) => s16((a >> 1) + (b >> 1) + (a & b & 1))),
  mod8: u8fn("mod8", 20, (a, m) => (m ? a % m : a), 2),
  addmod8: u8fn("addmod8", 22, (a, b, m) => (m ? ((a + b) & 255) % m : (a + b) & 255), 3),
  submod8: u8fn("submod8", 22, (a, b, m) => (m ? ((a - b) & 255) % m : (a - b) & 255), 3),
  abs8: fl("abs8", ["int"], "u8", 3, ([i]) => Math.abs(s8(i)) & 255),
  sqrt16: fl("sqrt16", ["u16"], "u8", 120, ([x]) => sqrt16(x)),
  blend8: u8fn("blend8", 12, blend8, 3),
  lerp8by8: u8fn("lerp8by8", 10, lerp8by8, 3),
  lerp16by16: fl("lerp16by16", ["u16", "u16", "u16"], "u16", 40, ([a, b, fr]) => lerp16by16(a, b, fr)),
  lerp16by8: fl("lerp16by8", ["u16", "u16", "u8"], "u16", 24, ([a, b, fr]) => (b > a ? a + scale16by8(b - a, fr) : a - scale16by8(a - b, fr)) & 0xffff),
  lerp15by8: fl("lerp15by8", ["i16", "i16", "u8"], "i16", 24, ([a, b, fr]) => s16(b > a ? a + scale16by8((b - a) & 0xffff, fr) : a - scale16by8((a - b) & 0xffff, fr))),
  map8: u8fn("map8", 8, (i, s, e) => scale8(i, (e - s) & 255) + s, 3),
  ease8InOutQuad: fl("ease8InOutQuad", ["u8"], "u8", 12, ([i], ctx) => easeQuad(ctx, i)),
  ease8InOutCubic: u8fn("ease8InOutCubic", 18, easeCubic),
  ease8InOutApprox: u8fn("ease8InOutApprox", 7, easeApprox),
  ease16InOutQuad: fl("ease16InOutQuad", ["u16"], "u16", 60, ([i]) => {
    let j = i & 0x8000 ? 65535 - i : i;
    j = (scale16(j, j) << 1) & 0xffff;
    return i & 0x8000 ? 65535 - j : j;
  }),
  triwave8: u8fn("triwave8", 4, triwave8),
  quadwave8: fl("quadwave8", ["u8"], "u8", 16, ([x], ctx) => easeQuad(ctx, triwave8(x))),
  cubicwave8: u8fn("cubicwave8", 22, (x) => easeCubic(triwave8(x))),
  squarewave8: u8fn("squarewave8", 4, (x, pw) => (x < pw || pw === 255 ? 255 : 0), 2, [128]),
  dim8_raw: u8fn("dim8_raw", 4, (x) => scale8(x, x)),
  dim8_video: u8fn("dim8_video", 6, (x) => scale8Video(x, x)),
  dim8_lin: u8fn("dim8_lin", 8, (x) => (x & 0x80 ? scale8(x, x) : (x + 1) >> 1)),
  brighten8_raw: u8fn("brighten8_raw", 6, (x) => 255 - scale8(255 - x, 255 - x)),
  brighten8_video: u8fn("brighten8_video", 8, (x) => 255 - scale8Video(255 - x, 255 - x)),
  brighten8_lin: u8fn("brighten8_lin", 10, (x) => {
    const ix = 255 - x;
    return 255 - (ix & 0x80 ? scale8(ix, ix) : (ix + 1) >> 1);
  }),
  sin8: u8fn("sin8", 20, sin8),
  cos8: u8fn("cos8", 22, (t) => sin8(t + 64)),
  sin16: fl("sin16", ["u16"], "i16", 40, ([t]) => sin16(t)),
  cos16: fl("cos16", ["u16"], "i16", 42, ([t]) => sin16(t + 16384)),
  // random numbers: the library's 16-bit generator from seed 1337
  random8: (args, ctx, pos) => {
    if (args.length === 0) return fl("random8", [], "u8", 12, (_v, cx) => random8(cx))(args, ctx, pos);
    if (args.length === 1) return fl("random8", ["u8"], "u8", 16, ([lim], cx) => (random8(cx) * lim) >> 8)(args, ctx, pos);
    return fl("random8", ["u8", "u8"], "u8", 20, ([lo, lim], cx) => (((random8(cx) * ((lim - lo) & 255)) >> 8) + lo) & 255)(args, ctx, pos);
  },
  random16: (args, ctx, pos) => {
    if (args.length === 0) return fl("random16", [], "u16", 10, (_v, cx) => rnd16(cx))(args, ctx, pos);
    if (args.length === 1) return fl("random16", ["u16"], "u16", 30, ([lim], cx) => Math.floor((lim * rnd16(cx)) / 65536))(args, ctx, pos);
    return fl("random16", ["u16", "u16"], "u16", 34, ([lo, lim], cx) => (Math.floor((((lim - lo) & 0xffff) * rnd16(cx)) / 65536) + lo) & 0xffff)(args, ctx, pos);
  },
  random16_set_seed: fl("random16_set_seed", ["u16"], "void", 4, ([s], ctx) => void (ctx.lib.fastled.seed = s)),
  random16_get_seed: fl("random16_get_seed", [], "u16", 4, (_v, ctx) => ctx.lib.fastled.seed),
  random16_add_entropy: fl("random16_add_entropy", ["u16"], "void", 4, ([e], ctx) => void (ctx.lib.fastled.seed = (ctx.lib.fastled.seed + e) & 0xffff)),
  // waves on the clock
  beat88: fl("beat88", ["u16", "u32"], "u16", 60, ([b, tb], ctx) => beat88(ctx, b, tb), [0]),
  beat16: fl("beat16", ["u16", "u32"], "u16", 62, ([b, tb], ctx) => beat16(ctx, b, tb), [0]),
  beat8: fl("beat8", ["u16", "u32"], "u8", 62, ([b, tb], ctx) => beat16(ctx, b, tb) >> 8, [0]),
  beatsin88: fl("beatsin88", ["u16", "u16", "u16", "u32", "u16"], "u16", 150, ([b, lo, hi, tb, ph], ctx) => (lo + scale16((sin16(beat88(ctx, b, tb) + ph) + 32768) & 0xffff, (hi - lo) & 0xffff)) & 0xffff, [0, 65535, 0, 0]),
  beatsin16: fl("beatsin16", ["u16", "u16", "u16", "u32", "u16"], "u16", 150, ([b, lo, hi, tb, ph], ctx) => (lo + scale16((sin16(beat16(ctx, b, tb) + ph) + 32768) & 0xffff, (hi - lo) & 0xffff)) & 0xffff, [0, 65535, 0, 0]),
  beatsin8: fl("beatsin8", ["u16", "u8", "u8", "u32", "u8"], "u8", 100, ([b, lo, hi, tb, ph], ctx) => (lo + scale8(sin8((beat16(ctx, b, tb) >> 8) + ph), (hi - lo) & 255)) & 255, [0, 255, 0, 0]),
  seconds16: fl("seconds16", [], "u16", 40, (_v, ctx) => clockOf(1, ms32(ctx))),
  minutes16: fl("minutes16", [], "u16", 40, (_v, ctx) => clockOf(3, ms32(ctx))),
  hours8: fl("hours8", [], "u8", 40, (_v, ctx) => clockOf(4, ms32(ctx))),
  bseconds16: fl("bseconds16", [], "u16", 30, (_v, ctx) => clockOf(2, ms32(ctx))),
  // filling and fading the LED array
  fill_solid: fillSolid,
  fill_rainbow: fillRainbow(false),
  fill_rainbow_circular: fillRainbow(true),
  fill_gradient: fillGradient,
  fill_gradient_RGB: fillGradientRgb,
  fadeToBlackBy: scaleLeds("fadeToBlackBy", nscale8x3, (x) => 255 - x, 18),
  fade_raw: scaleLeds("fade_raw", nscale8x3, (x) => 255 - x, 18),
  nscale8: scaleLeds("nscale8", nscale8x3, (x) => x, 18),
  nscale8_raw: scaleLeds("nscale8_raw", nscale8x3, (x) => x, 18),
  fadeLightBy: scaleLeds("fadeLightBy", nscale8x3Video, (x) => 255 - x, 24),
  fade_video: scaleLeds("fade_video", nscale8x3Video, (x) => 255 - x, 24),
  nscale8_video: scaleLeds("nscale8_video", nscale8x3Video, (x) => x, 24),
  fadeUsingColor: fl("fadeUsingColor", ["leds", "u16", "rgb"], "void", 20, ([p, n, m], ctx, pos) => ledLoop("fadeUsingColor")(ctx, pos, p, n, (px) => setPx(px, [scale8(px[0], m[0]), scale8(px[1], m[1]), scale8(px[2], m[2])]), 18)),
  blur1d: blurFn,
  blend: (args, ctx, pos) => {
    included(ctx, "blend()", pos);
    if (args.length === 5)
      return fl("blend", ["leds", "leds", "leds", "u16", "u8"], "void", 20, ([a, b, d, n, amt], cx, ps) =>
        ledLoop("blend")(cx, ps, d, n, (px, i) => {
          const x = ((a as Ptr).m[(a as Ptr).i + i] as Px) ?? [0, 0, 0];
          const y = ((b as Ptr).m[(b as Ptr).i + i] as Px) ?? [0, 0, 0];
          setPx(px, amt === 0 ? x : amt === 255 ? y : [blend8(x[0], y[0], amt), blend8(x[1], y[1], amt), blend8(x[2], y[2], amt)]);
        }, 40),
      )(args, ctx, pos);
    return fl("blend", ["rgb", "rgb", "u8"], "CRGB", 40, ([a, b, amt]) => (amt === 0 ? a.slice() : amt === 255 ? b.slice() : [blend8(a[0], b[0], amt), blend8(a[1], b[1], amt), blend8(a[2], b[2], amt)]))(args, ctx, pos);
  },
  nblend: nblendFn,
  HeatColor: fl("HeatColor", ["u8"], "CRGB", 30, ([t]) => heatColor(t)),
  hsv2rgb_rainbow: hsv2rgbFn,
  // palettes
  ColorFromPalette: fl("ColorFromPalette", ["pal", "u8", "u8", "u8"], "CRGB", 70, ([p, i, b, bl]) => colorFromPalette(p, i, b, bl), [255, 1]),
  fill_palette: fl(
    "fill_palette",
    ["leds", "u16", "u8", "u8", "pal", "u8", "u8"],
    "void",
    30,
    ([p, n, start, inc, pal, br, bl], ctx, pos) => {
      let idx = start;
      ledLoop("fill_palette")(ctx, pos, p, n, (px) => {
        setPx(px, colorFromPalette(pal, idx, br, bl));
        idx = (idx + inc) & 255;
      }, 80);
    },
    [255, 1],
  ),
  fill_palette_circular: fl(
    "fill_palette_circular",
    ["leds", "u16", "u8", "pal", "u8", "u8", "bool"],
    "void",
    40,
    ([p, n, start, pal, br, bl, rev], ctx, pos) => {
      if (n === 0) return;
      const change = Math.floor(65535 / n);
      let idx = (start << 8) & 0xffff;
      ledLoop("fill_palette_circular")(ctx, pos, p, n, (px) => {
        setPx(px, colorFromPalette(pal, idx >> 8, br, bl));
        idx = (rev ? idx - change : idx + change) & 0xffff;
      }, 84);
    },
    [255, 1, 0],
  ),
  nblendPaletteTowardPalette: fl("nblendPaletteTowardPalette", ["palref", "palref", "u8"], "void", 40, ([cur, tgt, max], ctx) => {
    const a = (cur as Px[][])[0];
    const b = (tgt as Px[][])[0];
    let changes = 0;
    let steps = 0;
    outer: for (let k = 0; k < 16; k++)
      for (let ch = 0; ch < 3; ch++) {
        steps++;
        if (a[k][ch] === b[k][ch]) continue;
        if (a[k][ch] < b[k][ch]) {
          a[k][ch]++;
          changes++;
        }
        if (a[k][ch] > b[k][ch]) {
          a[k][ch]--;
          changes++;
          if (a[k][ch] > b[k][ch]) a[k][ch]--;
        }
        if (changes >= max) break outer;
      }
    burn(ctx.hal, cy(ctx, 10) * steps);
  }),
  // the power limit
  calculate_unscaled_power_mW: fl("calculate_unscaled_power_mW", ["leds", "u16"], "u32", 40, ([p, n], ctx) => (burn(ctx.hal, cy(ctx, 12) * n), unscaledMw(p, n))),
  calculate_max_brightness_for_power_mW: (args, ctx, pos) => {
    if (args.length === 2) return fl("calculate_max_brightness_for_power_mW", ["u8", "u32"], "u8", 200, ([t, mw], cx) => maxBrightness(cx, t, mw))(args, ctx, pos);
    return fl("calculate_max_brightness_for_power_mW", ["leds", "u16", "u8", "u32"], "u8", 200, ([p, n, t, mw]) => {
      const req = Math.floor((unscaledMw(p, n) * t) / 256);
      return req > mw ? Math.floor((t * mw) / req) & 255 : t;
    })(args, ctx, pos);
  },
  calculate_max_brightness_for_power_vmA: fl("calculate_max_brightness_for_power_vmA", ["leds", "u16", "u8", "u32", "u32"], "u8", 200, ([p, n, t, v, ma]) => {
    const mw = (v * ma) >>> 0;
    const req = Math.floor((unscaledMw(p, n) * t) / 256);
    return req > mw ? Math.floor((t * mw) / req) & 255 : t;
  }),
  set_max_power_in_volts_and_milliamps: fl("set_max_power_in_volts_and_milliamps", ["u8", "u32"], "void", 20, ([v, ma], ctx) => void (ctx.lib.fastled.powerMw = (v * ma) >>> 0)),
  set_max_power_in_milliwatts: fl("set_max_power_in_milliwatts", ["u32"], "void", 10, ([mw], ctx) => void (ctx.lib.fastled.powerMw = mw >>> 0)),
  set_max_power_indicator_LED: fl("set_max_power_indicator_LED", ["u8"], "void", 10, ([pin], ctx) => {
    ctx.lib.fastled.powerPin = pin;
    if (pin) ctx.hal.pinMode(pin, 1);
  }),
  show_at_max_brightness_for_power: fl("show_at_max_brightness_for_power", [], "void", 40, (_v, ctx) => showAll(ctx, ctx.lib.fastled.scale)),
  delay_at_max_brightness_for_power: (args, ctx, pos) => fastLedObject.delay(args, ctx, pos),
};

export const FASTLED_FUNCS: Record<string, LibFn> = dict(flFuncs);

/** FastLED itself, and its palettes in flash (RainbowColors_p, a TProgmemRGBPalette16: 16 colour codes) */
export const FASTLED_OBJECTS: Record<string, Record<string, LibFn>> = dict<Record<string, LibFn>>({
  FastLED: fastLedObject,
  ...Object.fromEntries(
    Object.entries(PALETTES).map(([name, codes]) => [
      name,
      dict<LibFn>({
        "@value": (_a, ctx, pos) => {
          included(ctx, name, pos);
          return { t: { k: "arr", of: ctx.T.ulong, n: 16 }, ev: () => codes.slice(), cost: 2, pos };
        },
      }),
    ]),
  ),
  RainbowStripesColors_p: dict<LibFn>({ "@value": (_a, ctx, pos) => ({ t: { k: "arr", of: ctx.T.ulong, n: 16 }, ev: () => PALETTES.RainbowStripeColors_p.slice(), cost: 2, pos }) }),
});

export const FASTLED_CLASSES: Record<string, LibClass> = dict<LibClass>({
  CLEDController: controllerClass,
  CEveryNMillis: everyClass("CEveryNMillis", 0),
  CEveryNSeconds: everyClass("CEveryNSeconds", 1),
  CEveryNBSeconds: everyClass("CEveryNBSeconds", 2),
  CEveryNMinutes: everyClass("CEveryNMinutes", 3),
  CEveryNHours: everyClass("CEveryNHours", 4),
});

/** CRGB::Red and the other HTML colour names, as 0xRRGGBB codes */
export const FASTLED_SCOPED: Record<string, LibFn> = dict<LibFn>(
  Object.fromEntries(
    [...COLOURS].map(([name, v]) => [
      `CRGB::${name}`,
      ((_a, ctx, pos) => {
        included(ctx, `CRGB::${name}`, pos);
        return { t: ctx.T.ulong, ev: () => v, cost: 0, cv: v, pos };
      }) as LibFn,
    ]),
  ),
);

/** member functions that take template arguments (FastLED.addLeds<WS2812B, 6, GRB>) */
export const FASTLED_TEMPLATED = new Set(["addLeds"]);
