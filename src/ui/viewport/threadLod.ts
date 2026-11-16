// Which of a part's meshes the 3D view shows. A part with threads has a display mesh (exact tolerance, the threads
// drawn by the part shader on plain cylinders) and a final one with the real helical threads. The view shows the
// display mesh, and the real one for photoreal, films and when the camera is close enough for a thread's ridges to
// stand out (about seven pixels a pitch).

import type { MeshEntry } from "../../core/engine";
import type { MeshData } from "../../kernel/build";
import { THREAD_STRIDE } from "../../kernel/threadMarks";

export type MeshQualityShown = "preview" | "display" | "final";

export function pickMesh(entry: MeshEntry | undefined, real: boolean): { data: MeshData; quality: MeshQualityShown } | null {
  if (!entry) return null;
  const order: MeshQualityShown[] = real ? ["final", "display", "preview"] : ["display", "final", "preview"];
  for (const q of order) {
    const data = entry[q];
    if (data) return { data, quality: q };
  }
  return null;
}

const pitches = new WeakMap<MeshData, number>();

/** The largest pitch drawn on a display mesh (mm), 0 when it draws none. */
export function threadPitch(data: MeshData | undefined): number {
  if (!data?.thread) return 0;
  const hit = pitches.get(data);
  if (hit !== undefined) return hit;
  const t = data.thread;
  let p = 0;
  for (let i = 0; i < t.length; i += THREAD_STRIDE) if (t[i] !== 0) p = Math.max(p, Math.hypot(t[i + 2], t[i + 3]));
  pitches.set(data, p);
  return p;
}

/** Pixels a pitch spans past which the real thread is shown, and below which the drawn one comes back. */
export const REAL_THREAD_PX = 7;
export const DRAWN_THREAD_PX = 4.5;

/**
 * Whether the real thread should be on screen: one pitch at this distance spans more than REAL_THREAD_PX pixels
 * (less than DRAWN_THREAD_PX to go back, so it doesn't flick between the two at one zoom).
 */
export function closeEnough(pitch: number, distance: number, fovDeg: number, viewHeightPx: number, wasReal: boolean): boolean {
  if (!(pitch > 0) || !(distance > 0)) return false;
  const px = (pitch * viewHeightPx) / (2 * distance * Math.tan((fovDeg * Math.PI) / 360));
  return px > (wasReal ? DRAWN_THREAD_PX : REAL_THREAD_PX);
}
