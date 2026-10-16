// A spot on the model the user is talking about: right-click a part (or use
// "Ask" on a selection) and a small chat opens pinned to that spot.

import { create } from "zustand";
import { fmtNum } from "../lang/values";
import type { Vec3 } from "./viewportApi";

export interface SpotRef {
  partId: string;
  label: string;
  /** where on the part, in its own frame (absent: the part as a whole) */
  local?: Vec3;
  /** the same spot in assembly coordinates */
  point?: Vec3;
  /** outward face normal there, in assembly coordinates */
  normal?: Vec3;
}

export interface Spot extends SpotRef {
  /** chat items sent from this spot, so its replies can show in place */
  sent: string[];
  nonce: number;
}

export const useSpot = create<{ spot: Spot | null }>(() => ({ spot: null }));

let n = 0;
export function openSpot(ref: SpotRef) {
  useSpot.setState({ spot: { ...ref, sent: [], nonce: ++n } });
}
export function closeSpot() {
  useSpot.setState({ spot: null });
}
export function noteSpotMessage(itemId: string) {
  useSpot.setState((s) => (s.spot ? { spot: { ...s.spot, sent: [...s.spot.sent, itemId] } } : s));
}

const v3 = (v: Vec3) => `(${v.map((x) => fmtNum(Math.abs(x) < 5e-4 ? 0 : x, 1)).join(", ")})`;

/** Words for Claude that say where the user is pointing. */
export function spotText(s: SpotRef): string {
  if (!s.point || !s.local) return `The user is pointing at ${s.label} (part \`${s.partId}\`) as a whole. "This" means that part.`;
  return [
    `The user is pointing at a spot on ${s.label} (part \`${s.partId}\`):`,
    `${v3(s.point)} mm in assembly coordinates, ${v3(s.local)} mm in the part's own frame`,
    s.normal ? `, on a face whose outward normal is ${v3(s.normal)}.` : ".",
    ` "This" and "here" mean that spot. Work out which feature it is from the design before changing it.`,
  ].join("");
}

/** A short label for the spot, for chips. */
export const spotLabel = (s: SpotRef) => (s.point ? `${s.label} · ${s.point.map((x) => fmtNum(x, 0)).join(", ")}` : s.label);
