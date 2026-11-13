// Firmware generation: picks the generator for each firmware block's board.

import { CATALOG, catalogPart } from "../catalog";
import type { FirmwareDef, MachineData } from "../types";
import { ARM_WORDS, armFirmware } from "./arm";
import { busArmFirmware, hasServoBus } from "./busArms";
import { arduinoFirmware } from "./arduino";
import { fwContext, oneLine, type GenFile } from "./common";
import { OWN_FILE } from "./ownCode";
import { klipperConfig } from "./klipper";
import { MAGLEV_WORDS, maglevFirmware } from "./maglev";
import { marlinConfig } from "./marlin";
import { FLAVOR_NAME, type PrinterFlavor, PRINTER_FLAVORS, boardFlavors, flavorOf } from "./printer";
import { rrfConfig } from "./rrf";
import { tunerSketch } from "./tuner";
import { VANE_WORDS, vaneFirmware } from "./vanes";
import type { FwContext } from "./common";

export type { GenFile } from "./common";

export interface FirmwareOutput {
  name: string;
  board: string;
  target: "arduino" | PrinterFlavor | "none";
  /** one line on what the code does */
  summary: string;
  files: GenFile[];
  warnings: string[];
  pinTable: { signal: string; pin: string; wire: string }[];
  /** the files are the block's own code (code: "own"), not Kerf's */
  own?: boolean;
}

const ARDUINO_BOARDS = /^(arduino_|esp32|rpi_pico|feather_esp32)/;

export function generateFirmware(m: MachineData, designName: string): FirmwareOutput[] {
  return m.firmware.map((fw) => {
    const gen = generatedFor(m, fw, designName);
    return fw.settings.code === "own" ? ownFirmware(m, fw, gen) : gen;
  });
}

/**
 * A block set to `code: "own"` runs the code written for it (in Build → Firmware, or by Claude) in place of Kerf's.
 * Its pin map and wiring warnings still come from Kerf's code, as the reference for what the wiring expects.
 */
function ownFirmware(m: MachineData, fw: FirmwareDef, gen: FirmwareOutput): FirmwareOutput {
  const comp = m.components.find((c) => c.name === fw.board);
  const part = comp ? catalogPart(comp.catalogId) : undefined;
  if (gen.target !== "arduino" && gen.target !== "none")
    return { ...gen, warnings: [`code: "own" runs a sketch of your own on Arduino-style boards; ${part?.name ?? "this board"} runs ${TARGET_NAME[gen.target]}, so Kerf's ${TARGET_NAME[gen.target]} configuration is used.`, ...gen.warnings] };
  if (!part || !ARDUINO_BOARDS.test(part.id))
    return { ...gen, warnings: [`code: "own" needs an Arduino-style board (an Arduino, ESP32 or Raspberry Pi Pico) for the block's board:.`, ...gen.warnings] };
  const files = (fw.own?.files ?? []).filter((f) => OWN_FILE.test(f.path));
  if (!files.some((f) => f.path.endsWith(".ino")))
    return { ...gen, warnings: [`code: "own", but no sketch of your own is saved for ${fw.name} yet, so Kerf's generated code runs. Write it in Build → Firmware → My code.`, ...gen.warnings] };
  const ino = files.find((f) => f.path.endsWith(".ino"))!;
  const dir = `firmware/${ino.path.replace(/\.ino$/, "")}`;
  return {
    name: fw.name,
    board: gen.board || comp!.name,
    target: "arduino",
    summary: `Your own Arduino sketch for ${part.name}`,
    files: files.map((f) => ({ path: `${dir}/${f.path}`, content: f.content })),
    warnings: [],
    pinTable: gen.pinTable,
    own: true,
  };
}

const TARGET_NAME: Record<FirmwareOutput["target"], string> = { arduino: "Arduino", klipper: "Klipper", marlin: "Marlin", reprapfirmware: "RepRapFirmware", none: "no firmware" };

