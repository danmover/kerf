// Which workspace layout fits the screen.
//
//   phone     the phone workspace: one panel at a time (screens/PhoneWorkspace)
//   wide      desktop: model panel, 3D view and code, chat, side by side
//   compact   a tablet held sideways or a narrow window: the model panel folds
//             into a rail of tab icons so the 3D view keeps its room
//   portrait  a tablet held upright: the 3D view across the top, the model
//             panel and chat side by side below it
//
// wide, compact and portrait share one component tree (screens/Workspace), so
// turning a tablet changes the grid without rebuilding the 3D view or the chat.

import { useSyncExternalStore } from "react";

export type WorkspaceLayout = "phone" | "wide" | "compact" | "portrait";

/** Phones, upright or sideways (a sideways phone is short, not narrow). */
export const PHONE_QUERY = "(max-width: 760px), (max-height: 520px) and (max-width: 1000px)";
/** Too narrow for the three desktop columns at their usual widths. */
export const COMPACT_QUERY = "(max-width: 1279px)";
export const PORTRAIT_QUERY = "(orientation: portrait)";

function subscribe(cb: () => void) {
  if (typeof matchMedia === "undefined") return () => {};
  const mqs = [PHONE_QUERY, COMPACT_QUERY, PORTRAIT_QUERY].map((q) => matchMedia(q));
  for (const mq of mqs) mq.addEventListener("change", cb);
  return () => mqs.forEach((mq) => mq.removeEventListener("change", cb));
}

const matches = (q: string) => typeof matchMedia !== "undefined" && matchMedia(q).matches;

export function layoutNow(): WorkspaceLayout {
  if (matches(PHONE_QUERY)) return "phone";
  if (!matches(COMPACT_QUERY)) return "wide";
  return matches(PORTRAIT_QUERY) ? "portrait" : "compact";
}

export function useWorkspaceLayout(): WorkspaceLayout {
  return useSyncExternalStore(subscribe, layoutNow, () => "wide");
}

/** The window's size, kept current (the compact layouts size their columns from it). */
let size = { w: 0, h: 0 };
const readSize = () => {
  if (typeof window === "undefined") return size;
  if (size.w !== window.innerWidth || size.h !== window.innerHeight) size = { w: window.innerWidth, h: window.innerHeight };
  return size;
};
function subscribeSize(cb: () => void) {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}
export function useWindowSize() {
  return useSyncExternalStore(subscribeSize, readSize, () => size);
}

/** Width of the model panel's rail of tabs on tablets and narrow windows. */
export const RAIL = 56;

/**
 * Column and row sizes for each layout. The stored sizes are what the user
 * dragged to; on smaller screens they are capped so the 3D view keeps room.
 */
export function gridFor(layout: WorkspaceLayout, win: { w: number; h: number }, s: { left: number; right: number; below: number; dock: number; panelOpen: boolean }) {
  const rail = layout === "wide" ? 0 : RAIL;
  if (layout === "portrait") {
    const below = Math.round(Math.max(220, Math.min(s.below, win.h * 0.55)));
    const panel = Math.round(Math.min(s.left, Math.max(240, (win.w - rail) * 0.45)));
    const leftCol = rail + (s.panelOpen ? panel : 0);
    const centerH = win.h - 72 - below;
    return {
      grid: { gridTemplateColumns: `${leftCol}px minmax(0, 1fr)`, gridTemplateRows: `minmax(0, 1fr) ${below}px` },
      panel,
      leftCol,
      chat: 0,
      below,
      dock: Math.round(Math.min(s.dock, Math.max(140, centerH * 0.5))),
    };
  }
  const compact = layout === "compact";
  const panel = compact ? Math.round(Math.min(s.left, Math.max(230, win.w * 0.24))) : s.left;
  const chat = compact ? Math.round(Math.min(s.right, Math.max(300, win.w * 0.32))) : s.right;
  const leftCol = rail + (s.panelOpen ? panel : 0);
  return {
    grid: { gridTemplateColumns: `${leftCol}px minmax(0, 1fr) ${chat}px` },
    panel,
    leftCol,
    chat,
    below: 0,
    dock: compact ? Math.round(Math.min(s.dock, Math.max(140, (win.h - 72) * 0.5))) : s.dock,
  };
}
