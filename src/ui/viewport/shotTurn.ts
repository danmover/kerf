// Whose turn it is among the pictures drawn between the view's frames (SceneController.captureBetweenFrames).

/** What the turn is decided from, of a picture waiting to be drawn. */
export interface ShotWaiting {
  /** when it was asked for, ms */
  asked: number;
  /** how long the view is given to come to rest before the picture is drawn alongside it, ms from `asked` (Infinity: for as long as it takes) */
  patience: number;
  /** when its first sample was drawn (it may have started again since); 0 before */
  begun: number;
  /** where it is drawn from; null until its first sample, and again once another picture took the buffers */
  cam: unknown | null;
  /** the scene its samples so far are of */
  stamp: number;
}

/** How long a picture starts again because the scene changed under it before it is drawn in one go instead, ms. */
export const SHOT_STARVED_MS = 2000;

/**
 * The picture that gets the next sample, if any. The view goes first: while it is `busy` (its own picture not
 * finished, something moving or arriving), only a picture whose patience has run out takes a turn, so one that has
 * is not kept waiting by one ahead of it that gives the view longer. Otherwise they go in the order asked for,
 * except that one that has begun, of the scene as it is (`stamp`), is finished before another begins: they share one
 * set of buffers, and the one set aside would start again.
 *
 * `atOnce`: the scene keeps changing under it (a mechanism playing, parts arriving one after another) and it has
 * started again for long enough. It is to be drawn in one go of the scene as it is now. Never one that waits for
 * the view however long it takes: that one takes no turn while anything changes.
 */
export function shotTurn<T extends ShotWaiting>(shots: readonly T[], busy: boolean, now: number, stamp: number): { shot: T; atOnce: boolean } | null {
  const due = (t: T) => !busy || now - t.asked >= t.patience;
  const shot = shots.find((t) => t.cam !== null && t.stamp === stamp && due(t)) ?? shots.find(due);
  if (!shot) return null;
  const atOnce = shot.begun > 0 && shot.stamp !== stamp && now - shot.begun > SHOT_STARVED_MS && Number.isFinite(shot.patience);
  return { shot, atOnce };
}
