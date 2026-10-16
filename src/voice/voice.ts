// Voice input: one listening session at a time, the privacy choice of where
// speech is turned into text, and the pause and time limits that keep the
// microphone from staying on.
//
// Where audio goes: Kerf prefers recognition on the device (the audio never
// leaves it). Only if the device cannot, and the user has allowed it, does the
// browser send audio to its maker's speech service. Kerf itself never records,
// stores or uploads audio; it only receives the text.

import { create } from "zustand";
import { useSettings, updateSettings } from "../app/settings";
import { toast } from "../app/ui";
import { canAskOnDevice, hasRecognizer, installOnDevice, listen, onDeviceStatus, type OnDevice, type Session } from "./recognizer";
import { phrasesFor, serviceName, speechProvider, type Provider } from "./text";

export type VoicePhase =
  /** nothing happening */
  | "idle"
  /** asking the browser whether it can recognise speech on the device */
  | "checking"
  /** the device cannot recognise speech yet: offer the download or the online service */
  | "offer"
  /** downloading the on-device speech model */
  | "downloading"
  | "listening"
  /** asked to stop; the last words are arriving */
  | "finishing"
  /** heard; sending to Claude after a short countdown the user can cancel */
  | "sending"
  /** this browser has no speech recognition */
  | "unsupported"
  | "error";

export interface VoiceError {
  title: string;
  detail?: string;
  /** offer to open voice settings */
  settings?: boolean;
  /** clears itself after a few seconds */
  soft?: boolean;
}

/** The composer (or any text box) that receives the words. */
export interface VoiceClient {
  /** a session is starting: remember what is already in the box */
  begin(): void;
  /** everything heard so far in this session */
  text(spoken: string): void;
  /** the session ended normally with these words */
  done(spoken: string): void;
  /** the session was cancelled: put the box back as it was */
  cancel(): void;
  /** send the box's text now */
  send(): void;
  /** whether a message can be sent right now (false while Claude is working) */
  canSend(): boolean;
  /** names worth listening out for, such as the design's parts and parameters */
  vocabulary?(): string[];
}

interface VoiceState {
  phase: VoicePhase;
  /** where the current session is recognised */
  where: "device" | "online" | null;
  /** what the device can do for the current language, once known */
  onDevice: OnDevice | null;
  lang: string;
  provider: Provider;
  final: string;
  interim: string;
  startedAt: number;
  /** the microphone is on (the browser may first ask for permission) */
  ready: boolean;
  /** increments whenever sound or words arrive; drives the level animation */
  pulse: number;
  /** when the countdown to send ends (phase "sending") */
  sendAt: number;
  error: VoiceError | null;
}

export const PAUSE_MS = 2500;
export const FIRST_WORDS_MS = 8000;
export const MAX_MS = 120_000;
export const SEND_DELAY_MS = 1800;

function browserProvider(): Provider {
  if (typeof navigator === "undefined") return "other";
  const n = navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } };
  return speechProvider({ userAgent: n.userAgent, vendor: n.vendor, maxTouchPoints: n.maxTouchPoints, brands: n.userAgentData?.brands?.map((b) => b.brand) });
}

export function voiceLang(): string {
  const chosen = useSettings.getState().voiceLang;
  if (chosen) return chosen;
  return (typeof navigator !== "undefined" && navigator.language) || "en-US";
}

/** The most widely supported variant of each language, for on-device models that only ship one. */
const MAIN_VARIANT: Record<string, string> = { en: "en-US", de: "de-DE", fr: "fr-FR", es: "es-ES", it: "it-IT", pt: "pt-BR", nl: "nl-NL", sv: "sv-SE", pl: "pl-PL", ja: "ja-JP", ko: "ko-KR", zh: "zh-CN", hi: "hi-IN" };

/**
 * Languages to try, best first. With the browser's language (not one the
 * user picked), the main variant is a fallback, so someone whose browser says
 * en-GB can still keep speech on the device with the en-US model.
 */
export function langCandidates(): string[] {
  const lang = voiceLang();
  if (useSettings.getState().voiceLang) return [lang];
  const main = MAIN_VARIANT[lang.split("-")[0].toLowerCase()];
  return main && main !== lang ? [lang, main] : [lang];
}

export const useVoice = create<VoiceState>(() => ({
  phase: "idle",
  where: null,
  onDevice: null,
  lang: "en-US",
  provider: browserProvider(),
  final: "",
  interim: "",
  startedAt: 0,
  ready: false,
  pulse: 0,
  sendAt: 0,
  error: null,
}));

const set = useVoice.setState;
const get = useVoice.getState;

