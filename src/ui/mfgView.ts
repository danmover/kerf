// Display state for manufacturing checks: whether every process issue is
// drawn on the model, not only the one in focus.

import { create } from "zustand";

export const useMfgView = create<{ overlay: boolean }>(() => ({ overlay: true }));
