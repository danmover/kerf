// Character LCD libraries, ported from their source: Arduino's LiquidCrystal (the module's pins driven one by one,
// in 4- or 8-bit mode) and LiquidCrystal_I2C (Frank de Brabander's, through a PCF8574 backpack on Wire). Each sends
// the bytes the real library sends with the same waits, so the LCD (src/sim/engine/lcd.ts) sees the same edges on E
// and takes the same time: about 0.3 ms a character on the pins, about 1.3 ms through the backpack at 100 kHz.

import type { Pos } from "./ast";
import type { C, Ctx } from "./ir";
import { argCount, burn, decay, dict, method, numEv, pointee, ptrEv, sumCost, type LibClass, type LibFn, type LibMethod } from "./libBase";
import { printMethods } from "./libPrint";
import { readBytes } from "./mem";
import type { Hal, Ptr } from "./vm";

// the commands and flags, as LiquidCrystal.h defines them
const CLEAR = 0x01;
const HOME = 0x02;
const ENTRY = 0x04;
const CONTROL = 0x08;
const SHIFT = 0x10;
const FUNCTION = 0x20;
const CGRAM = 0x40;
const DDRAM = 0x80;
const ENTRY_LEFT = 0x02;
const ENTRY_SHIFT = 0x01;
const DISPLAY_ON = 0x04;
const CURSOR_ON = 0x02;
const BLINK_ON = 0x01;
const DISPLAY_MOVE = 0x08;
const MOVE_RIGHT = 0x04;
const EIGHT_BIT = 0x10;
const TWO_LINE = 0x08;
const DOTS_5X10 = 0x04;
const BACKLIGHT = 0x08;
const EN = 0x04;
const RS = 0x01;

export interface LcdObj {
  kind: "lcd";
  /** a PCF8574 backpack's address, or -1 for the pins */
  addr: number;
  rs: number;
  rw: number;
  en: number;
  data: number[];
  func: number;
  control: number;
  mode: number;
  cols: number;
  lines: number;
  rowOffsets: number[];
  backlight: number;
  /** the backpack did not answer */
  nack?: boolean;
  said: Set<string>;
}

const objOf = (obj: C) => (obj.lv ? obj.lv.get : obj.ev) as (f: unknown[]) => unknown;

/** a library digitalWrite: the pin changes and the call takes its time (about 3.5 µs on the AVR's core) */
function pinWrite(hal: Hal, pin: number, v: number) {
  hal.digitalWrite(pin, v);
  burn(hal, hal.arch === "esp32" ? 30 : 56);
}

const us = (hal: Hal, n: number) => hal.spend((n * hal.fcpu) / 1e6);

function say(ctx: Ctx, o: LcdObj, msg: string) {
  if (o.said.has(msg)) return;
  o.said.add(msg);
  ctx.hal.fault(msg, "firmware", 0);
}

// ---------- the bytes on the wire ----------

function expanderWrite(ctx: Ctx, o: LcdObj, v: number) {
  burn(ctx.hal, 120);
  const st = ctx.hal.wireWrite(o.addr, [(v | o.backlight) & 0xff], true);
  // 4: Wire was never started (Frank de Brabander's begin() does not start it; init() does)
  if (st === 4) say(ctx, o, `LiquidCrystal_I2C: Wire was not started, so nothing reaches the LCD. Call lcd.init() (it calls Wire.begin() and sets the LCD up) instead of lcd.begin(), or Wire.begin() before it`);
  else if (st !== 0 && !o.nack) {
    o.nack = true;
    say(
      ctx,
      o,
      `LiquidCrystal_I2C: nothing answered at address 0x${o.addr.toString(16).toUpperCase()}, so the LCD shows nothing (a row of blocks, or a blank screen). Backpacks come at 0x27 (PCF8574T) or 0x3F (PCF8574AT), and at 0x20 to 0x27 with their A0 to A2 pads bridged: run an I2C scanner sketch to find yours`,
    );
  }
}

function pulseI2c(ctx: Ctx, o: LcdObj, v: number) {
  expanderWrite(ctx, o, v | EN);
  us(ctx.hal, 1);
  expanderWrite(ctx, o, v & ~EN);
  us(ctx.hal, 50);
}

