// Runs a simulated twin in real time inside a worker: steps it a slice at a
// time to keep pace with the wall clock (or faster, or slower), and sends the
// app what it printed and every number it records, about 30 times a second.
// Kerf's worker and a saved app's worker both use this.

import { LiveTwin, type TwinInfo, type TwinOptions } from "./twin";
import type { WorldEvent } from "../sim/worlds/types";

export type TwinIn =
  | { type: "start"; opts: TwinOptions; speed: number }
  | { type: "type"; text: string }
  | { type: "speed"; speed: number }
  | { type: "pause"; paused: boolean }
  | { type: "stop" };

export type TwinOut =
  | { type: "ready"; info: TwinInfo }
  | { type: "tick"; t: number; ch: Record<string, number>; lines: { t: number; text: string }[]; events: WorldEvent[]; /** simulated seconds a wall-clock second, lately */ rate: number; behind: boolean }
  | { type: "stopped"; t: number; reason: string; error?: string; lines: { t: number; text: string }[] }
  | { type: "error"; message: string };

/** Serve one twin over a message port: `post` sends, the returned function takes what arrives. */
export function serveTwin(post: (m: TwinOut) => void): (m: TwinIn) => void {
  let twin: LiveTwin | null = null;
  let speed = 1;
  let paused = false;
  let wall0 = 0;
  let sim0 = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastPost = 0;
  const rateMark = { wall: 0, sim: 0, rate: 1 };
  let reported = false;

  const rebase = () => {
    wall0 = performance.now();
    sim0 = twin?.time ?? 0;
  };

  const tick = () => {
    timer = null;
    if (!twin) return;
    const now = performance.now();
    if (!paused && !twin.stopped) {
      const target = sim0 + ((now - wall0) / 1000) * speed;
      twin.runTo(target, 22);
      // more than half a second behind: it cannot keep up, so carry on from here rather than race to catch up
      if (target - twin.time > 0.5) rebase();
    }
    const t = performance.now();
    if (t - rateMark.wall > 1000) {
      rateMark.rate = paused ? 0 : (twin.time - rateMark.sim) / ((t - rateMark.wall) / 1000);
      rateMark.wall = t;
      rateMark.sim = twin.time;
    }
    if (twin.stopped && !reported) {
      reported = true;
      post({ type: "stopped", t: twin.time, reason: twin.stopped, error: twin.error, lines: twin.takeLines() });
      return;
    }
    if (t - lastPost >= 30 || paused) {
      lastPost = t;
      post({ type: "tick", t: twin.time, ch: twin.channels(), lines: twin.takeLines(), events: twin.takeEvents(), rate: rateMark.rate, behind: !paused && rateMark.rate < speed * 0.8 });
    }
    timer = setTimeout(tick, paused ? 100 : 8);
  };

  return (m) => {
    switch (m.type) {
      case "start": {
        try {
          twin = new LiveTwin(m.opts);
        } catch (e) {
          post({ type: "error", message: e instanceof Error ? e.message : String(e) });
          return;
        }
        speed = m.speed;
        reported = false;
        post({ type: "ready", info: twin.info });
        rebase();
        rateMark.wall = performance.now();
        rateMark.sim = twin.time;
        if (timer) clearTimeout(timer);
        tick();
        return;
      }
      case "type":
        twin?.type(m.text);
        return;
      case "speed":
        speed = Math.max(0.05, Math.min(50, m.speed));
        rebase();
        return;
      case "pause":
        paused = m.paused;
        rebase();
        return;
      case "stop":
        if (timer) clearTimeout(timer);
        timer = null;
        twin = null;
        return;
    }
  };
}
