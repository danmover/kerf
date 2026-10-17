// A circuit board Kerf routed itself (machine/pcb) as a board layout for the
// 3D view: the router's tracks, vias and ground pour, the footprints' pads and
// drilled holes, the silkscreen the Gerbers carry, and a solder joint on every
// through-hole pin on the side opposite its part. Before the router has
// finished, the board shows its pads and silkscreen without copper.

import { holeShape, placedHoles, placedPads } from "../pcb/board";
import { padShape, type Shape } from "../pcb/geom";
import { boardSilk } from "../pcb/silk";
import type { BoardSpec, Layer, RoutedBoard } from "../pcb/types";
import type { BoardLayout, Face, Hole, PadShape } from "./layout";
import { DEFAULT_STYLE } from "./look";
import type { V2 } from "./pins";

export function routedLayout(spec: BoardSpec, routed: RoutedBoard | undefined, t: number, mask = DEFAULT_STYLE.mask): BoardLayout {
  const { w, h } = spec;
  // the layout is centred on the board; the router's frame has its origin at the bottom-left corner
  const P = ([x, y]: V2 | [number, number]): V2 => [x - w / 2, y - h / 2];
  const shape = (s: Shape): PadShape => {
    if (s.k === "cap") return { k: "cap", a: P([s.ax, s.ay]), b: P([s.bx, s.by]), r: s.r };
    const pts: V2[] = [];
    for (let i = 0; i < s.p.length; i += 2) pts.push(P([s.p[i], s.p[i + 1]]));
    return { k: "poly", pts };
  };
  const pads = placedPads(spec);
  const silk = boardSilk(spec);
  const face = (layer: Layer): Face => {
    const f: Face = { pour: false, traces: [], vias: [], pads: [], silk: [], blocks: [], texts: [], joints: [] };
    for (const p of pads) {
      const [x, y] = P([p.x, p.y]);
      f.pads.push({ x, y, w: p.w, h: p.h, shape: shape(padShape(p)) });
      // through-hole pins are soldered on the side away from their part
      if ((p.side === "top") === (layer === "B")) f.joints.push([x, y, Math.min(p.w, p.h) * 0.42]);
    }
    if (routed) {
      for (const tr of routed.tracks) if (tr.layer === layer) f.traces.push({ w: tr.w, pts: tr.pts.map(P) });
      for (const v of routed.vias) f.vias.push(P([v.x, v.y]));
      f.via = { pad: routed.rules.via.pad, drill: routed.rules.via.drill };
      const polys = routed.pours.filter((p) => p.layer === layer).flatMap((p) => p.polys.map((r) => r.map(P)));
      if (polys.length) f.polys = polys;
    }
    const s = silk[layer];
    f.strokes = [...s.lines.map((l) => ({ pts: l.pts.map(P), w: l.w })), ...s.dots.map((d) => ({ pts: [P([d.x, d.y])], w: d.d }))];
    return f;
  };
  const holes: Hole[] = [];
  for (const p of pads) {
    const s = holeShape(p);
    if (s.k !== "cap") continue;
    const [x, y] = P([s.ax, s.ay]);
    const hole: Hole = { x, y, d: 2 * s.r, ring: 0 };
    if (s.ax !== s.bx || s.ay !== s.by) hole.to = P([s.bx, s.by]);
    holes.push(hole);
  }
  for (const hl of placedHoles(spec)) {
    const [x, y] = P([hl.x, hl.y]);
    holes.push({ x, y, d: hl.d, ring: 0 });
  }
  return {
    w,
    d: h,
    t,
    corner: Math.max(0, Math.min(spec.corner ?? 0, w / 4, h / 4)),
    style: { ...DEFAULT_STYLE, mask },
    items: [],
    sockets: [],
    smd: [],
    holes,
    top: face("F"),
    bottom: face("B"),
    silkW: 0.15,
  };
}