function pulsePins(hal: Hal, o: LcdObj) {
  pinWrite(hal, o.en, 0);
  us(hal, 1);
  pinWrite(hal, o.en, 1);
  us(hal, 1);
  pinWrite(hal, o.en, 0);
  us(hal, 100);
}

function bits(hal: Hal, o: LcdObj, v: number, n: number) {
  for (let i = 0; i < n; i++) pinWrite(hal, o.data[i], (v >> i) & 1);
  pulsePins(hal, o);
}

/** LiquidCrystal_I2C::write4bits(): the nibble in the top four bits, with RS in bit 0 */
function nibbleI2c(ctx: Ctx, o: LcdObj, v: number) {
  expanderWrite(ctx, o, v);
  pulseI2c(ctx, o, v);
}

function send(ctx: Ctx, o: LcdObj, value: number, mode: number) {
  const hal = ctx.hal;
  value &= 0xff;
  if (o.addr >= 0) {
    nibbleI2c(ctx, o, (value & 0xf0) | mode);
    nibbleI2c(ctx, o, ((value << 4) & 0xf0) | mode);
    return;
  }
  pinWrite(hal, o.rs, mode);
  if (o.rw >= 0) pinWrite(hal, o.rw, 0);
  if (o.func & EIGHT_BIT) bits(hal, o, value, 8);
  else {
    bits(hal, o, value >> 4, 4);
    bits(hal, o, value, 4);
  }
}

const command = (ctx: Ctx, o: LcdObj, v: number) => send(ctx, o, v, 0);

function begin(ctx: Ctx, o: LcdObj, cols: number, lines: number, dots: number) {
  const hal = ctx.hal;
  if (lines > 1) o.func |= TWO_LINE;
  o.lines = lines;
  o.cols = cols;
  if (o.addr < 0) o.rowOffsets = [0x00, 0x40, cols, 0x40 + cols];
  if (dots && lines === 1) o.func |= DOTS_5X10;
  if (o.addr >= 0) {
    // LiquidCrystal_I2C::begin(): 50 ms for the LCD's own reset, then the backpack reset with the backlight off
    hal.delayMs ? hal.delayMs(50) : us(hal, 50_000);
    expanderWrite(ctx, o, o.backlight);
    hal.delayMs ? hal.delayMs(1000) : us(hal, 1_000_000);
    nibbleI2c(ctx, o, 0x03 << 4);
    us(hal, 4500);
    nibbleI2c(ctx, o, 0x03 << 4);
    us(hal, 4500);
    nibbleI2c(ctx, o, 0x03 << 4);
    us(hal, 150);
    nibbleI2c(ctx, o, 0x02 << 4);
  } else {
    hal.pinMode(o.rs, 1);
    if (o.rw >= 0) hal.pinMode(o.rw, 1);
    hal.pinMode(o.en, 1);
    for (let i = 0; i < (o.func & EIGHT_BIT ? 8 : 4); i++) hal.pinMode(o.data[i], 1);
    us(hal, 50_000);
    pinWrite(hal, o.rs, 0);
    pinWrite(hal, o.en, 0);
    if (o.rw >= 0) pinWrite(hal, o.rw, 0);
    if (!(o.func & EIGHT_BIT)) {
      bits(hal, o, 0x03, 4);
      us(hal, 4500);
      bits(hal, o, 0x03, 4);
      us(hal, 4500);
      bits(hal, o, 0x03, 4);
      us(hal, 150);
      bits(hal, o, 0x02, 4);
    } else {
      command(ctx, o, FUNCTION | o.func);
      us(hal, 4500);
      command(ctx, o, FUNCTION | o.func);
      us(hal, 150);
      command(ctx, o, FUNCTION | o.func);
    }
  }
  command(ctx, o, FUNCTION | o.func);
  o.control = DISPLAY_ON;
  command(ctx, o, CONTROL | o.control);
  clear(ctx, o);
  o.mode = ENTRY_LEFT;
  command(ctx, o, ENTRY | o.mode);
  // LiquidCrystal_I2C ends with home(); LiquidCrystal does not
  if (o.addr >= 0) home(ctx, o);
}

function clear(ctx: Ctx, o: LcdObj) {
  command(ctx, o, CLEAR);
  us(ctx.hal, 2000);
}

function home(ctx: Ctx, o: LcdObj) {
  command(ctx, o, HOME);
  us(ctx.hal, 2000);
}

