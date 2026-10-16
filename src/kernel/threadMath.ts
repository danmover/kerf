// Thread geometry numbers shared by the kernel and the language: depth,
// pitch and minor diameters, and the basic profile of each thread form.

import type { ThreadForm, ThreadSpec3 } from "./recipe";

/** Most turns (length / pitch) of one thread: more takes the detailed build minutes. */
export const MAX_THREAD_TURNS = 200;

/** Why a thread of this length cannot be built, or null when it can. */
export function threadTurnsError(fn: string, length: number, pitch: number): string | null {
  const turns = length / pitch;
  if (turns <= MAX_THREAD_TURNS) return null;
  return `${fn}: ${Math.round(turns)} turns of thread is more than the ${MAX_THREAD_TURNS} Kerf builds; model only the length that engages (at most ${Math.floor(MAX_THREAD_TURNS * pitch)} mm at pitch ${pitch})`;
}

/** Radial depth of the basic thread form. */
export function threadDepth(form: ThreadForm, pitch: number) {
  switch (form) {
    case "iso":
      return 0.541266 * pitch; // 5/8 H, H = 0.866 p
    case "trapezoid":
    case "square":
      return 0.5 * pitch;
    case "buttress":
      return 0.6 * pitch;
  }
}

/** Pitch diameter: where the flanks are as wide as the gaps. */
export function pitchDiameter(spec: Pick<ThreadSpec3, "d" | "pitch" | "form">) {
  return spec.form === "iso" ? spec.d - 0.649519 * spec.pitch : spec.d - threadDepth(spec.form, spec.pitch);
}

export function minorDiameter(spec: Pick<ThreadSpec3, "d" | "pitch" | "form">) {
  return spec.d - 2 * threadDepth(spec.form, spec.pitch);
}

/**
 * Basic radius at axial phase s (0..1 along one pitch), crest centred at s = 0.5.
 * Flanks are straight lines between the root and crest flats.
 */
export function formRadius(form: ThreadForm, d: number, pitch: number, s: number): number {
  const rMaj = d / 2;
  const rMin = rMaj - threadDepth(form, pitch);
  const u = ((s % 1) + 1) % 1;
  // [root flat half, crest flat half] as fractions of the pitch, for symmetric forms
  let crest: number;
  let root: number;
  switch (form) {
    case "iso":
      crest = 1 / 16;
      root = 1 / 8;
      break;
    case "trapezoid":
      crest = 0.183;
      root = 0.183;
      break;
    case "square":
      crest = 0.24;
      root = 0.24;
      break;
    case "buttress": {
      // asymmetric: a 45° clearance flank rising to the crest, then a steep (7°) load flank
      const rise = 0.6; // axial width of the 45° flank, in pitches (depth 0.6 p)
      const fall = 0.074; // 0.6 p × tan 7°
      const top = 0.16;
      const a = (1 - rise - fall - top) / 2;
      if (u < a) return rMin;
      if (u < a + rise) return rMin + ((u - a) / rise) * (rMaj - rMin);
      if (u < a + rise + top) return rMaj;
      if (u < a + rise + top + fall) return rMaj - ((u - a - rise - top) / fall) * (rMaj - rMin);
      return rMin;
    }
  }
  const x = Math.abs(u - 0.5); // distance from the crest centre, in pitches
  if (x <= crest) return rMaj;
  if (x >= 0.5 - root) return rMin;
  const t = (x - crest) / (0.5 - root - crest);
  return rMaj - t * (rMaj - rMin);
}
