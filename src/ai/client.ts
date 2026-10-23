// The one place Kerf makes a Claude client. Chat, self-review and the
// sub-assembly agents all use it, so when the key is on a Kerf account (or the
// server offers a shared one) every request goes through that server, which
// adds the key; otherwise requests go straight to the API with this browser's key.

import Anthropic from "@anthropic-ai/sdk";
import { getApiKey } from "../persist/vault";
import { useAccount } from "../cloud/account";
import { useSettings } from "../app/settings";
import { getOpenAIKey } from "../persist/openaiVault";
import { isOpenAIModel, openAIFetch } from "./openai";

const TIMEOUT = 10 * 60 * 1000;

/** Where Claude requests go: through the Kerf server with the account's or a shared key, with this browser's key, or nowhere. */
export function claudeRoute(): "account" | "shared" | "browser" | null {
  if (isOpenAIModel(useSettings.getState().model)) return getOpenAIKey() ? "browser" : null;
  const acct = useAccount.getState();
  const via = acct.status === "signed-in" ? acct.info?.claude?.source : null;
  const key = getApiKey();
  // a key in this browser is preferred to a shared one
  if (via === "account" || (via === "shared" && !key)) return via;
  return key ? "browser" : null;
}

export function claudeClient(opts: { maxRetries?: number } = {}): Anthropic | null {
  if (isOpenAIModel(useSettings.getState().model)) {
    const key = getOpenAIKey();
    return key ? new Anthropic({ apiKey: "openai-adapter", baseURL: "https://api.openai.com/v1", fetch: openAIFetch(key), dangerouslyAllowBrowser: true, maxRetries: opts.maxRetries ?? 2, timeout: TIMEOUT }) : null;
  }
  const route = claudeRoute();
  const maxRetries = opts.maxRetries ?? 2;
  if (route === "account" || route === "shared") {
    return new Anthropic({ apiKey: "kerf-account", baseURL: `${location.origin}/api/claude`, defaultHeaders: { "x-kerf": "1" }, dangerouslyAllowBrowser: true, maxRetries, timeout: TIMEOUT });
  }
  if (route === "browser") return new Anthropic({ apiKey: getApiKey()!, dangerouslyAllowBrowser: true, maxRetries, timeout: TIMEOUT });
  return null;
}

/** How many requests to run at once: a shared key on a Kerf server takes one at a time. */
export const claudeParallel = (wanted: number) => (claudeRoute() === "shared" ? 1 : wanted);
