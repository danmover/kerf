// What the 3D view does when the graphics card resets (the view loses its drawing context). Chromium gives the
// context back each time, so a view that goes on drawing whatever set the card off resets it again, for ever: on
// screen, "Bringing the 3D view back…" over and over. Counting the resets breaks that loop.

/** resets further apart than this are unrelated (a driver update, the PC waking from sleep) */
export const LOSS_WINDOW_MS = 5 * 60_000;
/** results drawn over the model (their own shaders and textures) go after this many resets in the window */
export const LOSSES_BEFORE_RESULTS_HIDE = 2;
/** this many with nothing left to take away stops the view until asked to try again */
export const LOSSES_ALLOWED = 3;

/** wait: the context should come back; hide-results: take the results off, then wait; stop: show the error card */
export type ResetStep = "wait" | "hide-results" | "stop";

/** After a reset at `now`: the resets that still count, and what to do. `resultsOn`: results are drawn over the model. */
export function afterReset(times: readonly number[], now: number, resultsOn: boolean): { times: number[]; step: ResetStep } {
  const recent = [...times.filter((t) => now - t < LOSS_WINDOW_MS), now];
  // with the results gone the view gets a fresh count: the model alone may well draw fine
  if (resultsOn && recent.length >= LOSSES_BEFORE_RESULTS_HIDE) return { times: [now], step: "hide-results" };
  if (recent.length >= LOSSES_ALLOWED) return { times: recent, step: "stop" };
  return { times: recent, step: "wait" };
}
