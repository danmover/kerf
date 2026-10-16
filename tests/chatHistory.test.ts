// The chat loop against a fake Claude API that enforces thinking-block binding
// the way the real one does (see fakeClaude.ts). Each test is a way Kerf used to
// send back a thinking block from a conversation that had since changed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClaude, normalized, type Turn } from "./fakeClaude";

const mem = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  prompt: "You design mechanical parts.",
  tools: [
    { name: "capture_view", description: "Look at the model.", input_schema: { type: "object", properties: {} } },
    { name: "run_checks", description: "Run the checks.", input_schema: { type: "object", properties: {} } },
  ] as { name: string; description: string; input_schema: object }[],
  gate: null as Promise<void> | null,
  views: 0,
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
vi.mock("../src/agents/orchestrator", () => ({ isBuilding: () => false }));
vi.mock("../src/ai/prompt", () => ({ systemPrompt: () => mem.prompt }));
vi.mock("../src/ai/tools", () => ({
  TOOL_DEFS: mem.tools,
  TOOL_TITLES: {},
  modelSummary: () => "Design t: 1 part",
  briefSummary: () => "",
  reportSummary: () => "All checks pass",
  runTool: async (name: string) => {
    if (mem.gate) await mem.gate;
    if (name === "capture_view") {
      const n = ++mem.views;
      return { content: [{ type: "text", text: `view ${n}` }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: `/9j/${n}` } }], card: { title: "Looked at the model" } };
    }
    return { content: "All checks pass", card: { title: "Ran the checks" } };
  },
}));

type Chat = typeof import("../src/ai/chat");
let chat: Chat;
let api: ReturnType<typeof fakeClaude>;

function useApi(script: Turn[], opts?: Parameters<typeof fakeClaude>[1]) {
  api = fakeClaude(script, opts);
  vi.stubGlobal("fetch", api.fetch);
}
const errors = () => chat.useChat.getState().items.filter((i) => i.kind === "notice" && i.level !== "info");
const thinkingIn = (b: (typeof api.requests)[number]) => b.messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content)).filter((c) => c.type === "thinking").length;
const saved = () => new Promise((r) => setTimeout(r, 500));

beforeEach(async () => {
  vi.resetModules();
  mem.store.clear();
  mem.prompt = "You design mechanical parts.";
  mem.tools.splice(2);
  mem.gate = null;
  mem.views = 0;
  chat = await import("../src/ai/chat");
  await chat.loadChat("p1");
});
afterEach(() => {
  chat.resetChat(); // also cancels a pending save
  vi.unstubAllGlobals();
});

