// User preferences (never secrets) in localStorage.

import { create } from "zustand";

export const TERMS_VERSION = "2026-10-draft-1";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", note: "Most capable. Best for whole designs and big revisions." },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "Fast and strong. Good for most edits." },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", note: "Fastest and cheapest. Good for small changes." },
] as const;

/** Lighting presets the viewport offers; kept here so settings stay free of three.js. */
export const LIGHTING_IDS = ["studio", "showroom", "blueprint", "workshop", "daylight"];

export type ModelId = (typeof MODELS)[number]["id"];
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Settings {
  model: ModelId;
  effort: Effort;
  showThinking: boolean;
  reduceMotion: boolean;
  grid: boolean;
  edges: boolean;
  /** viewport lighting preset (see ui/viewport/render/studio) */
  lighting: string;
  /** how far the lighting is turned about the vertical axis, degrees */
  lightAngle: number;
  /** viewport render quality: draft renders one pass; balanced and high refine while the view is still */
  quality: "draft" | "balanced" | "high";
  /** photoreal view: path traces the scene while the camera is still */
  photoreal: boolean;
  /** maximum Claude tool-loop iterations per message */
  maxSteps: number;
  termsAccepted: string | null;
  onboarded: boolean;
}

const DEFAULTS: Settings = {
  model: "claude-opus-5-5",
  effort: "high",
  showThinking: true,
  reduceMotion: false,
  grid: true,
  edges: true,
  lighting: "studio",
  lightAngle: 0,
  quality: "balanced",
  photoreal: false,
  maxSteps: 16,
  termsAccepted: null,
  onboarded: false,
};

const KEY = "kerf.settings.v1";

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const v = JSON.parse(raw) as Partial<Settings>;
    const out = { ...DEFAULTS };
    // accept only known keys with the right types
    for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
      if (k in v && typeof v[k] === typeof DEFAULTS[k]) (out as Record<string, unknown>)[k] = v[k];
      if (k === "termsAccepted" && typeof v.termsAccepted === "string") out.termsAccepted = v.termsAccepted;
    }
    if (!MODELS.some((m) => m.id === out.model)) out.model = DEFAULTS.model;
    if (!["low", "medium", "high", "xhigh", "max"].includes(out.effort)) out.effort = DEFAULTS.effort;
    out.maxSteps = Math.min(40, Math.max(4, Math.round(out.maxSteps)));
    if (!LIGHTING_IDS.includes(out.lighting)) out.lighting = DEFAULTS.lighting;
    if (!["draft", "balanced", "high"].includes(out.quality)) out.quality = DEFAULTS.quality;
    out.lightAngle = Number.isFinite(out.lightAngle) ? ((Math.round(out.lightAngle) % 360) + 360) % 360 : 0;
    return out;
  } catch {
    return DEFAULTS;
  }
}

export const useSettings = create<Settings>(() => load());

useSettings.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage full or blocked: settings stay for this session */
  }
});

export const updateSettings = (patch: Partial<Settings>) => useSettings.setState(patch);
export const resetSettings = () => useSettings.setState({ ...DEFAULTS, termsAccepted: useSettings.getState().termsAccepted, onboarded: true });
export const clearSettingsStorage = () => {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
};