function setCursor(ctx: Ctx, o: LcdObj, col: number, row: number) {
  if (o.addr >= 0) {
    // LiquidCrystal_I2C keeps the 20 × 4 offsets for every size, and lets row == lines through
    if (row > o.lines) row = o.lines - 1;
    command(ctx, o, DDRAM | (col + [0x00, 0x40, 0x14, 0x54][row & 3]));
    return;
  }
  if (row >= 4) row = 3;
  if (row >= o.lines) row = o.lines - 1;
  command(ctx, o, DDRAM | (col + o.rowOffsets[Math.max(0, row)]));
}

const flag = (field: "control" | "mode", bit: number, on: boolean, cmd: number) => (ctx: Ctx, o: LcdObj) => {
  o[field] = on ? o[field] | bit : o[field] & ~bit;
  command(ctx, o, cmd | o[field]);
};

function createChar(ctx: Ctx, o: LcdObj, loc: number, rows: number[]) {
  command(ctx, o, CGRAM | ((loc & 7) << 3));
  for (let i = 0; i < 8; i++) send(ctx, o, rows[i] ?? 0, RS);
}

function setBacklight(ctx: Ctx, o: LcdObj, on: boolean) {
  o.backlight = on ? BACKLIGHT : 0;
  expanderWrite(ctx, o, 0);
}

// ---------- the classes ----------

function newLcd(addr: number): LcdObj {
  return { kind: "lcd", addr, rs: -1, rw: -1, en: -1, data: [], func: 0, control: 0, mode: 0, cols: 16, lines: 1, rowOffsets: [0x00, 0x40, 0x10, 0x50], backlight: 0, said: new Set() };
}

/** LiquidCrystal(rs, [rw,] enable, d0, d1, d2, d3 [, d4, d5, d6, d7]) */
const constructPins: LibFn = (args, ctx, pos) => {
  const n = args.length;
  if (![6, 7, 10, 11].includes(n)) argCount("LiquidCrystal", 6, 11, n, ctx, pos);
  const A = args.map((a) => numEv(a, ctx.T.uchar, ctx, "LiquidCrystal()"));
  const withRw = n === 7 || n === 11;
  const t = { k: "class" as const, name: "LiquidCrystal" };
  return {
    t,
    ev: (f) => {
      const v = A.map((a) => a(f) as number);
      const o = newLcd(-1);
      o.rs = v[0];
      o.rw = withRw ? v[1] : -1;
      o.en = v[withRw ? 2 : 1];
      o.data = v.slice(withRw ? 3 : 2);
      o.func = o.data.length === 8 ? EIGHT_BIT : 0;
      // the constructor's own begin(16, 1) runs before setup(); the sketch's lcd.begin() sets the module up again
      return o;
    },
    cost: sumCost(args) + 60,
    pos,
  };
};

/** LiquidCrystal_I2C(address, cols, rows) */
const constructI2c: LibFn = (args, ctx, pos) => {
  if (args.length !== 3) argCount("LiquidCrystal_I2C", 3, 3, args.length, ctx, pos);
  const [A, Cc, R] = args.map((a) => numEv(a, ctx.T.uchar, ctx, "LiquidCrystal_I2C()"));
  return {
    t: { k: "class", name: "LiquidCrystal_I2C" },
    ev: (f) => {
      const o = newLcd((A(f) as number) & 0x7f);
      o.cols = Cc(f) as number;
      o.lines = R(f) as number;
      return o;
    },
    cost: sumCost(args) + 40,
    pos,
  };
};

