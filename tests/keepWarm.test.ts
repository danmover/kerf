// Keeping the design conversation in the prompt cache while the chat is idle.

import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureWarm, refreshBody, requestFinished, requestStarted, resetWarmForTests, stopWarm } from "../src/ai/keepWarm";
import type { Usage } from "../src/agents/pricing";

const MODEL = "claude-opus-5-5";
const params = () => ({ model: MODEL, max_tokens: 32000, stream: true, fallbacks: "default", betas: ["thinking-binding-controls-2026-08-01", "server-side-fallback-2026-07-01"], system: "s", messages: [{ role: "user", content: "hi" }] });
const finished: Usage = { input_tokens: 50, cache_creation_input_tokens: 20_000, cache_read_input_tokens: 0, output_tokens: 400 };

let sent: Record<string, unknown>[];
let recorded: Usage[];
let reply: () => unknown;
let minutes: number;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  recorded = [];
  minutes = 30;
  reply = () => ({ usage: { input_tokens: 10, cache_read_input_tokens: 20_050, output_tokens: 0 } });
  const client = { beta: { messages: { create: async (body: Record<string, unknown>) => (sent.push(body), reply()) } } } as unknown as Anthropic;
  configureWarm({ client: () => client, minutes: () => minutes, record: (_m, u) => void recorded.push(u) });
});
afterEach(() => {
  resetWarmForTests();
  vi.useRealTimers();
});

/** a design request that started now and wrote `u` */
function designTurn(u = finished) {
  const p = params();
  requestStarted(MODEL, p, Date.now(), true);
  return { p, saved: requestFinished(p, u) };
}

describe("keeping the cache warm", () => {
  it("re-sends the last design request with no output shortly before the cache would forget it", async () => {
    designTurn();
    await vi.advanceTimersByTimeAsync(224_000);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ model: MODEL, max_tokens: 0, system: "s", messages: [{ role: "user", content: "hi" }] });
    expect(sent[0]).not.toHaveProperty("stream");
    expect(sent[0]).not.toHaveProperty("fallbacks");
    expect(sent[0].betas).toEqual(["thinking-binding-controls-2026-08-01"]);
    expect(recorded).toHaveLength(1);
    // and again before the refreshed entry runs out
    await vi.advanceTimersByTimeAsync(225_000);
    expect(sent).toHaveLength(2);
  });

  it("stops once the user has been away longer than Settings allow", async () => {
    minutes = 10;
    designTurn();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    // refreshes at 3.75 and 7.5 minutes; the next would be after 10
    expect(sent).toHaveLength(2);
  });

  it("does nothing when turned off", async () => {
    minutes = 0;
    designTurn();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(sent).toHaveLength(0);
  });

  it("does not bother with a small conversation", async () => {
    designTurn({ input_tokens: 2000, output_tokens: 100 });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(sent).toHaveLength(0);
  });

  it("stops when a refresh finds the entry gone, rather than paying to write it again", async () => {
    reply = () => ({ usage: { input_tokens: 10, cache_creation_input_tokens: 20_050, output_tokens: 0 } });
    designTurn();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(sent).toHaveLength(1);
  });

  it("turns itself off for the session when the API rejects the refresh", async () => {
    reply = () => {
      throw new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "max_tokens: must be at least 1" } }, "max_tokens: must be at least 1", new Headers());
    };
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    designTurn();
    await vi.advanceTimersByTimeAsync(226_000);
    expect(sent).toHaveLength(1);
    designTurn();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(sent).toHaveLength(1);
  });

  it("follows only the design model: a quick turn counts as activity but is not kept warm", async () => {
    designTurn();
    await vi.advanceTimersByTimeAsync(200_000);
    requestStarted("claude-haiku-5-5", { model: "claude-haiku-5-5" }, Date.now(), false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent.map((b) => b.model)).toEqual([MODEL]);
  });

  it("keeps the design model's cache as warm after a quick turn as answering it there would have, even when turned off", async () => {
    minutes = 0;
    designTurn();
    await vi.advanceTimersByTimeAsync(100_000);
    requestStarted("claude-haiku-5-5", { model: "claude-haiku-5-5" }, Date.now(), false);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(sent).toHaveLength(1);
  });

  it("does not bring back an entry that expired before the quick turn", async () => {
    minutes = 0;
    designTurn();
    await vi.advanceTimersByTimeAsync(310_000);
    requestStarted("claude-haiku-5-5", { model: "claude-haiku-5-5" }, Date.now(), false);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(sent).toHaveLength(0);
  });

  it("counts it against routing when a quick turn left the design model to write the conversation again", async () => {
    minutes = 0;
    reply = () => {
      throw new Anthropic.APIConnectionError({ message: "offline" });
    };
    designTurn();
    await vi.advanceTimersByTimeAsync(150_000);
    requestStarted("claude-haiku-5-5", { model: "claude-haiku-5-5" }, Date.now(), false);
    await vi.advanceTimersByTimeAsync(250_000);
    expect(sent).toHaveLength(1);
    // the design model alone would have touched the entry at 2.5 minutes and found it now
    const { saved } = designTurn({ input_tokens: 80, cache_creation_input_tokens: 20_350, cache_read_input_tokens: 0, output_tokens: 500 });
    expect(saved).toBeCloseTo(-(20_050 * 4.8) / 1e6, 10);
  });

  it("credits the next message with the write it avoided", async () => {
    designTurn();
    await vi.advanceTimersByTimeAsync(400_000);
    expect(sent).toHaveLength(1);
    // without the refresh at 3.75 minutes the entry would have gone at 5
    const { saved } = designTurn({ input_tokens: 80, cache_creation_input_tokens: 300, cache_read_input_tokens: 20_050, output_tokens: 500 });
    expect(saved).toBeCloseTo((20_050 * 4.8) / 1e6, 10);
    // the one after that found it warm on its own
    const again = designTurn({ input_tokens: 80, cache_creation_input_tokens: 300, cache_read_input_tokens: 20_400, output_tokens: 500 });
    expect(again.saved).toBe(0);
  });

  it("forgets everything when the chat closes", async () => {
    designTurn();
    stopWarm();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(sent).toHaveLength(0);
  });

  it("drops the betas field entirely when only the fallback beta was set", () => {
    expect(refreshBody({ model: MODEL, betas: ["server-side-fallback-2026-07-01"] })).not.toHaveProperty("betas");
  });
});
