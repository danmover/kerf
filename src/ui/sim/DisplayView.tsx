// A display from a simulation run, showing what it showed at time t: an SSD1306
// OLED drawn pixel for pixel as a lit panel on black, or a character LCD drawn dot
// for dot in its 5 × 8 cells, on its glass and as bright as its backlight was.

import { useEffect, useRef } from "react";
import type { DisplayFrame, DisplayRun } from "../../sim/engine/run";

/** The frame on screen at t: the last one recorded at or before it. */
export function frameAt(d: DisplayRun, t: number): DisplayFrame | undefined {
  const f = d.frames;
  let lo = 0;
  let hi = f.length - 1;
  if (hi < 0 || f[0].t > t) return undefined;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (f[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return f[lo];
}

/** how a lit OLED pixel and the panel around it look */
const LIT = [214, 236, 255];
const DARK = [5, 7, 10];

/** an LCD's glass: the gaps between cells, an unlit dot and a lit one, with the backlight on and off */
const GLASS: Record<string, { on: number[][]; off: number[][] }> = {
  white_on_blue: {
    on: [[24, 72, 196], [36, 92, 220], [236, 244, 255]],
    off: [[10, 20, 52], [13, 26, 64], [64, 74, 104]],
  },
  black_on_green: {
    on: [[148, 192, 42], [138, 182, 36], [28, 42, 22]],
    off: [[86, 100, 52], [82, 96, 50], [30, 36, 24]],
  },
};

const mix = (a: number[], b: number[], k: number) => a.map((v, i) => Math.round(v + (b[i] - v) * k));

export function DisplayView({ d, t, scale = 2 }: { d: DisplayRun; t: number; scale?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const frame = frameAt(d, t);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(d.w, d.h);
    const row = d.w >> 3;
    const lcd = d.look?.kind === "lcd";
    const glass = GLASS[d.look?.color ?? ""] ?? GLASS.white_on_blue;
    const light = (frame as { light?: number } | undefined)?.light ?? 0;
    const [gap, dot, on] = glass.off.map((c, i) => mix(c, glass.on[i], light));
    for (let y = 0; y < d.h; y++)
      for (let x = 0; x < d.w; x++) {
        const lit = frame ? (frame.px[y * row + (x >> 3)] & (0x80 >> (x & 7))) !== 0 : false;
        const c = !lcd ? (lit ? LIT : DARK) : lit ? on : x % 6 < 5 && y % 9 < 8 ? dot : gap;
        const i = (y * d.w + x) * 4;
        img.data[i] = c[0];
        img.data[i + 1] = c[1];
        img.data[i + 2] = c[2];
        img.data[i + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
  }, [frame, d]);
  // an LCD's cells are small: draw it larger, so its text reads like the real 66 mm wide glass
  const k = d.look?.kind === "lcd" ? scale * 1.6 : scale;
  const label = d.look?.kind === "lcd" ? `What ${d.name} shows (at the end of the run: ${d.look.text.map((r) => r.trimEnd()).join(" / ")})` : `What ${d.name} shows`;
  return <canvas ref={ref} width={d.w} height={d.h} className="sim-oled" style={{ width: d.w * k, aspectRatio: `${d.w} / ${d.h}` }} role="img" aria-label={label} />;
}