describe("thinking blocks stay valid", () => {
  it("only ever appends to the conversation, however many views Claude looks at", async () => {
    useApi([{ tool: "capture_view" }, { tool: "capture_view" }, { tool: "capture_view" }, { tool: "capture_view" }, { text: "Looks right." }]);
    await chat.sendMessage("make a bracket");
    expect(errors()).toEqual([]);
    expect(api.requests).toHaveLength(5);
    for (let i = 1; i < api.requests.length; i++) {
      const prev = api.requests[i - 1];
      expect(normalized(api.requests[i], prev.messages.length)).toBe(normalized(prev));
    }
    expect(api.dropped).toEqual([]);
    expect(thinkingIn(api.requests[4])).toBe(4);
  });

  it("keeps working when a long chat's oldest pictures are dropped to keep requests small", async () => {
    const views = (n: number): Turn[] => [...Array.from({ length: n }, () => ({ tool: "capture_view" })), { text: "Looked." }];
    useApi([...views(11), ...views(11), ...views(11)]);
    await chat.sendMessage("look around");
    await chat.sendMessage("and again");
    await chat.sendMessage("once more");
    expect(errors()).toEqual([]);
    // the cut is made by Kerf before sending, never left to the API to notice
    expect(api.dropped).toEqual([]);
    const imagesIn = (b: (typeof api.requests)[number]) => JSON.stringify(b.messages).split('"type":"image"').length - 1;
    expect(imagesIn(api.requests.at(-1)!)).toBeLessThanOrEqual(30);
  });

  it("sends the safety net: drop instead of failing on a block that no longer matches", async () => {
    useApi([{ text: "Hi." }]);
    await chat.sendMessage("hello");
    const body = api.requests[0] as { thinking?: { block_binding?: { prefix_mismatch_behavior?: string } } };
    expect(body.thinking?.block_binding?.prefix_mismatch_behavior).toBe("drop_block");
  });

  it("keeps working when a saved chat with images is reopened", async () => {
    useApi([{ tool: "capture_view" }, { text: "Done." }, { text: "Thicker now." }]);
    await chat.sendMessage("make a bracket");
    await saved();
    await chat.loadChat("p1");
    await chat.sendMessage("make it thicker");
    expect(errors()).toEqual([]);
    expect(api.dropped).toEqual([]);
    // the thinking from before the image survives; the one after it can't
    expect(thinkingIn(api.requests[2])).toBe(1);
  });

  it("keeps working after an update changed the system prompt or tools", async () => {
    useApi([{ tool: "run_checks" }, { text: "Done." }, { text: "Again." }, { text: "And again." }]);
    await chat.sendMessage("make a bracket");
    await saved();
    mem.prompt += " Prefer metric units.";
    await chat.loadChat("p1");
    await chat.sendMessage("check it");
    expect(errors()).toEqual([]);
    expect(api.dropped).toEqual([]);
    expect(thinkingIn(api.requests[2])).toBe(0);
    // a tool added while the chat is open (hot reload) is caught before sending too
    mem.tools.push({ name: "measure", description: "Measure.", input_schema: { type: "object", properties: {} } });
    await chat.sendMessage("once more");
    expect(errors()).toEqual([]);
    expect(api.dropped).toEqual([]);
  });

  it("recovers by itself if the API still rejects an old block", async () => {
    // a saved chat whose history was changed elsewhere (another device, an old build)
    // but claims to be intact, on a model that does not take block_binding
    useApi([{ tool: "run_checks" }, { text: "Done." }], { rejectBinding: true });
    await chat.sendMessage("make a bracket");
    await saved();
    const rec = mem.store.get("p1") as { history: { content: { type: string; text?: string }[] }[]; binding?: string; validBefore?: number };
    rec.history[0].content[1].text = "make a hook";
    // the prompt and tools as sent, web search included
    rec.binding = chat.currentBinding();
    rec.validBefore = rec.history.length;
    api.script.push({ text: "A hook." });
    await chat.loadChat("p1");
    await chat.sendMessage("go on");
    expect(errors()).toEqual([]);
    // the first try is rejected, the second goes without the old thinking
    const [rejected, retried] = api.requests.slice(2);
    expect(thinkingIn(rejected)).toBeGreaterThan(0);
    expect(thinkingIn(retried)).toBe(0);
    expect(api.requests).toHaveLength(4);
    const last = chat.useChat.getState().items.filter((i) => i.kind === "assistant").at(-1);
    expect(last && last.kind === "assistant" && last.text).toBe("A hook.");
  });

  it("never lets a run that is still going write into another project's chat", async () => {
    let open!: () => void;
    mem.gate = new Promise((r) => (open = r));
    useApi([{ tool: "run_checks" }, { text: "Done." }, { text: "Hello from B." }]);
    const runA = chat.sendMessage("make a bracket in A");
    await vi.waitFor(() => expect(api.requests).toHaveLength(1));
    await chat.loadChat("p2");
    open();
    mem.gate = null;
    await runA;
    await chat.sendMessage("hello B");
    expect(errors()).toEqual([]);
    const b = api.requests.at(-1)!;
    expect(b.messages).toHaveLength(1);
    expect(JSON.stringify(b.messages)).toContain("hello B");
    expect(JSON.stringify(b.messages)).not.toContain("bracket in A");
  });
});
