import { describe, expect, it } from "vitest";
import { inSlices, pacer, sliceAfter } from "../src/core/slices";

// Work done a few milliseconds at a time, so the page can draw and answer in between.

/** keep the thread busy for a while, as real work would */
function spin(ms: number) {
  const until = performance.now() + ms;
  while (performance.now() < until);
}

function* count(to: number, each = 0): Generator<void, number> {
  let n = 0;
  for (let i = 0; i < to; i++) {
    if (each) spin(each);
    n++;
    yield;
  }
  return n;
}

describe("work in slices", () => {
  it("runs the work to its end and gives its answer", async () => {
    expect(await inSlices(count(2000))).toBe(2000);
    expect(await inSlices(count(40, 1), () => true, 3)).toBe(40);
  });

  it("stops with nothing once the answer is no longer wanted", async () => {
    let wanted = true;
    const work = count(400, 1);
    const job = inSlices(work, () => wanted, 2);
    wanted = false;
    expect(await job).toBeNull();
    // and leaves the rest undone
    expect(work.next().done).toBe(false);
  });

  it("does work that fits in one stretch at once, with no pause", () => {
    const work = count(10);
    void inSlices(work);
    expect(work.next()).toEqual({ done: true, value: undefined });
  });

  it("takes a few milliseconds at a time on a page that answers at once", () => {
    expect(sliceAfter(0)).toBe(6);
    expect(sliceAfter(8)).toBe(6);
    expect(sliceAfter(0.2, 3)).toBe(3);
  });

  it("takes half as long as a slow page takes over its own turn, up to a tenth of a second", () => {
    expect(sliceAfter(40)).toBe(20);
    expect(sliceAfter(120)).toBe(60);
    expect(sliceAfter(2500)).toBe(100);
  });
});

describe("a few larger steps, paced", () => {
  it("gives back what each step returns, and what it throws", () => {
    const pace = pacer();
    expect(pace.step(() => 7)).toBe(7);
    expect(() =>
      pace.step(() => {
        throw new Error("no");
      }),
    ).toThrow("no");
  });

  it("does not pause between steps that take no time", async () => {
    const pace = pacer(10);
    pace.step(() => 1);
    let turned = false;
    setTimeout(() => (turned = true), 0);
    await pace.pause();
    // nothing else got a turn: the next step follows straight on
    expect(turned).toBe(false);
  });

  it("lets the page have a turn once the steps have added up to a stretch it would feel", async () => {
    const pace = pacer(10);
    pace.step(() => spin(6));
    pace.step(() => spin(6));
    let turned = false;
    setTimeout(() => (turned = true), 0);
    await pace.pause();
    expect(turned).toBe(true);
    // and starts counting again
    pace.step(() => spin(2));
    turned = false;
    setTimeout(() => (turned = true), 0);
    await pace.pause();
    expect(turned).toBe(false);
  });
});
