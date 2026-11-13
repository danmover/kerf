// A character LCD as its HD44780 controller runs it: the 80-character display RAM and the eight characters of
// character-generator RAM the firmware fills, the instructions it latches on each falling edge of E (8 bits at a
// time, or 4 after the firmware switches it), the time each one takes (37 µs, 1.52 ms to clear) and the font in
// its ROM (the A00 one: ASCII, except ¥ for a backslash and arrows at 0x7E and 0x7F). It draws what the glass
// shows, dot for dot: a cursor, a blinking block, the display shifted, and the row of solid blocks a module shows
// on its top line until the firmware sets it up for two lines. The PCF8574 I2C backpack that most modules carry
// sits in front of it: each byte the firmware writes sets its eight pins, wired to RS, RW, E, the backlight and
// D4 to D7.

import type { DisplayFrame } from "./devices";
import type { I2CDevice } from "./hal";

/** one picture of the glass, with how bright the backlight was */
export interface LcdFrame extends DisplayFrame {
  light: number;
}

/** keep at most this many frames: past it, every other one goes and the gap between frames doubles */
const FRAMES_MAX = 3000;
/** the HD44780 at its typical 270 kHz clock: most instructions take 37 µs, clear and home 1.52 ms */
export const HD44780_US = { cmd: 37, clear: 1520, data: 41 };
/** the cursor blinks every 409.6 ms */
const BLINK_S = 0.4096;

