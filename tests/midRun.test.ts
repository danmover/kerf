// Messages sent while Claude works join the running loop at its next step,
// against the fake Claude API that enforces thinking-block binding: nothing is
// stopped or asked again, and the conversation only ever grows.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClaude, normalized, type Turn } from "./fakeClaude";

const mem = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  tools: [
    { name: "run_checks", description: "Run the checks.", input_schema: { type: "object", properties: {} } },
    { name: "capture_view", description: "Look at the model.", input_schema: { type: "object", properties: {} } },
  ],
  gate: null as Promise<void> | null,
}));

vi.mock("../src/persist/vault", () => ({ getApiKey: () => "sk-ant-test" }));
vi.mock("../src/persist/db", () => ({
  getOne: async (_s: string, id: string) => structuredClone(mem.store.get(id)),
  put: async (_s: string, r: { projectId: string }) => void mem.store.set(r.projectId, structuredClone(r)),
  remove: async (_s: string, id: string) => void mem.store.delete(id),
}));
vi.mock("../src/core/engine", async () => {
  const { create } = await import("zustand");
  return { useDesign: create(() => ({ source: 'design "t"', model: null, report: null })), evaluateOnly: () => null };
});
vi.mock("../src/app/view", () => ({ useView: { getState: () => ({ selected: [] }) } }));
vi.mock("../src/app/project", async () => {
  const { create } = await import("zustand");
  return { commitSource: () => undefined, endPreview: () => undefined, setUndoGuard: () => undefined, useProject: create(() => ({ current: { id: "p1" }, versions: [] })) };
});
vi.mock("../src/agents/orchestrator", () => ({ isBuilding: () => false, relayToAgents: () => [] }));
vi.mock("../src/ai/prompt", () => ({ systemPrompt: () => "You design mechanical parts." }));
vi.mock("../src/ai/tools", () => ({
  TOOL_DEFS: mem.tools,
  TOOL_TITLES: {},
  modelSummary: () => "Design t: 1 part",
  briefSummary: () => "",
  reportSummary: () => "All checks pass",
  runTool: async () => {
    if (mem.gate) await mem.gate;
    return { content: "All checks pass", card: { title: "Ran the checks" } };
  },
}));

type Chat = typeof import("../src/ai/chat");
let chat: Chat;
let api: ReturnType<typeof fakeClaude>;
/** holds the next streamed response until released, as if Claude were still writing it */
let streamGate: Promise<void> | null = null;

function useApi(script: Turn[]) {
  api = fakeClaude(script);
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (streamGate && JSON.parse(String(init?.body)).stream) await streamGate;
    return api.fetch(url, init);
  });
}
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};
const items = () => chat.useChat.getState().items;
const errors = () => items().filter((i) => i.kind === "notice" && i.level !== "info");
const lastUserTurn = (b: (typeof api.requests)[number]) => JSON.stringify(b.messages.at(-1));
const appendOnly = () => {
  for (let i = 1; i < api.requests.length; i++) expect(normalized(api.requests[i], api.requests[i - 1].messages.length)).toBe(normalized(api.requests[i - 1]));
};

beforeEach(async () => {
  vi.resetModules();
  mem.store.clear();
  mem.gate = null;
  streamGate = null;
  chat = await import("../src/ai/chat");
  await chat.loadChat("p1");
});
afterEach(() => {
  chat.resetChat();
  vi.unstubAllGlobals();
});

describe("messages sent while Claude works", () => {
  it("join the run after the current tool, without a new turn", async () => {
    const g = gate();
    mem.gate = g.p;
    useApi([{ tool: "run_checks" }, { text: "Made it 3 mm." }]);
    const run = chat.sendMessage("make a bracket");
    await vi.waitFor(() => expect(api.requests).toHaveLength(1));
    expect(chat.useChat.getState().busy).toBe(true);
    await chat.sendMessage("make the wall 3 mm");
    const mine = items().find((i) => i.kind === "user" && i.text === "make the wall 3 mm");
    expect(mine).toMatchObject({ midRun: true });
    expect(chat.midRunState(mine!.id)?.delivered).toBe(false);
    g.open();
    await run;
    expect(errors()).toEqual([]);
    expect(api.requests).toHaveLength(2);
    // it rides with the tool result, so Claude's next step already takes it into account
    const turn = lastUserTurn(api.requests[1]);
    expect(turn).toContain("tool_result");
    expect(turn).toContain("<user-messages>");
    expect(turn).toContain("make the wall 3 mm");
    expect(chat.midRunState(mine!.id)?.delivered).toBe(true);
    appendOnly();
    expect(items().filter((i) => i.kind === "cost")).toHaveLength(1);
  });

  it("still get an answer when Claude was writing its final reply", async () => {
    const g = gate();
    streamGate = g.p;
    useApi([{ text: "Here is the bracket." }, { text: "And now with a slot." }]);
    const run = chat.sendMessage("make a bracket");
    await vi.waitFor(() => expect(chat.useChat.getState().busy).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    await chat.sendMessage("add a slot too");
    streamGate = null;
    g.open();
    await run;
    expect(errors()).toEqual([]);
    expect(api.requests).toHaveLength(2);
    expect(lastUserTurn(api.requests[1])).toContain("add a slot too");
    appendOnly();
    expect(chat.useChat.getState().busy).toBe(false);
  });

  it("can be taken back before Claude reads them", async () => {
    const g = gate();
    mem.gate = g.p;
    useApi([{ tool: "run_checks" }, { text: "Done." }]);
    const run = chat.sendMessage("make a bracket");
    await vi.waitFor(() => expect(api.requests).toHaveLength(1));
    await chat.sendMessage("actually make it blue");
    const mine = items().find((i) => i.kind === "user" && i.text === "actually make it blue")!;
    chat.withdrawMidRun(mine.id);
    expect(items().some((i) => i.id === mine.id)).toBe(false);
    g.open();
    await run;
    expect(JSON.stringify(api.requests.at(-1)!.messages)).not.toContain("make it blue");
  });

  it("wait after a stop, and go when the user says so", async () => {
    const g = gate();
    mem.gate = g.p;
    useApi([{ tool: "run_checks" }, { text: "Blue it is." }]);
    const run = chat.sendMessage("make a bracket");
    await vi.waitFor(() => expect(api.requests).toHaveLength(1));
    await chat.sendMessage("make it blue");
    chat.stop();
    g.open();
    await run;
    const mine = items().find((i) => i.kind === "user" && i.text === "make it blue")!;
    expect(chat.midRunState(mine.id)?.delivered).toBe(false);
    await chat.sendQueuedNow();
    expect(errors()).toEqual([]);
    expect(lastUserTurn(api.requests.at(-1)!)).toContain("make it blue");
    expect(chat.midRunState(mine.id)?.delivered).toBe(true);
    appendOnly();
  });

  it("keep pictures and files for after the run", async () => {
    const g = gate();
    mem.gate = g.p;
    useApi([{ tool: "run_checks" }, { text: "Done." }]);
    const run = chat.sendMessage("make a bracket");
    await vi.waitFor(() => expect(api.requests).toHaveLength(1));
    expect(chat.addMidRun("like this", { files: [{ asset: "ast_1", kind: "image", name: "a.jpg" }] })).toBe(false);
    expect(items().some((i) => i.kind === "user" && i.text === "like this")).toBe(false);
    g.open();
    await run;
  });
});
