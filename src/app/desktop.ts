// What the desktop app (desktop/preload.ts) adds to the page. In a browser
// none of this exists and desktop() returns null.

export type GraphicsBackend = "auto" | "d3d11" | "vulkan" | "gl";

export interface DesktopInfo {
  version: string;
  platform: string;
  electron: string;
  chrome: string;
  /** the backend chosen in Settings, used from the next start */
  graphics: GraphicsBackend;
  /** the backend this launch is using */
  running: GraphicsBackend;
  backends: GraphicsBackend[];
  /** the backend Kerf switched back to Auto from at this launch because it couldn't start 3D, or "" */
  resetFrom?: string;
}

/** Kerf's tools served to the person's own Claude Code (desktop/mcp.ts). */
export interface ClaudeCodeInfo {
  enabled: boolean;
  running: boolean;
  url: string;
  token: string;
  /** why the server could not start, e.g. every port taken */
  error: string;
  /** the last program that connected since Kerf started, e.g. "claude-code 2.1.323" */
  lastConnect?: { at: number; client: string } | null;
  /** the last time a program was turned away for a missing or old token */
  lastRefused?: { at: number; why: "no-token" | "wrong-token" } | null;
}

export interface ClaudeCodeBridge {
  info(): Promise<ClaudeCodeInfo>;
  setEnabled(on: boolean): Promise<ClaudeCodeInfo>;
  newToken(): Promise<ClaudeCodeInfo>;
  serve(page: { run(id: number, method: string, params: unknown): Promise<unknown>; cancel(id: number): void }): Promise<void>;
}

export interface DesktopBridge {
  info(): Promise<DesktopInfo>;
  setGraphics(b: GraphicsBackend): Promise<void>;
  relaunch(): Promise<void>;
  /** tells the app this launch has no hardware WebGL 2; with a backend chosen in Settings it goes back to Auto and restarts */
  graphicsFailed?(): Promise<{ relaunching: boolean }>;
  claudeCode: ClaudeCodeBridge;
}

export function desktop(): DesktopBridge | null {
  return (window as unknown as { kerfDesktop?: DesktopBridge }).kerfDesktop ?? null;
}

/** WebGL 2's renderer string ("ANGLE (AMD, …)"), or null when WebGL 2 can't start at all. */
export function webglRenderer(): string | null {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return name;
  } catch {
    return null;
  }
}

/** The renderer emulates a GPU on the CPU (Chromium's SwiftShader, Windows' Basic Render Driver, Mesa's llvmpipe). */
export function isSoftwareRenderer(name: string): boolean {
  return /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render/i.test(name);
}

/** The graphics card WebGL draws with, as the browser reports it. */
export function graphicsCard(): string {
  const name = webglRenderer();
  return name === null ? "No WebGL 2" : cardName(name);
}

const BACKEND_NAMES: Record<string, string> = { d3d11: "Direct3D 11", vulkan: "Vulkan", gl: "OpenGL" };

/**
 * Run once at desktop startup. With no hardware WebGL 2 and a backend picked in
 * Settings, the app goes back to Auto and restarts. Otherwise it says what
 * happened: a backend that was switched back, or 3D drawn in software.
 */
export async function checkDesktopGraphics(say: (t: { kind: "warn" | "info"; title: string; detail: string }) => void) {
  const app = desktop();
  if (!app) return;
  const name = webglRenderer();
  const hardware = name !== null && !isSoftwareRenderer(name);
  if (!hardware) {
    const r = await app.graphicsFailed?.().catch(() => null);
    if (r?.relaunching) return;
  }
  const info = await app.info().catch(() => null);
  if (info?.resetFrom) {
    say({
      kind: "info",
      title: "Graphics switched back to Auto",
      detail: `${BACKEND_NAMES[info.resetFrom] ?? info.resetFrom} couldn't start 3D on this PC, so Kerf is using Auto again. You can change it in Settings → Display → Graphics.`,
    });
  }
  if (name !== null && !hardware) {
    say({
      kind: "warn",
      title: "3D is drawing in software",
      detail: "Kerf can't use this PC's graphics card right now (Remote Desktop, a missing or old graphics driver, or a virtual machine), so the 3D view will be slow and photoreal is off. Updating the graphics driver usually fixes it.",
    });
  }
}

/**
 * The card's name from WebGL's renderer string, which Chromium wraps in ANGLE's
 * description of the backend: "ANGLE (AMD, AMD Radeon RX 7800 XT (0x0000747E)
 * Direct3D11 vs_5_0 ps_5_0, D3D11)" or "ANGLE (AMD, Vulkan 1.3.260 (AMD Radeon
 * RX 7800 XT (0x0000747E)), AMD proprietary driver)".
 */
export function cardName(renderer: string): string {
  const m = /^ANGLE \((.*)\)$/.exec(renderer.trim());
  if (!m) return renderer;
  // the fields are separated by ", " outside brackets: vendor, device, driver
  const fields: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < m[1].length; i++) {
    const c = m[1][i];
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (depth === 0 && m[1].startsWith(", ", i)) {
      fields.push(cur);
      cur = "";
      i++;
    } else cur += c;
  }
  fields.push(cur);
  let device = fields[1] ?? fields[0];
  const inner = /^(?:Vulkan|OpenGL|Metal)[^(]*\((.*)\)$/.exec(device);
  if (inner) device = inner[1];
  return device.replace(/ \(0x[0-9a-f]+\)/i, "").replace(/ (Direct3D|OpenGL|Vulkan|Metal).*$/, "").trim() || renderer;
}
