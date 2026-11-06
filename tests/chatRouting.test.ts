// Automatic model choice in the chat loop, against the fake Claude API: which
// turns go to the quick model, how a quick turn hands over to the design model
// the moment it needs to change something, and what the line under the reply
// records.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClaude, normalized, type Turn } from "./fakeClaude";

const mem = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  tools: [
    { name: "get_design", description: "Read the design.", input_schema: { type: "object", properties: {} } },
    { name: "run_checks", description: "Run the checks.", input_schema: { type: "object", properties: {} } },
    { name: "edit_design", description: "Change the design.", input_schema: { type: "object", properties: {} } },
  ],
  ran: [] as string[],
}));

vi.mock("../src/persist/vault", () => ({ getApiKey: () => "sk-ant-test" }));
vi.mock("../src/persist/db", () => ({
  getOne: async (_s: string, id: string) => structuredClone(mem.store.get(id)),
  put: async (_s: string, r: { projectId: string }) => void mem.store.set(r.projectId, structuredClone(r)),
  remove: async (_s: string, id: string) => void mem.store.delete(id),
}));
vi.mock("../src/core/engine", async () => {
  const { create } = await import("zustand");
  // a design with a part in it, so a question about it is not the start of a design
  return { useDesign: create(() => ({ source: 'design "t"', model: { name: "t", parts: [{ name: "base" }], notes: [] }, report: null })), evaluateOnly: () => null };
});
vi.mock("../src/app/view", () => ({ useView: { getState: () => ({ selected: [] }) } }));
vi.mock("../src/app/project", async () => {
  const { create } = await import("zustand");
  return { commitSource: () => undefined, endPreview: () => undefined, setUndoGuard: () => undefined, realSource: () => "", undo: () => false, redo: () => false, useProject: create(() => ({ current: { id: "p1" }, versions: [] })) };
});
vi.mock("../src/agents/orchestrator", () => ({ isBuilding: () => false }));
vi.mock("../src/ai/prompt", () => ({ systemPrompt: () => "You design mechanical parts." }));
vi.mock("../src/ai/tools", () => ({
  TOOL_DEFS: mem.tools,
  TOOL_TITLES: {},
  modelSummary: () => "Design t: 1 part",
  briefSummary: () => "",
  reportSummary: () => "All checks pass",
  runTool: async (name: string) => {
    mem.ran.push(name);
    return { content: name === "get_design" ? 'design "t" { part base { box(40, 20, 5) } }' : "All checks pass", card: { title: "Done" } };
  },
}));

type Chat = typeof import("../src/ai/chat");
type Settings = typeof import("../src/app/settings");
let chat: Chat;
let settings: Settings;
let api: ReturnType<typeof fakeClaude>;

function useApi(script: Turn[], opts?: Parameters<typeof fakeClaude>[1]) {
  api = fakeClaude(script, opts);
  vi.stubGlobal("fetch", api.fetch);
}
const items = () => chat.useChat.getState().items;
const errors = () => items().filter((i) => i.kind === "notice" && i.level !== "info");
const costs = () => items().filter((i): i is Extract<ReturnType<typeof items>[number], { kind: "cost" }> => i.kind === "cost");
const replies = () => items().filter((i): i is Extract<ReturnType<typeof items>[number], { kind: "assistant" }> => i.kind === "assistant");

beforeEach(async () => {
  vi.resetModules();
  mem.store.clear();
  mem.ran = [];
  settings = await import("../src/app/settings");
  settings.useSettings.setState({ model: "claude-opus-5-5", effort: "high", routeQuick: true, selfReview: "off" });
  chat = await import("../src/ai/chat");
  await chat.loadChat("p1");
});
afterEach(() => {
  chat.resetChat();
  vi.unstubAllGlobals();
});

