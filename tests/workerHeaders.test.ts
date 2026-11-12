import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Every web worker gets its own Content-Security-Policy from public/_headers
// (static hosts) and vite.config.ts (`vite preview`). A worker without a rule
// is served with no policy at all, so a new worker must add one to both.

const ROOT = new URL("..", import.meta.url).pathname;

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** the asset name each `new Worker(new URL("./x.worker.ts", ...))` builds to: x.worker-<hash>.js */
function workerAssets(): string[] {
  const names = new Set<string>();
  for (const f of sources(join(ROOT, "src")))
    for (const m of readFileSync(f, "utf8").matchAll(/new Worker\(\s*new URL\(\s*["']\.\/(?:[\w-]+\/)*([\w.-]+)\.ts["']/g)) names.add(m[1]);
  return [...names].sort();
}

describe("worker security headers", () => {
  const headers = readFileSync(join(ROOT, "public/_headers"), "utf8");
  const vite = readFileSync(join(ROOT, "vite.config.ts"), "utf8");
  const workers = workerAssets();

  it("finds the workers", () => {
    expect(workers).toContain("worker");
    expect(workers).toContain("fea.worker");
  });

  it.each(workers)("%s has a policy on static hosts and in vite preview", (name) => {
    expect(headers).toMatch(new RegExp(`^/assets/${name.replace(/\./g, "\\.")}-\\*\\n\\s+Content-Security-Policy: `, "m"));
    // the preview server's path tests: /^\/assets\/fea\.worker-[\w-]+\.js$/ or a group like (render|route)\.worker
    const [stem, ...rest] = name.split(".");
    const tail = rest.length ? `\\\\.${rest.join("\\\\.")}` : "";
    const direct = new RegExp(`\\\\/assets\\\\/${stem}${tail}-\\[`);
    const grouped = new RegExp(`\\\\/assets\\\\/\\(([\\w|]+)\\)${tail}-\\[`, "g");
    const inGroup = [...vite.matchAll(grouped)].some((m) => m[1].split("|").includes(stem));
    expect(direct.test(vite) || inGroup, `vite.config.ts has no Content-Security-Policy for ${name}`).toBe(true);
  });
});
