import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clock, collect, joinText, phrasesFor, speechProvider, spokenName, type ResultLike } from "../src/voice/text";

const results = (...r: [string, boolean][]): ResultLike[] => r.map(([t, isFinal]) => Object.assign([{ transcript: t }], { isFinal }));

describe("voice transcripts", () => {
  it("splits settled words from words that may still change", () => {
    expect(collect(results(["make the lid", true], [" 3 mm thicker", false]))).toEqual({ final: "make the lid", interim: "3 mm thicker" });
  });

  it("copes with results that repeat the earlier words (Safari)", () => {
    expect(collect(results(["make the lid", true], ["make the lid 3 mm thicker", true])).final).toBe("make the lid 3 mm thicker");
    expect(collect(results(["make the lid", true], ["make the lid thicker", false])).interim).toBe("thicker");
    expect(collect(results(["the lid", true], ["lid", true])).final).toBe("the lid");
  });

  it("adds spoken words after what was typed", () => {
    expect(joinText("", "make it wider")).toBe("Make it wider");
    expect(joinText("Keep the board.", "make it wider")).toBe("Keep the board. Make it wider");
    expect(joinText("Change the lid ", "to 3 mm")).toBe("Change the lid to 3 mm");
    expect(joinText("unchanged", "  ")).toBe("unchanged");
  });

  it("names whose servers hear the audio when recognition is not on the device", () => {
    const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
    expect(speechProvider({ userAgent: chrome, brands: ["Chromium", "Google Chrome", "Not?A_Brand"] })).toBe("google");
    expect(speechProvider({ userAgent: chrome })).toBe("google");
    expect(speechProvider({ userAgent: `${chrome} Edg/141.0.0.0`, brands: ["Chromium", "Microsoft Edge"] })).toBe("microsoft");
    expect(speechProvider({ userAgent: chrome, brands: ["Chromium", "Brave"] })).toBe("other");
    expect(speechProvider({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1" })).toBe("apple");
    expect(speechProvider({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", vendor: "Apple Computer, Inc.", maxTouchPoints: 5 })).toBe("apple");
    expect(speechProvider({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", vendor: "Apple Computer, Inc." })).toBe("apple");
    expect(speechProvider({ userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0" })).toBe("other");
  });

  it("listens out for the design's own names, then CAD words", () => {
    expect(spokenName("lid_fasteners")).toBe("lid fasteners");
    expect(spokenName("innerWidth")).toBe("inner width");
    const p = phrasesFor(["lid_fasteners", "lid_fasteners", "x", "board"], 4);
    expect(p.map((x) => x.phrase)).toEqual(["lid fasteners", "board", "millimetres", "fillet"]);
    expect(p[0].boost).toBeGreaterThan(p[3].boost);
  });

  it("formats elapsed time", () => {
    expect(clock(7400)).toBe("0:07");
    expect(clock(125000)).toBe("2:05");
  });
});

// ---------- the listening session, against a fake browser recogniser ----------

class FakeRecognition {
  static last: FakeRecognition | null = null;
  static all: FakeRecognition[] = [];
  static onDevice: string = "available";
  /** hold back onstart, as while the browser asks for microphone permission */
  static deferStart = false;
  static available?: (o: unknown) => Promise<string> = async () => FakeRecognition.onDevice;
  static install?: (o: unknown) => Promise<boolean> = async () => {
    FakeRecognition.onDevice = "available";
    return true;
  };
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  processLocally = false;
  phrases: unknown[] = [];
  started = false;
  onresult: ((e: { results: ResultLike[] }) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onstart: (() => void) | null = null;
  onsoundstart: (() => void) | null = null;
  constructor() {
    FakeRecognition.last = this;
    FakeRecognition.all.push(this);
  }
  start() {
    this.started = true;
    if (!FakeRecognition.deferStart) queueMicrotask(() => this.onstart?.());
  }
  stop() {
    queueMicrotask(() => this.onend?.());
  }
  abort() {
    queueMicrotask(() => this.onend?.());
  }
  say(...r: [string, boolean][]) {
    this.onresult?.({ results: results(...r) });
  }
  fail(code: string) {
    this.onerror?.({ error: code });
    this.onend?.();
  }
}

class FakePhrase {
  constructor(
    public phrase: string,
    public boost: number,
  ) {}
}

function makeClient(over: Partial<{ canSend: boolean }> = {}) {
  let box = "Keep the board.";
  const c = {
    box: () => box,
    begin: vi.fn(),
    text: vi.fn((s: string) => void (box = `Keep the board. ${s}`)),
    done: vi.fn(),
    cancel: vi.fn(() => void (box = "Keep the board.")),
    send: vi.fn(),
    canSend: () => over.canSend ?? true,
    vocabulary: () => ["lid", "wall_t"],
  };
  return c;
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("voice sessions", () => {
  let voice: typeof import("../src/voice/voice");
  let settings: typeof import("../src/app/settings");

  beforeEach(async () => {
    vi.useFakeTimers();
    FakeRecognition.all = [];
    FakeRecognition.last = null;
    FakeRecognition.onDevice = "available";
    FakeRecognition.deferStart = false;
    FakeRecognition.available = async () => FakeRecognition.onDevice;
    (globalThis as Record<string, unknown>).window = { SpeechRecognition: FakeRecognition, SpeechRecognitionPhrase: FakePhrase };
    vi.resetModules();
    settings = await import("../src/app/settings");
    voice = await import("../src/voice/voice");
    settings.updateSettings({ voiceOnline: false, voiceSend: "review", voiceLang: "en-GB" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    voice.resetVoiceForTests();
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).window;
  });

  it("recognises on the device when it can, and stops by itself after a pause", async () => {
    const c = makeClient();
    await voice.startVoice(c);
    const r = FakeRecognition.last!;
    expect(r.started).toBe(true);
    expect(r.processLocally).toBe(true);
    expect(r.lang).toBe("en-GB");
    expect(r.continuous).toBe(true);
    expect((r.phrases as FakePhrase[]).slice(0, 2).map((p) => p.phrase)).toEqual(["lid", "wall t"]);
    expect(voice.useVoice.getState()).toMatchObject({ phase: "listening", where: "device" });
    expect(c.begin).toHaveBeenCalled();

    r.say(["make the lid", true], ["3 mm thicker", false]);
    expect(c.box()).toBe("Keep the board. make the lid 3 mm thicker");
    vi.advanceTimersByTime(voice.PAUSE_MS + 10);
    expect(voice.useVoice.getState().phase).toBe("finishing");
    await flush();
    expect(c.done).toHaveBeenCalledWith("make the lid 3 mm thicker");
    expect(c.send).not.toHaveBeenCalled();
    expect(voice.useVoice.getState().phase).toBe("idle");
  });

  it("asks before using the browser's online service, and remembers the answer", async () => {
    FakeRecognition.onDevice = "unavailable";
    const c = makeClient();
    await voice.startVoice(c);
    expect(voice.useVoice.getState().phase).toBe("offer");
    expect(FakeRecognition.all).toHaveLength(0);

    voice.allowOnlineSpeech();
    expect(settings.useSettings.getState().voiceOnline).toBe(true);
    expect(FakeRecognition.last!.processLocally).toBe(false);
    expect(FakeRecognition.last!.phrases).toEqual([]);
    expect(voice.useVoice.getState()).toMatchObject({ phase: "listening", where: "online" });
    voice.cancelVoice();
    await flush();

    await voice.startVoice(c);
    expect(voice.useVoice.getState().phase).toBe("listening");
  });

  it("offers the on-device download when the browser has one", async () => {
    FakeRecognition.onDevice = "downloadable";
    const c = makeClient();
    await voice.startVoice(c);
    expect(voice.useVoice.getState()).toMatchObject({ phase: "offer", onDevice: "downloadable" });
    await voice.downloadSpeechModel();
    expect(voice.useVoice.getState()).toMatchObject({ phase: "idle", onDevice: "available" });
    await voice.startVoice(c);
    expect(FakeRecognition.last!.processLocally).toBe(true);
  });

  it("falls back to the main variant of the browser's language to keep speech on the device", async () => {
    settings.updateSettings({ voiceLang: "" });
    vi.stubGlobal("navigator", { language: "en-GB", userAgent: "" });
    FakeRecognition.available = async (o) => ((o as { langs: string[] }).langs[0] === "en-US" ? "available" : "unavailable");
    await voice.startVoice(makeClient());
    expect(FakeRecognition.last!.lang).toBe("en-US");
    expect(FakeRecognition.last!.processLocally).toBe(true);

    // a language the user picked is used as it is
    voice.resetVoiceForTests();
    settings.updateSettings({ voiceLang: "en-GB" });
    await voice.startVoice(makeClient());
    expect(voice.useVoice.getState()).toMatchObject({ phase: "offer", lang: "en-GB" });
  });

  it("never treats a browser that cannot say as on-device", async () => {
    FakeRecognition.available = undefined;
    await voice.startVoice(makeClient());
    expect(voice.useVoice.getState().phase).toBe("offer");
  });

  it("sends after a short countdown when set to send, unless held", async () => {
    settings.updateSettings({ voiceSend: "auto" });
    const c = makeClient();
    await voice.startVoice(c);
    FakeRecognition.last!.say(["add four M3 holes", true]);
    voice.stopVoice();
    await flush();
    expect(voice.useVoice.getState().phase).toBe("sending");
    vi.advanceTimersByTime(voice.SEND_DELAY_MS + 10);
    expect(c.send).toHaveBeenCalledTimes(1);

    await voice.startVoice(c);
    FakeRecognition.last!.say(["round the corners", true]);
    voice.stopVoice();
    await flush();
    voice.holdSend();
    vi.advanceTimersByTime(voice.SEND_DELAY_MS + 10);
    expect(c.send).toHaveBeenCalledTimes(1);
  });

  it("does not count down while a message cannot be sent", async () => {
    settings.updateSettings({ voiceSend: "auto" });
    const c = makeClient({ canSend: false });
    await voice.startVoice(c);
    FakeRecognition.last!.say(["also fillet the edges", true]);
    voice.stopVoice();
    await flush();
    expect(voice.useVoice.getState().phase).toBe("idle");
    expect(c.done).toHaveBeenCalledWith("also fillet the edges");
  });

  it("puts the box back when cancelled", async () => {
    const c = makeClient();
    await voice.startVoice(c);
    FakeRecognition.last!.say(["oops", false]);
    voice.cancelVoice();
    await flush();
    expect(c.cancel).toHaveBeenCalled();
    expect(c.done).not.toHaveBeenCalled();
    expect(c.box()).toBe("Keep the board.");
  });

  it("explains a blocked microphone", async () => {
    await voice.startVoice(makeClient());
    FakeRecognition.last!.fail("not-allowed");
    expect(voice.useVoice.getState()).toMatchObject({ phase: "error", error: { title: "Microphone access is blocked" } });
  });

  it("listens again without word hints when the recogniser rejects them", async () => {
    await voice.startVoice(makeClient());
    FakeRecognition.last!.fail("phrases-not-supported");
    expect(FakeRecognition.all).toHaveLength(2);
    expect(FakeRecognition.last!.phrases).toEqual([]);
    expect(voice.useVoice.getState().phase).toBe("listening");
  });

  it("gives up quietly when nothing is said, and caps a session's length", async () => {
    const c = makeClient();
    FakeRecognition.deferStart = true;
    await voice.startVoice(c);
    vi.advanceTimersByTime(voice.FIRST_WORDS_MS * 2);
    expect(voice.useVoice.getState()).toMatchObject({ phase: "listening", ready: false }); // still asking for the mic: no limits yet
    FakeRecognition.last!.onstart?.();
    FakeRecognition.deferStart = false;
    expect(voice.useVoice.getState().ready).toBe(true);
    vi.advanceTimersByTime(voice.FIRST_WORDS_MS + 10);
    await flush();
    expect(voice.useVoice.getState()).toMatchObject({ phase: "error", error: { soft: true } });

    await voice.startVoice(c);
    await flush();
    for (let t = 0; t < voice.MAX_MS; t += 1000) {
      FakeRecognition.last!.say(["still talking", false]);
      vi.advanceTimersByTime(1000);
    }
    await flush();
    expect(c.done).toHaveBeenLastCalledWith("still talking");
  });

  it("says when the browser has no recogniser", async () => {
    (globalThis as Record<string, unknown>).window = {};
    await voice.startVoice(makeClient());
    expect(voice.useVoice.getState().phase).toBe("unsupported");
  });
});
