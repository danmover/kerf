// The SPI bus: the clock the firmware sets (only the rates the chip can divide its clock to), the bytes it sends
// and reads back with the time they take on the wire, and the devices on it, each answering only while its
// chip-select pin is low. The mistakes the chip makes real are reported: two devices selected at once, a clock
// faster than a device takes, the wrong SPI mode, and on the AVR the SS pin left as an input that reads low,
// which drops the chip out of master mode.

import type { SpiDevice, SpiPort } from "../mcu/vm";
import type { SimHal } from "./hal";

/** the AVR's SPI.setClockDivider() codes (SPI_CLOCK_DIVn) and the divider each makes */
const AVR_DIVIDERS: Record<number, number> = { 0x00: 4, 0x01: 16, 0x02: 64, 0x03: 128, 0x04: 2, 0x05: 8, 0x06: 32 };

const reverse = (b: number) => {
  let r = 0;
  for (let i = 0; i < 8; i++) if (b & (1 << i)) r |= 0x80 >> i;
  return r;
};

export class SpiBus implements SpiPort {
  /** the device on each chip-select pin */
  devs = new Map<number, SpiDevice>();
  on = false;
  hz: number;
  mode = 0;
  msbFirst = true;
  /** bytes sent while running, for the run's results */
  bytes = 0;
  private selected = new Map<number, boolean>();
  private said = new Set<string>();

  constructor(private h: SimHal) {
    // the AVR core's SPI starts at F_CPU/4; the ESP32's SPI.begin() at 1 MHz, the RP2040's and STM32's at SPISettings()' 4 MHz
    this.hz = h.board.arch === "esp32" ? 1e6 : (h.board.arch ?? "avr") === "avr" ? h.fcpu / 4 : 4e6;
  }

  private warn(msg: string) {
    if (this.said.has(msg)) return;
    this.said.add(msg);
    this.h.fault(msg, "firmware", 0);
  }

  private get esp() {
    return this.h.board.arch === "esp32";
  }

  private get avr() {
    return (this.h.board.arch ?? "avr") === "avr";
  }

  get pins() {
    return this.h.board.spi;
  }

  attach(cs: number, dev: SpiDevice) {
    this.devs.set(cs, dev);
  }

  device(cs: number): SpiDevice | undefined {
    return this.devs.get(cs);
  }

  begin() {
    const h = this.h;
    const p = h.board.spi;
    if (!p) return this.warn(`SPI.begin(): the ${h.board.name} has no SPI pins the simulator knows`);
    if (this.avr) {
      // as the AVR core does: SS high (its pull-up) before it becomes an output, so nothing is selected by it
      if (h.mode[p.ss] !== 1) h.digitalWrite(p.ss, 1);
      h.pinMode(p.ss, 1);
    }
    h.pinMode(p.sck, 1);
    h.pinMode(p.mosi, 1);
    if (!this.avr) h.pinMode(p.miso, 0);
    this.on = true;
  }

  end() {
    this.on = false;
  }

  settings(hz: number, msbFirst: boolean, mode: number) {
    this.msbFirst = msbFirst;
    this.mode = mode & 3;
    if (!(hz > 0)) return;
    if (this.esp) {
      // the ESP32 divides its 80 MHz APB clock by a whole number
      this.hz = 80e6 / Math.max(1, Math.ceil(80e6 / hz - 1e-9));
      return;
    }
    if (this.h.board.arch === "rp2040") {
      // the RP2040's SPI divides its clock by a whole number, 2 at the least
      this.hz = this.h.fcpu / Math.max(2, Math.ceil(this.h.fcpu / hz - 1e-9));
      return;
    }
    // the AVR's SPISettings: the fastest of F_CPU/2 ... F_CPU/128 at or below the clock asked for
    let div = 2;
    while (div < 128 && this.h.fcpu / div > hz) div *= 2;
    this.hz = this.h.fcpu / div;
  }

  divider(code: number) {
    if (this.esp) {
      // the ESP32 core takes a raw clock register value here; most sketches pass SPI_CLOCK_DIVn from AVR code
      this.warn("SPI.setClockDivider() on the ESP32 takes a clock register value, not the AVR's SPI_CLOCK_DIVn: use SPI.setFrequency(hz) or SPISettings");
      return;
    }
    const div = AVR_DIVIDERS[code & 7];
    if (div) this.hz = this.h.fcpu / div;
  }

