// The design assistant: machine reference, part lookup and calculator tools,
// web search wiring and the chat loop against a fake API client. No test here
// touches the network or needs an API key.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { evaluate } from "../src/lang/evaluator";
import { UNITS } from "../src/lang/lexer";
import { assembleReport } from "../src/core/checks";
import { CATALOG, CATALOG_KINDS } from "../src/machine/catalog";
import { CALC_FNS } from "../src/machine/calcs";
import { calcParams, languageReference, partsTable } from "../src/ai/reference";
import { systemPrompt } from "../src/ai/prompt";
import { TOOL_DEFS, catalogLookup, engineeringCalc, firmwareSummary, machineSummary, reportSummary, runTool } from "../src/ai/tools";
import { webTools, webSearchFee, webActivity, citedSources, isPausedTurn, echoContent, flattenServerTools, isWebToolError, safeUrl } from "../src/ai/web";
import { useChat, sendMessage, retryLast, clearChat, loadChat, setClientFactory, chatHistory, requestTools, type ChatItem } from "../src/ai/chat";
import { useSettings } from "../src/app/settings";
import { useAccount } from "../src/cloud/account";

// ---------- reference and prompt ----------

describe("assistant reference", () => {
  const ref = languageReference();

  it("documents every catalog part, kind, unit and calculator", () => {
    for (const p of CATALOG) expect(ref, p.id).toContain(p.id);
    for (const k of CATALOG_KINDS) expect(ref, k).toContain(`- ${k}: `);
    for (const u of Object.keys(UNITS)) expect(ref, u).toMatch(new RegExp(`(^|[^A-Za-z_])${u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z_]|$)`, "m"));
    for (const name of Object.keys(CALC_FNS)) {
      expect(ref, name).toContain(`calc.${name}(`);
      expect(calcParams(name).length, name).toBeGreaterThan(0);
    }
  });

  it("documents every firmware setting the generators read", () => {
    const dir = join(__dirname, "../src/machine/firmware");
    const names = new Set<string>();
    for (const f of ["arduino.ts", "klipper.ts"]) {
      const src = readFileSync(join(dir, f), "utf8");
      for (const m of src.matchAll(/setting\(c\.fw, "([a-z_0-9]+)"/g)) names.add(m[1]);
      for (const m of src.matchAll(/setting\(c\.fw, `\$\{[^}]+\}(_[a-z_]+)`/g)) for (const ax of ["x", "y", "z", "e"]) names.add(ax + m[1]);
    }
    names.delete("behavior"); // US spelling of behaviour, accepted as an alias
    expect(names.size).toBeGreaterThan(20);
    for (const n of names) expect(ref, n).toMatch(new RegExp(`\\b${n}\\b`));
  });

  it("lists parts with their decimals intact and calculator arguments", () => {
    const table = partsTable();
    expect(table.split("\n").filter((l) => / \| /.test(l)).length).toBeGreaterThanOrEqual(CATALOG.length);
    expect(calcParams("sand_stress")).toContain("depth");
    expect(calcParams("bearing_life")).toEqual(["bearing", "load", "rpm"]);
    expect(calcParams("no_such_calc")).toEqual([]);
  });

  it("tells Claude how to design a machine and use web search", () => {
    const p = systemPrompt();
    expect(p).toContain("## Machines");
    expect(p).toContain("## Web search");
    expect(p).toMatch(/catalog first/i);
    expect(p).toContain("engineering_calc");
    expect(p).toContain("catalog_lookup");
    expect(p).toMatch(/physical test/);
  });
});

// ---------- part lookup and calculator tools ----------

describe("catalog_lookup", () => {
  it("returns pins, specs and usage for an id", () => {
    const r = catalogLookup({ id: "arduino_nano" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('lib.controller("arduino_nano")');
    expect(String(r.content)).toMatch(/D13|A0/);
  });

  it("suggests close ids for a typo", () => {
    const r = catalogLookup({ id: "arduino_nanoo" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("arduino_nano");
  });

  it("searches and lists by kind", () => {
    const q = catalogLookup({ query: "motor driver" });
    expect(q.isError).toBeFalsy();
    expect(q.content).toMatch(/catalog parts? match/);
    const k = catalogLookup({ kind: "battery" });
    for (const p of CATALOG.filter((x) => x.kind === "battery")) expect(k.content).toContain(p.id);
    expect(catalogLookup({ kind: "spaceship" }).isError).toBe(true);
    expect(catalogLookup({}).isError).toBe(true);
  });

  it("points at web search when the catalog has nothing", () => {
    const r = catalogLookup({ query: "flux capacitor 1.21 gigawatt" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/search the web/);
  });

  it("runs through the tool dispatcher with input validation", async () => {
    const ok = await runTool("catalog_lookup", { id: "lipo_3s_2200" });
    expect(ok.isError).toBeFalsy();
    const bad = await runTool("catalog_lookup", { limit: 500 });
    expect(bad.isError).toBe(true);
  });
});

describe("engineering_calc", () => {
  it("reads values with units and reports inputs, results and method", () => {
    const r = engineeringCalc("sand_stress", { depth: "9.5m", box_w: "1m" });
    expect(r.isError).toBeFalsy();
    const t = String(r.content);
    expect(t).toContain("calc.sand_stress(depth: 9.5m, box_w: 1m)");
    expect(t).toContain("Results:");
    expect(t).toContain("Method:");
    expect(t).toMatch(/sigma_v = [\d.]+/);
    expect(t).toContain("let <name> = calc.sand_stress(depth: 9.5m, box_w: 1m)");
  });

  it("takes catalog parts for component arguments", () => {
    const r = engineeringCalc("motor_point", { motor: "gobilda_5203_188", load: "10Nm" });
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toMatch(/stall_margin = [\d.]+/);
  });

  it("takes bearing codes", () => {
    const r = engineeringCalc("bearing_life", { bearing: "6808", load: 200, rpm: 100 });
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toMatch(/hours = /);
    expect(engineeringCalc("bearing_life", { bearing: "9999x", load: 200, rpm: 100 }).isError).toBe(true);
  });

  it("explains bad input in plain terms", () => {
    const unknown = engineeringCalc("sand_stress", { depthh: 1 });
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toMatch(/no argument "depthh"[\s\S]*It accepts: .*depth/);
    const unreadable = engineeringCalc("sand_stress", { depth: "9.5 parsecs" });
    expect(unreadable.isError).toBe(true);
    expect(unreadable.content).toContain("could not read depth");
    expect(engineeringCalc("motor_point", { motor: "not_a_motor", load: 1 }).isError).toBe(true);
    expect(engineeringCalc("warp_drive", {}).isError).toBe(true);
  });

  it("is declared with every calculator name", () => {
    const def = TOOL_DEFS.find((t) => t.name === "engineering_calc") as unknown as { input_schema: { properties: { name: { enum: string[] } } } };
    expect(def.input_schema.properties.name.enum.sort()).toEqual(Object.keys(CALC_FNS).sort());
  });
});

// ---------- machine summaries ----------

const TUNNELLER = `
design "Tunneller"
param depth = 9.5m
component ctrl = lib.controller("arduino_nano") { at: (0, 0, 0) }
component drv_f = lib.motor_driver("pololu_g2_18v17") { at: (50, 0, 0) }
component m_front = lib.gearmotor("gobilda_5203_188") { at: (200, 0, 0), axis: X, role: "front screw", load: 10Nm }
component bat = lib.battery("lipo_3s_2200") { at: (0, 500, 0) }
let sand = calc.sand_stress(depth: depth, box_w: 1m)
let point = calc.motor_point(motor: m_front, load: 10Nm)
wire bat.POS -> drv_f.VIN { gauge: 16, color: "red" }
net GND: bat.NEG, drv_f.GND_PWR, drv_f.GND, ctrl.GND { gauge: 16, color: "black" }
wire drv_f.OUTA -> m_front.M_PLUS { gauge: 16 }
wire drv_f.OUTB -> m_front.M_MINUS { gauge: 16 }
wire ctrl.D9 -> drv_f.PWM
wire ctrl.D8 -> drv_f.DIR
firmware brain { board: ctrl, behaviour: "Dig through the sand box and stop at the far side", run_distance: 1100mm }
test "Thrust": "Push the screw into sand and measure the current; pass below 5 A"
buy "M3 screw assortment" { qty: 1, price: 10 }
require "motor margin" soft: point.stall_margin >= 2
`;

describe("machine summaries", () => {
  const m = evaluate(TUNNELLER, { skipGeometry: true });

  it("evaluates the test design", () => {
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("summarises parts, wiring, calculations and cost", () => {
    const s = machineSummary(m);
    expect(s).toMatch(/Machine: 4 catalog parts, 5 wires, 1 net, 2 calculations, 1 firmware block, 1 test, 1 buy item; parts about \$\d+\./);
    expect(s).toContain("sand");
  });

  it("reports what the firmware generator makes and its warnings", () => {
    const f = firmwareSummary(m);
    expect(f.text).toMatch(/^Firmware:\n  - brain \(board ctrl\): Arduino sketch\. .+\. \d+ files?, \d+ wired signals?\./);
    expect(f.warnings).toBe((f.text.match(/^    \* /gm) ?? []).length);
    expect(f.text).toContain(f.warnings ? "Warnings:" : "No warnings.");
    expect(firmwareSummary(null)).toEqual({ text: "", warnings: 0 });
  });

  it("includes machine checks with how each was established", () => {
    const r = reportSummary(assembleReport(m));
    expect(r).toMatch(/^Checks: \d+ pass/);
    expect(r).toMatch(/; (electrical rules|calculation|physical test)\)/);
  });
});

// ---------- web search helpers ----------

const SEARCH_RESULT = { type: "web_search_result", url: "https://www.pololu.com/product/3754", title: "Pololu G2 High-Power Motor Driver 18v17", encrypted_content: "enc", page_age: null };
const PAGE = { type: "web_fetch_result", url: "https://www.pololu.com/product/3754", content: { type: "document", source: { type: "text", media_type: "text/plain", data: "Price $39.95" }, title: "Pololu G2 18v17" }, retrieved_at: "2026-10-16" };
const CITE = { type: "web_search_result_location", url: "https://www.pololu.com/product/3754", title: "Pololu G2 High-Power Motor Driver 18v17", cited_text: "Price $39.95", encrypted_index: "idx" };

describe("web search helpers", () => {
  it("declares the basic versions, which every model takes, so a turn on a cheaper model sees the same tools", () => {
    const tools = webTools() as { type: string; max_uses?: number }[];
    expect(tools.map((t) => t.type)).toEqual(["web_search_20250305", "web_fetch_20250910"]);
    expect(tools.every((t) => t.max_uses === 8)).toBe(true);
  });

  it("works out the web search fee from a response's usage", () => {
    expect(webSearchFee({ server_tool_use: { web_search_requests: 3 } })).toBeCloseTo(0.03, 10);
    expect(webSearchFee({ server_tool_use: null })).toBe(0);
    expect(webSearchFee(undefined)).toBe(0);
  });

  it("describes searches, page reads and their errors", () => {
    const acts = webActivity([
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "BTS7960 price" } },
      { type: "web_search_tool_result", tool_use_id: "s1", content: [SEARCH_RESULT] },
      { type: "server_tool_use", id: "s2", name: "web_fetch", input: { url: "https://www.pololu.com/product/3754" } },
      { type: "web_fetch_tool_result", tool_use_id: "s2", content: PAGE },
      { type: "server_tool_use", id: "s3", name: "web_search", input: { query: "more" } },
      { type: "web_search_tool_result", tool_use_id: "s3", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
      { type: "server_tool_use", id: "s4", name: "web_fetch", input: { url: "javascript:alert(1)" } },
    ]);
    expect(acts.map((a) => [a.status, a.title])).toEqual([
      ["done", "Searched the web: BTS7960 price"],
      ["done", "Read: pololu.com"],
      ["error", "Web search did not work: more"],
      ["running", "Reading: javascript:alert(1)"],
    ]);
    expect(acts[0].detail).toBe("1 result: pololu.com");
    expect(acts[1].link).toEqual({ url: "https://www.pololu.com/product/3754", label: "Pololu G2 18v17" });
    expect(acts[2].error?.code).toBe("max_uses_exceeded");
    expect(acts[3].link).toBeUndefined();
    // a finished response: a call without a result block (read in code) has run
    expect(webActivity([{ type: "server_tool_use", id: "s5", name: "web_search", input: { query: "q" } }, { type: "text", text: "x" }], true)[0].status).toBe("done");
    expect(webActivity([{ type: "server_tool_use", id: "s6", name: "web_search", input: { query: "q" } }], "paused")[0].status).toBe("running");
  });

  it("collects cited pages once each and only http links", () => {
    const s = citedSources([
      { type: "text", text: "a", citations: [CITE, CITE] },
      { type: "text", text: "b", citations: [{ ...CITE, url: "javascript:alert(1)" }, { type: "char_location", cited_text: "x" }] },
      { type: "text", text: "c" },
    ]);
    expect(s).toEqual([{ url: "https://www.pololu.com/product/3754", title: "Pololu G2 High-Power Motor Driver 18v17" }]);
    expect(safeUrl("ftp://x")).toBeNull();
  });

  it("recognises a paused turn and a key that cannot use web search", () => {
    expect(isPausedTurn({ role: "assistant", content: [{ type: "server_tool_use", id: "s", name: "web_search", input: {} }] })).toBe(true);
    expect(isPausedTurn({ role: "assistant", content: [{ type: "text", text: "done" }] })).toBe(false);
    expect(isWebToolError("tools.12: web_search is not enabled for this organization")).toBe(true);
    expect(isWebToolError("messages: text is required")).toBe(false);
  });

  it("echoes only what the API accepts after a mid-answer fallback", () => {
    const content = [
      { type: "thinking", thinking: "t", signature: "s" },
      { type: "text", text: "partial" },
      { type: "server_tool_use", id: "a", name: "web_search", input: {} },
      { type: "web_search_tool_result", tool_use_id: "a", content: [] },
      { type: "server_tool_use", id: "b", name: "web_search", input: {} },
      { type: "tool_use", id: "c", name: "get_design", input: {} },
      { type: "fallback", from: { model: "x" }, to: { model: "y" } },
      { type: "thinking", thinking: "t2", signature: "s2" },
      { type: "tool_use", id: "d", name: "get_design", input: {} },
    ];
    expect(echoContent(content).map((b) => b.type + ((b as { id?: string }).id ?? ""))).toEqual(["text", "server_tool_usea", "web_search_tool_result", "fallback", "thinking", "tool_used"]);
    expect(echoContent(content.slice(0, 6))).toHaveLength(6);
  });

  it("keeps earlier web results readable when web search is switched off", () => {
    const { history, changed } = flattenServerTools([
      { role: "user", content: "find a driver" },
      {
        role: "assistant",
        content: [
          { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "motor driver" } },
          { type: "web_search_tool_result", tool_use_id: "s1", content: [SEARCH_RESULT] },
          { type: "text", text: "The G2 fits.", citations: [CITE] },
        ],
      } as never,
    ]);
    expect(changed).toBe(3);
    const blocks = history[1].content as { type: string; text?: string; citations?: unknown }[];
    expect(blocks.map((b) => b.type)).toEqual(["text", "text"]);
    expect(blocks[0].text).toContain("Searched the web: motor driver");
    expect(blocks[0].text).toContain("https://www.pololu.com/product/3754");
    expect(blocks[1].citations).toBeUndefined();
  });
});

// ---------- the chat loop against a fake client ----------

type Block = Record<string, unknown> & { type: string };
type Reply = { content: Block[]; stop_reason: string } | { error: Error };

/** A stand-in for the SDK client: records each request and replays scripted responses as stream events. */
function fakeClient(replies: Reply[]) {
  const requests: { tools: { name: string; type?: string; max_uses?: number; max_content_tokens?: number }[]; messages: { role: string; content: Block[] | string }[]; model: string }[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: Record<string, unknown>) {
          requests.push(JSON.parse(JSON.stringify(params)));
          const r = replies.shift();
          if (!r) throw new Error("No more scripted replies");
          let listener: ((ev: unknown, snap: unknown) => void) | null = null;
          return {
            on(ev: string, cb: (ev: unknown, snap: unknown) => void) {
              if (ev === "streamEvent") listener = cb;
              return this;
            },
            async finalMessage() {
              if ("error" in r) throw r.error;
              const msg = { id: "msg", type: "message", role: "assistant", model: params.model, content: r.content, stop_reason: r.stop_reason, usage: {} };
              r.content.forEach((b, index) => {
                listener?.({ type: "content_block_start", index, content_block: b.type === "text" ? { ...b, text: "" } : b }, msg);
                if (b.type === "text") listener?.({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } }, msg);
                listener?.({ type: "content_block_stop", index }, msg);
              });
              return msg;
            },
          };
        },
      },
    },
  };
  setClientFactory(() => client as unknown as Anthropic);
  return requests;
}

const badRequest = (message: string) => new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message } }, undefined, new Headers());
const items = () => useChat.getState().items;
const of = <K extends ChatItem["kind"]>(k: K) => items().filter((i): i is Extract<ChatItem, { kind: K }> => i.kind === k);

