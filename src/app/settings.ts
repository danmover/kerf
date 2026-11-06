// User preferences (never secrets) in localStorage.

import { create } from "zustand";
import { sanitizeMachines, sanitizeMachineFor, type MachineProfile } from "../mfg/machines";

export const TERMS_VERSION = "2026-10-draft-2";

export const MODELS = [
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", note: "OpenAI: capable design work with balanced cost." },
  { id: "gpt-6-astra", label: "GPT-6 Astra", note: "OpenAI: most capable for complex engineering tasks." },
  { id: "gpt-6-luna", label: "GPT-6 Luna", note: "OpenAI: fast and economical for simpler tasks." },
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
/**
 * quick: every step at low effort with no self-review, for small edits; normal: as set in Settings; thorough: the
 * most thought on the plan, the Settings effort on every later step, and a review of every change, up to 3 rounds.
 */
export type Speed = "quick" | "normal" | "thorough";
export const SPEEDS: { value: Speed; label: string; d: string }[] = [
  { value: "quick", label: "Quick", d: "Thinks briefly and skips the review. Best for small edits." },
  { value: "normal", label: "Normal", d: "As set in Settings: the effort, the follow-up steps and the review." },
  { value: "thorough", label: "Thorough", d: "Thinks hardest, then reviews every change, up to 3 rounds. For hard parts." },
];

/** dark is the default; system follows the device's light or dark setting */
export type ThemePref = "dark" | "light" | "system";

export interface Settings {
  theme: ThemePref;
  model: ModelId;
  effort: Effort;
  /** steps after the first in a reply run at medium effort at most (see ai/stepEffort) */
  fasterFollowUps: boolean;
  /** how hard Claude works on each message, chosen beside Send (see SPEEDS) */
  speed: Speed;
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
  /** let Claude search the web and read pages (Anthropic's server tools) to find parts the catalog lacks */
  webSearch: boolean;
  /** someone who used Kerf before web search existed has yet to be told it is on and what it costs */
  webNotice: boolean;
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
  /** let a cheaper model answer turns that only read the design (see ai/routing) */
  routeQuick: boolean;
  /** plain commands ("fillet 2", "hole M3 here", "wall 3") are done at once, without Claude (see core/quickCommands) */
  quickCommands: boolean;
  /** short, plain change requests run at low effort without the self-review (see ai/routing smallChange) */
  fastChanges: boolean;
  /** the modelling tools beside the 3D view (see ui/ModelTools) */
  advanced: boolean;
  /** minutes to keep the prompt cache warm after Claude's last request while you look (0 = off) */
  keepWarm: number;
  /** prompt tokens at which a long chat's older turns are summarised (see ai/compact) */
  compactAt: number;
  /** show what each reply cost and saved */
  showCost: boolean;
  /** manufacturing processes you have ("own"), can order ("order") or cannot use ("none"); missing ones can be ordered */
  processAccess: Record<string, "own" | "order" | "none">;
  /** what an hour of your own hands-on time is worth in cost estimates, US dollars */
  labourRate: number;
  /** parts the user already has, one per line as they would say it ("M3x10 socket", "M3 nut", "17HS4401", "Arduino Nano"): preferred when they fit, and not counted in the cost */
  onHand: string[];
  /** your own machine and shop profiles (copies of presets or your own), see mfg/machines */
  machines: MachineProfile[];
  /** the machine each process's parts are checked against, by process id (a preset's or your machine's id) */
  machineFor: Record<string, string>;
  /** what the user said they make with Kerf ("maker", "engineer", "student", "manufacturer"; empty: not asked yet), which orders the starting points */
  audience: string;
  /** version of these defaults the stored settings were last migrated to */
  rev: number;
}

/** Steps per message: enough for Claude to design, wire, check and review a whole machine in one go. */
export const DEFAULT_STEPS = 50;
export const MIN_STEPS = 4;
export const MAX_STEPS = 80;
const SETTINGS_REV = 3;

export type VoiceSend = "review" | "auto";

const DEFAULTS: Settings = {
  theme: "dark",
  model: "claude-opus-5-5",
  effort: "high",
  fasterFollowUps: true,
  speed: "normal",
  showThinking: true,
  reduceMotion: false,
  grid: true,
  edges: true,
  lighting: "studio",
  lightAngle: 0,
  quality: "balanced",
  photoreal: false,
  maxSteps: DEFAULT_STEPS,
  webSearch: true,
  webNotice: false,
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
  routeQuick: true,
  quickCommands: true,
  fastChanges: true,
  advanced: false,
  keepWarm: 30,
  compactAt: 500_000,
  showCost: true,
  processAccess: {},
  labourRate: 20,
  onHand: [],
  machines: [],
  machineFor: {},
  audience: "",
  rev: SETTINGS_REV,
};

/** keep-warm durations the settings offer, in minutes */
export const KEEP_WARM_MINUTES = [0, 15, 30, 60];
/** prompt sizes a long chat can be summarised at; every model Kerf offers reads up to 1M tokens */
export const COMPACT_AT_TOKENS = [200_000, 350_000, 500_000, 750_000];

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
    // settings saved before rev 2 had no rev; their untouched 16-step default becomes the new default
    if (typeof v.rev !== "number" || v.rev < 2) {
      if (v.maxSteps === undefined || v.maxSteps === 16) out.maxSteps = DEFAULT_STEPS;
      // web search arrived switched on: tell them once, before it can cost them anything
      if (v.webSearch === undefined) out.webNotice = true;
    }
    // the 30-step default became 50, so a reply stops for "continue" less often; a limit someone chose stays
    if (typeof v.rev !== "number" || v.rev < 3) {
      if (out.maxSteps === 30) out.maxSteps = DEFAULT_STEPS;
    }
    out.rev = SETTINGS_REV;
    out.maxSteps = Math.min(MAX_STEPS, Math.max(MIN_STEPS, Math.round(Number.isFinite(out.maxSteps) ? out.maxSteps : DEFAULT_STEPS)));
    if (out.voiceSend !== "review" && out.voiceSend !== "auto") out.voiceSend = DEFAULTS.voiceSend;
    if (!/^([a-z]{2,3}(-[A-Za-z0-9]{2,8})*)?$/.test(out.voiceLang)) out.voiceLang = DEFAULTS.voiceLang;
    if (!LIGHTING_IDS.includes(out.lighting)) out.lighting = DEFAULTS.lighting;
    if (!["", "maker", "engineer", "student", "manufacturer"].includes(out.audience)) out.audience = DEFAULTS.audience;
    if (!["draft", "balanced", "high"].includes(out.quality)) out.quality = DEFAULTS.quality;
    out.lightAngle = Number.isFinite(out.lightAngle) ? ((Math.round(out.lightAngle) % 360) + 360) % 360 : 0;
    if (out.agentModel !== "same" && !MODELS.some((m) => m.id === out.agentModel)) out.agentModel = "same";
    out.agentParallel = Math.min(8, Math.max(1, Math.round(out.agentParallel)));
    out.agentBudget = Math.min(100, Math.max(0.5, Number(out.agentBudget) || DEFAULTS.agentBudget));
    out.agentWorkers = Math.min(4, Math.max(0, Math.round(out.agentWorkers)));
    if (!["off", "auto", "always"].includes(out.selfReview)) out.selfReview = DEFAULTS.selfReview;
    if (!SPEEDS.some((x) => x.value === out.speed)) out.speed = DEFAULTS.speed;
    out.reviewRounds = Math.min(3, Math.max(1, Math.round(out.reviewRounds) || DEFAULTS.reviewRounds));
    if (!KEEP_WARM_MINUTES.includes(out.keepWarm)) out.keepWarm = DEFAULTS.keepWarm;
    if (!COMPACT_AT_TOKENS.includes(out.compactAt)) out.compactAt = DEFAULTS.compactAt;
    const access: Settings["processAccess"] = {};
    if (out.processAccess && typeof out.processAccess === "object" && !Array.isArray(out.processAccess)) {
      for (const [k, a] of Object.entries(out.processAccess)) if (/^[a-z_]{2,24}$/.test(k) && (a === "own" || a === "order" || a === "none")) access[k] = a;
    }
    out.processAccess = access;
    out.labourRate = Math.min(500, Math.max(0, Number.isFinite(out.labourRate) ? out.labourRate : DEFAULTS.labourRate));
    out.onHand = cleanOnHand(out.onHand);
    out.machines = sanitizeMachines(out.machines);
    out.machineFor = sanitizeMachineFor(out.machineFor) as Record<string, string>;
    // the photoreal view starts off on every load: a GPU that hangs while path tracing must not be sent back into it
    out.photoreal = false;
    return out;
  } catch {
    return DEFAULTS;
  }
}

/** The on-hand list as stored: short lines of text, no blanks or repeats, a few hundred at most. */
export function cleanOnHand(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") continue;
    const t = x.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
    if (out.length >= 300) break;
  }
  return out;
}

export const useSettings = create<Settings>(() => load());

useSettings.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage full or blocked: settings stay for this session */
  }
});

export const updateSettings = (patch: Partial<Settings>) => {
  if (patch.model && patch.model.startsWith("gpt-") !== useSettings.getState().model.startsWith("gpt-")) patch = { ...patch, agentModel: "same" };
  useSettings.setState(patch);
};
export const resetSettings = () => useSettings.setState({ ...DEFAULTS, termsAccepted: useSettings.getState().termsAccepted, onboarded: true });
export const clearSettingsStorage = () => {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
};
