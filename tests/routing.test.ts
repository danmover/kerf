// Which turns may go to the quick model, decided by rules or by a short call to
// the router; and the money each request costs and saves.

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { askRouter, QUICK_TOOLS, quickCanSave, routerRequest, ruleReason, type TurnFacts } from "../src/ai/routing";
import { addToTurn, carryOver, counterfactualCost, emptyTurn, onSpend, promptTokens, recordSpend, warmSaving } from "../src/ai/spend";
import { costOf } from "../src/agents/pricing";

const facts = (text: string, more: Partial<TurnFacts> = {}): TurnFacts => ({ text, lastReply: "", hasFiles: false, pointsAtModel: false, answersChoice: false, steering: false, parts: 3, ...more });

describe("the rules", () => {
  it("send anything that can change the design to the design model", () => {
    expect(ruleReason(facts("make the wall 3 mm"))).toBe("asks for a change");
    expect(ruleReason(facts("Please add four M3 holes"))).toBe("asks for a change");
    expect(ruleReason(facts("can you fillet the top edges"))).toBe("asks for a change");
    expect(ruleReason(facts("ok, go ahead"))).toBe("asks for a change");
    expect(ruleReason(facts("yes do it"))).toBe("asks for a change");
    expect(ruleReason(facts("now try aluminium"))).toBe("asks for a change");
    expect(ruleReason(facts("how wide is it?", { answersChoice: true }))).toBe("answers Claude's question");
    expect(ruleReason(facts("how wide is it?", { steering: true }))).toBe("changes the plan");
    expect(ruleReason(facts("like this", { hasFiles: true }))).toBe("has an attachment");
    expect(ruleReason(facts("what is this?", { pointsAtModel: true }))).toBe("points at the model");
    expect(ruleReason(facts("what is the wall thickness?", { parts: 0 }))).toBe("starts a design");
    expect(ruleReason(facts("what is the wall thickness? ".repeat(20)))).toBe("a detailed request");
  });

  it("leave everything else to the router", () => {
    for (const t of ["how wide is the base?", "what material is the lid?", "thanks!", "which checks fail?", "is it strong enough?", "yes", "the second one"]) expect(ruleReason(facts(t))).toBeNull();
  });

  it("let a quick turn only read", () => {
    for (const t of ["edit_design", "write_design", "update_brief", "update_plan", "ask_user", "build_subassemblies", "review_design", "explore_fixes", "run_analysis"]) expect(QUICK_TOOLS.has(t)).toBe(false);
    for (const t of ["get_design", "run_checks", "capture_view", "measure"]) expect(QUICK_TOOLS.has(t)).toBe(true);
  });
});

describe("the router", () => {
  const client = (reply: () => unknown) => ({ beta: { messages: { create: async () => reply() } } }) as unknown as Anthropic;
  const said = (text: string, stop = "end_turn") => () => ({ model: "claude-haiku-5-5", stop_reason: stop, usage: { input_tokens: 400, output_tokens: 12 }, content: [{ type: "text", text }] });

  it("asks the quick model for a JSON verdict, with the end of the last reply for context", () => {
    const body = routerRequest(facts("yes", { lastReply: "x".repeat(3000) + " Shall I add ribs?" })) as { model: string; thinking: unknown; output_config: { effort: string; format: { type: string } }; messages: { content: string }[] };
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.output_config.effort).toBe("low");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.messages[0].content).toContain("Shall I add ribs?");
    expect(body.messages[0].content.length).toBeLessThan(1700);
  });

  it("reads the verdict", async () => {
    expect(await askRouter(client(said('{"route":"quick","reason":"Reads a dimension."}')), facts("how wide?"))).toMatchObject({ quick: true, why: "reads a dimension" });
    expect(await askRouter(client(said('{"route":"design","reason":"Asks for advice."}')), facts("should I?"))).toMatchObject({ quick: false, why: "asks for advice" });
  });

  it("means design whenever the answer is not a clear quick", async () => {
    expect((await askRouter(client(said("quick")), facts("how wide?"))).quick).toBe(false);
    expect((await askRouter(client(said('{"route":"quick","reason":"x"}', "max_tokens")), facts("how wide?"))).quick).toBe(false);
    expect((await askRouter(client(said("", "refusal")), facts("how wide?"))).quick).toBe(false);
    const failed = await askRouter(
      client(() => {
        throw new Error("network down");
      }),
      facts("how wide?"),
    );
    expect(failed).toMatchObject({ quick: false, why: "the router did not answer" });
  });

  it("stops when the user stops", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = askRouter(
      client(() => {
        throw new Anthropic.APIUserAbortError();
      }),
      facts("how wide?"),
      ac.signal,
    );
    await expect(r).rejects.toThrow();
  });
});