describe("choosing a model for each turn", () => {
  it("answers a question that only reads the design on the quick model", async () => {
    useApi([{ tool: "get_design" }, { text: "The base is 40 mm wide." }], { route: "quick" });
    await chat.sendMessage("how wide is the base?");
    expect(errors()).toEqual([]);
    expect(api.routerRequests).toHaveLength(1);
    expect(api.requests.map((r) => r.model)).toEqual(["claude-haiku-5-5", "claude-haiku-5-5"]);
    // Haiku has no server-side fallback, and runs at its own default effort
    expect(api.requests[0].fallbacks).toBeUndefined();
    expect(api.requests[0].output_config?.effort).toBe("medium");
    // the same conversation the design model would have seen
    expect(api.requests[0].system).toEqual([{ type: "text", text: "You design mechanical parts.", cache_control: { type: "ephemeral" } }]);
    // web search included: thinking blocks are bound to the tools, so every model gets the same list
    expect((api.requests[0].tools as { name: string }[]).map((t) => t.name)).toEqual(["get_design", "run_checks", "edit_design", "web_search", "web_fetch"]);
    expect(mem.ran).toEqual(["get_design"]);

    const [cost] = costs();
    expect(cost.route).toMatchObject({ model: "claude-haiku-5-5", quick: true, by: "router", why: "reads a dimension from the design" });
    expect(cost.spend.byKind.quick?.[0]).toMatchObject({ model: "claude-haiku-5-5", requests: 2 });
    expect(cost.spend.byKind.router?.[0]).toMatchObject({ model: "claude-haiku-5-5", requests: 1 });
    expect(cost.spend.saved).toBeGreaterThan(0);
  });

  it("sends a change straight to the design model without asking the router", async () => {
    useApi([{ text: "Added it." }], { route: "quick" });
    await chat.sendMessage("add a battery compartment to the base");
    expect(api.routerRequests).toHaveLength(0);
    expect(api.requests[0].model).toBe("claude-opus-5-5");
    expect(api.requests[0].fallbacks).toBe("default");
    expect(costs()[0].route).toMatchObject({ model: "claude-opus-5-5", quick: false, by: "rule", why: "asks for a change" });
  });

  it("does a plain command at once, without Claude", async () => {
    useApi([{ text: "unused" }], { route: "quick" });
    await chat.sendMessage("undo");
    expect(api.requests).toHaveLength(0);
    expect(api.routerRequests).toHaveLength(0);
    expect(chat.useChat.getState().items.slice(-2)).toMatchObject([
      { kind: "user", text: "undo" },
      { kind: "notice", title: "There is nothing to undo." },
    ]);
  });

  it("does a short, plain change on the design model as a small change", async () => {
    useApi([{ text: "Made it thicker." }], { route: "quick" });
    await chat.sendMessage("make the base 5 mm thicker");
    expect(api.routerRequests).toHaveLength(0);
    expect(api.requests[0].model).toBe("claude-opus-5-5");
    expect(costs()[0].route).toMatchObject({ model: "claude-opus-5-5", quick: false, by: "rule", why: "a small change" });
    // it thinks at low effort, set inside the conversation so the cache stays warm
    const messages = api.requests[0].messages as { role: string; output_config?: { effort: string } }[];
    expect(messages.find((m) => m.role === "system")?.output_config?.effort).toBe("low");
  });

  it("keeps a turn on the design model when the router says so", async () => {
    useApi([{ text: "It will hold." }], { route: "design" });
    await chat.sendMessage("is the base strong enough for 20 kg?");
    expect(api.routerRequests).toHaveLength(1);
    expect(api.requests[0].model).toBe("claude-opus-5-5");
    expect(costs()[0].route).toMatchObject({ quick: false, by: "router", why: "needs engineering judgment" });
  });

  it("uses the design model when the router fails", async () => {
    useApi([{ text: "40 mm." }], { route: "broken" });
    await chat.sendMessage("how wide is the base?");
    expect(errors()).toEqual([]);
    expect(api.requests[0].model).toBe("claude-opus-5-5");
    expect(costs()[0].route.why).toBe("the router did not answer");
  });

  it("uses the design model for everything when Settings turn it off", async () => {
    settings.useSettings.setState({ routeQuick: false });
    useApi([{ text: "40 mm." }], { route: "quick" });
    await chat.sendMessage("how wide is the base?");
    expect(api.routerRequests).toHaveLength(0);
    expect(api.requests[0].model).toBe("claude-opus-5-5");
  });

  it("asks no router when the design model is the quick model already", async () => {
    settings.useSettings.setState({ model: "claude-haiku-5-5" });
    useApi([{ text: "40 mm." }], { route: "quick" });
    await chat.sendMessage("how wide is the base?");
    expect(api.routerRequests).toHaveLength(0);
    expect(costs()[0].route.quick).toBe(false);
  });
});

