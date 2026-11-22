// Colours for cables by what they carry and by how loaded they are, shared
// by the 3D harness (tinted cables), the cable card and the wiring tab's list.

import type { WireKind } from "../../machine/wiring";

export const KIND_NAME: Record<WireKind, string> = { ground: "Ground", signal: "Signal", motor: "Motor", cable: "Cable", power: "Power" };

const KIND_COLOR: Record<WireKind, string> = {
  power: "#f0524f",
  ground: "#8d97ab",
  signal: "#4f8dff",
  motor: "#f2a43a",
  cable: "#a77bf3",
};

export const kindColor = (k: WireKind) => KIND_COLOR[k];

/** Current against rating, 0 to 1 and beyond, as a colour from cool (lightly loaded) through amber to red (over). */
export function loadColor(f: number | undefined): string {
  if (f === undefined) return "#5c6577";
  const stops: [number, [number, number, number]][] = [
    [0, [52, 120, 246]],
    [0.4, [38, 196, 133]],
    [0.75, [245, 190, 60]],
    [1, [240, 82, 79]],
    [1.5, [255, 60, 160]],
  ];
  const x = Math.max(0, Math.min(1.5, f));
  for (let i = 1; i < stops.length; i++) {
    const [b, cb] = stops[i];
    const [a, ca] = stops[i - 1];
    if (x <= b) {
      const t = (x - a) / (b - a);
      const c = ca.map((v, k) => Math.round(v + (cb[k] - v) * t));
      return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
    }
  }
  return "rgb(255, 60, 160)";
}
