import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Windows and macOS file systems ignore case, Linux (and CI) doesn't. Two
// paths that differ only by case work here and break there: src/ui/viewport
// once had Measure.tsx beside measure.ts, so on Windows `./viewport/Measure`
// resolved to measure.ts and the app loaded blank.

const ROOT = new URL("..", import.meta.url).pathname;
const SKIP = new Set(["node_modules", "dist", ".git", "coverage"]);
// extensions an import may leave out, so `./a` can mean a.ts or A.tsx
const IMPLIED = /\.(?:[cm]?[jt]sx?|json)$/;

function walk(dir: string, files: string[], dirs: string[]) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      dirs.push(relative(ROOT, p));
      walk(p, files, dirs);
    } else files.push(relative(ROOT, p));
  }
}

/** Groups of paths that are the same once lower-cased. */
function clashes(paths: string[]): string[][] {
  const by = new Map<string, string[]>();
  for (const p of paths) by.set(p.toLowerCase(), [...(by.get(p.toLowerCase()) ?? []), p]);
  return [...by.values()].filter((g) => new Set(g).size > 1);
}

describe("file names", () => {
  const files: string[] = [];
  const dirs: string[] = [];
  walk(ROOT, files, dirs);

  it("has no two files or folders whose paths differ only by case", () => {
    expect(clashes(files)).toEqual([]);
    expect(clashes(dirs)).toEqual([]);
  });

  it("has no two modules an import could mix up on a case-insensitive disk", () => {
    const modules = files.filter((f) => IMPLIED.test(f)).map((f) => f.replace(IMPLIED, ""));
    expect(clashes(modules)).toEqual([]);
  });
});
