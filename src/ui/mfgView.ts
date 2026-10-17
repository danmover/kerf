// Display state for manufacturing checks: whether every process issue is
// drawn on the model, not only the one in focus, and a route's issues shown
// for a moment while the make tab hovers it.

import { create } from "zustand";
import type { ProcessResult } from "../mfg/types";

export const useMfgView = create<{ overlay: boolean; preview: Record<string, ProcessResult> | null }>(() => ({ overlay: true, preview: null }));
