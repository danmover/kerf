// Peripherals the firmware reaches through a library rather than through the plant's own drivers and sensors: a
// microSD card module on the SPI bus (SD.h) and character LCDs (LiquidCrystal on the module's own pins,
// LiquidCrystal_I2C through a PCF8574 backpack). Each is wired up as the design wires it: a module on the wrong
// pins is left off its bus with a note saying why, as the real one would never answer, and each takes its power
// from the net its supply pin is on.

import type { Net } from "../../machine/erc";
import type { CatalogPart, MachineComponent } from "../../machine/types";
import { SdCard, type SdFileReport } from "../mcu/sdcard";
import type { Ssd1306 } from "./devices";
import { Hd44780, Pcf8574Lcd } from "./lcd";
import type { Plant } from "./plant";

/** A microSD card at the end of a run, for the run's results. */
export interface SdCardRun {
  name: string;
  /** what the card holds */
  files: SdFileReport[];
  gb: number;
  format: string;
  /** 512-byte blocks read and written over the run */
  blocksRead: number;
  blocksWritten: number;
}

/** How a display's frames are drawn: an OLED's lit pixels, or an LCD's dots in character cells. */
export interface DisplayLook {
  kind: "lcd";
  cols: number;
  rows: number;
  /** the glass: white_on_blue, black_on_green */
  color: string;
  /** what each row showed at the end of the run */
  text: string[];
}

/** Put the peripheral a part is on its bus: true when the part is one (wired right or not). */
export function attachPeripheral(p: Plant, mc: MachineComponent, part: CatalogPart): boolean {
  if (part.specs.driver === "SDCARD") {
    sdModule(p, mc, part);
    return true;
  }
  if (part.specs.driver === "HD44780") {
    if (part.specs.iface === "i2c") lcdI2c(p, mc, part);
    else lcdPins(p, mc, part);
    return true;
  }
  return false;
}

const volts = (p: Plant, n: Net | undefined) => (n ? (p.netV.get(n.id) ?? 0) : 0);

function warner(p: Plant) {
  const said = new Set<string>();
  return (text: string) => {
    if (said.has(text)) return;
    said.add(text);
    p.events.push({ t: p.t, kind: "warn", text });
  };
}

// ---------- the microSD card ----------

function sdModule(p: Plant, mc: MachineComponent, part: CatalogPart) {
  const bus = p.board.spi;
  const spi = p.hal.spi;
  if (!bus) {
    p.notes.push(`${mc.name}: the simulator knows no SPI pins on the ${p.board.name}, so the card is not on a bus.`);
    return;
  }
  const want: [string | undefined, number, string][] = [
    [part.pins.find((x) => x.bus === "spi_sck")?.id, bus.sck, "SCK"],
    [part.pins.find((x) => x.bus === "spi_miso")?.id, bus.miso, "MISO"],
    [part.pins.find((x) => x.bus === "spi_mosi")?.id, bus.mosi, "MOSI"],
  ];
  const wrong: string[] = [];
  for (const [id, pin, role] of want) {
    if (!id) continue;
    const got = p.mcuPinFor(mc.name, id);
    if (got !== pin) wrong.push(`${id} goes to ${got < 0 ? "no controller pin" : `pin ${got}`}, not the ${role} pin (${pin})`);
  }
  const cs = p.mcuPinFor(mc.name, "CS");
  if (wrong.length) {
    p.notes.push(`${mc.name}: ${wrong.join("; ")}. The SD library uses the hardware SPI pins only, so the card never answers.`);
    return;
  }
  if (cs < 0) {
    p.notes.push(`${mc.name}: CS is not wired to a pin of the ${p.board.name}, so SD.begin() cannot select the card.`);
    return;
  }
  const card = new SdCard(mc.name, Number(part.specs.card_gb ?? 16) * 2 ** 30);
  const vcc = p.netOf(mc.name, "V5") ?? p.netOf(mc.name, "VCC");
  const v3 = p.netOf(mc.name, "V3");
  const vmin = Number(part.specs.v_min ?? 3.6);
  // fed from 3.6 V up through its regulator, or 3.3 V straight onto the 3v pin
  card.powered = () => volts(p, vcc) >= vmin || volts(p, v3) >= 3;
  spi.attach(cs, card);
  const cd = p.mcuPinFor(mc.name, "CD");
  if (cd >= 0 && !card.inserted) p.hal.setExternal(cd, 0);
}

// ---------- character LCDs ----------

