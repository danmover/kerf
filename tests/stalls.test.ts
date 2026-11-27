import { beforeEach, describe, expect, it } from "vitest";
import { BROWSER_WORK, clearStalls, during, noteWork, onStall, recordStallForTest, STALL_MS, stallReport, stallSummary, watchStalls } from "../src/app/stalls";

// The freeze record: every stretch where the page stopped answering, and what Kerf was doing in it.

/** keep the thread busy for a while, as real work would */
function spin(ms: number) {
  const until = performance.now() + ms;
  while (performance.now() < until);
}

describe("the freeze record", () => {
  beforeEach(() => clearStalls());

  it("names the work that ran inside a freeze, longest first", () => {
    const start = performance.now();
    during("checks: fits", () => spin(30));
    during("3D view: drawing a frame", () => spin(8));
    const end = performance.now();
    recordStallForTest(start, end - start + 20);
    const s = stallSummary();
    expect(s.count).toBe(1);
    expect(s.recent[0].work.map((w) => w.name)).toEqual(["checks: fits", "3D view: drawing a frame"]);
    expect(s.recent[0].work[0].ms).toBeGreaterThanOrEqual(29);
    expect(s.causes[0]).toMatchObject({ name: "checks: fits", count: 1 });
  });

  it("gives back what the work returns, and records it even when it throws", () => {
    expect(during("a sum", () => 2 + 2)).toBe(4);
    const start = performance.now();
    expect(() =>
      during("a failing step", () => {
        spin(12);
        throw new Error("no");
      }),
    ).toThrow("no");
    recordStallForTest(start, 150);
    expect(stallSummary().recent[0].work[0].name).toBe("a failing step");
  });

  it("leaves out work that ran outside the freeze, and work too short to matter", () => {
    during("before", () => spin(10));
    const start = performance.now();
    during("a blink", () => spin(1));
    during("inside", () => spin(10));
    recordStallForTest(start, 120);
    expect(stallSummary().recent[0].work.map((w) => w.name)).toEqual(["inside"]);
  });

  it("adds up work that ran more than once under one name", () => {
    const start = performance.now();
    for (let i = 0; i < 3; i++) during("checks: sweeps", () => spin(6));
    recordStallForTest(start, 200);
    const work = stallSummary().recent[0].work;
    expect(work).toHaveLength(1);
    expect(work[0].ms).toBeGreaterThanOrEqual(17);
  });

  it("takes work that was timed elsewhere", () => {
    const start = performance.now();
    spin(9);
    noteWork("kernel: reading the answer", start);
    recordStallForTest(start, 110);
    expect(stallSummary().recent[0].work[0].name).toBe("kernel: reading the answer");
  });

  it("counts two reports of one stretch as one freeze, and separate stretches apart", () => {
    recordStallForTest(1000, 300);
    recordStallForTest(1050, 400);
    expect(stallSummary().count).toBe(1);
    expect(stallSummary().recent[0].ms).toBe(400);
    recordStallForTest(5000, 150);
    const s = stallSummary();
    expect(s.count).toBe(2);
    expect(s.longestMs).toBe(400);
  });

  it("knows a stretch again when its longer account comes after others", () => {
    // two long tasks, then the long frame the first was part of
    recordStallForTest(1000, 300);
    recordStallForTest(1600, 200);
    recordStallForTest(990, 330);
    const s = stallSummary();
    expect(s.count).toBe(2);
    expect(s.recent.map((x) => [x.at, x.ms])).toEqual([
      [990, 330],
      [1600, 200],
    ]);
    // one that only brushes another is its own freeze
    recordStallForTest(1790, 400);
    expect(stallSummary().count).toBe(3);
  });

  it("does not blame a freeze on work that was a sliver of it", () => {
    const start = performance.now();
    during("3D view: drawing a frame", () => spin(6));
    recordStallForTest(start, 600);
    const s = stallSummary();
    expect(s.causes[0].name).toBe(BROWSER_WORK);
    // the sliver is still in the record, for whoever reads it
    expect(s.recent[0].work[0].name).toBe("3D view: drawing a frame");
  });

  it("keeps counting past what it keeps", () => {
    for (let i = 0; i < 260; i++) recordStallForTest(i * 1000, 120);
    const s = stallSummary();
    expect(s.count).toBe(260);
    expect(s.recent).toHaveLength(200);
    expect(s.recent[0].at).toBe(60_000);
  });

  it("tells whoever is listening, until they stop", () => {
    let told = 0;
    const stop = onStall(() => told++);
    recordStallForTest(0, 200);
    stop();
    recordStallForTest(9000, 200);
    expect(told).toBe(1);
  });

  it("writes a record that can be pasted into a message", () => {
    const start = performance.now();
    during("checks: fits", () => spin(170));
    recordStallForTest(start, 640);
    recordStallForTest(start + 20_000, 130);
    const text = stallReport(["Graphics: test card"]);
    const lines = text.split("\n");
    expect(lines[0]).toMatch(new RegExp(`^Kerf freeze record: 2 freezes of ${STALL_MS} ms or more, the longest 640 ms, in \\d+ s\\.$`));
    expect(lines[1]).toBe("Graphics: test card");
    expect(text).toContain("By cause:");
    expect(text).toMatch(/checks: fits: 1 time, 640 ms in all/);
    // nothing of Kerf's ran in the second one: the browser's own work
    expect(text).toContain(`${BROWSER_WORK}: 1 time, 130 ms in all`);
    expect(text).toMatch(/640 ms {2}checks: fits \d+ ms/);
  });

  it("says so plainly when nothing froze", () => {
    expect(stallReport()).toMatch(/^Kerf freeze record: 0 freezes of 100 ms or more, the longest 0 ms, in \d+ s\.$/);
  });

  it("starts quietly where the browser cannot tell", () => {
    expect(() => watchStalls()).not.toThrow();
    expect(() => watchStalls()).not.toThrow();
  });
});
