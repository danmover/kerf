// Pure helpers for voice input: assembling transcripts, naming the speech
// service a browser uses, and the words worth listening out for in a design.

/** One recognition result, as the Web Speech API reports it. */
export interface ResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { readonly transcript: string };
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const norm = (s: string) => squash(s).toLowerCase();

/**
 * The settled and still-changing parts of what was heard so far, rebuilt from
 * the whole result list each time. Rebuilding (instead of appending from
 * resultIndex) copes with Safari, which can repeat earlier words in each new
 * result: a segment that already contains everything before it replaces it.
 */
export function collect(results: ArrayLike<ResultLike>): { final: string; interim: string } {
  let final = "";
  let interim = "";
  const add = (acc: string, seg: string) => {
    const s = squash(seg);
    if (!s) return acc;
    if (!acc) return s;
    if (norm(s).startsWith(norm(acc))) return s;
    if (norm(acc).endsWith(norm(s))) return acc;
    return `${acc} ${s}`;
  };
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r || !r.length) continue;
    const t = r[0].transcript;
    if (r.isFinal) final = add(final, t);
    else interim = add(interim, t);
  }
  // a cumulative interim result repeats the settled words in front of the new ones
  if (final && interim && norm(interim).startsWith(norm(final))) interim = squash(squash(interim).slice(squash(final).length));
  return { final, interim };
}

/** Put spoken text after what was already in the box. */
export function joinText(base: string, spoken: string): string {
  const s = squash(spoken);
  if (!s) return base;
  const b = base.replace(/\s+$/, "");
  if (!b) return capitalise(s);
  const sentenceEnd = /[.!?]$/.test(b);
  return `${b} ${sentenceEnd ? capitalise(s) : s}`;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- which company runs the browser's speech service ----------

export type Provider = "apple" | "google" | "microsoft" | "other";

export interface NavigatorInfo {
  userAgent: string;
  vendor?: string;
  maxTouchPoints?: number;
  brands?: string[];
}

/**
 * Whose servers a browser's built-in speech recognition uses when it is not
 * running on the device. Every browser on iPhone and iPad is Safari underneath.
 */
export function speechProvider(n: NavigatorInfo): Provider {
  const ua = n.userAgent;
  const brands = n.brands ?? [];
  const iOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (n.maxTouchPoints ?? 0) > 1);
  if (iOS) return "apple";
  if (brands.includes("Microsoft Edge") || /\bEdg(A|iOS)?\//.test(ua)) return "microsoft";
  if (brands.includes("Google Chrome")) return "google";
  if (brands.length) return "other"; // another Chromium browser (Brave, Opera, Samsung Internet…)
  if (/\bChrome\//.test(ua) && !/\b(OPR|SamsungBrowser|Vivaldi|YaBrowser)\//.test(ua)) return "google";
  if (/Safari\//.test(ua) && /Apple/.test(n.vendor ?? "")) return "apple";
  return "other";
}

export function providerName(p: Provider): string {
  return p === "apple" ? "Apple" : p === "google" ? "Google" : p === "microsoft" ? "Microsoft" : "your browser's maker";
}

/** "Google's speech service", or "your browser's online speech service". */
export function serviceName(p: Provider): string {
  return p === "other" ? "your browser's online speech service" : `${providerName(p)}'s speech service`;
}

// ---------- listening out for the design's own words ----------

export interface Phrase {
  phrase: string;
  boost: number;
}

/** Shop words a general recogniser often mishears. */
const CAD_WORDS = ["millimetres", "fillet", "chamfer", "countersink", "counterbore", "heat-set insert", "standoff", "boss", "rib", "bearing", "spur gear", "gear ratio", "clearance", "wall thickness", "PETG", "PLA", "M2", "M3", "M4", "M5", "M6", "NEMA 17", "USB-C", "PCB"];

/** `lid_fasteners` → "lid fasteners", `innerWidth` → "inner width". */
export function spokenName(name: string): string {
  return squash(
    name
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_\-.]+/g, " ")
      .toLowerCase(),
  );
}

/**
 * Words to bias recognition towards: the design's part and parameter names,
 * then common CAD terms. Only on-device recognisers take these.
 */
export function phrasesFor(names: string[], limit = 60): Phrase[] {
  const seen = new Set<string>();
  const out: Phrase[] = [];
  const push = (phrase: string, boost: number) => {
    const k = phrase.toLowerCase();
    if (phrase.length < 2 || seen.has(k) || out.length >= limit) return;
    seen.add(k);
    out.push({ phrase, boost });
  };
  for (const n of names) push(spokenName(n), 4);
  for (const w of CAD_WORDS) push(w, 2.5);
  return out;
}

/** "0:07" */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Where to talk into the desktop app, which has no voice input of its own yet. */
export function desktopDictationHint(windows: boolean): string {
  return windows
    ? "Voice input isn't in the desktop app yet. Press Windows + H to dictate into the message box with Windows voice typing, or open Kerf in Chrome or Edge to use its own."
    : "Voice input isn't in the desktop app yet. Use your system's dictation to talk into the message box, or open Kerf in Chrome, Edge or Safari to use its own.";
}