/** The code Kerf writes for a block from the wiring. */
function generatedFor(m: MachineData, fw: FirmwareDef, designName: string): FirmwareOutput {
  const ctx = fwContext(m, fw, designName);
  if (typeof ctx === "string") return { name: fw.name, board: fw.board ?? "", target: "none", summary: ctx, files: [], warnings: [ctx], pinTable: [] };
  const flavors = boardFlavors(ctx.boardPart);
  if (flavors.length) return printerFirmware(ctx, flavors);
  if (fw.settings.app === "tuner" && /^arduino_(nano|uno)/.test(ctx.boardPart.id)) {
    const r = tunerFor(ctx);
    return { name: fw.name, board: ctx.board.name, target: "arduino", summary: `Arduino sketch for ${ctx.boardPart.name}: chromatic guitar tuner with the note and cents on the OLED`, ...r };
  }
  if (VANE_WORDS.test(String(fw.settings.behaviour ?? fw.settings.behavior ?? "")) && ARDUINO_BOARDS.test(ctx.boardPart.id) && /esp32/i.test(String(ctx.boardPart.specs.mcu ?? ""))) {
    const r = vaneFirmware(ctx);
    return { name: fw.name, board: ctx.board.name, target: "arduino", summary: r.summary, files: r.files, warnings: r.warnings, pinTable: r.pinTable };
  }
  if (MAGLEV_WORDS.test(String(fw.settings.behaviour ?? fw.settings.behavior ?? "")) && ARDUINO_BOARDS.test(ctx.boardPart.id) && /esp32/i.test(String(ctx.boardPart.specs.mcu ?? ""))) {
    const r = maglevFirmware(ctx);
    return { name: fw.name, board: ctx.board.name, target: r.files.length ? "arduino" : "none", summary: r.summary, files: r.files, warnings: r.warnings, pinTable: r.pinTable };
  }
  // smart servos on a bus adapter: the board is a bridge between a computer and the servo buses
  if (ARDUINO_BOARDS.test(ctx.boardPart.id) && hasServoBus(ctx)) {
    const r = busArmFirmware(ctx);
    return { name: fw.name, board: ctx.board.name, target: "arduino", summary: r.summary, files: r.files, warnings: r.warnings, pinTable: r.pinTable };
  }
  if ((fw.settings.app === "arm" || ARM_WORDS.test(String(fw.settings.behaviour ?? fw.settings.behavior ?? ""))) && ARDUINO_BOARDS.test(ctx.boardPart.id)) {
    const r = armFirmware(ctx);
    return { name: fw.name, board: ctx.board.name, target: "arduino", summary: r.summary, files: r.files, warnings: r.warnings, pinTable: r.pinTable };
  }
  if (ARDUINO_BOARDS.test(ctx.boardPart.id)) {
    const r = arduinoFirmware(ctx);
    return {
      name: fw.name,
      board: ctx.board.name,
      target: "arduino",
      summary:
        r.behaviour === "ride"
          ? `Arduino sketch for ${ctx.boardPart.name}: ${r.rideSummary}`
          : r.behaviour === "tunneller"
            ? `Arduino sketch for ${ctx.boardPart.name}: autonomous tunnelling run with heading hold, stall back-off and a run log`
            : `Arduino sketch for ${ctx.boardPart.name}: serial console to test every motor and sensor`,
      files: r.files,
      warnings: r.warnings,
      pinTable: r.pinTable,
    };
  }
  const msg = `Kerf cannot generate firmware for ${ctx.boardPart.name} yet.`;
  return { name: fw.name, board: ctx.board.name, target: "none", summary: msg, files: [], warnings: [msg], pinTable: [] };
}

/**
 * A 3D printer board's config in the firmware the block's `flavor` setting names (the board's first
 * firmware without one). A flavor the board cannot run writes nothing and says which boards run it.
 */
function printerFirmware(c: FwContext, flavors: PrinterFlavor[]): FirmwareOutput {
  const base = { name: c.fw.name, board: c.board.name };
  const asked = c.fw.settings.flavor;
  const notes: string[] = [];
  let flavor = flavors[0];
  if (asked !== undefined && String(asked).trim() !== "") {
    const f = flavorOf(String(asked));
    if (f) flavor = f;
    else notes.push(`flavor "${oneLine(String(asked), 40)}" is not one Kerf writes (${PRINTER_FLAVORS.join(", ")}): writing ${FLAVOR_NAME[flavor]}, the ${c.boardPart.name}'s default.`);
  }
  if (!flavors.includes(flavor)) {
    const others = CATALOG.filter((p) => p.kind === "controller" && boardFlavors(p).includes(flavor)).map((p) => `${p.name}, catalog id ${p.id}`);
    const msg = `Kerf cannot write ${FLAVOR_NAME[flavor]} for the ${c.boardPart.name}: it runs ${flavors.map((x) => FLAVOR_NAME[x]).join(" or ")}. ${others.length ? `Boards that run ${FLAVOR_NAME[flavor]}: ${others.join("; ")}.` : `No board in Kerf's catalog runs ${FLAVOR_NAME[flavor]}.`}`;
    return { ...base, target: "none", summary: msg, files: [], warnings: [...notes, msg], pinTable: [] };
  }
  const r = flavor === "marlin" ? marlinConfig(c) : flavor === "reprapfirmware" ? rrfConfig(c) : klipperConfig(c);
  const summary = flavor === "marlin" ? `Marlin Configuration.h for ${c.boardPart.name}` : flavor === "reprapfirmware" ? `RepRapFirmware config.g for ${c.boardPart.name}` : `Klipper printer.cfg for ${c.boardPart.name}`;
  return { ...base, target: flavor, summary, files: r.files, warnings: [...notes, ...r.warnings], pinTable: r.pinTable };
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
