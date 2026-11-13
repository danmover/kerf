// The virtual microcontroller: takes the firmware's files as the Arduino
// builder would (Arduino.h first, then the sketch), parses and compiles them
// for the board, and gives back callable firmware bound to a HAL.

import { boardFor, NANO, type Board } from "./board";
import { compileFirmware, type Firmware } from "./compile";
import { typesFor } from "./ctypes";
import { predefines, systemHeaders } from "./headers";
import { CError, type Tok } from "./lex";
import { CLASS_NAMES, TEMPLATED } from "./lib";
import { FirmwareDebugger, type DebugSpec } from "./debug";
import { parseProgram, parseProgramForDebug } from "./parse";
import { preprocess } from "./pre";
import type { Hal } from "./vm";

export { Halt, type Hal, type Ptr, type FnRef } from "./vm";
export { CError } from "./lex";
export type { Firmware } from "./compile";
export type { DebugBreakpoint, DebugResult, DebugSpec, DebugStop, DebugSite, DebugFrame, DebugVar, TraceStep } from "./debug";
export { boardFor, BOARDS, FEATHER_ESP32_V2, NANO, UNO, type Board } from "./board";

export interface LoadedFirmware {
  fw: Firmware;
  board: Board;
  /** RAM taken before the first function runs: globals, string literals and the core's buffers */
  staticRam: number;
  /** libraries the sketch uses */
  uses: { serial: boolean; wire: boolean; eeprom: boolean; servo: boolean };
}

/** RAM the AVR core and libraries take for their own buffers and state, bytes. */
const CORE_RAM = { base: 9, serial: 175, wire: 211, servo: 50, sd: 610, fastled: 24 };

export function loadFirmware(files: Record<string, string>, board: Board, hal: Hal, main?: string, debug?: DebugSpec): LoadedFirmware {
  const sketch = main ?? Object.keys(files).find((f) => f.endsWith(".ino")) ?? Object.keys(files)[0];
  if (!sketch || !(sketch in files)) throw new CError("The firmware has no .ino sketch", sketch ?? "firmware", 0);
  let expand: ((text: string, file: string) => Tok[]) | null = null;
  const toks = preprocess(`#include <Arduino.h>\n#include "${sketch}"\n`, {
    files,
    system: systemHeaders(board),
    defines: predefines(board),
    ...(debug ? { after: (x: (text: string, file: string) => Tok[]) => (expand = x) } : {}),
  });
  const ids = new Set<string>();
  for (const t of toks) if (t.k === "id") ids.add(t.v);
  const T = typesFor(board.abi);
  let prog: ReturnType<typeof parseProgram>;
  let dbg: FirmwareDebugger | undefined;
  if (debug) {
    const p = parseProgramForDebug(toks, { T, classes: CLASS_NAMES, templated: TEMPLATED });
    prog = p.prog;
    dbg = new FirmwareDebugger(debug, hal, (text) => p.parseExpr(expand!(text, "<watch>")));
    // a firmware mistake stops the debugger there; one made reading a watch is the watch's
    const report = hal.fault.bind(hal);
    const d = dbg;
    hal.fault = (msg, file, line) => {
      if (d.fault(msg, file, line)) report(msg, file, line);
    };
  } else prog = parseProgram(toks, { T, classes: CLASS_NAMES, templated: TEMPLATED });
  const fw = compileFirmware(prog, T, hal, dbg);
  // LiquidCrystal_I2C brings Wire with it; SD keeps a 512-byte block cache and its volume
  const uses = { serial: ids.has("Serial"), wire: ids.has("Wire") || ids.has("LiquidCrystal_I2C"), eeprom: ids.has("EEPROM"), servo: ids.has("Servo") };
  const libs = (ids.has("SD") ? CORE_RAM.sd : 0) + (ids.has("FastLED") ? CORE_RAM.fastled : 0);
  const staticRam = fw.staticRam + CORE_RAM.base + (uses.serial ? CORE_RAM.serial : 0) + (uses.wire ? CORE_RAM.wire : 0) + (uses.servo ? CORE_RAM.servo : 0) + (board.arch === "esp32" ? 0 : libs);
  return { fw, board, staticRam, uses };
}

/** The board profile for a controller part, or the Nano when the part is not one the simulator knows. */
export function boardForPart(partId: string | undefined): Board {
  return boardFor(partId) ?? NANO;
}