// The ROM's characters 0x20 to 0x7F, five columns each, bit 0 at the top (the 8th row is the cursor's).
// prettier-ignore
const FONT: number[][] = [
  [0x00, 0x00, 0x00, 0x00, 0x00], [0x00, 0x00, 0x5F, 0x00, 0x00], [0x00, 0x07, 0x00, 0x07, 0x00], [0x14, 0x7F, 0x14, 0x7F, 0x14],
  [0x24, 0x2A, 0x7F, 0x2A, 0x12], [0x23, 0x13, 0x08, 0x64, 0x62], [0x36, 0x49, 0x55, 0x22, 0x50], [0x00, 0x05, 0x03, 0x00, 0x00],
  [0x00, 0x1C, 0x22, 0x41, 0x00], [0x00, 0x41, 0x22, 0x1C, 0x00], [0x08, 0x2A, 0x1C, 0x2A, 0x08], [0x08, 0x08, 0x3E, 0x08, 0x08],
  [0x00, 0x50, 0x30, 0x00, 0x00], [0x08, 0x08, 0x08, 0x08, 0x08], [0x00, 0x60, 0x60, 0x00, 0x00], [0x20, 0x10, 0x08, 0x04, 0x02],
  [0x3E, 0x51, 0x49, 0x45, 0x3E], [0x00, 0x42, 0x7F, 0x40, 0x00], [0x42, 0x61, 0x51, 0x49, 0x46], [0x21, 0x41, 0x45, 0x4B, 0x31],
  [0x18, 0x14, 0x12, 0x7F, 0x10], [0x27, 0x45, 0x45, 0x45, 0x39], [0x3C, 0x4A, 0x49, 0x49, 0x30], [0x01, 0x71, 0x09, 0x05, 0x03],
  [0x36, 0x49, 0x49, 0x49, 0x36], [0x06, 0x49, 0x49, 0x29, 0x1E], [0x00, 0x36, 0x36, 0x00, 0x00], [0x00, 0x56, 0x36, 0x00, 0x00],
  [0x00, 0x08, 0x14, 0x22, 0x41], [0x14, 0x14, 0x14, 0x14, 0x14], [0x41, 0x22, 0x14, 0x08, 0x00], [0x02, 0x01, 0x51, 0x09, 0x06],
  [0x32, 0x49, 0x79, 0x41, 0x3E], [0x7E, 0x11, 0x11, 0x11, 0x7E], [0x7F, 0x49, 0x49, 0x49, 0x36], [0x3E, 0x41, 0x41, 0x41, 0x22],
  [0x7F, 0x41, 0x41, 0x22, 0x1C], [0x7F, 0x49, 0x49, 0x49, 0x41], [0x7F, 0x09, 0x09, 0x01, 0x01], [0x3E, 0x41, 0x41, 0x51, 0x32],
  [0x7F, 0x08, 0x08, 0x08, 0x7F], [0x00, 0x41, 0x7F, 0x41, 0x00], [0x20, 0x40, 0x41, 0x3F, 0x01], [0x7F, 0x08, 0x14, 0x22, 0x41],
  [0x7F, 0x40, 0x40, 0x40, 0x40], [0x7F, 0x02, 0x04, 0x02, 0x7F], [0x7F, 0x04, 0x08, 0x10, 0x7F], [0x3E, 0x41, 0x41, 0x41, 0x3E],
  [0x7F, 0x09, 0x09, 0x09, 0x06], [0x3E, 0x41, 0x51, 0x21, 0x5E], [0x7F, 0x09, 0x19, 0x29, 0x46], [0x46, 0x49, 0x49, 0x49, 0x31],
  [0x01, 0x01, 0x7F, 0x01, 0x01], [0x3F, 0x40, 0x40, 0x40, 0x3F], [0x1F, 0x20, 0x40, 0x20, 0x1F], [0x7F, 0x20, 0x18, 0x20, 0x7F],
  [0x63, 0x14, 0x08, 0x14, 0x63], [0x03, 0x04, 0x78, 0x04, 0x03], [0x61, 0x51, 0x49, 0x45, 0x43], [0x00, 0x7F, 0x41, 0x41, 0x00],
  [0x15, 0x16, 0x7C, 0x16, 0x15], [0x00, 0x41, 0x41, 0x7F, 0x00], [0x04, 0x02, 0x01, 0x02, 0x04], [0x40, 0x40, 0x40, 0x40, 0x40],
  [0x00, 0x01, 0x02, 0x04, 0x00], [0x20, 0x54, 0x54, 0x54, 0x78], [0x7F, 0x48, 0x44, 0x44, 0x38], [0x38, 0x44, 0x44, 0x44, 0x20],
  [0x38, 0x44, 0x44, 0x48, 0x7F], [0x38, 0x54, 0x54, 0x54, 0x18], [0x08, 0x7E, 0x09, 0x01, 0x02], [0x08, 0x14, 0x54, 0x54, 0x3C],
  [0x7F, 0x08, 0x04, 0x04, 0x78], [0x00, 0x44, 0x7D, 0x40, 0x00], [0x20, 0x40, 0x44, 0x3D, 0x00], [0x00, 0x7F, 0x10, 0x28, 0x44],
  [0x00, 0x41, 0x7F, 0x40, 0x00], [0x7C, 0x04, 0x18, 0x04, 0x78], [0x7C, 0x08, 0x04, 0x04, 0x78], [0x38, 0x44, 0x44, 0x44, 0x38],
  [0x7C, 0x14, 0x14, 0x14, 0x08], [0x08, 0x14, 0x14, 0x18, 0x7C], [0x7C, 0x08, 0x04, 0x04, 0x08], [0x48, 0x54, 0x54, 0x54, 0x20],
  [0x04, 0x3F, 0x44, 0x40, 0x20], [0x3C, 0x40, 0x40, 0x20, 0x7C], [0x1C, 0x20, 0x40, 0x20, 0x1C], [0x3C, 0x40, 0x30, 0x40, 0x3C],
  [0x44, 0x28, 0x10, 0x28, 0x44], [0x0C, 0x50, 0x50, 0x50, 0x3C], [0x44, 0x64, 0x54, 0x4C, 0x44], [0x00, 0x08, 0x36, 0x41, 0x00],
  [0x00, 0x00, 0x7F, 0x00, 0x00], [0x00, 0x41, 0x36, 0x08, 0x00], [0x08, 0x08, 0x2A, 0x1C, 0x08], [0x08, 0x1C, 0x2A, 0x08, 0x08],
];

/** rows of a ROM character, bit 4 the leftmost dot: the A00 ROM's own above 0x7F where sketches use them */
const HIGH_ROM: Record<number, number[]> = {
  // ° (sketches print it as (char)223)
  0xdf: [0x1c, 0x14, 0x1c, 0, 0, 0, 0, 0],
  // µ and Ω
  0xe4: [0, 0, 0x11, 0x11, 0x13, 0x1d, 0x10, 0x10],
  0xf4: [0, 0x0e, 0x11, 0x11, 0x11, 0x0a, 0x1b, 0],
  // the full block
  0xff: [0x1f, 0x1f, 0x1f, 0x1f, 0x1f, 0x1f, 0x1f, 0x1f],
};

const glyphCache = new Map<number, number[]>();
const fmtV = (v: number) => (Math.round(v * 10) / 10).toString();

