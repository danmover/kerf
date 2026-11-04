// Kerf's design tools for the person's own Claude Code: the local MCP server
// (desktop/mcp.ts) and the page side that runs the calls (src/ai/claudeCode.ts).

import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { startMcp, type McpBackend, type RunningMcp } from "../desktop/mcp";
import { callTool, mcpTools, toMcp, type McpToolResult } from "../src/ai/claudeCode";
import { TOOL_DEFS } from "../src/ai/tools";
import { useProject } from "../src/app/project";
import { useChat } from "../src/ai/chat";
import { useDesign } from "../src/core/engine";
import { evaluate } from "../src/lang/evaluator";
import { templateById } from "../src/demos/templates";
import { clearAsks } from "../src/ai/asks";

const TOKEN = "t".repeat(43);
const textOf = (r: McpToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
let running: RunningMcp[] = [];
afterEach(async () => {
  await Promise.all(running.map((r) => r.close()));
  running = [];
});

async function serve(request: McpBackend["request"], port = 0) {
  const r = await startMcp({ port, token: TOKEN, backend: { request, instructions: "Use kerf_instructions first.", version: "9.9.9" } });
  running.push(r);
  return r;
}

const post = (url: string, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });

describe("Kerf's MCP server", () => {
  it("only answers with the token, and never a web page", async () => {
    const r = await serve(async () => ({}));
    expect(r.url).toBe(`http://127.0.0.1:${r.port}/mcp`);
    expect((await post(r.url, { jsonrpc: "2.0", id: 1, method: "ping" }, {})).status).toBe(401);
    expect((await post(r.url, { jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await post(r.url, { jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: `Bearer ${TOKEN}`, origin: "https://example.com" })).status).toBe(403);
    expect((await post(r.url.replace("/mcp", "/other"), {})).status).toBe(404);
    expect((await fetch(r.url, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
  });

  it("initializes with Kerf's instructions and acknowledges notifications", async () => {
    const r = await serve(async () => ({}));
    const init = await (await post(r.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } } })).json();
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.capabilities.tools).toBeTruthy();
    expect(init.result.serverInfo).toMatchObject({ name: "kerf", version: "9.9.9" });
    expect(init.result.instructions).toContain("kerf_instructions");
    const unknown = await (await post(r.url, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })).json();
    expect(unknown.result.protocolVersion).toBe("2025-11-25");
    expect((await post(r.url, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const missing = await (await post(r.url, { jsonrpc: "2.0", id: 3, method: "resources/list" })).json();
    expect(missing.error.code).toBe(-32601);
  });

  it("passes tool calls to the page and returns its answer or its error", async () => {
    const seen: unknown[] = [];
    const r = await serve(async (method, params) => {
      seen.push([method, params]);
      if ((params as { name?: string }).name === "boom") throw new Error("the page broke");
      return method === "tools/list" ? { tools: [{ name: "get_design" }] } : { content: [{ type: "text", text: "ok" }] };
    });
    const list = await (await post(r.url, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
    expect(list.result.tools[0].name).toBe("get_design");
    const call = await (await post(r.url, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_design", arguments: {} } })).json();
    expect(call).toEqual({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ok" }] } });
    const bad = await (await post(r.url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "boom" } })).json();
    expect(bad.error.message).toBe("the page broke");
    expect(seen[1]).toEqual(["tools/call", { name: "get_design", arguments: {} }]);
  });

  it("aborts a call Claude Code cancels", async () => {
    let aborted = false;
    const r = await serve(
      (_m, _p, signal) =>
        new Promise((resolve) =>
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ content: [{ type: "text", text: "Cancelled." }], isError: true });
          }),
        ),
    );
    const call = post(r.url, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "run_analysis" } });
    await new Promise((res) => setTimeout(res, 50));
    expect((await post(r.url, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } })).status).toBe(202);
    expect((await (await call).json()).result.isError).toBe(true);
    expect(aborted).toBe(true);
  });

  it("moves to the next port when its own is taken", async () => {
    const blocker = createServer();
    await new Promise<void>((res) => blocker.listen(0, "127.0.0.1", () => res()));
    const taken = (blocker.address() as { port: number }).port;
    try {
      const r = await serve(async () => ({}), taken);
      expect(r.port).toBeGreaterThan(taken);
      expect(r.port).toBeLessThanOrEqual(taken + 10);
    } finally {
      blocker.close();
    }
  });
});

describe("Kerf's tools in Claude Code", () => {
  afterEach(() => {
    useProject.setState({ current: null });
    useChat.setState({ busy: false });
  });

  it("offers the chat's tools except those that need Kerf's own chat, plus the design guide", () => {
    const names = mcpTools().map((t) => t.name);
    expect(names[0]).toBe("kerf_instructions");
    for (const n of ["get_design", "edit_design", "write_design", "capture_view", "run_checks", "update_plan", "catalog_lookup"]) expect(names).toContain(n);
    for (const n of ["ask_user", "suggest_next_steps", "review_design", "build_subassemblies"]) expect(names).not.toContain(n);
    expect(names.length).toBe(TOOL_DEFS.length - 4 + 1);
    for (const t of mcpTools()) expect((t.inputSchema as { type: string }).type).toBe("object");
  });

  it("turns tool results into MCP content", () => {
    expect(toMcp("")).toEqual([{ type: "text", text: "Done." }]);
    expect(
      toMcp([
        { type: "text", text: "Front view" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "BBBB" }, title: "Datasheet" },
      ]),
    ).toEqual([
      { type: "text", text: "Front view" },
      { type: "image", data: "AAAA", mimeType: "image/jpeg" },
      { type: "resource", resource: { uri: "kerf://document/3.pdf", mimeType: "application/pdf", blob: "BBBB" } },
    ]);
  });

  it("gives the guide, runs tools on the open project and says when it can't", async () => {
    const signal = new AbortController().signal;
    const guide = await callTool({ name: "kerf_instructions" }, signal);
    expect(textOf(guide)).toContain("through Claude Code");
    expect(textOf(guide)).toContain("design engineer inside Kerf");

    expect((await callTool({ name: "nope" }, signal)).isError).toBe(true);
    const closed = await callTool({ name: "catalog_lookup", arguments: { id: "lipo_3s_2200" } }, signal);
    expect(closed.isError).toBe(true);
    expect(textOf(closed)).toContain("No project is open");

    useProject.setState({ current: { id: "p1" } as never });
    const ok = await callTool({ name: "catalog_lookup", arguments: { id: "lipo_3s_2200" } }, signal);
    expect(ok.isError).toBeUndefined();
    expect(textOf(ok)).toContain("lipo_3s_2200");

    useChat.setState({ busy: true });
    const clash = await callTool({ name: "catalog_lookup", arguments: { id: "lipo_3s_2200" } }, signal);
    expect(textOf(clash)).toContain("Kerf's own chat is working");
  });

  it("measures Claude Code's asks against the design as it was when it noted them", async () => {
    const source = templateById("enclosure")!.source;
    const s = useDesign.getState();
    useDesign.setState({ source, model: evaluate(source), reportRev: s.rev });
    useProject.setState({ current: { id: "p1" } as never });
    clearAsks();
    const r = await callTool({ name: "record_asks", arguments: { asks: [{ ask: "keep the lid screws", keep: true, part: "lid_fasteners" }] } }, new AbortController().signal);
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toContain("✓ keep: keep the lid screws (lid_fasteners unchanged)");
    clearAsks();
  });
});
