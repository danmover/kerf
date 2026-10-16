// What the material views share: Claude's comparisons (kept for the chat
// cards), and the part whose materials are being compared on the model.

import { create } from "zustand";
import type { Advice } from "./advise";

export interface AdviceSnapshot {
  /** part block, or null for the design as a whole */
  part: string | null;
  advice: Advice;
}

interface MaterialsState {
  /** compare_materials results by tool use, for the chat card */
  byTool: Record<string, AdviceSnapshot>;
  /** the part block shown in the comparison on the model */
  comparing: string | null;
  record: (toolUseId: string, snap: AdviceSnapshot) => void;
  compare: (part: string | null) => void;
}

export const useMaterials = create<MaterialsState>((set) => ({
  byTool: {},
  comparing: null,
  record: (toolUseId, snap) => set((s) => ({ byTool: { ...s.byTool, [toolUseId]: snap } })),
  compare: (part) => set({ comparing: part }),
}));