/** the eight rows of a ROM character, bit 4 the leftmost dot */
export function romGlyph(code: number): number[] {
  const hit = glyphCache.get(code);
  if (hit) return hit;
  let rows = [0, 0, 0, 0, 0, 0, 0, 0];
  if (code >= 0x20 && code < 0x80) {
    const cols = FONT[code - 0x20];
    rows = rows.map((_, r) => cols.reduce((m, col, c) => m | (((col >> r) & 1) << (4 - c)), 0));
  } else if (HIGH_ROM[code]) rows = HIGH_ROM[code].slice();
  glyphCache.set(code, rows);
  return rows;
}

const HIGH_TEXT: Record<number, string> = { 0xdf: "°", 0xe4: "µ", 0xf4: "Ω", 0xff: "█" };

/** how a character code looks, as text: the ROM's own where it is not ASCII, a box for the eight custom ones */
export function glyphText(code: number): string {
  if (code < 0x10) return "□";
  if (code === 0x5c) return "¥";
  if (code === 0x7e) return "→";
  if (code === 0x7f) return "←";
  if (code < 0x20 || code >= 0x80) return HIGH_TEXT[code] ?? " ";
  return String.fromCharCode(code);
}

export class Hd44780 {
  readonly w: number;
  readonly h: number;
  frames: LcdFrame[] = [];
  /** told about mistakes the module would show as a blank or garbled screen */
  warn?: (msg: string) => void;
  /** volts on its supply pin */
  vdd: () => number = () => 5;
  /** the backlight's brightness, 0 to 1 */
  light: () => number = () => 1;
  ddram = new Uint8Array(0x80).fill(0x20);
  cgram = new Uint8Array(64);
  /** every instruction and character it took over the run */
  writes = 0;
  /** how the glass looks: its text and backlight colours */
  color = "white_on_blue";
  // the registers
  private eightBit = true;
  private twoLine = false;
  private on = false;
  private cursor = false;
  private blink = false;
  private inc = true;
  private shiftOnWrite = false;
  private ac = 0;
  private toCg = false;
  private shift = 0;
  /** 4-bit mode: the high half of a byte waiting for its low half */
  private nibble: number | null = null;
  private busyTo = 0;
  private powered = false;
  /** the cycle its supply came up: it takes nothing for the 40 ms its own reset runs */
  private upAt = 0;
  private faint = false;
  private dirty = true;
  private lastSnap = -Infinity;
  private gap = 0.05;
  private lastLight = -1;
  private lastBlink = -1;

  constructor(
    public name: string,
    public cols: number,
    public rows: number,
    private fcpu: number,
  ) {
    // cells of 5 × 8 dots with a dot's gap between them
    this.w = cols * 6;
    this.h = rows * 9;
  }

  /** the reset it runs as its supply comes up: 8 bits, one line, display off, cleared, moving right */
  private reset() {
    this.eightBit = true;
    this.twoLine = false;
    this.on = false;
    this.cursor = false;
    this.blink = false;
    this.inc = true;
    this.shiftOnWrite = false;
    this.ac = 0;
    this.toCg = false;
    this.shift = 0;
    this.nibble = null;
    this.ddram.fill(0x20);
    this.dirty = true;
  }

  private alive(cyc: number): boolean {
    const v = this.vdd();
    if (v < 2.7) {
      this.powered = false;
      return false;
    }
    if (!this.powered) {
      this.powered = true;
      this.upAt = cyc;
      this.reset();
    }
    if (v < 4 && !this.faint) {
      this.faint = true;
      this.warn?.(`${this.name} runs from ${fmtV(v)} V: a 5 V character LCD needs 4.5 to 5.5 V, so its text is too faint to see. Power it from 5 V (its I2C lines still work with a 3.3 V board)`);
    }
    return true;
  }

  /** a falling edge of E: it takes the RS and RW lines and D0 to D7 as they are */
  strobe(rs: number, rw: number, data: number, cyc: number) {
    if (!this.alive(cyc)) return;
    if (rw) {
      // a read: the module puts its busy flag and address on the data lines, and takes nothing in
      this.warn?.(`${this.name}: RW is high when E falls, so the LCD reads instead of taking the byte. Tie RW to GND (or drive it low)`);
      return;
    }
    if (this.eightBit) return this.byte(rs, data & 0xff, cyc);
    if (this.nibble === null) {
      this.nibble = data & 0xf0;
      return;
    }
    const b = this.nibble | ((data >> 4) & 0x0f);
    this.nibble = null;
    this.byte(rs, b, cyc);
  }

