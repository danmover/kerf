// Firmware blocks' own code in the open design: a block that says code: "own" runs the sketch written for it (in
// Build → Firmware, or by Claude) instead of the code Kerf generates. The files live with the project; this adds
// them to the machine every consumer reads (the simulator, apps, the build pack, Claude), and switches a block
// between its own code and Kerf's by editing its code: setting in the design.

import { useMemo } from "react";
import { useDesign } from "../core/engine";
import { setFirmwareProps } from "../core/sourceEdit";
import { generateFirmware, type FirmwareOutput } from "../machine/firmware";
import { ownFileProblem, seedFiles, type FirmwareCodeRecord } from "../machine/firmware/ownCode";
import type { MachineData } from "../machine/types";
import { commitSource, projectFirmware, saveFirmwareCode, useProject } from "./project";

type Files = FirmwareCodeRecord["files"];

let memo: { m: MachineData; fw: FirmwareCodeRecord[] | undefined; out: MachineData } | null = null;

/** The machine with each code: "own" block's files from the project (the same object when no block runs its own code). */
export function withOwnCode<T extends MachineData | null | undefined>(m: T): T {
  if (!m || !m.firmware.some((f) => f.settings.code === "own")) return m;
  const fw = useProject.getState().current?.firmware;
  if (memo && memo.m === m && memo.fw === fw) return memo.out as T;
  const out: MachineData = { ...m, firmware: m.firmware.map((f) => (f.settings.code === "own" ? { ...f, own: { files: fw?.find((r) => r.block === f.name)?.files ?? [] } } : f)) };
  memo = { m, fw, out };
  return out as T;
}

/** withOwnCode for a component: it renders again when the own code changes. */
export function useOwnCode<T extends MachineData | null | undefined>(m: T): T {
  const fw = useProject((s) => s.current?.firmware);
  return useMemo(() => withOwnCode(m), [m, fw]);
}

/** A block's own files (empty when it has none yet). */
export function ownFiles(block: string): Files {
  return projectFirmware().find((r) => r.block === block)?.files ?? [];
}

/** Kerf's code for a block, whatever the block's code: setting says. */
export function kerfCodeFor(block: string): FirmwareOutput | undefined {
  const m = useDesign.getState().model;
  const mm = m?.machine;
  if (!mm) return undefined;
  const plain: MachineData = { ...mm, firmware: mm.firmware.map((f) => (f.name === block ? { ...f, settings: { ...f.settings, code: "generated" } } : f)) };
  return generateFirmware(plain, m.name).find((f) => f.name === block);
}

function blockExists(block: string): boolean {
  return !!useDesign.getState().model?.machine?.firmware.some((f) => f.name === block);
}

/**
 * Run a block on its own code: start the code from Kerf's sketch when it has none yet, and say code: "own" in the
 * design. Returns why it couldn't, or null.
 */
export function startOwnCode(block: string, author: "you" | "claude" = "you"): string | null {
  if (!blockExists(block)) return `The design has no firmware block "${block}".`;
  if (!ownFiles(block).length) {
    const gen = kerfCodeFor(block);
    const files = seedFiles(gen?.files ?? []);
    if (!files.some((f) => f.path.endsWith(".ino"))) files.unshift({ path: `${block.toLowerCase()}.ino`, content: BLANK_SKETCH });
    const err = saveFirmwareCode(block, files);
    if (err) return err;
  }
  return setCodeSetting(block, '"own"', author, `Firmware ${block} runs its own code`);
}

/** Run a block on Kerf's code again. Its own files are kept, to switch back to. */
export function switchToKerfCode(block: string, author: "you" | "claude" = "you"): string | null {
  if (!blockExists(block)) return `The design has no firmware block "${block}".`;
  return setCodeSetting(block, null, author, `Firmware ${block} runs Kerf's code`);
}

/** Start a block's own code again from Kerf's sketch (its own files are replaced). */
export function resetOwnCode(block: string): string | null {
  const files = seedFiles(kerfCodeFor(block)?.files ?? []);
  if (!files.length) return `Kerf writes no Arduino sketch for ${block} to start from.`;
  return saveFirmwareCode(block, files);
}

function setCodeSetting(block: string, value: string | null, author: "you" | "claude", message: string): string | null {
  const { source } = useDesign.getState();
  const next = setFirmwareProps(source, block, { code: value });
  if (next !== source) commitSource(next, author, message);
  return null;
}

/** Write one of a block's own files (adding it when it's new). Returns why it couldn't, or null. */
export function writeOwnFile(block: string, path: string, content: string): string | null {
  const files = ownFiles(block);
  const at = files.findIndex((f) => f.path === path);
  if (at < 0) {
    const problem = ownFileProblem(path, files);
    if (problem) return problem;
  }
  return saveFirmwareCode(block, at >= 0 ? files.map((f, i) => (i === at ? { path, content } : f)) : [...files, { path, content }]);
}

export function renameOwnFile(block: string, from: string, to: string): string | null {
  const files = ownFiles(block);
  if (!files.some((f) => f.path === from)) return `${block} has no file ${from}.`;
  if (from === to) return null;
  const problem = ownFileProblem(to, files, from);
  if (problem) return problem;
  if (from.endsWith(".ino") && !to.endsWith(".ino") && files.filter((f) => f.path.endsWith(".ino")).length === 1) return "The sketch needs its .ino file: keep the .ino ending.";
  return saveFirmwareCode(block, files.map((f) => (f.path === from ? { path: to, content: f.content } : f)));
}

export function deleteOwnFile(block: string, path: string): string | null {
  const files = ownFiles(block);
  if (!files.some((f) => f.path === path)) return `${block} has no file ${path}.`;
  if (path.endsWith(".ino") && files.filter((f) => f.path.endsWith(".ino")).length === 1) return "The sketch needs its .ino file.";
  return saveFirmwareCode(block, files.filter((f) => f.path !== path));
}

const BLANK_SKETCH = `// Your own sketch. Build → Wiring shows which pin each part is on.

void setup() {
  Serial.begin(115200);
  Serial.println("state: ready");
}

void loop() {
}
`;
