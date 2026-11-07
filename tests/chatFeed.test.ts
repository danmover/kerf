// The chat feed's layout: which items are a turn's working steps (the work
// log), which are the reply, what the log's header sums up, and how thinking
// splits into titled sections.

import { describe, expect, it } from "vitest";
import type { ChatItem } from "../src/ai/chat";
import { feedRows, fmtDur, thoughtSections } from "../src/ui/chatFeed";

const user = (id: string, ts = 1000, extra: Partial<Extract<ChatItem, { kind: "user" }>> = {}): ChatItem => ({ kind: "user", id, text: "make it stronger", ts, ...extra });
const said = (id: string, text: string, extra: Partial<Extract<ChatItem, { kind: "assistant" }>> = {}): ChatItem => ({ kind: "assistant", id, text, thinking: "", streaming: false, ...extra });
const tool = (id: string, name: string, extra: Partial<Extract<ChatItem, { kind: "tool" }>> = {}): ChatItem => ({ kind: "tool", id, toolUseId: `tu-${id}`, name, status: "done", title: name, ...extra });

const kinds = (items: ChatItem[], busy = false) => feedRows(items, busy).map((r) => (r.kind === "log" ? "log" : `${r.it.id}${r.step ? ":step" : ""}${r.kind === "item" && r.lastStep ? ":last" : ""}`));

describe("chat feed", () => {
  it("puts a turn's tool calls and the notes between them in a log, and keeps the reply after the last call", () => {
    const items = [user("u1"), said("a1", "I'll check the screws first.", { thinking: "**Reading**\n\nok" }), tool("t1", "catalog_lookup"), tool("t2", "edit_design"), said("a2", "Done: the walls are 2.4 mm.")];
    expect(kinds(items)).toEqual(["u1", "log", "a1:step", "t1:step", "t2:step:last", "a2"]);
  });

  it("gives a plain question and answer no log", () => {
    expect(kinds([user("u1"), said("a1", "It weighs 89 g.")])).toEqual(["u1", "a1"]);
  });

  it("keeps the parallel build, plan updates and next-step chips out of the log", () => {
    const items = [user("u1"), tool("p", "update_plan"), tool("b", "build_subassemblies"), tool("t1", "run_checks"), { kind: "suggest", id: "s", options: [] } as ChatItem, said("a1", "Built.")];
    expect(kinds(items)).toEqual(["u1", "b", "log", "t1:step:last", "a1"]);
  });

  it("starts a new log for each turn, but not for a message sent while Claude worked", () => {
    const items = [user("u1"), tool("t1", "run_checks"), said("a1", "ok"), user("u2", 5000), tool("t2", "edit_design"), user("m", 6000, { midRun: true }), tool("t3", "run_checks"), said("a2", "done")];
    const rows = feedRows(items, true);
    expect(rows.filter((r) => r.kind === "log").map((r) => r.turn)).toEqual(["u1", "u2"]);
    expect(kinds(items, true)).toEqual(["u1", "log", "t1:step:last", "a1", "u2", "log", "t2:step", "m", "t3:step:last", "a2"]);
  });

  it("treats thinking with nothing written yet after the work began as a step, and a reply's first words move it out", () => {
    const thinking = [user("u1"), tool("t1", "run_checks"), said("a1", "", { thinking: "hmm", streaming: true })];
    expect(kinds(thinking, true)).toEqual(["u1", "log", "t1:step", "a1:step:last"]);
    const writing = [user("u1"), tool("t1", "run_checks"), said("a1", "The checks pass.", { thinking: "hmm", streaming: true })];
    expect(kinds(writing, true)).toEqual(["u1", "log", "t1:step:last", "a1"]);
  });

  it("sums up a log: steps, edits, failures, marks and how long it took", () => {
    const items = [user("u1", 1000), said("a1", "", { thinking: "x", started: 1100, thoughtMs: 900 }), tool("t1", "edit_design", { ran: 2000, ms: 500 }), tool("t2", "catalog_lookup", { status: "error", ran: 2600, ms: 100 }), tool("t3", "run_checks", { status: "running", ran: 2800, title: "Building and checking" }), said("a2", "ok")];
    const log = feedRows(items, true).find((r) => r.kind === "log");
    expect(log?.kind).toBe("log");
    if (log?.kind !== "log") return;
    const s = log.summary;
    expect([s.steps, s.thoughts, s.edits, s.errors, s.running]).toEqual([3, 1, 1, 1, true]);
    expect(s.marks).toEqual(["thought", "done", "error", "running"]);
    expect(s.from).toBe(1000);
    expect(s.to).toBe(2800);
    expect(s.now).toBe("Building and checking");
  });

  it("does not count a web search that found nothing as a failed step mark", () => {
    const items = [user("u1"), tool("w", "web_search", { web: true, status: "error" }), said("a", "ok")];
    const log = feedRows(items, false).find((r) => r.kind === "log");
    expect(log?.kind === "log" && log.summary.marks).toEqual(["done"]);
  });
});

describe("thought sections", () => {
  it("splits summarised thinking at its bold headings", () => {
    expect(thoughtSections("**Reading the request**\n\nThe user wants a drop test.\n\n**Planning**\n\nThicken the walls.")).toEqual([
      { title: "Reading the request", body: "The user wants a drop test." },
      { title: "Planning", body: "Thicken the walls." },
    ]);
  });

  it("keeps thinking with no headings as one untitled section, and text before the first heading", () => {
    expect(thoughtSections("Just thinking aloud.")).toEqual([{ title: "", body: "Just thinking aloud." }]);
    expect(thoughtSections("Intro.\n**Next**\nMore.")).toEqual([
      { title: "", body: "Intro." },
      { title: "Next", body: "More." },
    ]);
    expect(thoughtSections("")).toEqual([]);
  });

  it("does not take bold words inside a sentence for a heading", () => {
    expect(thoughtSections("The **wall** is thin.")).toEqual([{ title: "", body: "The **wall** is thin." }]);
  });
});

describe("durations", () => {
  it("reads the way people say them", () => {
    expect(fmtDur(20)).toBe("");
    expect(fmtDur(400)).toBe("0.4 s");
    expect(fmtDur(12_300)).toBe("12 s");
    expect(fmtDur(72_000)).toBe("1 m 12 s");
    expect(fmtDur(120_000)).toBe("2 m");
  });
});
