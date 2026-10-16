// Firmware generation: picks the generator for each firmware block's board.

import { catalogPart } from "../catalog";
import type { MachineData } from "../types";
import { arduinoFirmware } from "./arduino";
import { fwContext, type GenFile } from "./common";
import { klipperConfig } from "./klipper";
import { tunerSketch } from "./tuner";
import type { FwContext } from "./common";

export type { GenFile } from "./common";

export interface FirmwareOutput {
  name: string;
  board: string;
  target: "arduino" | "klipper" | "none";
  /** one line on what the code does */
  summary: string;
  files: GenFile[];
  warnings: string[];
  pinTable: { signal: string; pin: string; wire: string }[];
}

const KLIPPER_BOARDS = /^skr_/;
const ARDUINO_BOARDS = /^(arduino_|esp32|rpi_pico)/;

export function generateFirmware(m: MachineData, designName: string): FirmwareOutput[] {
  return m.firmware.map((fw) => {
    const ctx = fwContext(m, fw, designName);
    if (typeof ctx === "string") return { name: fw.name, board: fw.board ?? "", target: "none", summary: ctx, files: [], warnings: [ctx], pinTable: [] };
    if (KLIPPER_BOARDS.test(ctx.boardPart.id)) {
      const r = klipperConfig(ctx);
      return { name: fw.name, board: ctx.board.name, target: "klipper", summary: `Klipper printer.cfg for ${ctx.boardPart.name}`, ...r };
    }
    if (fw.settings.app === "tuner" && /^arduino_(nano|uno)/.test(ctx.boardPart.id)) {
      const r = tunerFor(ctx);
      return { name: fw.name, board: ctx.board.name, target: "arduino", summary: `Arduino sketch for ${ctx.boardPart.name}: chromatic guitar tuner with the note and cents on the OLED`, ...r };
    }
    if (ARDUINO_BOARDS.test(ctx.boardPart.id)) {
      const r = arduinoFirmware(ctx);
      return {
        name: fw.name,
        board: ctx.board.name,
        target: "arduino",
        summary: r.behaviour === "tunneller" ? `Arduino sketch for ${ctx.boardPart.name}: autonomous tunnelling run with heading hold, stall back-off and a run log` : `Arduino sketch for ${ctx.boardPart.name}: serial console to test every motor and sensor`,
        files: r.files,
        warnings: r.warnings,
        pinTable: r.pinTable,
      };
    }
    const msg = `Kerf cannot generate firmware for ${ctx.boardPart.name} yet.`;
    return { name: fw.name, board: ctx.board.name, target: "none", summary: msg, files: [], warnings: [msg], pinTable: [] };
  });
}

/** The tuner's pins from the wiring: the analog input the signal reaches, the button's pin and the display's address. */
function tunerFor(c: FwContext) {
  const pins = c.nl.pinsOf.get(c.board.name) ?? [];
  const others = (key: string) => (c.nl.netOf.get(key)?.pins ?? []).filter((p) => p.comp !== c.board.name);
  const adc = pins.find((p) => p.pin.adc && !p.pin.bus && others(p.key).some((o) => o.part.kind !== "display"));
  const button = pins.find((p) => p.pin.type === "io" && others(p.key).some((o) => o.part.kind === "switch"));
  const display = c.m.components.find((x) => catalogPart(x.catalogId)?.kind === "display");
  const addr = Number(catalogPart(display?.catalogId ?? "")?.specs.i2c_addr ?? 0x3c);
  const ref = Number(c.fw.settings.ref_hz ?? 440);
  const r = tunerSketch({
    designName: c.designName,
    adcPin: adc?.pin.id ?? "A0",
    buttonPin: button ? button.pin.id.replace(/^D/, "") : undefined,
    oledAddr: Number.isFinite(addr) ? addr : 0x3c,
    refHz: Number.isFinite(ref) ? ref : 440,
  });
  if (!adc) r.warnings.unshift("No analog input is wired to the guitar signal: the sketch listens on A0.");
  if (!button) r.warnings.unshift("No button is wired to the board: the reference pitch stays at A = " + (Number.isFinite(ref) ? ref : 440) + " Hz.");
  return r;
}
