// The one place Kerf makes a Claude client. Chat, self-review and the
// sub-assembly agents all use it, so when the key is on a Kerf account (or the
// server offers a shared one) every request goes through that server, which
// adds the key; otherwise requests go straight to the API with this browser's key.

import Anthropic from "@anthropic-ai/sdk";
import { getApiKey } from "../persist/vault";
import { useAccount } from "../cloud/account";

const TIMEOUT = 10 * 60 * 1000;

/** Where Claude requests go: through the Kerf server with the account's or a shared key, with this browser's key, or nowhere. */
export function claudeRoute(): "account" | "shared" | "browser" | null {
  const acct = useAccount.getState();
  const via = acct.status === "signed-in" ? acct.info?.claude?.source : null;
  const key = getApiKey();
  // a key in this browser is preferred to a shared one
  if (via === "account" || (via === "shared" && !key)) return via;
  return key ? "browser" : null;
}

export function claudeClient(opts: { maxRetries?: number } = {}): Anthropic | null {
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
