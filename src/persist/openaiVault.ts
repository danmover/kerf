// A separate encrypted vault record; switching provider never overwrites a key.
import { getOne, put, remove } from "./db";
const ID = "openai-api-key";
let key: string | null = null;
let remembered = false;
const listeners = new Set<() => void>();
export const getOpenAIKey = () => key;
export const openAIKeyRemembered = () => remembered;
export const subscribeOpenAIKey = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const emit = () => listeners.forEach(fn => fn());
export function validateOpenAIKey(value: string) {
  if (!/^sk-[A-Za-z0-9_-]{20,500}$/.test(value.trim()) || value.trim().startsWith("sk-ant-")) return "Paste your complete OpenAI API key from platform.openai.com. A ChatGPT subscription does not include API usage.";
  return null;
}
export async function setOpenAIKey(value: string, remember: boolean) {
  const next = value.trim(); const error = validateOpenAIKey(next); if (error) throw Error(error);
  await remove("vault", ID); key = next; remembered = false;
  try {
    if (remember) {
      const cryptoKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, new TextEncoder().encode(next));
      await put("vault", { id: ID, cryptoKey, iv, data }); remembered = true;
    }
  } finally { emit(); }
}
export async function forgetOpenAIKey() { key = null; remembered = false; emit(); await remove("vault", ID); }
export async function loadOpenAIKey() {
  try {
    const rec = await getOne<{ id: string; cryptoKey: CryptoKey; iv: Uint8Array; data: ArrayBuffer }>("vault", ID);
    if (!rec) return;
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(rec.iv) }, rec.cryptoKey, rec.data);
    const value = new TextDecoder().decode(plain); if (validateOpenAIKey(value)) return;
    key = value; remembered = true; emit();
  } catch { /* a missing or unreadable saved key is ignored */ }
}
