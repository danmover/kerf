// Compiles a sketch for a board without running it, as the Arduino IDE's Verify does: whether it builds, the first
// mistake with its file and line when it doesn't, and the RAM its globals take. The firmware editor runs it as you
// type, so a mistake shows on its line before the simulation starts.

import { SimHal } from "../engine/hal";
import { boardForPart, loadFirmware } from "./index";
import { CError } from "./lex";

export interface FirmwareCheck {
  ok: boolean;
  /** the board the sketch was compiled for */
  board: string;
  /** the first mistake: the file (as the sketch names it, or a library header) and its line, from 1 */
  problem?: { file: string; line: number; message: string };
  /** RAM taken before any function runs (globals, strings in RAM, the core's buffers), and the board's RAM, bytes */
  ram?: { used: number; total: number };
  /** functions the sketch defines */
  functions?: string[];
  /** setup() or loop() is missing */
  missing?: string[];
}

/** Compile files ({path, content}, paths as the sketch #includes them) for a controller part. */
export function checkFirmware(files: { path: string; content: string }[], partId: string | undefined): FirmwareCheck {
  const board = boardForPart(partId);
  const record: Record<string, string> = {};
  for (const f of files) if (/\.(ino|h|hpp|c|cpp)$/.test(f.path)) record[f.path.split("/").pop()!] = f.content;
  try {
    const loaded = loadFirmware(record, board, new SimHal(board));
    const fns = loaded.fw.fnNames;
    const missing = ["setup", "loop"].filter((n) => !fns.includes(n));
    return { ok: !missing.length, board: board.name, ram: { used: loaded.staticRam, total: board.ramBytes }, functions: fns, missing: missing.length ? missing : undefined };
  } catch (e) {
    if (e instanceof CError) {
      const prefix = `${e.file}:${e.line}: `;
      const message = e.message.startsWith(prefix) ? e.message.slice(prefix.length) : e.message;
      return { ok: false, board: board.name, problem: { file: e.file, line: e.line, message } };
    }
    return { ok: false, board: board.name, problem: { file: "", line: 0, message: e instanceof Error ? e.message : String(e) } };
  }
}
