// The film maker's state: whether it is open, the film being edited, and a
// render under way (from the dialog or the assistant). Each design remembers
// the film last made of it.

import { create } from "zustand";
import type { FilmInputT, FilmSpec } from "./spec";
import type { FilmProgress, FilmResult } from "./render";

export interface FilmJob {
  progress: FilmProgress | null;
  result: FilmResult | null;
  error: string | null;
  /** started by the assistant: the dialog shows it, the tool waits for it */
  byAssistant: boolean;
  abort: AbortController;
}

interface FilmState {
  open: boolean;
  /** what the assistant (or a caller) asked for, laid over the default film when the dialog opens */
  preset: FilmInputT | null;
  /** the film being edited (or last rendered), kept while the dialog is closed */
  spec: FilmSpec | null;
  /** the design that film is of: another design starts from its own film */
  design: string | null;
  job: FilmJob | null;
}

export const useFilm = create<FilmState>(() => ({ open: false, preset: null, spec: null, design: null, job: null }));

export function openFilmMaker(preset: FilmInputT | null = null) {
  useFilm.setState({ open: true, preset, spec: preset ? null : useFilm.getState().spec });
}

export function closeFilmMaker() {
  const j = useFilm.getState().job;
  if (j && !j.result && !j.error) j.abort.abort();
  useFilm.setState({ open: false });
}

const KEY = (design: string) => `kerf.film.${design}`;

export function savedFilm(design: string): Partial<FilmSpec> | null {
  try {
    const s = localStorage.getItem(KEY(design));
    return s ? (JSON.parse(s) as Partial<FilmSpec>) : null;
  } catch {
    return null;
  }
}

export function saveFilm(design: string, spec: FilmSpec) {
  try {
    localStorage.setItem(KEY(design), JSON.stringify(spec));
  } catch {
    // a full or private store: the film is just not remembered
  }
}