describe("chat loop", () => {
  beforeEach(async () => {
    await clearChat();
    // effort marks between steps have their own tests (stepEffort.test.ts)
    useSettings.setState({ model: "claude-opus-5-5", webSearch: true, maxSteps: 30, showThinking: true, fasterFollowUps: false });
  });
  afterEach(() => setClientFactory(null));

  it("sends Kerf's tools plus web search and resumes a paused turn without an extra message", async () => {
    const requests = fakeClient([
      {
        stop_reason: "pause_turn",
        content: [
          { type: "text", text: "Looking for a motor driver." },
          { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "18 V 17 A motor driver" } },
          { type: "web_search_tool_result", tool_use_id: "srv_1", content: [SEARCH_RESULT] },
          { type: "server_tool_use", id: "srv_2", name: "web_fetch", input: { url: "https://www.pololu.com/product/3754" } },
        ],
      },
      {
        stop_reason: "end_turn",
        content: [
          { type: "web_fetch_tool_result", tool_use_id: "srv_2", content: PAGE },
          { type: "text", text: "The Pololu G2 18v17 costs $39.95.", citations: [CITE] },
        ],
      },
    ]);
    await sendMessage("Find me a motor driver");

    expect(requests).toHaveLength(2);
    const tools = requests[0].tools;
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["get_design", "catalog_lookup", "engineering_calc", "run_checks", "web_search", "web_fetch"]));
    expect(tools.find((t) => t.name === "web_search")).toEqual({ type: "web_search_20250305", name: "web_search", max_uses: 8 });
    expect(tools.find((t) => t.name === "web_fetch")).toMatchObject({ type: "web_fetch_20250910", name: "web_fetch", max_uses: 8, max_content_tokens: 20000 });

    // the resume sends the paused assistant turn back unchanged, with no new user message
    expect(requests[0].messages.map((m) => m.role)).toEqual(["user"]);
    expect(requests[1].messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(requests[1].messages[0]).toEqual(requests[0].messages[0]);
    const paused = requests[1].messages[1].content as Block[];
    expect(paused.map((b) => b.type)).toEqual(["text", "server_tool_use", "web_search_tool_result", "server_tool_use"]);
    expect(paused[3]).toEqual({ type: "server_tool_use", id: "srv_2", name: "web_fetch", input: { url: "https://www.pololu.com/product/3754" } });
    expect(chatHistory().map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);

    // the chat shows each search and page read, then the answer with its sources below them
    const web = of("tool").filter((t) => t.web);
    expect(web.map((t) => [t.status, t.title])).toEqual([
      ["done", "Searched the web: 18 V 17 A motor driver"],
      ["done", "Read: pololu.com"],
    ]);
    expect(web[1].link).toEqual({ url: "https://www.pololu.com/product/3754", label: "Pololu G2 18v17" });
    const said = of("assistant");
    expect(said.map((a) => a.text)).toEqual(["Looking for a motor driver.", "The Pololu G2 18v17 costs $39.95."]);
    expect(said[1].sources).toEqual([{ url: "https://www.pololu.com/product/3754", title: "Pololu G2 High-Power Motor Driver 18v17" }]);
    expect(items().map((i) => i.kind)).toEqual(["user", "assistant", "tool", "tool", "assistant"]);
    expect(useChat.getState().busy).toBe(false);
  });

  it("declares the same web tools on Haiku and none when web search is off", async () => {
    useSettings.setState({ model: "claude-haiku-5-5" });
    let requests = fakeClient([{ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }]);
    await sendMessage("hi");
    expect(requests[0].tools.filter((t) => t.type?.startsWith("web_")).map((t) => t.type)).toEqual(["web_search_20250305", "web_fetch_20250910"]);

    await clearChat();
    useSettings.setState({ webSearch: false });
    requests = fakeClient([{ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }]);
    await sendMessage("hi");
    expect(requests[0].tools.some((t) => t.name === "web_search" || t.name === "web_fetch")).toBe(false);
    expect(requests[0].tools).toHaveLength(TOOL_DEFS.length);
    expect(requestTools({ webSearch: false })).toHaveLength(TOOL_DEFS.length);
  });

  it("leaves web tools off on a Kerf server's shared key, which refuses server-side tools", () => {
    expect(requestTools({ webSearch: true })).toHaveLength(TOOL_DEFS.length + 2);
    const before = useAccount.getState();
    useAccount.setState({ status: "signed-in", info: { claude: { source: "shared" } } } as never);
    try {
      expect(requestTools({ webSearch: true })).toHaveLength(TOOL_DEFS.length);
    } finally {
      useAccount.setState(before, true);
    }
  });

  it("sends earlier web results as notes when web search is off, without rewriting the history", async () => {
    let requests = fakeClient([
      {
        stop_reason: "end_turn",
        content: [
          { type: "server_tool_use", id: "srv_7", name: "web_search", input: { query: "motor driver" } },
          { type: "web_search_tool_result", tool_use_id: "srv_7", content: [SEARCH_RESULT] },
          { type: "text", text: "The G2 fits.", citations: [CITE] },
        ],
      },
    ]);
    await sendMessage("Find a driver");
    useSettings.setState({ webSearch: false });
    requests = fakeClient([
      { error: badRequest("messages.1.content.0: server_tool_use blocks need the matching server tool in tools") },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Still the G2." }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Yes." }] },
    ]);
    await sendMessage("Which one again?");
    expect(requests).toHaveLength(2);
    const types = (r: (typeof requests)[number]) => (r.messages[1].content as Block[]).map((b) => b.type);
    expect(types(requests[0])).toContain("server_tool_use");
    expect(types(requests[1])).toEqual(["text", "text"]);
    // the stored history still holds the search, so turning web search back on sends it as it was
    expect((chatHistory()[1].content as Block[]).map((b) => b.type)).toEqual(["server_tool_use", "web_search_tool_result", "text"]);
    // later requests keep sending notes without another failed request
    await sendMessage("Thanks");
    expect(requests).toHaveLength(3);
    expect(types(requests[2])).toEqual(["text", "text"]);
    useSettings.setState({ webSearch: true });
  });

  it("runs Kerf tools and sends their results back", async () => {
    const requests = fakeClient([
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_1", name: "catalog_lookup", input: { id: "arduino_nano" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "The Nano has 14 digital pins." }] },
    ]);
    await sendMessage("What pins does the Nano have?");
    expect(requests).toHaveLength(2);
    const back = requests[1].messages[2];
    expect(back.role).toBe("user");
    const result = (back.content as Block[])[0] as { type: string; tool_use_id: string; content: string };
    expect(result).toMatchObject({ type: "tool_result", tool_use_id: "tu_1" });
    expect(result.content).toContain('lib.controller("arduino_nano")');
    const row = of("tool").find((t) => t.toolUseId === "tu_1");
    expect(row).toMatchObject({ status: "done", title: "Looked up Arduino Nano" });
  });

  it("shows a failed web search as a quiet note and carries on", async () => {
    fakeClient([
      {
        stop_reason: "end_turn",
        content: [
          { type: "server_tool_use", id: "srv_9", name: "web_search", input: { query: "lead screw T8" } },
          { type: "web_search_tool_result", tool_use_id: "srv_9", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
          { type: "text", text: "I will use the catalog lead screw." },
        ],
      },
    ]);
    await sendMessage("Find a lead screw");
    const note = of("notice");
    expect(note).toHaveLength(1);
    expect(note[0]).toMatchObject({ level: "info", title: "Web search limit reached for this step" });
    expect(of("tool")[0]).toMatchObject({ web: true, status: "error", title: "Web search did not work: lead screw T8" });
    // the empty bubble before the search row is dropped; the answer follows the row
    expect(items().map((i) => i.kind)).toEqual(["user", "tool", "notice", "assistant"]);
    expect(of("assistant")[0].text).toBe("I will use the catalog lead screw.");
  });

  it("stops resuming after five pauses, then a new message drops the unanswered search", async () => {
    const pause = (k: number): Reply => ({
      stop_reason: "pause_turn",
      content: [...(k > 1 ? [{ type: "web_search_tool_result", tool_use_id: `p${k - 1}`, content: [SEARCH_RESULT] }] : []), { type: "server_tool_use", id: `p${k}`, name: "web_search", input: { query: `query ${k}` } }],
    });
    const requests = fakeClient([1, 2, 3, 4, 5, 6].map(pause));
    await sendMessage("Search a lot");
    expect(requests).toHaveLength(6);
    expect(of("notice").at(-1)).toMatchObject({ title: "Claude paused during a long web search", action: "retry" });
    expect(isPausedTurn(chatHistory().at(-1))).toBe(true);

    // Try again resumes the paused turn as it is
    const more = fakeClient([{ stop_reason: "end_turn", content: [{ type: "web_search_tool_result", tool_use_id: "p6", content: [SEARCH_RESULT] }, { type: "text", text: "Done searching." }] }]);
    await retryLast();
    expect(more[0].messages.at(-1)?.role).toBe("assistant");
    expect(of("tool").filter((t) => t.web).every((t) => t.status === "done")).toBe(true);

    // pause again, then write: the trailing unanswered call is dropped and the found results stay
    await clearChat();
    fakeClient([pause(1), pause(2), pause(3), pause(4), pause(5), pause(6)]);
    await sendMessage("Search a lot");
    const next = fakeClient([{ stop_reason: "end_turn", content: [{ type: "text", text: "Using what I found." }] }]);
    await sendMessage("Use what you found");
    const sent = next[0].messages;
    expect(sent.at(-1)?.role).toBe("user");
    const lastAssistant = sent.at(-2)!;
    expect((lastAssistant.content as Block[]).map((b) => b.type)).toEqual(["web_search_tool_result"]);
  });

  it("drops thinking and resends once when the API says it belongs to another conversation", async () => {
    fakeClient([{ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "plan", signature: "sig" }, { type: "text", text: "First answer." }] }]);
    await sendMessage("one");
    const requests = fakeClient([{ error: badRequest("messages.1.content.0: Invalid `signature` in `thinking` block") }, { stop_reason: "end_turn", content: [{ type: "text", text: "Second answer." }] }]);
    await sendMessage("two");
    expect(requests).toHaveLength(2);
    const blocks = (r: (typeof requests)[number]) => r.messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content.map((b) => b.type)));
    expect(blocks(requests[0])).toContain("thinking");
    expect(blocks(requests[1])).not.toContain("thinking");
    expect(requests[1].messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(of("notice")).toHaveLength(0);
    expect(of("assistant").map((a) => a.text)).toEqual(["First answer.", "Second answer."]);
  });

  it("saves and reloads conversations with web rows and sources", async () => {
    await loadChat("ai-test-project");
    fakeClient([
      {
        stop_reason: "end_turn",
        content: [
          { type: "server_tool_use", id: "srv_1", name: "web_fetch", input: { url: "https://www.pololu.com/product/3754" } },
          { type: "web_fetch_tool_result", tool_use_id: "srv_1", content: PAGE },
          { type: "text", text: "It costs $39.95.", citations: [CITE] },
        ],
      },
    ]);
    await sendMessage("Price?");
    await new Promise((r) => setTimeout(r, 500)); // the save is debounced
    const before = items();
    useChat.setState({ items: [] });
    await loadChat("ai-test-project");
    expect(items()).toEqual(before);
    expect(of("tool")[0].link?.url).toBe("https://www.pololu.com/product/3754");
    expect(of("assistant")[0].sources).toHaveLength(1);
    expect(chatHistory().map((m) => m.role)).toEqual(["user", "assistant"]);
    await clearChat();
  });

  it("shows the web search cost notice once, before the first reply (integration review)", async () => {
    useSettings.setState({ webNotice: true });
    fakeClient([{ stop_reason: "end_turn", content: [{ type: "text", text: "Hello." }] }]);
    await sendMessage("hi");
    expect(of("notice")).toHaveLength(1);
    expect(of("notice")[0]).toMatchObject({ level: "info", title: "Claude can now search the web for parts", action: "settings" });
    expect(of("notice")[0].detail).toMatch(/\$0\.01 on your API key.*Settings → AI/);
    expect(useSettings.getState().webNotice).toBe(false);
    fakeClient([{ stop_reason: "end_turn", content: [{ type: "text", text: "Again." }] }]);
    await sendMessage("again");
    expect(of("notice")).toHaveLength(1);
  });

  // last: it switches web search off for the rest of this module's session
  it("carries on without web search when the key cannot use it", async () => {
    const requests = fakeClient([{ error: badRequest("tools.13: web_search is not enabled for this organization") }, { stop_reason: "end_turn", content: [{ type: "text", text: "Using the catalog." }] }]);
    await sendMessage("Find a part");
    expect(requests).toHaveLength(2);
    expect(requests[0].tools.some((t) => t.name === "web_search")).toBe(true);
    expect(requests[1].tools.some((t) => t.name === "web_search")).toBe(false);
    expect(of("notice")[0]).toMatchObject({ level: "info", title: "Web search is not available with this key or model" });
    expect(of("assistant").map((a) => a.text)).toEqual(["Using the catalog."]);
  });
});

