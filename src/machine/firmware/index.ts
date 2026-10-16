// Firmware generation: picks the generator for each firmware block's board.

import type { MachineData } from "../types";
import { arduinoFirmware } from "./arduino";
import { fwContext, type GenFile } from "./common";
import { klipperConfig } from "./klipper";

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