let client: VoiceClient | null = null;
let session: Session | null = null;
let timers: ReturnType<typeof setTimeout>[] = [];
let pauseTimer: ReturnType<typeof setTimeout> | null = null;
let sendTimer: ReturnType<typeof setTimeout> | null = null;
let softTimer: ReturnType<typeof setTimeout> | null = null;
let lastError: string | null = null;
let usedPhrases = false;
/** on-device status per language, so a known answer starts listening without waiting */
const known = new Map<string, OnDevice>();

const spoken = () => {
  const { final, interim } = get();
  return [final, interim].filter(Boolean).join(" ");
};

function clearTimers() {
  for (const t of timers) clearTimeout(t);
  timers = [];
  if (pauseTimer) clearTimeout(pauseTimer);
  pauseTimer = null;
}

function fail(e: VoiceError) {
  if (softTimer) clearTimeout(softTimer);
  set({ phase: "error", error: e, where: null });
  if (e.soft) softTimer = setTimeout(() => get().phase === "error" && get().error === e && set({ phase: "idle", error: null }), 5000);
}

/** The mic button: start listening, or stop if already listening. */
export function toggleVoice(c: VoiceClient) {
  const p = get().phase;
  if (p === "listening") return stopVoice();
  if (p === "finishing" || p === "checking" || p === "downloading") return;
  if (p === "sending") return holdSend();
  void startVoice(c);
}

/** Start a session. Call from a click or key press: browsers want a user gesture. */
export async function startVoice(c: VoiceClient) {
  client = c;
  if (sendTimer) clearTimeout(sendTimer);
  set({ provider: browserProvider(), error: null });
  if (!hasRecognizer()) return set({ phase: "unsupported" });

  // Remembered answers start at once, still inside the click (Safari needs that).
  const pick = await chooseLang(() => set({ phase: "checking" }));
  if (!pick) return; // dismissed while checking
  set({ lang: pick.lang, onDevice: pick.status });
  if (pick.status === "available") return begin(true);
  if (useSettings.getState().voiceOnline) return begin(false);
  set({ phase: "offer" });
}

/**
 * The language to listen in and whether the device can recognise it. Prefers
 * a language the device can handle; asks the browser only for answers not
 * already known. Returns null if voice input was dismissed while waiting.
 */
async function chooseLang(onWait?: () => void): Promise<{ lang: string; status: OnDevice } | null> {
  const langs = langCandidates();
  if (!canAskOnDevice()) return { lang: langs[0], status: "unavailable" };
  let waited = false;
  for (const lang of langs) {
    let status = known.get(lang);
    if (!status) {
      if (!waited) onWait?.();
      waited = true;
      status = await onDeviceStatus(lang);
      known.set(lang, status);
      if (onWait && get().phase !== "checking") return null;
    }
    if (status !== "unavailable") return { lang, status };
  }
  return { lang: langs[0], status: "unavailable" };
}

/** What the device can do in the current speech language, or "none" when the browser has no recogniser. */
export async function checkOnDevice(): Promise<{ lang: string; status: OnDevice | "none" }> {
  if (!hasRecognizer()) return { lang: voiceLang(), status: "none" };
  for (const l of langCandidates()) known.delete(l);
  const pick = (await chooseLang())!;
  set({ lang: pick.lang, onDevice: pick.status });
  return pick;
}

/** Download the on-device speech model (from a click). */
export async function downloadSpeechModel(lang = get().lang): Promise<OnDevice> {
  set({ phase: "downloading", lang, error: null });
  const ok = await installOnDevice(lang);
  const status = ok ? "available" : await onDeviceStatus(lang);
  known.set(lang, status);
  set({ onDevice: status });
  const shown = get().phase === "downloading";
  if (shown) set({ phase: "idle" });
  const failed = { title: "The speech model did not download", detail: "Check your connection and free space, then try again. You can also allow the browser's online speech service in Settings → Voice.", settings: true };
  if (status === "available") toast({ kind: "success", title: "Voice is ready", detail: "Speech is now turned into text on this device. Tap the mic to talk." });
  else if (shown) fail(failed);
  else toast({ kind: "warn", title: failed.title, detail: failed.detail });
  return status;
}

/** The user agreed to the browser's online speech service (from a click). */
export function allowOnlineSpeech() {
  updateSettings({ voiceOnline: true });
  if (client) begin(false);
}

function begin(local: boolean, withPhrases = true) {
  const c = client;
  if (!c) return;
  clearTimers();
  lastError = null;
  const lang = get().lang;
  const phrases = local && withPhrases ? phrasesFor(c.vocabulary?.() ?? []) : undefined;
  usedPhrases = !!phrases?.length;
  c.begin();
  try {
    session = listen(
      { lang, local, phrases },
      {
        // the limits count from when the mic is actually on, not from the permission prompt
        onStart: () => {
          if (get().phase !== "listening") return;
          set({ startedAt: Date.now(), ready: true });
          timers.push(
            setTimeout(() => {
              if (get().phase === "listening" && !spoken()) stopVoice();
            }, FIRST_WORDS_MS),
            setTimeout(() => get().phase === "listening" && stopVoice(), MAX_MS),
          );
        },
        onText: (final, interim) => {
          set({ final, interim });
          c.text(spoken());
        },
        onActivity: () => {
          set((s) => ({ pulse: s.pulse + 1 }));
          armPause();
        },
        onError: (code) => {
          lastError = code;
        },
        onEnd: () => end(local),
      },
    );
  } catch {
    c.cancel();
    return set({ phase: "unsupported" });
  }
  set({ phase: "listening", where: local ? "device" : "online", final: "", interim: "", startedAt: Date.now(), ready: false, error: null });
}

