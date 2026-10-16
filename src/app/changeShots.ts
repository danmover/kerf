// Before and after pictures of a change, taken from the same camera so they
// line up for a wipe. The "before" is taken as soon as the scene shows the
// starting design; if the design moves on first, there is no picture.

import { useDesign, whenRefined } from "../core/engine";
import { viewport, type Box, type Vec3 } from "./viewportApi";

export interface Shot {
  img: string;
  box: Box;
  dir: Vec3;
}

export interface ChangeShots {
  before: string;
  after: string;
  /** "wipe": the same framing, so one can be slid over the other; "pair": framed apart, shown side by side */
  mode: "wipe" | "pair";
}

const W = 560;
const H = 340;
const frames = (n: number) => new Promise<void>((r) => (n <= 0 ? r() : requestAnimationFrame(() => void frames(n - 1).then(r))));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pad([a, b]: Box, k: number): Box {
  const d = [0, 1, 2].map((i) => Math.max(b[i] - a[i], 1) * k);
  return [[a[0] - d[0], a[1] - d[1], a[2] - d[2]], [b[0] + d[0], b[1] + d[1], b[2] + d[2]]];
}
const inside = ([a, b]: Box, [c, d]: Box) => [0, 1, 2].every((i) => a[i] >= c[i] - 1e-6 && b[i] <= d[i] + 1e-6);

/** Capture the scene once it shows `src`, framed on `frame` (or the model, padded). */
export async function shotOf(src: string, frame?: { box: Box; dir: Vec3 }, settleMs = 0): Promise<Shot | null> {
  try {
    await whenRefined(30_000);
    if (settleMs) await wait(settleMs);
    await frames(2);
    const vp = viewport();
    const s = useDesign.getState();
    if (!vp || s.source !== src || !s.model?.parts.length) return null;
    const box = frame?.box ?? pad(vp.bounds(), 0.12);
    const dir = frame?.dir ?? vp.viewDir();
    const img = await vp.capture({ view: "current", width: W, height: H, box, dir, mime: "image/webp", quality: 0.84, overlays: false });
    return useDesign.getState().source === src ? { img, box, dir } : null;
  } catch {
    return null;
  }
}

/** The "after" picture to go with a "before": same framing when the new design still fits in it. */
export async function changeShots(before: Promise<Shot | null>, afterSrc: string): Promise<ChangeShots | null> {
  const b = await before;
  if (!b) return null;
  // removed parts fade out after a build; let them go first
  await whenRefined(30_000);
  await wait(320);
  const vp = viewport();
  if (!vp || useDesign.getState().source !== afterSrc) return null;
  const fits = inside(vp.bounds(), b.box);
  const a = await shotOf(afterSrc, fits ? b : { box: pad(vp.bounds(), 0.12), dir: b.dir });
  return a ? { before: b.img, after: a.img, mode: fits ? "wipe" : "pair" } : null;
}
