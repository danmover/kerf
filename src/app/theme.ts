// Light and dark themes. Dark is the default; "system" follows the device.
// The theme lives on <html data-theme>, so CSS follows it through the tokens
// in styles/theme.css, and code that draws its own colours (the 3D view, the
// code editor, canvases) reads it with useTheme() or currentTheme().

import { useLayoutEffect, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { updateSettings, useSettings, type ThemePref } from "./settings";

export type Theme = "dark" | "light";

const LIGHT_QUERY = "(prefers-color-scheme: light)";

/** The browser chrome colour on phones, matching --bg-1 of each theme. */
const CHROME: Record<Theme, string> = { dark: "#0b0e14", light: "#f5f6f9" };

export function resolveTheme(pref: ThemePref, systemLight: boolean): Theme {
  return pref === "light" || (pref === "system" && systemLight) ? "light" : "dark";
}

const systemLight = () => typeof matchMedia !== "undefined" && matchMedia(LIGHT_QUERY).matches;

function subscribeSystem(cb: () => void) {
  if (typeof matchMedia === "undefined") return () => {};
  const mq = matchMedia(LIGHT_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/** The theme on screen now. */
export function useTheme(): Theme {
  const pref = useSettings((s) => s.theme);
  const sys = useSyncExternalStore(subscribeSystem, systemLight, () => false);
  return resolveTheme(pref, sys);
}

/** The theme on screen now, outside React. */
export const currentTheme = (): Theme => (typeof document !== "undefined" && document.documentElement.dataset.theme === "light" ? "light" : "dark");

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (root.dataset.theme === theme) return;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", CHROME[theme]);
}

/** Keep <html data-theme> in step with the setting and the device. Mounted once, in App. */
export function useThemeSync() {
  const theme = useTheme();
  useLayoutEffect(() => applyTheme(theme), [theme]);
  return theme;
}

// where the last press was, so a theme picked from a menu opens from there
let lastPress: { x: number; y: number } | null = null;
if (typeof window !== "undefined") window.addEventListener("pointerdown", (e) => (lastPress = { x: e.clientX, y: e.clientY }), { capture: true, passive: true });

/**
 * Change the theme setting. When it changes what is on screen, the new theme
 * opens as a circle from `from` (or the last press), where the
 * browser supports view transitions and motion is not reduced.
 */
export function setTheme(pref: ThemePref, from?: { x: number; y: number }) {
  const next = resolveTheme(pref, systemLight());
  const change = () => {
    // render synchronously, so the transition's "after" picture is the new theme everywhere
    flushSync(() => updateSettings({ theme: pref }));
    applyTheme(next);
  };
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  const still = useSettings.getState().reduceMotion || (typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  if (next === currentTheme() || still || !doc.startViewTransition) return change();
  const root = document.documentElement;
  const at = from ?? lastPress;
  const x = at?.x ?? innerWidth / 2;
  const y = at?.y ?? innerHeight / 2;
  root.style.setProperty("--theme-x", `${x}px`);
  root.style.setProperty("--theme-y", `${y}px`);
  root.style.setProperty("--theme-r", `${Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))}px`);
  doc.startViewTransition(change);
}

/** Flip between light and dark from a button, opening the new theme from it. */
export function toggleTheme(e?: { currentTarget: Element }) {
  const r = e?.currentTarget.getBoundingClientRect();
  setTheme(currentTheme() === "light" ? "dark" : "light", r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : undefined);
}