// ---------- settings ----------

describe("settings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const withStored = async (stored: unknown) => {
    const store = new Map<string, string>([["kerf.settings.v1", JSON.stringify(stored)]]);
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    vi.resetModules();
    return (await import("../src/app/settings")).useSettings.getState();
  };

  it("moves the old 16-step default to the new one and turns web search on", async () => {
    const s = await withStored({ maxSteps: 16, model: "claude-haiku-5-5" });
    expect(s.maxSteps).toBe(50);
    expect(s.webSearch).toBe(true);
    expect(s.model).toBe("claude-haiku-5-5");
  });

  it("keeps a step limit the user chose, within bounds", async () => {
    expect((await withStored({ maxSteps: 24 })).maxSteps).toBe(24);
    expect((await withStored({ maxSteps: 16, rev: 2 })).maxSteps).toBe(16);
    expect((await withStored({ maxSteps: 500, rev: 2 })).maxSteps).toBe(80);
    expect((await withStored({ maxSteps: 30, webSearch: false, rev: 2 })).webSearch).toBe(false);
  });

  it("moves the 30-step default to 50 once, and keeps 30 when it was chosen after that", async () => {
    expect((await withStored({ maxSteps: 30, rev: 2 })).maxSteps).toBe(50);
    expect((await withStored({ maxSteps: 30, rev: 3 })).maxSteps).toBe(30);
    expect((await withStored({ maxSteps: 40, rev: 2 })).maxSteps).toBe(40);
  });

  it("starts at normal speed and drops a speed it does not know", async () => {
    expect((await withStored({ rev: 3 })).speed).toBe("normal");
    expect((await withStored({ rev: 3, speed: "thorough" })).speed).toBe("thorough");
    expect((await withStored({ rev: 3, speed: "warp" })).speed).toBe("normal");
  });

  it("tells someone who used Kerf before web search, once, what it costs (integration review)", async () => {
    expect((await withStored({ maxSteps: 16 })).webNotice).toBe(true);
    expect((await withStored({ maxSteps: 30, webSearch: true, rev: 2 })).webNotice).toBe(false);
    expect((await withStored({ maxSteps: 30, webSearch: true, webNotice: false, rev: 2 })).webNotice).toBe(false);
  });
});