  private byte(rs: number, b: number, cyc: number) {
    if (cyc < this.upAt + 0.04 * this.fcpu) {
      this.warn?.(`${this.name}: the firmware wrote to the LCD within 40 ms of its power coming up, while its own reset still runs, so it was ignored. Wait 50 ms before setting it up (lcd.begin() does)`);
      return;
    }
    if (cyc < this.busyTo) {
      this.warn?.(`${this.name}: a byte came while the LCD was still busy with the last one (it takes 37 µs, 1.52 ms to clear), so it was lost. Wait longer between them`);
      return;
    }
    this.writes++;
    const us = (n: number) => cyc + (n * this.fcpu) / 1e6;
    this.dirty = true;
    if (rs) {
      this.data(b);
      this.busyTo = us(HD44780_US.data);
      return;
    }
    this.busyTo = us(HD44780_US.cmd);
    if (b & 0x80) {
      this.toCg = false;
      this.ac = b & 0x7f;
    } else if (b & 0x40) {
      this.toCg = true;
      this.ac = b & 0x3f;
    } else if (b & 0x20) {
      this.eightBit = (b & 0x10) !== 0;
      this.twoLine = (b & 0x08) !== 0;
      this.nibble = null;
    } else if (b & 0x10) {
      const display = (b & 0x08) !== 0;
      const right = (b & 0x04) !== 0;
      if (display) this.shift = (this.shift + (right ? -1 : 1) + this.lineLen()) % this.lineLen();
      else this.move(right);
    } else if (b & 0x08) {
      this.on = (b & 0x04) !== 0;
      this.cursor = (b & 0x02) !== 0;
      this.blink = (b & 0x01) !== 0;
    } else if (b & 0x04) {
      this.inc = (b & 0x02) !== 0;
      this.shiftOnWrite = (b & 0x01) !== 0;
    } else if (b & 0x02) {
      this.ac = 0;
      this.toCg = false;
      this.shift = 0;
      this.busyTo = us(HD44780_US.clear);
    } else if (b & 0x01) {
      this.ddram.fill(0x20);
      this.ac = 0;
      this.toCg = false;
      this.shift = 0;
      this.inc = true;
      this.busyTo = us(HD44780_US.clear);
    }
  }

  private lineLen() {
    return this.twoLine ? 40 : 80;
  }

  /** the address after ac, one place right or left, wrapping as each line's RAM does */
  private move(right: boolean) {
    if (this.toCg) {
      this.ac = (this.ac + (right ? 1 : 63)) & 63;
      return;
    }
    const a = this.ac;
    if (this.twoLine) this.ac = right ? (a === 0x27 ? 0x40 : a === 0x67 ? 0 : a + 1) : a === 0x40 ? 0x27 : a === 0 ? 0x67 : a - 1;
    else this.ac = right ? (a >= 0x4f ? 0 : a + 1) : a === 0 ? 0x4f : a - 1;
    this.ac &= 0x7f;
  }

  private data(b: number) {
    if (this.toCg) this.cgram[this.ac & 63] = b & 0x1f;
    else this.ddram[this.ac & 0x7f] = b;
    this.move(this.inc);
    if (this.shiftOnWrite && !this.toCg) this.shift = (this.shift + (this.inc ? 1 : -1) + this.lineLen()) % this.lineLen();
  }

  /** the characters on the glass now, one string per row (custom characters as \x00 to \x07) */
  text(): string[] {
    const out: string[] = [];
    for (let r = 0; r < this.rows; r++) {
      let s = "";
      for (let c = 0; c < this.cols; c++) {
        const a = this.addrAt(r, c);
        s += a === null ? " " : String.fromCharCode(this.ddram[a]);
      }
      out.push(s);
    }
    return out;
  }

  /** what each row looks like, as text (glyphText()), blank while the glass shows nothing readable */
  shown(): string[] {
    const blank = !this.powered || this.vdd() < 4 || !this.on || (!this.twoLine && this.rows > 1);
    return this.text().map((row, r) => (blank && !(r === 0 && !this.twoLine && this.rows > 1) ? " ".repeat(this.cols) : !this.twoLine && this.rows > 1 ? "█".repeat(this.cols) : [...row].map((ch) => glyphText(ch.charCodeAt(0))).join("")));
  }