  /** the devices whose chip select is low now, telling each whose selection changed */
  private selectedNow(): [number, SpiDevice][] {
    const h = this.h;
    const out: [number, SpiDevice][] = [];
    for (const [cs, d] of this.devs) {
      const on = h.mode[cs] === 1 && h.level(cs) === 0;
      if (on !== (this.selected.get(cs) ?? false)) {
        this.selected.set(cs, on);
        d.select?.(on, h.cyc);
      }
      if (on) out.push([cs, d]);
    }
    return out;
  }

  /**
   * The time the bytes take: their bits at the clock, the loop around each byte, and the call around them all
   * (the ESP32's SPI driver takes about a microsecond to start a transfer).
   */
  private cycles(n: number, calls: number): number {
    const per = (8 * this.h.fcpu) / this.hz;
    return n * (per + (this.avr ? 4 : 0)) + calls * (this.avr ? 10 : this.h.fcpu * 1e-6);
  }

  private spendCycles(c: number) {
    const h = this.h;
    h.cyc += Math.round(c);
    if (h.cyc >= h.nextEvt) h.service();
  }

  transfer(out: number[]): number[] {
    const h = this.h;
    if (!this.on) {
      this.warn("SPI.transfer() before SPI.begin(): the SPI hardware is off, so nothing goes out on the wire");
      this.spendCycles(out.length * 20);
      return out.map(() => 0);
    }
    const p = h.board.spi;
    if (this.avr && p && h.mode[p.ss] !== 1 && h.level(p.ss) === 0) {
      // the AVR's SPI turns slave when SS is a low input, and the transfer never finishes
      this.warn(`SS (pin ${p.ss}) is an input reading low: the ${h.board.mcu}'s SPI drops out of master mode, so it stops sending. Keep pin ${p.ss} an output, even when another pin is the chip select`);
      this.spendCycles(this.cycles(out.length, 1));
      return out.map(() => 0);
    }
    const sel = this.selectedNow();
    if (sel.length > 1) this.warn(`${sel.map(([, d]) => d.name).join(" and ")} are selected at once (their chip-select pins are all low): they all drive MISO, so what comes back is garbage. Take one chip select high before the other goes low`);
    const t0 = h.cyc;
    const inp = out.map((b) => {
      let v = 0xff;
      for (const [, d] of sel) {
        // an unpowered device leaves MISO to its pull-up
        if (d.ready && !d.ready(h.cyc)) continue;
        let r = d.transfer(this.msbFirst ? b & 0xff : reverse(b & 0xff), h.cyc) & 0xff;
        if (!this.msbFirst) r = reverse(r);
        if (this.hz > d.maxHz * 1.001) {
          this.warn(`The SPI clock is ${+(this.hz / 1e6).toFixed(2)} MHz, faster than ${d.name} takes (${+(d.maxHz / 1e6).toFixed(2)} MHz): it reads the bits wrong. Slow it down with SPISettings`);
          r = ((r << 1) | 1) & 0xff;
        }
        if (!d.modes.includes(this.mode)) {
          this.warn(`${d.name} talks SPI mode ${d.modes.join(" or ")}, and the bus is in mode ${this.mode}: each byte comes back shifted a bit. Set SPI_MODE${d.modes[0]} in SPISettings`);
          r = (r >> 1) | 0x80;
        }
        v &= r;
      }
      return v;
    });
    this.bytes += out.length;
    this.spendCycles(this.cycles(out.length, 1));
    h.probe?.spi(sel[0]?.[0] ?? -1, out, inp, this.hz, t0, h.cyc);
    return inp;
  }

  traffic(cs: number, out: number[], inp: number[], bytes: number, waitUs: number) {
    const h = this.h;
    const t0 = h.cyc;
    this.bytes += bytes;
    this.spendCycles(this.cycles(bytes, 1) + waitUs * 1e-6 * h.fcpu);
    h.probe?.spi(cs, out, inp, this.hz, t0, h.cyc);
  }
}
