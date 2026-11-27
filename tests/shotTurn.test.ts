import { describe, expect, it } from "vitest";
import { SHOT_STARVED_MS, shotTurn, type ShotWaiting } from "../src/ui/viewport/shotTurn";

// Pictures drawn a sample at a time between the 3D view's frames: which of those waiting gets the next sample.

const CAM = {};
/** a picture asked for at `asked`: a change card's (waits half a second for the view) unless told otherwise */
function shot(name: string, asked: number, more: Partial<ShotWaiting> = {}): ShotWaiting & { name: string } {
  return { name, asked, patience: 500, begun: 0, cam: null, stamp: -1, ...more };
}
const turn = (shots: (ShotWaiting & { name: string })[], busy: boolean, now: number, stamp = 7) => {
  const t = shotTurn(shots, busy, now, stamp);
  return t && (t.atOnce ? `${t.shot.name}, at once` : t.shot.name);
};

describe("whose turn it is among pictures drawn between frames", () => {
  it("goes in the order asked for once the view is at rest", () => {
    expect(turn([shot("list", 0, { patience: Infinity }), shot("card", 10)], false, 20)).toBe("list");
    expect(turn([shot("card", 0), shot("list", 10, { patience: Infinity })], false, 20)).toBe("card");
    expect(turn([], false, 20)).toBeNull();
  });

  it("gives a busy view as long as each picture allows, and no longer", () => {
    const waiting = [shot("list", 0, { patience: Infinity }), shot("card", 100)];
    // the view is still drawing its own picture: nobody yet
    expect(turn(waiting, true, 400)).toBeNull();
    // the card has waited its half second; the projects-list picture ahead of it does not hold it back
    expect(turn(waiting, true, 600)).toBe("card");
    // and the projects-list picture never takes a turn from a busy view
    expect(turn([waiting[0]], true, 1e9)).toBeNull();
    expect(turn([shot("now", 100, { patience: 0 })], true, 100)).toBe("now");
  });

  it("finishes one that has begun before another begins", () => {
    // the card began while the view was busy; the view comes to rest, and the projects-list picture, asked for
    // first, may now go: the card is finished first, or its samples so far would be thrown away
    const list = shot("list", 0, { patience: Infinity });
    const card = shot("card", 100, { begun: 650, cam: CAM, stamp: 7 });
    expect(turn([list, card], false, 900)).toBe("card");
    expect(turn([list], false, 1500)).toBe("list");
  });

  it("does not hold on to one whose samples are of a scene that has changed", () => {
    const list = shot("list", 0, { patience: Infinity });
    const card = shot("card", 100, { begun: 650, cam: CAM, stamp: 6 });
    expect(turn([list, card], false, 900)).toBe("list");
    // nor to one another picture took the buffers from
    expect(turn([list, shot("card", 100, { begun: 650, cam: null, stamp: 7 })], false, 900)).toBe("list");
    // nor to one that may not go: the view is busy again and it gives the view as long as it takes
    const begun = shot("list", 0, { patience: Infinity, begun: 300, cam: CAM, stamp: 7 });
    expect(turn([begun, shot("card", 100)], true, 700)).toBe("card");
  });

  it("draws one in one go when the scene has changed under it for two seconds", () => {
    // a mechanism is playing: the scene is another at every frame
    const card = shot("card", 0, { begun: 500, cam: CAM, stamp: 6 });
    expect(turn([card], true, 500 + SHOT_STARVED_MS)).toBe("card");
    expect(turn([card], true, 501 + SHOT_STARVED_MS)).toBe("card, at once");
    // not while the scene is as it was at its last sample: it is getting there
    expect(turn([{ ...card, stamp: 7 }], true, 60_000)).toBe("card");
    // not before its first sample
    expect(turn([shot("card", 0)], true, 60_000)).toBe("card");
    // and never the one that waits for the view however long it takes
    expect(turn([shot("list", 0, { patience: Infinity, begun: 500, cam: CAM, stamp: 6 })], false, 60_000)).toBe("list");
  });
});
