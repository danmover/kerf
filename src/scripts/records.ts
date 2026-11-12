// Scripts saved with a project: their names, limits, and what is kept of scripts read from a file or another device.

import type { ScriptRecord } from "../persist/db";

export const MAX_SCRIPTS = 50;
export const MAX_SCRIPT_CHARS = 200_000;
export const SCRIPT_ID = /^scr_[a-z0-9]{4,32}$/;

export function cleanScriptName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

/** Why a name can't be used for a script, or null. */
export function scriptNameProblem(name: string, list: ScriptRecord[], exceptId?: string): string | null {
  const clean = cleanScriptName(name);
  if (!clean) return "Give the script a name.";
  if (list.some((s) => s.id !== exceptId && s.name.toLowerCase() === clean.toLowerCase())) return `There is already a script called “${clean}”.`;
  return null;
}

/** "Script", "Script 2", ...: the first that is free. */
export function nextScriptName(list: ScriptRecord[], base = "Script"): string {
  const taken = new Set(list.map((s) => s.name.toLowerCase()));
  const clean = cleanScriptName(base) || "Script";
  if (!taken.has(clean.toLowerCase())) return clean;
  for (let n = 2; ; n++) if (!taken.has(`${clean} ${n}`.toLowerCase())) return `${clean} ${n}`;
}

export function newScriptId(): string {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return `scr_${[...a].map((b) => (b % 36).toString(36)).join("")}`;
}

/**
 * Scripts as Kerf keeps them: well formed, one of each id and name, at most MAX_SCRIPTS. Scripts from a file someone
 * else made don't run after each change until the user turns that on (keepOnChange false).
 */
export function cleanScripts(list: unknown, opts: { keepOnChange: boolean }): ScriptRecord[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out: ScriptRecord[] = [];
  for (const s of list) {
    if (!s || typeof s !== "object") continue;
    const x = s as Partial<ScriptRecord>;
    if (typeof x.id !== "string" || !SCRIPT_ID.test(x.id) || typeof x.code !== "string" || x.code.length > MAX_SCRIPT_CHARS || typeof x.name !== "string") continue;
    const name = cleanScriptName(x.name);
    if (!name || out.some((o) => o.id === x.id || o.name.toLowerCase() === name.toLowerCase())) continue;
    out.push({ id: x.id, name, code: x.code, updatedAt: typeof x.updatedAt === "number" && Number.isFinite(x.updatedAt) ? x.updatedAt : Date.now(), ...(opts.keepOnChange && x.onChange === true ? { onChange: true } : {}) });
    if (out.length >= MAX_SCRIPTS) break;
  }
  return out.length ? out : undefined;
}