  /** the display RAM address shown in a cell, or null for a row the module does not drive now */
  private addrAt(r: number, c: number): number | null {
    if (!this.twoLine) {
      if (r !== 0) return null;
      return (c + this.shift) % 80;
    }
    // rows 3 and 4 of a four-line module carry on from rows 1 and 2
    const line = r & 1;
    const col = c + (r >= 2 ? this.cols : 0);
    return line * 0x40 + ((col + this.shift) % 40);
  }

  private rowsOf(code: number): number[] {
    if (code < 16) {
      const base = (code & 7) * 8;
      return Array.from(this.cgram.subarray(base, base + 8));
    }
    return romGlyph(code);
  }

  /** the dots as lit/unlit bits, rows of w bits packed eight to a byte, first dot in the top bit */
  image(t: number): Uint8Array {
    const out = new Uint8Array((this.w >> 3) * this.h);
    const row = this.w >> 3;
    const set = (x: number, y: number) => (out[y * row + (x >> 3)] |= 0x80 >> (x & 7));
    if (!this.powered || this.vdd() < 4) return out;
    const blinkOn = Math.floor(t / BLINK_S) % 2 === 0;
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++) {
        const x0 = c * 6;
        const y0 = r * 9;
        if (!this.twoLine && this.rows > 1) {
          // one-line mode on a module made for more: the top row shows as solid blocks, the rest stays clear
          if (r === 0) for (let y = 0; y < 8; y++) for (let x = 0; x < 5; x++) set(x0 + x, y0 + y);
          continue;
        }
        if (!this.on) continue;
        const a = this.addrAt(r, c);
        if (a === null) continue;
        const dots = this.rowsOf(this.ddram[a]);
        const here = !this.toCg && a === this.ac;
        for (let y = 0; y < 8; y++) {
          let bits = dots[y] & 0x1f;
          if (here && this.cursor && y === 7) bits = 0x1f;
          if (here && this.blink && blinkOn) bits = 0x1f;
          for (let x = 0; x < 5; x++) if (bits & (0x10 >> x)) set(x0 + x, y0 + y);
        }
      }
    return out;
  }

  /** Called as time passes: record what changed, at most every `gap` seconds (`final`: at the end of the run). */
  tick(cyc: number, final = false) {
    const t = cyc / this.fcpu;
    this.alive(cyc);
    const light = Math.round(this.light() * 100) / 100;
    if (light !== this.lastLight) {
      this.lastLight = light;
      this.dirty = true;
    }
    if (this.on && this.blink) {
      const phase = Math.floor(t / BLINK_S) % 2;
      if (phase !== this.lastBlink) {
        this.lastBlink = phase;
        this.dirty = true;
      }
    }
    if (!this.dirty || (!final && t - this.lastSnap < this.gap)) return;
    this.dirty = false;
    this.lastSnap = t;
    const px = this.image(t);
    const last = this.frames[this.frames.length - 1];
    if (last && last.light === light && last.px.every((v, i) => v === px[i])) return;
    this.frames.push({ t, px, light });
    if (this.frames.length > FRAMES_MAX) {
      this.frames = this.frames.filter((_f, i) => i % 2 === 0);
      this.gap *= 2;
    }
  }
}

/**
 * The PCF8574 I2C backpack: eight quasi-bidirectional pins, all high at power-up, wired P0 RS, P1 RW, P2 E, P3 the
 * backlight transistor and P4 to P7 to D4 to D7 (D0 to D3 stay open, so the LCD's pull-ups hold them high).
 */
export class Pcf8574Lcd implements I2CDevice {
  /** the pins as last written */
  pins = 0xff;
  /** the backlight jumper is fitted */
  jumper = true;

  constructor(public lcd: Hd44780) {
    lcd.light = () => (this.jumper && this.pins & 0x08 ? 1 : 0);
  }

  write(bytes: number[], t: number) {
    for (const b of bytes) {
      const was = this.pins;
      this.pins = b & 0xff;
      // E falls: the LCD takes RS, RW and the data lines as they are now
      if (was & 0x04 && !(b & 0x04)) this.lcd.strobe(b & 1, (b >> 1) & 1, (b & 0xf0) | 0x0f, t);
    }
  }

  read(n: number): number[] {
    return new Array(n).fill(this.pins);
  }
}