function newLcd(p: Plant, mc: MachineComponent, part: CatalogPart): Hd44780 {
  const lcd = new Hd44780(mc.name, Number(part.specs.cols ?? 16), Number(part.specs.rows ?? 2), p.board.fcpu);
  lcd.color = String(part.specs.lcd_color ?? "white_on_blue");
  lcd.warn = warner(p);
  // the plant ticks its displays every step and the run takes their frames
  p.displays.push(lcd as unknown as Ssd1306);
  return lcd;
}

function lcdI2c(p: Plant, mc: MachineComponent, part: CatalogPart) {
  const sda = p.mcuPinFor(mc.name, "SDA");
  const scl = p.mcuPinFor(mc.name, "SCL");
  if (sda !== p.board.sda || scl !== p.board.scl) {
    if (sda >= 0 || scl >= 0) p.notes.push(`${mc.name}: SDA and SCL must go to the ${p.board.name}'s Wire pins (${p.board.arch === "esp32" ? `GPIO${p.board.sda} and GPIO${p.board.scl}` : "A4 and A5"}); it is not on the bus.`);
    return;
  }
  const lcd = newLcd(p, mc, part);
  const vcc = p.netOf(mc.name, "VCC");
  lcd.vdd = () => volts(p, vcc);
  const pcf = new Pcf8574Lcd(lcd);
  p.i2cDevs.set(parseInt(String(part.specs.i2c_addr ?? "0x27"), 16), { dev: pcf, vcc, comp: mc.name });
}

/** a module pin's level: the controller pin it is wired to, a rail, or the LCD's own pull-up when it is open */
function lineLevel(p: Plant, mc: MachineComponent, id: string): () => number {
  const pin = p.mcuPinFor(mc.name, id);
  if (pin >= 0) return () => p.hal.level(pin);
  const n = p.netOf(mc.name, id);
  if (n?.pins.some((x) => x.pin.type === "gnd")) return () => 0;
  return () => 1;
}

function lcdPins(p: Plant, mc: MachineComponent, part: CatalogPart) {
  const en = p.mcuPinFor(mc.name, "E");
  const rs = p.mcuPinFor(mc.name, "RS");
  if (en < 0 || rs < 0) {
    p.notes.push(`${mc.name}: ${en < 0 ? "E" : "RS"} is not wired to a pin of the ${p.board.name}, so the LCD never takes a byte.`);
    return;
  }
  const lcd = newLcd(p, mc, part);
  const vdd = p.netOf(mc.name, "VDD");
  const v0 = p.netOf(mc.name, "V0");
  // V0 left open: no contrast voltage, so nothing shows however the firmware drives it
  const contrast = !!v0 && v0.pins.length > 1;
  if (!contrast) p.notes.push(`${mc.name}: V0 (contrast) is not connected, so the screen stays blank. Wire the wiper of a 10 kΩ pot to it, the pot's ends to 5 V and GND.`);
  lcd.vdd = () => (contrast ? volts(p, vdd) : 0);
  const a = p.netOf(mc.name, "A");
  const aPin = p.mcuPinFor(mc.name, "A");
  const k = p.netOf(mc.name, "K");
  const kGround = !!k?.pins.some((x) => x.pin.type === "gnd" && x.comp !== mc.name);
  lcd.light = () => {
    if (!kGround) return 0;
    if (aPin >= 0) return p.hal.duty[aPin] >= 0 ? p.hal.duty[aPin] : p.hal.level(aPin);
    return volts(p, a) >= 3 ? 1 : 0;
  };
  const rw = lineLevel(p, mc, "RW");
  const d = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => lineLevel(p, mc, `D${i}`));
  const before = p.hal.onWrite.get(en);
  let last = p.hal.level(en);
  p.hal.onWrite.set(en, (level, t) => {
    before?.(level, t);
    // the LCD takes RS, RW and the data lines as E falls
    if (last === 1 && level === 0) lcd.strobe(p.hal.level(rs), rw(), d.reduce((m, f, i) => m | (f() << i), 0), t);
    last = level;
  });
}

// ---------- results ----------

/** a display's look and last text, for the run's results */
export function displayLook(d: unknown): { look?: DisplayLook } {
  if (!(d instanceof Hd44780)) return {};
  return { look: { kind: "lcd", cols: d.cols, rows: d.rows, color: d.color, text: d.shown() } };
}

/** the microSD cards on the bus at the end of the run, with the files on them */
export function peripheralResults(p: Plant): { sdCards?: SdCardRun[] } {
  const cards: SdCardRun[] = [];
  for (const dev of p.hal.spi.devs.values())
    if (dev instanceof SdCard) cards.push({ name: dev.name, files: dev.report(), gb: Math.round(dev.capacity / 2 ** 30), format: dev.format, blocksRead: dev.reads, blocksWritten: dev.writes });
  return cards.length ? { sdCards: cards } : {};
}
