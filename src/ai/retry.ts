// Requests that fail for a passing reason are tried again after a wait, so a
// busy moment at the API does not end the assistant's run, a review or a
// subassembly agent and leave the user to press Retry.

import Anthropic from "@anthropic-ai/sdk";

/** Error types the API sends part-way through a stream when it is busy or failed, which the SDK does not retry. */
const PASSING = new Set(["overloaded_error", "api_error", "rate_limit_error"]);

/**
 * Seconds to wait before trying a failed request again, or null when the error will not pass by itself or the
 * attempts are used up. Passing: busy or overloaded (also when said mid-stream), a server error, a rate limit the
 * SDK's own retries did not outlast, a dropped connection. Waits grow 5, 15, 45 s, or the API's retry-after,
 * at most a minute.
 */
export function retryWait(e: unknown, attempt: number, max = 3): number | null {
  if (attempt >= max || e instanceof Anthropic.APIUserAbortError) return null;
  const passing =
    e instanceof Anthropic.RateLimitError ||
    e instanceof Anthropic.InternalServerError ||
    e instanceof Anthropic.APIConnectionError ||
    (e instanceof Anthropic.APIError && (e.status === 529 || (e.status === undefined && PASSING.has(String(e.type)))));
  if (!passing) return null;
  const after = Number((e as InstanceType<typeof Anthropic.APIError>).headers?.get?.("retry-after")) || 0;
  return Math.min(60, Math.max(after, 5 * 3 ** attempt));
}

/** Wait, unless the user stops first. */
export function pause(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
}
