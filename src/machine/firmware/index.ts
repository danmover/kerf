// Firmware generation: picks the generator for each firmware block's board.

import { CATALOG, catalogPart } from "../catalog";
import type { MachineData } from "../types";
import { arduinoFirmware } from "./arduino";
import { fwContext, oneLine, type GenFile } from "./common";
import { klipperConfig } from "./klipper";
import { marlinConfig } from "./marlin";
import { FLAVOR_NAME, type PrinterFlavor, PRINTER_FLAVORS, boardFlavors, flavorOf } from "./printer";
import { rrfConfig } from "./rrf";
import { tunerSketch } from "./tuner";
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
}

const ARDUINO_BOARDS = /^(arduino_|esp32|rpi_pico)/;

export function generateFirmware(m: MachineData, designName: string): FirmwareOutput[] {
  return m.firmware.map((fw) => {
    const ctx = fwContext(m, fw, designName);
    if (typeof ctx === "string") return { name: fw.name, board: fw.board ?? "", target: "none", summary: ctx, files: [], warnings: [ctx], pinTable: [] };
    const flavors = boardFlavors(ctx.boardPart);
    if (flavors.length) return printerFirmware(ctx, flavors);
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
