import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTheme } from "../src/app/theme";
import { gridFor, layoutNow, RAIL } from "../src/app/layout";
import { LIGHTING, lightingPreset } from "../src/ui/viewport/render/studio";

const css = (p: string) => readFileSync(new URL(`../src/styles/${p}`, import.meta.url), "utf8");
const tokens = (block: string) => new Map([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const isColour = (v: string) => /^(#|rgba?\(|\d+ \d+ \d+$)/.test(v) || /rgba?\(/.test(v);

describe("themes", () => {
  it("is dark unless light is chosen, or the device is light and the setting follows it", () => {
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("light");
    expect(resolveTheme("system", false)).toBe("dark");
  });

  it("gives every dark colour token a light value", () => {
    const dark = tokens(css("app.css").match(/:root\s*\{([\s\S]*?)\n\}/)![1]);
    const light = tokens(css("theme.css").match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)![1]);
    const missing = [...dark].filter(([k, v]) => isColour(v) && !light.has(k)).map(([k]) => k);
    expect(missing).toEqual([]);
    // and nothing only the light theme knows about
    expect([...light.keys()].filter((k) => !dark.has(k))).toEqual([]);
  });

  it("keeps the colour channels in step with the colours they tint", () => {
    for (const block of [css("app.css").match(/:root\s*\{([\s\S]*?)\n\}/)![1], css("theme.css").match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)![1]]) {
      const t = tokens(block);
      for (const name of ["accent", "accent-2", "cyan", "violet", "pass", "warn", "fail", "info", "bg-0", "bg-1", "bg-2", "bg-3", "line", "text", "text-2"]) {
        const hex = t.get(name)!;
        const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(" ");
        expect(t.get(`${name}-rgb`), name).toBe(rgb);
      }
    }
  });

  it("shows every lighting preset on a light set in the light theme, and leaves dark untouched", () => {
    for (const p of LIGHTING) {
      expect(lightingPreset(p.id, "light").light, p.id).toBe(true);
      expect(lightingPreset(p.id, "dark")).toBe(p);
    }
    expect(lightingPreset("studio", "light").panels).toBe(lightingPreset("studio").panels);
  });

  describe("the boot script", () => {
    const boot = readFileSync(new URL("../public/theme-boot.js", import.meta.url), "utf8");
    const run = (stored: unknown, systemLight: boolean) => {
      const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
      const meta = { content: "", setAttribute(_: string, v: string) { this.content = v; } };
      runInNewContext(boot, {
        localStorage: { getItem: () => (stored === undefined ? null : JSON.stringify(stored)) },
        matchMedia: () => ({ matches: systemLight }),
        document: { documentElement: root, querySelector: () => meta },
      });
      return root.dataset.theme;
    };

    it("picks the same theme as the app, before the app loads", () => {
      for (const pref of ["dark", "light", "system"] as const) for (const sys of [true, false]) expect(run({ theme: pref }, sys)).toBe(resolveTheme(pref, sys));
      expect(run(undefined, true)).toBe("dark");
      expect(run({ theme: "neon" }, true)).toBe("dark");
    });
  });
});

describe("theme setting", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });
  const load = async (stored: unknown) => {
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(stored), setItem: () => undefined, removeItem: () => undefined });
    vi.resetModules();
    return (await import("../src/app/settings")).useSettings.getState().theme;
  };
  it("defaults to dark and keeps only known themes", async () => {
    expect(await load({})).toBe("dark");
    expect(await load({ theme: "light" })).toBe("light");
    expect(await load({ theme: "system" })).toBe("system");
    expect(await load({ theme: "sepia" })).toBe("dark");
  });
});

describe("workspace layouts", () => {
  afterEach(() => vi.unstubAllGlobals());
  const screen = (w: number, h: number) =>
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.split(",").some((part) => {
        const conds = [...part.matchAll(/\((max-width|max-height|orientation): ([\w]+)\)/g)];
        return conds.every(([, f, v]) => (f === "max-width" ? w <= parseInt(v) : f === "max-height" ? h <= parseInt(v) : v === (h > w ? "portrait" : "landscape")));
      }),
    }));

  it("picks a layout from the screen", () => {
    const cases: [number, number, string][] = [
      [390, 844, "phone"],
      [844, 390, "phone"],
      [932, 430, "phone"],
      [820, 1180, "portrait"],
      [768, 1024, "portrait"],
      [1180, 820, "compact"],
      [1024, 768, "compact"],
      [1366, 1024, "wide"],
      [1600, 1000, "wide"],
    ];
    for (const [w, h, want] of cases) {
      screen(w, h);
      expect(layoutNow(), `${w}×${h}`).toBe(want);
    }
  });

  const sizes = { left: 300, right: 384, below: 440, dock: 300 };
  it("leaves the 3D view room on a tablet held sideways", () => {
    for (const w of [1024, 1133, 1180, 1279]) {
      const folded = gridFor("compact", { w, h: 768 }, { ...sizes, panelOpen: false });
      expect(w - folded.leftCol - folded.chat, `${w} folded`).toBeGreaterThanOrEqual(560);
      const open = gridFor("compact", { w, h: 768 }, { ...sizes, panelOpen: true });
      expect(w - open.leftCol - open.chat, `${w} open`).toBeGreaterThanOrEqual(360);
      expect(folded.leftCol).toBe(RAIL);
    }
  });

  it("puts the panel and chat under the 3D view when upright, never over about half the height", () => {
    for (const [w, h] of [[768, 1024], [820, 1180], [1024, 1366]]) {
      const g = gridFor("portrait", { w, h }, { ...sizes, below: 2000, panelOpen: true });
      expect(g.below).toBeLessThanOrEqual(Math.round(h * 0.55));
      expect(w - g.leftCol, "chat width").toBeGreaterThanOrEqual(360);
      expect(g.dock).toBeLessThanOrEqual((h - 72 - g.below) * 0.5 + 1);
    }
  });

  it("keeps the desktop sizes as dragged", () => {
    const g = gridFor("wide", { w: 1600, h: 1000 }, { ...sizes, panelOpen: true });
    expect(g.grid.gridTemplateColumns).toBe("300px minmax(0, 1fr) 384px");
    expect(g.dock).toBe(300);
  });
});
