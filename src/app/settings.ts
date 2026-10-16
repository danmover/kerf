// User preferences (never secrets) in localStorage.

import { create } from "zustand";

export const TERMS_VERSION = "2026-10-draft-1";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", note: "Most capable. Best for whole designs and big revisions." },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "Fast and strong. Good for most edits." },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", note: "Fastest and cheapest. Good for small changes." },
] as const;

export type ModelId = (typeof MODELS)[number]["id"];
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Settings {
  model: ModelId;
  effort: Effort;
  showThinking: boolean;
  reduceMotion: boolean;
  grid: boolean;
  edges: boolean;
  /** maximum Claude tool-loop iterations per message */
  maxSteps: number;
  /** let Claude search the web and read pages (Anthropic's server tools) to find parts the catalog lacks */
  webSearch: boolean;
  termsAccepted: string | null;
  onboarded: boolean;
  /** version of these defaults the stored settings were last migrated to */
  rev: number;
}

/** Steps per message: enough for Claude to design, wire and check a whole machine in one go. */
export const DEFAULT_STEPS = 30;
export const MIN_STEPS = 4;
export const MAX_STEPS = 80;
const SETTINGS_REV = 2;

const DEFAULTS: Settings = {
  model: "claude-opus-5-5",
  effort: "high",
  showThinking: true,
  reduceMotion: false,
  grid: true,
  edges: true,
  maxSteps: DEFAULT_STEPS,
  webSearch: true,
  termsAccepted: null,
  onboarded: false,
  rev: SETTINGS_REV,
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
    // settings saved before rev 2 had no rev; their untouched 16-step default becomes the new default
    if (typeof v.rev !== "number" || v.rev < 2) {
      if (v.maxSteps === undefined || v.maxSteps === 16) out.maxSteps = DEFAULT_STEPS;
    }
    out.rev = SETTINGS_REV;
    out.maxSteps = Math.min(MAX_STEPS, Math.max(MIN_STEPS, Math.round(Number.isFinite(out.maxSteps) ? out.maxSteps : DEFAULT_STEPS)));
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
