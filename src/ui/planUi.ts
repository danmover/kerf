// View state for the live plan: whether the tree is open, which step to
// reveal, and the parts a hovered step lights up in the 3D view.

import { create } from "zustand";
import { useView } from "../app/view";
import { useDesign } from "../core/engine";

const KEY = "kerf.plan.open";
const initialOpen = () => {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
};

interface PlanUi {
  open: boolean;
  /** a step to scroll into view and flash */
  reveal: { id: string; nonce: number } | null;
}

export const usePlanUi = create<PlanUi>(() => ({ open: initialOpen(), reveal: null }));

export function setPlanOpen(open: boolean) {
  usePlanUi.setState({ open });
  try {
    localStorage.setItem(KEY, open ? "1" : "0");
  } catch {
    /* ignore */
  }
}

let nonce = 0;
export function revealStep(id: string) {
  setPlanOpen(true);
  usePlanUi.setState({ reveal: { id, nonce: ++nonce } });
}

/** Part ids for the names a step lists (a component name covers its instances and sub-parts). */
export function partIds(names: string[] | undefined): string[] {
  const m = useDesign.getState().model;
  if (!m || !names?.length) return [];
  return m.parts.filter((p) => names.some((n) => p.name === n || p.id === n || p.id.startsWith(n + "#") || p.id.startsWith(n + "."))).map((p) => p.id);
}

// a hovered step emphasises its parts, unless a check is focused (that wins)
let lit = false;
export function lightParts(names: string[] | undefined) {
  const v = useView.getState();
  if (v.focusCheck) return;
  const ids = partIds(names);
  if (!ids.length && !lit) return;
  lit = ids.length > 0;
  useView.setState({ focusParts: ids });
}
export function unlightParts() {
  if (!lit) return;
  lit = false;
  if (!useView.getState().focusCheck) useView.setState({ focusParts: [] });
}
