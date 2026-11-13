// A firmware block's own code: the sketch the user or Claude writes in place of the code Kerf generates, kept with
// the project (not in the design source) and run when the block says code: "own". Its files are flat, as in an
// Arduino sketch folder: one .ino and any .h, .c and .cpp files beside it.

/** A firmware block's own code as a project keeps it. */
export interface FirmwareCodeRecord {
  /** the firmware block's name in the design */
  block: string;
  files: { path: string; content: string }[];
  updatedAt: number;
}

/** a file of a sketch of your own: flat, with a C or C++ extension */
export const OWN_FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,59}\.(ino|h|hpp|c|cpp)$/;
export const MAX_OWN_BLOCKS = 12;
export const MAX_OWN_FILES = 24;
export const MAX_OWN_FILE_CHARS = 300_000;
export const MAX_OWN_CHARS = 1_000_000;
const BLOCK = /^[A-Za-z_][A-Za-z0-9_]{0,59}$/;

/** Why a file name can't be used for a block's own code, or null. */
export function ownFileProblem(name: string, files: { path: string }[], except?: string): string | null {
  if (!OWN_FILE.test(name)) return "A file name is letters, digits, _ . and -, ending .ino, .h, .hpp, .c or .cpp (no folders).";
  if (files.some((f) => f.path !== except && f.path.toLowerCase() === name.toLowerCase())) return `There is already a file called ${name}.`;
  return null;
}

/** Own code as Kerf keeps it: well-formed blocks and files, one of each, within the limits. Undefined when there is none. */
export function cleanFirmwareCode(list: unknown): FirmwareCodeRecord[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out: FirmwareCodeRecord[] = [];
  let total = 0;
  for (const r of list as Partial<FirmwareCodeRecord>[]) {
    if (!r || typeof r !== "object" || typeof r.block !== "string" || !BLOCK.test(r.block) || !Array.isArray(r.files)) continue;
    if (out.some((x) => x.block === r.block) || out.length >= MAX_OWN_BLOCKS) continue;
    const files: FirmwareCodeRecord["files"] = [];
    for (const f of r.files) {
      if (!f || typeof f.path !== "string" || typeof f.content !== "string" || !OWN_FILE.test(f.path)) continue;
      if (files.some((x) => x.path.toLowerCase() === f.path.toLowerCase()) || files.length >= MAX_OWN_FILES) continue;
      if (f.content.length > MAX_OWN_FILE_CHARS || total + f.content.length > MAX_OWN_CHARS) continue;
      total += f.content.length;
      files.push({ path: f.path, content: f.content });
    }
    out.push({ block: r.block, files, updatedAt: typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt) ? r.updatedAt : Date.now() });
  }
  return out.length ? out : undefined;
}

/** The files a block starts its own code from: Kerf's sketch files for it, flat (READMEs and configs left out). */
export function seedFiles(files: { path: string; content: string }[]): FirmwareCodeRecord["files"] {
  const out: FirmwareCodeRecord["files"] = [];
  for (const f of files) {
    const base = f.path.split("/").pop() ?? "";
    if (OWN_FILE.test(base) && !out.some((x) => x.path === base)) out.push({ path: base, content: f.content });
  }
  return out;
}
