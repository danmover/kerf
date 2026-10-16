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
/** off: only when Claude asks for one · auto: after substantial changes · always: after every change */
export type SelfReview = "off" | "auto" | "always";

/** dark is the default; system follows the device's light or dark setting */
export type ThemePref = "dark" | "light" | "system";

export interface Settings {
  theme: ThemePref;
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
  /** maximum Claude tool-loop iterations per message */
  maxSteps: number;
  /** when an independent reviewer checks Claude's changes before it reports back */
  selfReview: SelfReview;
  /** review rounds per reply: the first review plus re-checks after fixes */
  reviewRounds: number;
  termsAccepted: string | null;
  onboarded: boolean;
  /** the user allowed the browser's online speech service, for when the device cannot recognise speech itself */
  voiceOnline: boolean;
  /** after the user stops talking: leave the words to review, or send them */
  voiceSend: VoiceSend;
  /** speech language as a BCP 47 tag; empty means the browser's language */
  voiceLang: string;
  /** parallel subassembly agents: model ("same" follows the chat model) */
  agentModel: string;
  /** how many agents may call Claude at once */
  agentParallel: number;
  /** spending cap per parallel build, in US dollars */
  agentBudget: number;
  /** show the plan and its cost before agents start */
  agentReview: boolean;
  /** extra geometry workers for agents' checks (0 = decide from the device) */
  agentWorkers: number;
}

export type VoiceSend = "review" | "auto";

const DEFAULTS: Settings = {
  theme: "dark",
  model: "claude-opus-5-5",
  effort: "high",
  showThinking: true,
  reduceMotion: false,
  grid: true,
  edges: true,
  lighting: "studio",
  lightAngle: 0,
  quality: "balanced",
  maxSteps: 16,
  selfReview: "auto",
  reviewRounds: 2,
  termsAccepted: null,
  onboarded: false,
  voiceOnline: false,
  voiceSend: "review",
  voiceLang: "",
  agentModel: "same",
  agentParallel: 4,
  agentBudget: 5,
  agentReview: true,
  agentWorkers: 0,
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
    if (!["dark", "light", "system"].includes(out.theme)) out.theme = DEFAULTS.theme;
    if (!MODELS.some((m) => m.id === out.model)) out.model = DEFAULTS.model;
    if (!["low", "medium", "high", "xhigh", "max"].includes(out.effort)) out.effort = DEFAULTS.effort;
    out.maxSteps = Math.min(40, Math.max(4, Math.round(out.maxSteps)));
    if (out.voiceSend !== "review" && out.voiceSend !== "auto") out.voiceSend = DEFAULTS.voiceSend;
    if (!/^([a-z]{2,3}(-[A-Za-z0-9]{2,8})*)?$/.test(out.voiceLang)) out.voiceLang = DEFAULTS.voiceLang;
    if (!LIGHTING_IDS.includes(out.lighting)) out.lighting = DEFAULTS.lighting;
    if (!["draft", "balanced", "high"].includes(out.quality)) out.quality = DEFAULTS.quality;
    out.lightAngle = Number.isFinite(out.lightAngle) ? ((Math.round(out.lightAngle) % 360) + 360) % 360 : 0;
    if (out.agentModel !== "same" && !MODELS.some((m) => m.id === out.agentModel)) out.agentModel = "same";
    out.agentParallel = Math.min(8, Math.max(1, Math.round(out.agentParallel)));
    out.agentBudget = Math.min(100, Math.max(0.5, Number(out.agentBudget) || DEFAULTS.agentBudget));
    out.agentWorkers = Math.min(4, Math.max(0, Math.round(out.agentWorkers)));
    if (!["off", "auto", "always"].includes(out.selfReview)) out.selfReview = DEFAULTS.selfReview;
    out.reviewRounds = Math.min(3, Math.max(1, Math.round(out.reviewRounds) || DEFAULTS.reviewRounds));
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