function armPause() {
  if (pauseTimer) clearTimeout(pauseTimer);
  pauseTimer = setTimeout(() => {
    if (get().phase === "listening" && spoken()) stopVoice();
  }, PAUSE_MS);
}

/** Stop listening and keep the words. */
export function stopVoice() {
  if (get().phase !== "listening") return;
  clearTimers();
  set({ phase: "finishing" });
  session?.stop();
  // a recogniser that never reports its end should not leave the mic button stuck
  timers.push(setTimeout(() => get().phase === "finishing" && end(get().where === "device"), 2500));
}

/** Stop listening and put the text box back as it was. */
export function cancelVoice() {
  const p = get().phase;
  clearTimers();
  if (sendTimer) clearTimeout(sendTimer);
  if (p === "listening" || p === "finishing") {
    const s = session;
    session = null;
    s?.abort();
    client?.cancel();
  }
  set({ phase: "idle", where: null, error: null, final: "", interim: "" });
}

/** Close an offer or error card. */
export function dismissVoice() {
  const p = get().phase;
  if (p === "offer" || p === "error" || p === "unsupported" || p === "checking" || p === "downloading") set({ phase: "idle", error: null });
}

/** Keep the words in the box instead of sending them. */
export function holdSend() {
  if (sendTimer) clearTimeout(sendTimer);
  sendTimer = null;
  if (get().phase === "sending") set({ phase: "idle" });
}

/** Send now instead of waiting for the countdown. */
export function sendNow() {
  if (get().phase !== "sending") return;
  if (sendTimer) clearTimeout(sendTimer);
  sendTimer = null;
  set({ phase: "idle" });
  client?.send();
}

function end(local: boolean) {
  clearTimers();
  if (!session) return; // cancelled
  session = null;
  const c = client;
  const text = spoken();
  const code = lastError;
  const p = get().phase;
  if (p !== "listening" && p !== "finishing") return;

  if (code === "phrases-not-supported" && usedPhrases && c) return begin(local, false);
  if (code && code !== "no-speech" && code !== "aborted" && !text) {
    if (code === "language-not-supported" && local) known.delete(get().lang);
    return fail(errorFor(code, local));
  }
  set({ where: null });
  if (!text) {
    c?.done("");
    return fail({ title: "Didn't catch anything", detail: "Tap the mic and start talking. It stops by itself when you pause.", soft: true });
  }
  c?.done(text);
  if (useSettings.getState().voiceSend === "auto" && c?.canSend()) {
    set({ phase: "sending", sendAt: Date.now() + SEND_DELAY_MS });
    sendTimer = setTimeout(sendNow, SEND_DELAY_MS);
  } else set({ phase: "idle" });
}

export function errorFor(code: string, local: boolean): VoiceError {
  const service = serviceName(get().provider);
  switch (code) {
    case "not-allowed":
      return { title: "Microphone access is blocked", detail: "Allow the microphone for this site in your browser's site settings, then tap the mic again." };
    case "audio-capture":
      return { title: "No microphone found", detail: "Connect a microphone, or check that no other app is using it." };
    case "network":
      return { title: `Couldn't reach ${service}`, detail: "Check your connection and try again." };
    case "service-not-allowed":
      return local
        ? { title: "On-device speech isn't available right now", detail: "Try again, or allow the browser's online speech service in Settings → Voice.", settings: true }
        : get().provider === "apple"
          ? { title: "Dictation is turned off", detail: "Turn on Dictation in your device's keyboard settings, then try again." }
          : { title: `${service[0].toUpperCase()}${service.slice(1)} isn't available in this browser`, detail: "Use the dictation key on your keyboard instead, or try Chrome, Edge or Safari." };
    case "language-not-supported":
      return { title: "This language isn't supported here", detail: "Pick another speech language in Settings → Voice.", settings: true };
    default:
      return { title: "Voice input stopped", detail: `The browser reported “${code}”. Tap the mic to try again.` };
  }
}

// The mic never stays on in a hidden tab.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && get().phase === "listening") stopVoice();
  });
}

/** Test hook: forget remembered on-device answers. */
export function resetVoiceForTests() {
  known.clear();
  cancelVoice();
  client = null;
}