function lcdMethods(cls: string): Record<string, LibMethod> {
  const m = (name: string, params: Parameters<typeof method>[2], cyc: number, run: (o: LcdObj, v: number[], ctx: Ctx, pos: Pos) => unknown, defaults: unknown[] = [], ret: Parameters<typeof method>[3] = "void") =>
    method<LcdObj>(cls, name, params, ret, cyc, run, defaults);
  const simple = (name: string, run: (ctx: Ctx, o: LcdObj) => void) => m(name, [], 40, (o, _v, ctx) => run(ctx, o));
  const out: Record<string, LibMethod> = {
    ...printMethods(
      cls,
      (obj, bytes, ctx) => {
        const o = obj as LcdObj;
        if (bytes.includes(10) || bytes.includes(13)) say(ctx, o, `${cls}.println() sends the carriage return and newline to the LCD as two more characters, which show as junk after the text. Use print() and setCursor(0, row) to start a new line`);
        for (const b of bytes) send(ctx, o, b, RS);
        return bytes.length;
      },
      (obj) => objOf(obj),
    ),
    begin: m(
      "begin",
      ["u8", "u8", "u8"],
      200,
      (o, [cols, lines, dots], ctx) => begin(ctx, o, cols, lines, dots),
      [0],
    ),
    clear: simple("clear", clear),
    home: simple("home", home),
    setCursor: m("setCursor", ["u8", "u8"], 60, (o, [c, r], ctx) => setCursor(ctx, o, c, r)),
    noDisplay: simple("noDisplay", flag("control", DISPLAY_ON, false, CONTROL)),
    display: simple("display", flag("control", DISPLAY_ON, true, CONTROL)),
    noCursor: simple("noCursor", flag("control", CURSOR_ON, false, CONTROL)),
    cursor: simple("cursor", flag("control", CURSOR_ON, true, CONTROL)),
    noBlink: simple("noBlink", flag("control", BLINK_ON, false, CONTROL)),
    blink: simple("blink", flag("control", BLINK_ON, true, CONTROL)),
    scrollDisplayLeft: simple("scrollDisplayLeft", (ctx, o) => command(ctx, o, SHIFT | DISPLAY_MOVE)),
    scrollDisplayRight: simple("scrollDisplayRight", (ctx, o) => command(ctx, o, SHIFT | DISPLAY_MOVE | MOVE_RIGHT)),
    leftToRight: simple("leftToRight", flag("mode", ENTRY_LEFT, true, ENTRY)),
    rightToLeft: simple("rightToLeft", flag("mode", ENTRY_LEFT, false, ENTRY)),
    autoscroll: simple("autoscroll", flag("mode", ENTRY_SHIFT, true, ENTRY)),
    noAutoscroll: simple("noAutoscroll", flag("mode", ENTRY_SHIFT, false, ENTRY)),
    command: m("command", ["u8"], 40, (o, [v], ctx) => command(ctx, o, v)),
    createChar: (obj, args, ctx, pos) => {
      if (args.length !== 2) argCount(`${cls}.createChar`, 2, 2, args.length, ctx, pos);
      const O = objOf(obj);
      const L = numEv(args[0], ctx.T.uchar, ctx, `${cls}.createChar()`);
      const P = ptrEv(decay(args[1]), ctx, `${cls}.createChar()`);
      const el = pointee(args[1]);
      return {
        t: { k: "void" },
        ev: (f) => createChar(ctx, O(f) as LcdObj, L(f) as number, readBytes(P(f) as Ptr, el, 8, ctx.abi)),
        cost: sumCost(args) + 60,
        pos,
      };
    },
  };
  if (cls === "LiquidCrystal") out.setRowOffsets = m("setRowOffsets", ["int", "int", "int", "int"], 20, (o, v) => (o.rowOffsets = v.slice(0, 4)));
  else {
    const init = m("init", [], 200, (o, _v, ctx) => {
      ctx.hal.wireBegin();
      o.func = 0;
      begin(ctx, o, o.cols, o.lines, 0);
    });
    Object.assign(out, {
      init,
      backlight: simple("backlight", (ctx, o) => setBacklight(ctx, o, true)),
      noBacklight: simple("noBacklight", (ctx, o) => setBacklight(ctx, o, false)),
      setBacklight: m("setBacklight", ["u8"], 40, (o, [v], ctx) => setBacklight(ctx, o, v !== 0)),
      cursor_on: simple("cursor_on", flag("control", CURSOR_ON, true, CONTROL)),
      cursor_off: simple("cursor_off", flag("control", CURSOR_ON, false, CONTROL)),
      blink_on: simple("blink_on", flag("control", BLINK_ON, true, CONTROL)),
      blink_off: simple("blink_off", flag("control", BLINK_ON, false, CONTROL)),
      load_custom_character: out.createChar,
      printstr: out.print,
    });
  }
  return out;
}

export const liquidCrystalClass: LibClass = { construct: constructPins, methods: dict(lcdMethods("LiquidCrystal")) };
export const liquidCrystalI2cClass: LibClass = { construct: constructI2c, methods: dict(lcdMethods("LiquidCrystal_I2C")) };