describe("handing over to the design model", () => {
  it("stops the quick model before an edit runs, and the design model answers from the same conversation", async () => {
    useApi([{ tool: "edit_design", input: { find: "5", replace: "10" } }, { text: "Made it 10 mm thick." }], { route: "quick" });
    await chat.sendMessage("the base looks thin to me");
    expect(errors()).toEqual([]);
    expect(api.requests.map((r) => r.model)).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
    // the edit never ran, and nothing Haiku wrote is in the conversation
    expect(mem.ran).toEqual([]);
    expect(normalized(api.requests[1])).toBe(normalized(api.requests[0]));
    expect(items().some((i) => i.kind === "tool" && i.name === "edit_design")).toBe(false);
    expect(replies().map((r) => r.text)).toEqual(["Made it 10 mm thick."]);
    expect(items().some((i) => i.kind === "notice" && i.title === "Passed to Opus 5.5")).toBe(true);

    const [cost] = costs();
    expect(cost.route).toMatchObject({ model: "claude-haiku-5-5", quick: true, escalated: { to: "claude-opus-5-5", why: "it needs a design change" } });
    expect(cost.spend.byKind.escalated?.[0].model).toBe("claude-haiku-5-5");
    expect(cost.spend.byKind.chat?.[0].model).toBe("claude-opus-5-5");
  });

  it("hands over after reading, keeping what the quick model read", async () => {
    useApi([{ tool: "get_design" }, { tool: "edit_design" }, { text: "Done." }], { route: "quick" });
    await chat.sendMessage("the base looks thin to me");
    expect(errors()).toEqual([]);
    expect(api.requests.map((r) => r.model)).toEqual(["claude-haiku-5-5", "claude-haiku-5-5", "claude-opus-5-5"]);
    expect(mem.ran).toEqual(["get_design"]);
    // the design model continues after the read, as an append to the conversation
    expect(normalized(api.requests[2])).toBe(normalized(api.requests[1]));
    expect(api.dropped).toEqual([]);
  });

  it("lets the quick model search the web, and leaves its search out when it hands over for a change", async () => {
    const search = { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "M5 shaft collar" } };
    const found = { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://www.example.com/collar", title: "M5 shaft collar", encrypted_content: "x", page_age: null }] };
    useApi([{ raw: [search, found, { type: "tool_use", id: "toolu_q", name: "edit_design", input: {} }], stop: "tool_use", searches: 1 }, { text: "Added a collar." }], { route: "quick" });
    await chat.sendMessage("how wide is the base?");
    expect(errors()).toEqual([]);
    expect(api.requests.map((r) => r.model)).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
    // the design model starts from the same conversation with the same tools; the quick model's search row goes with its answer
    expect(normalized(api.requests[1])).toBe(normalized(api.requests[0]));
    expect(items().some((i) => i.kind === "tool" && i.web)).toBe(false);
    expect(replies().map((r) => r.text)).toEqual(["Added a collar."]);
  });

  it("resumes a quick model's paused search, then hands over without the paused turn", async () => {
    const search = { type: "server_tool_use", id: "srvtoolu_2", name: "web_search", input: { query: "6808 bearing" } };
    const found = { type: "web_search_tool_result", tool_use_id: "srvtoolu_2", content: [] };
    useApi([{ raw: [search], stop: "pause_turn" }, { raw: [found, { type: "tool_use", id: "toolu_p", name: "edit_design", input: {} }], stop: "tool_use", searches: 1 }, { text: "Changed the bearing." }], { route: "quick" });
    await chat.sendMessage("how wide is the base?");
    expect(errors()).toEqual([]);
    expect(api.requests.map((r) => r.model)).toEqual(["claude-haiku-5-5", "claude-haiku-5-5", "claude-opus-5-5"]);
    // the pause is resumed with the paused turn sent back and no new message
    expect(api.requests[1].messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    // the design model answers the message afresh
    expect(normalized(api.requests[2])).toBe(normalized(api.requests[0]));
    expect(chat.chatHistory().map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(items().some((i) => i.kind === "tool" && i.web)).toBe(false);
    expect(replies().map((r) => r.text)).toEqual(["Changed the bearing."]);
    expect(api.dropped).toEqual([]);
  });

  it("counts web searches at $0.01 each in the cost under the reply", async () => {
    const search = { type: "server_tool_use", id: "srvtoolu_3", name: "web_search", input: { query: "NEMA 17 price" } };
    const found = { type: "web_search_tool_result", tool_use_id: "srvtoolu_3", content: [] };
    useApi([{ raw: [search, found, { type: "text", text: "About $14." }], stop: "end_turn", searches: 2 }], { route: "quick" });
    await chat.sendMessage("how wide is the base?");
    const [cost] = costs();
    const quick = cost.spend.byKind.quick![0];
    // 2 searches are $0.02; the tokens add a fraction of a cent
    expect(quick.cost).toBeGreaterThan(0.02);
    expect(quick.cost).toBeLessThan(0.021);
    // the design model would have searched too, so the saving is in the tokens alone
    expect(cost.spend.saved).toBeGreaterThan(0);
    expect(cost.spend.saved).toBeLessThan(0.001);
  });

  it("answers the quick question again on the design model when asked", async () => {
    useApi([{ text: "40 mm." }, { text: "The base is 40 mm wide across the flange, 20 mm deep." }], { route: "quick" });
    await chat.sendMessage("how wide is the base?");
    const quick = costs()[0];
    expect(quick.route.quick).toBe(true);

    await chat.askDesignModel(quick.id);
    expect(errors()).toEqual([]);
    expect(api.requests.map((r) => r.model)).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
    // the quick answer was taken off the end, so the design model sees the question as it was asked
    expect(normalized(api.requests[1])).toBe(normalized(api.requests[0]));
    expect(replies().map((r) => r.text)).toEqual(["The base is 40 mm wide across the flange, 20 mm deep."]);
    expect(costs()).toHaveLength(1);
    const cost = costs()[0];
    expect(cost.route).toMatchObject({ quick: true, escalated: { to: "claude-opus-5-5", why: "you asked for it" } });
    // what the quick answer cost is carried into this turn
    expect(cost.spend.byKind.escalated?.[0].cost).toBeCloseTo(quick.spend.cost, 10);
    expect(cost.spend.cost).toBeGreaterThan(quick.spend.cost);
  });

  it("answers the quick question again on the design model when the effort changed between steps", async () => {
    useApi([{ tool: "get_design" }, { text: "Made it thicker." }, { text: "Made it thicker again." }, { text: "40 mm." }, { text: "The base is 40 mm wide." }], { route: "quick" });
    await chat.sendMessage("make the base thicker");
    await chat.sendMessage("make it thicker again");
    await chat.sendMessage("how wide is the base?");
    const quick = costs()[2];
    expect(quick.route.quick).toBe(true);

    await chat.askDesignModel(quick.id);
    expect(errors()).toEqual([]);
    expect(api.requests.map((r) => r.model)).toEqual(["claude-opus-5-5", "claude-opus-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-opus-5-5"]);
    // the quick answer goes, the question stays, and the design model thinks at its own effort again
    const last = api.requests[4].messages;
    expect(last.slice(-3).map((m) => m.role)).toEqual(["system", "system", "user"]);
    expect(JSON.stringify(last[last.length - 1].content)).toContain("how wide is the base?");
    expect(replies().at(-1)?.text).toBe("The base is 40 mm wide.");
    expect(api.dropped).toEqual([]);
  });

  it("offers the design model only for the latest quick answer", async () => {
    useApi([{ text: "40 mm." }, { text: "Made it thicker." }], { route: "quick" });
    await chat.sendMessage("how wide is the base?");
    const quick = costs()[0];
    await chat.sendMessage("make it thicker");
    await chat.askDesignModel(quick.id);
    expect(api.requests).toHaveLength(2);
  });
});

describe("what a quick answer would cost", () => {
  it("keeps a long conversation on the design model, where reading it back costs less than Haiku writing it", async () => {
    // the design model has 150K tokens of conversation in its cache
    useApi([{ text: "Made it thicker." }, { text: "40 mm." }], { route: "quick", usage: () => ({ input_tokens: 10, cache_read_input_tokens: 150_000, output_tokens: 1 }) });
    await chat.sendMessage("make the base thicker");
    await chat.sendMessage("how wide is the base?");
    expect(api.routerRequests).toHaveLength(0);
    expect(api.requests.map((r) => r.model)).toEqual(["claude-opus-5-5", "claude-opus-5-5"]);
    expect(costs()[1].route).toMatchObject({ quick: false, by: "rule", why: "a conversation this long costs less on Opus 5.5" });
  });

  it("uses the quick model for a long conversation it has just read", async () => {
    useApi([{ text: "40 mm." }, { text: "20 mm." }], { route: "quick", usage: () => ({ input_tokens: 10, cache_creation_input_tokens: 150_000, output_tokens: 1 }) });
    // the first quick turn is decided before any request reported a size
    await chat.sendMessage("how wide is the base?");
    await chat.sendMessage("and how deep?");
    expect(api.requests.map((r) => r.model)).toEqual(["claude-haiku-5-5", "claude-haiku-5-5"]);
  });
});

describe("keeping the design model's cache", () => {
  it("sends changes asked for from Kerf's panels straight to the design model", async () => {
    useApi([{ text: "Updated." }], { route: "quick" });
    await chat.sendMessage("I changed the brief. Update the design to match, and tell me what you changed.", { design: true });
    expect(api.routerRequests).toHaveLength(0);
    expect(api.requests[0].model).toBe("claude-opus-5-5");
    expect(chat.useChat.getState().routing).toBe(false);
  });

  it("marks where the design model's last request ended, so many quick reads in between don't lose its cache", async () => {
    const marks = (b: (typeof api.requests)[number]) => b.messages.flatMap((m, i) => (typeof m.content !== "string" && m.content.some((c) => "cache_control" in c) ? [i] : []));
    useApi([{ text: "Thicker now." }, { tool: "get_design" }, { tool: "run_checks" }, { tool: "get_design" }, { text: "40 mm." }, { text: "Thinner now." }], { route: "quick" });
    await chat.sendMessage("make the base thicker");
    await chat.sendMessage("how wide is the base?");
    await chat.sendMessage("make it thinner again");
    const [first, ...rest] = api.requests;
    const last = rest.at(-1)!;
    expect(rest.map((r) => r.model)).toEqual(["claude-haiku-5-5", "claude-haiku-5-5", "claude-haiku-5-5", "claude-haiku-5-5", "claude-opus-5-5"]);
    expect(marks(first)).toEqual([first.messages.length - 1]);
    expect(marks(last)).toEqual([first.messages.length - 1, last.messages.length - 1]);
    expect(api.dropped).toEqual([]);
  });
});

describe("the speed chosen beside Send", () => {
  /** the effort each request runs at: the last mark inside the conversation, else the request's own */
  const effortOf = (b: (typeof api.requests)[number]) =>
    (b.messages as { role: string; output_config?: { effort: string } }[]).filter((m) => m.role === "system").at(-1)?.output_config?.effort ?? b.output_config?.effort;

  it("Quick thinks briefly on every step, past the few a small change usually gets", async () => {
    settings.useSettings.setState({ speed: "quick" });
    useApi([{ tool: "get_design" }, { tool: "get_design" }, { tool: "get_design" }, { tool: "get_design" }, { tool: "get_design" }, { text: "Added it." }], { route: "quick" });
    await chat.sendMessage("add a battery compartment to the base");
    expect(api.requests).toHaveLength(6);
    expect(api.requests.map(effortOf)).toEqual(["low", "low", "low", "low", "low", "low"]);
    expect(api.requests.every((r) => r.model === "claude-opus-5-5")).toBe(true);
    expect(costs()[0].route).toMatchObject({ by: "you", why: "you chose Quick" });
  });

  it("Quick leaves a question the router sends to the quick model as it is", async () => {
    settings.useSettings.setState({ speed: "quick" });
    useApi([{ text: "40 mm." }], { route: "quick" });
    await chat.sendMessage("how wide is the base?");
    expect(api.requests[0].model).toBe("claude-haiku-5-5");
    expect(costs()[0].route).toMatchObject({ quick: true, by: "router" });
  });

  it("Thorough puts even a question on the design model without asking the router, thinking hardest first", async () => {
    settings.useSettings.setState({ speed: "thorough" });
    useApi([{ tool: "get_design" }, { text: "The base is 40 mm wide." }], { route: "quick" });
    await chat.sendMessage("how wide is the base?");
    expect(api.routerRequests).toHaveLength(0);
    expect(api.requests.map((r) => r.model)).toEqual(["claude-opus-5-5", "claude-opus-5-5"]);
    expect(api.requests.map(effortOf)).toEqual(["max", "high"]);
    // the request's own effort stays as set, so the cache holds
    expect(api.requests.map((r) => r.output_config?.effort)).toEqual(["high", "high"]);
    expect(costs()[0].route).toMatchObject({ quick: false, by: "you", why: "you chose Thorough" });
  });
});
