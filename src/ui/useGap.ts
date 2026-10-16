// The gap between two selected parts, measured exactly by the kernel.

import { useEffect, useState } from "react";
import { meshes, useDesign } from "../core/engine";
import { kernel } from "../kernel/client";
import type { MeasureResult } from "../kernel/core";
import type { EvalPart } from "../core/model";

export interface Gap extends MeasureResult {
  a_label: string;
  b_label: string;
}

/** Two sides to measure: two selected parts or components, or two selected solids of one. */
export function gapSides(parts: EvalPart[], ids: string[]): [EvalPart[], EvalPart[]] | null {
  const sel = parts.filter((p) => ids.includes(p.id) && meshes.has(p.hash));
  const names = [...new Set(sel.map((p) => p.name))];
  if (names.length === 2) return [sel.filter((p) => p.name === names[0]), sel.filter((p) => p.name === names[1])];
  if (sel.length === 2) return [[sel[0]], [sel[1]]];
  return null;
}

const sideLabel = (side: EvalPart[]) => (side.length === 1 ? side[0].label : side[0].name);

export function useGap(ids: string[]): Gap | null {
  const model = useDesign((s) => s.model);
  const meshVersion = useDesign((s) => s.meshVersion);
  const [gap, setGap] = useState<Gap | null>(null);
  const sides = model ? gapSides(model.parts, ids) : null;
  const key = sides ? sides.map((s) => s.map((p) => p.hash + JSON.stringify(p.xf)).join(",")).join("|") : "";
  useEffect(() => {
    if (!sides) {
      setGap(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      kernel
        .measure(
          sides[0].map((p) => ({ hash: p.hash, xf: p.xf })),
          sides[1].map((p) => ({ hash: p.hash, xf: p.xf })),
        )
        .then((r) => live && setGap({ ...r, a_label: sideLabel(sides[0]), b_label: sideLabel(sides[1]) }))
        .catch(() => live && setGap(null));
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // the key covers the sides' geometry and placement
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, meshVersion]);
  return sides ? gap : null;
}
