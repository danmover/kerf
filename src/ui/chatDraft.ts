// The chat composer's draft, so other panels can start a question for the user.

import { create } from "zustand";

interface Draft {
  text: string;
  nonce: number;
  set: (text: string) => void;
}

export const useChatDraft = create<Draft>((set) => ({
  text: "",
  nonce: 0,
  set: (text) => set((s) => ({ text, nonce: s.nonce + 1 })),
}));
