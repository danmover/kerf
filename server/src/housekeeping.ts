// Daily clean-up, so the server keeps only what the privacy notice says it keeps.

import type { Deps } from "./types.js";

const DAY = 24 * 3600 * 1000;

/** How long things are kept after they stop being useful. */
export const RETENTION = {
  /** Markers that tell other devices a project was deleted. */
  tombstones: 90 * DAY,
  /** Used or expired email links. */
  tokens: 1 * DAY,
  /** Daily Claude token counts. */
  usage: 400 * DAY,
  /** Invite-only sign-ups whose emailed link was never used. */
  pendingSignups: 7 * DAY,
  /** Files no live project refers to (a day's grace covers a sync that sends files before the project). */
  unusedFiles: 1 * DAY,
};

export function housekeeping(deps: Deps, now = Date.now()) {
  const { db } = deps;
  db.tx(() => {
    db.run("DELETE FROM projects WHERE deleted_at IS NOT NULL AND deleted_at < ?", now - RETENTION.tombstones);
    db.run("DELETE FROM sessions WHERE expires_at < ?", now);
    db.run("DELETE FROM tokens WHERE expires_at < ? OR used_at < ?", now - RETENTION.tokens, now - RETENTION.tokens);
    db.run("DELETE FROM usage WHERE day < ?", new Date(now - RETENTION.usage).toISOString().slice(0, 10));
    db.run("DELETE FROM users WHERE password_hash = '' AND email_verified_at IS NULL AND created_at < ?", now - RETENTION.pendingSignups);
    db.run(
      `DELETE FROM files WHERE created_at < ? AND NOT EXISTS
         (SELECT 1 FROM projects p WHERE p.user_id = files.user_id AND p.deleted_at IS NULL AND instr(p.extra, files.hash) > 0)`,
      now - RETENTION.unusedFiles,
    );
  });
}
