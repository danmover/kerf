// One film render at a time, from the film maker or the assistant: its
// progress goes to the film store, its frames to whoever is watching.

import { useDesign } from "../core/engine";
import { errorText } from "../app/ui";
import { FilmPreview, makeFilm, type FilmResult } from "./render";
import { saveFilm, useFilm, type FilmJob } from "./store";
import type { FilmSpec } from "./spec";

type Canvas = HTMLCanvasElement | OffscreenCanvas;
const frameWatchers = new Set<(c: Canvas) => void>();

/** Watch the frames of the render under way (a live picture). Returns the way to stop. */
export function watchFrames(fn: (c: Canvas) => void): () => void {
  frameWatchers.add(fn);
  return () => void frameWatchers.delete(fn);
}

const patch = (p: Partial<FilmJob>) => {
  const j = useFilm.getState().job;
  if (j) useFilm.setState({ job: { ...j, ...p } });
};

export const filmBusy = () => {
  const j = useFilm.getState().job;
  return !!j && !j.result && !j.error;
};

export async function runFilmJob(spec: FilmSpec, opts: { byAssistant?: boolean; stills?: number[] } = {}): Promise<FilmResult> {
  if (filmBusy()) throw new Error("A film is already being made");
  const abort = new AbortController();
  useFilm.setState({ job: { progress: null, result: null, error: null, byAssistant: !!opts.byAssistant, abort }, spec, design: useDesign.getState().model?.name ?? null });
  try {
    // the render needs the 3D view to itself
    await FilmPreview.closeAll();
    const r = await makeFilm(spec, { signal: abort.signal, stills: opts.stills, onProgress: (progress) => patch({ progress }), onFrame: (c) => frameWatchers.forEach((f) => f(c)) });
    patch({ result: r });
    const name = useDesign.getState().model?.name;
    if (name) saveFilm(name, spec);
    return r;
  } catch (e) {
    patch({ error: abort.signal.aborted ? "Stopped" : errorText(e) });
    throw e;
  }
}

/** Leave the finished (or failed) render behind, back to editing. */
export function clearFilmJob() {
  if (!filmBusy()) useFilm.setState({ job: null });
}
