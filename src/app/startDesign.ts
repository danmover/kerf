// Starting a design by describing it: a new blank project named from the
// description, opened, with the description sent to Claude as the first
// message (or left in the message box when no model is connected yet, so the
// chat can say how to connect one). Home's describe box and the find
// palette's "Ask Claude" outside a project both start here.

import { createProject, openProject } from "./project";
import { useSettings } from "./settings";
import { sendMessage, useChat } from "../ai/chat";
import { useChatDraft } from "../ui/chatDraft";
import { getApiKey } from "../persist/vault";
import { getOpenAIKey } from "../persist/openaiVault";
import { useAccount } from "../cloud/account";
import { templateById } from "../demos/templates";

/** The key chat would use now: the browser's, the account's ("account") or none (see ui/ChatPanel useApiKey). */
export function chatKey(): string | null {
  if (useSettings.getState().model.startsWith("gpt-")) return getOpenAIKey();
  const a = useAccount.getState();
  return getApiKey() ?? (a.status === "signed-in" && a.info?.claude?.source ? "account" : null);
}

const LEAD = /^(?:(?:please|can you|could you|i want(?: you)? to|i'd like(?: you)? to|help me|let's|lets)\s+)*(?:design|make|build|create|model|draw|cad|i need|i want)?\s*(?:me\s+)?(?:an?|the|some)?\s+/i;

/** A project name from a description: its first clause without "design a", capitalised, at most about 48 characters. */
export function nameFrom(text: string): string {
  // a full stop, colon or comma ends the clause only before a space, so 2.5 mm and 3:1 stay whole
  const first = text.trim().split(/[;!?\n]|[.:,](?=\s|$)/)[0] ?? "";
  let s = first.replace(LEAD, "").replace(/["\\]/g, "").replace(/\s+/g, " ").trim();
  if (s.length > 48) s = s.slice(0, 48).replace(/\s+\S*$/, "");
  if (!s) return "Untitled design";
  return s[0].toUpperCase() + s.slice(1);
}

/** Wait until the chat has loaded this project's conversation, so a first message isn't wiped by the load. */
function chatReady(projectId: string, ms = 4000): Promise<void> {
  if (useChat.getState().projectId === projectId) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    const off = useChat.subscribe((s) => s.projectId === projectId && done());
    function done() {
      clearTimeout(t);
      off();
      resolve();
    }
  });
}

/** Start a new design from a description and hand it to Claude. */
export async function startDesign(text: string): Promise<void> {
  const brief = text.trim();
  if (!brief) return;
  const name = nameFrom(brief);
  const blank = templateById("blank")?.source ?? 'design "Untitled design"\n';
  const p = await createProject("blank", name, blank.replace(/design\s+"[^"]*"/, `design "${name}"`));
  await openProject(p.id);
  await chatReady(p.id);
  if (chatKey()) await sendMessage(brief);
  else useChatDraft.getState().set(brief);
}
