// A thin wrapper over the browser's Web Speech API, so the rest of Kerf deals
// with one small interface whatever the browser. The browser does the
// recognition; Kerf never touches the audio itself.

import { collect, type Phrase, type ResultLike } from "./text";

export type OnDevice = "available" | "downloadable" | "downloading" | "unavailable";

// The parts of the Web Speech API Kerf uses. TypeScript's DOM types do not
// include the recogniser itself, and on-device recognition is newer still.
interface RecognitionEvent {
  readonly results: ArrayLike<ResultLike>;
}
interface RecognitionErrorEvent {
  readonly error: string;
  readonly message?: string;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  processLocally?: boolean;
  phrases?: unknown[];
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  onsoundstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface AvailabilityOptions {
  langs: string[];
  processLocally: boolean;
  quality?: "command" | "dictation" | "conversation";
}
interface RecognitionClass {
  new (): Recognition;
  available?: (o: AvailabilityOptions) => Promise<OnDevice>;
  install?: (o: AvailabilityOptions) => Promise<boolean>;
}

function recognitionClass(): RecognitionClass | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionClass; webkitSpeechRecognition?: RecognitionClass };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** The browser has a speech recogniser at all. */
export const hasRecognizer = () => !!recognitionClass();

/** The browser can tell whether recognition runs on this device. */
export const canAskOnDevice = () => typeof recognitionClass()?.available === "function";

/**
 * Whether this language can be recognised on the device without sending audio
 * anywhere. Browsers that cannot say report "unavailable", so Kerf never
 * assumes audio stays local when it might not.
 */
export async function onDeviceStatus(lang: string): Promise<OnDevice> {
  const C = recognitionClass();
  if (!C?.available) return "unavailable";
  try {
    return await C.available({ langs: [lang], processLocally: true, quality: "dictation" });
  } catch {
    // older builds reject the quality option
    try {
      return await C.available({ langs: [lang], processLocally: true });
    } catch {
      return "unavailable";
    }
  }
}

/** Download the on-device language pack. Call from a click: browsers require a user gesture. */
export async function installOnDevice(lang: string): Promise<boolean> {
  const C = recognitionClass();
  if (!C?.install) return false;
  try {
    return await C.install({ langs: [lang], processLocally: true, quality: "dictation" });
  } catch {
    try {
      return await C.install({ langs: [lang], processLocally: true });
    } catch {
      return false;
    }
  }
}

export interface SessionOptions {
  lang: string;
  /** recognise on the device only; never fall back to an online service */
  local: boolean;
  /** words to listen out for (on-device recognisers only) */
  phrases?: Phrase[];
}

export interface SessionHandlers {
  onStart?: () => void;
  /** everything heard so far: settled words, and words that may still change */
  onText: (final: string, interim: string) => void;
  /** sound or words arrived: drives the level animation and the pause timer */
  onActivity?: () => void;
  onError: (code: string) => void;
  onEnd: () => void;
}

export interface Session {
  /** stop listening and keep what was heard */
  stop(): void;
  /** stop listening and drop what was heard */
  abort(): void;
}

/** Start listening. Throws if the browser has no recogniser. */
export function listen(opts: SessionOptions, h: SessionHandlers): Session {
  const C = recognitionClass();
  if (!C) throw new Error("This browser has no speech recogniser.");
  const r = new C();
  r.lang = opts.lang;
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 1;
  if ("processLocally" in r) r.processLocally = opts.local;
  const Phrase = (window as unknown as { SpeechRecognitionPhrase?: new (p: string, boost: number) => unknown }).SpeechRecognitionPhrase;
  if (opts.local && opts.phrases?.length && Phrase && "phrases" in r) {
    try {
      r.phrases = opts.phrases.map((p) => new Phrase(p.phrase, p.boost));
    } catch {
      /* biasing is a bonus: listen without it */
    }
  }
  let ended = false;
  r.onstart = () => h.onStart?.();
  r.onsoundstart = () => h.onActivity?.();
  r.onresult = (e) => {
    const { final, interim } = collect(e.results);
    h.onActivity?.();
    h.onText(final, interim);
  };
  r.onerror = (e) => h.onError(e.error);
  r.onend = () => {
    if (ended) return;
    ended = true;
    h.onEnd();
  };
  r.start();
  return {
    stop: () => {
      try {
        r.stop();
      } catch {
        /* already stopped */
      }
    },
    abort: () => {
      try {
        r.abort();
      } catch {
        /* already stopped */
      }
    },
  };
}
