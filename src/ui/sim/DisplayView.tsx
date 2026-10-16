// A display from a simulation run (an SSD1306 OLED), showing what it showed
// at time t: drawn pixel for pixel, always as a lit panel on black.

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

export function DisplayView({ d, t, scale = 2 }: { d: DisplayRun; t: number; scale?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const frame = frameAt(d, t);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(d.w, d.h);
    const row = d.w >> 3;
    for (let y = 0; y < d.h; y++)
      for (let x = 0; x < d.w; x++) {
        const lit = frame ? (frame.px[y * row + (x >> 3)] & (0x80 >> (x & 7))) !== 0 : false;
        const c = lit ? LIT : DARK;
        const i = (y * d.w + x) * 4;
        img.data[i] = c[0];
        img.data[i + 1] = c[1];
        img.data[i + 2] = c[2];
        img.data[i + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
  }, [frame, d]);
  return <canvas ref={ref} width={d.w} height={d.h} className="sim-oled" style={{ width: d.w * scale, aspectRatio: `${d.w} / ${d.h}` }} role="img" aria-label={`What ${d.name} shows`} />;
}
