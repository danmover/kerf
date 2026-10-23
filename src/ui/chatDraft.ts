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

/** Put a request for Claude in the message box, to send as it is or add to first. */
export const askClaude = (prompt: string) => useChatDraft.getState().set(prompt);

/** A careful engineer's read of the design, offered from the overview and the find palette. */
export const REVIEW_ASK = "Review this design as a careful engineer: what would fail, be hard to make or assemble, or cost more than it should? Put the most important first and offer a fix for each.";
