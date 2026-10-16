// The real design's model and source, even while a preview is on screen.

import { useMemo } from "react";
import { evaluateOnly, useDesign } from "../core/engine";
import { realSource, useProject } from "../app/project";
import type { Model } from "../core/model";

let cache: { src: string; model: Model } | null = null;

export function useRealModel(): { model: Model | null; source: string; previewing: boolean } {
  const model = useDesign((s) => s.model);
  const source = useDesign((s) => s.source);
  const previewing = useProject((s) => s.preview !== null);
  return useMemo(() => {
    if (!previewing) return { model, source, previewing };
    const real = realSource();
    if (cache?.src !== real) cache = { src: real, model: evaluateOnly(real) };
    return { model: cache.model, source: real, previewing };
  }, [previewing, model, source]);
}
