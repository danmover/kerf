// The desktop app's own settings, kept in a small JSON file next to Kerf's
// data. Graphics switches have to be in place before Chromium starts its GPU
// process, so they are read synchronously at launch and changed by restarting.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

/** How Chromium talks to the graphics card. `auto` is Chromium's own choice: Direct3D 11 on Windows. */
export type GraphicsBackend = "auto" | "d3d11" | "vulkan" | "gl";

export interface DesktopSettings {
  graphics: GraphicsBackend;
  /** Kerf's tools for the person's own Claude Code (desktop/mcp.ts): off until they turn it on in Settings → AI */
  claudeCode: {
    enabled: boolean;
    port: number;
    token: string;
    /** how Kerf added its bridge to Claude Code with Connect, so a moved or updated Kerf can put it right; null when it hasn't */
    registered: { command: string; args: string[] } | null;
  };
}

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

const DEFAULTS: DesktopSettings = { graphics: "auto", claudeCode: { enabled: false, port: 47615, token: "", registered: null } };

/** Backends worth offering: only Windows has a real choice between them. */
export function backendsFor(platform: NodeJS.Platform): GraphicsBackend[] {
  return platform === "win32" ? ["auto", "d3d11", "vulkan", "gl"] : ["auto"];
}

function readJson<T>(file: string): Partial<T> {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function writeJson(file: string, v: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  // written whole and then swapped in, because Claude Code's bridge reads the settings while Kerf runs
  writeFileSync(`${file}.tmp`, JSON.stringify(v, null, 2) + "\n");
  renameSync(`${file}.tmp`, file);
}

export function loadSettings(dir: string, platform: NodeJS.Platform): DesktopSettings {
  const s = { ...DEFAULTS, ...readJson<DesktopSettings>(join(dir, "desktop-settings.json")) };
  if (!backendsFor(platform).includes(s.graphics)) s.graphics = "auto";
  const cc = (s.claudeCode ?? {}) as Partial<DesktopSettings["claudeCode"]>;
  s.claudeCode = {
    enabled: cc.enabled === true,
    port: Number.isInteger(cc.port) && cc.port! >= 1024 && cc.port! < 65536 ? cc.port! : DEFAULTS.claudeCode.port,
    token: typeof cc.token === "string" && cc.token.length >= 32 ? cc.token : "",
    registered:
      cc.registered && typeof cc.registered.command === "string" && Array.isArray(cc.registered.args) && cc.registered.args.every((a) => typeof a === "string")
        ? { command: cc.registered.command, args: cc.registered.args }
        : null,
  };
  return s;
}

export function saveSettings(dir: string, s: DesktopSettings) {
  writeJson(join(dir, "desktop-settings.json"), s);
}

export function loadWindowState(dir: string): WindowState | null {
  const s = readJson<WindowState>(join(dir, "window-state.json"));
  if (!(Number(s.width) >= 400 && Number(s.height) >= 300)) return null;
  return { x: s.x, y: s.y, width: Number(s.width), height: Number(s.height), maximized: !!s.maximized };
}

export function saveWindowState(dir: string, s: WindowState) {
  try {
    writeJson(join(dir, "window-state.json"), s);
  } catch {
    /* a read-only profile: the window opens at its default size next time */
  }
}