describe("spend", () => {
  it("prices a quick request at no more than the design model would have cost", () => {
    // Haiku wrote 12K tokens to its own cache; the design model would at least have read them
    const u = { input_tokens: 200, cache_creation_input_tokens: 12_000, cache_read_input_tokens: 0, output_tokens: 300 };
    expect(promptTokens(u)).toBe(12_200);
    const opus = counterfactualCost("claude-opus-5-5", u);
    expect(opus).toBeCloseTo((200 * 4 + 12_000 * 0.2 + 300 * 20) / 1e6, 10);
    expect(counterfactualCost("claude-opus-5-5", { ...u, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 10_000 })).toBeCloseTo(opus, 10);
    // the cheaper model is cheaper even writing everything cold
    expect(costOf("claude-haiku-5-5", u)).toBeLessThan(opus / 2);
  });

  it("values a warm cache at the write it avoided", () => {
    expect(warmSaving("claude-opus-5-5", { input_tokens: 10, cache_read_input_tokens: 20_000, output_tokens: 0 })).toBeCloseTo((20_000 * 4.8) / 1e6, 10);
  });

  it("adds a turn up by kind and model", () => {
    let t = emptyTurn();
    t = addToTurn(t, "chat", "claude-opus-5-5", 0.1, 0, { input_tokens: 1, cache_read_input_tokens: 500, output_tokens: 40 });
    t = addToTurn(t, "chat", "claude-opus-5-5", 0.2, 0.05, { input_tokens: 1, output_tokens: 60 });
    t = addToTurn(t, "router", "claude-haiku-5-5", 0.001, -0.001);
    expect(t.cost).toBeCloseTo(0.301, 10);
    expect(t.saved).toBeCloseTo(0.049, 10);
    expect(t.byKind.chat).toEqual([{ model: "claude-opus-5-5", cost: expect.closeTo(0.3, 10), requests: 2 }]);
    expect(t.byKind.router).toHaveLength(1);
    expect(t.cacheRead).toBe(500);
    expect(t.output).toBe(100);
  });

  it("carries a quick turn answered again as spend that bought nothing", () => {
    let quick = emptyTurn();
    quick = addToTurn(quick, "router", "claude-haiku-5-5", 0.0001, -0.0001);
    quick = addToTurn(quick, "quick", "claude-haiku-5-5", 0.003, 0.01, { input_tokens: 10, cache_read_input_tokens: 900, output_tokens: 50 });
    quick = addToTurn(quick, "quick", "claude-haiku-5-5", 0.002, 0.008);
    quick = addToTurn(quick, "warm", "claude-opus-5-5", 0.004, -0.004);
    const t = carryOver(emptyTurn(), quick);
    expect(t.cost).toBeCloseTo(quick.cost, 10);
    expect(t.saved).toBeCloseTo(-quick.cost, 10);
    expect(t.byKind.warm).toEqual([{ model: "claude-opus-5-5", cost: 0.004, requests: 1 }]);
    expect(t.byKind.escalated).toEqual([{ model: "claude-haiku-5-5", cost: expect.closeTo(0.0051, 10), requests: 3 }]);
    expect(t.byKind.quick).toBeUndefined();
    expect(t.cacheRead).toBe(900);
  });

  it("tells every listener about each request", () => {
    const heard: string[] = [];
    const off = onSpend((kind, model, cost) => heard.push(`${kind} ${model} ${cost.toFixed(6)}`));
    const cost = recordSpend("review", "claude-opus-5-5", { input_tokens: 1000, output_tokens: 100 });
    off();
    recordSpend("review", "claude-opus-5-5", { input_tokens: 1000, output_tokens: 100 });
    expect(cost).toBeCloseTo(0.006, 10);
    expect(heard).toEqual(["review claude-opus-5-5 0.006000"]);
  });
});

describe("when the quick model is cheaper", () => {
  it("is cheaper for an ordinary conversation, even writing it to its cache from cold", () => {
    expect(quickCanSave("claude-opus-5-5", 20_000, false)).toBe(true);
    expect(quickCanSave("claude-opus-5-5", 95_000, false)).toBe(true);
    expect(quickCanSave("claude-sonnet-5-5", 60_000, false)).toBe(true);
  });

  it("is dearer for a long conversation it has not read recently", () => {
    expect(quickCanSave("claude-opus-5-5", 150_000, false)).toBe(false);
    expect(quickCanSave("claude-opus-5-5", 150_000, true)).toBe(true);
  });
});
