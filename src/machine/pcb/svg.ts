// Board preview as SVG, seen from one side the way the board will look: green
// solder mask, copper showing through it a shade lighter, tinned pads, holes,
// white silkscreen. Seen from the bottom the picture is mirrored left-right,
// as it is when you turn the board over. It is a picture of the real board, so
// it looks the same on both themes and in the build pack.

import { holeShape, placedHoles, placedPads } from "./board";
import { bodyShape, padShape, shapeBox, type Pt, type Shape } from "./geom";
import { pourGroups } from "./pour";
import { boardSilk } from "./silk";
import type { Layer, RoutedBoard } from "./types";

const C = {
  bg: "#0b0f0d",
  mask: "#1d5c3a",
  edge: "#5f8f72",
  copper: "#38a062",
  pour: "#2b8050",
  copperHi: "#9cf0b8",
  pad: "#d6d3c6",
  padHi: "#fff1a8",
  hole: "#0b0f0d",
  silk: "#f2f2ea",
  focus: "#ffc93c",
};

const MARGIN = 2;

export function boardSvg(b: RoutedBoard, opts: { side?: "top" | "bottom"; scale?: number; highlightNet?: string; highlightRef?: string } = {}): { svg: string; width: number; height: number } {
  const { spec } = b;
  const side = opts.side ?? "top";
  const layer: Layer = side === "top" ? "F" : "B";
  const scale = opts.scale ?? 6;
  const { w, h } = spec;
  const X = (x: number) => n2(side === "bottom" ? w - x : x);
  const Y = (y: number) => n2(h - y);
  const P = ([x, y]: Pt) => `${X(x)} ${Y(y)}`;
  const line = (pts: Pt[]) => "M" + pts.map(P).join("L");
  const ring = (pts: Pt[]) => line(pts) + "Z";
  const hi = opts.highlightNet;
  const out: string[] = [];
  const width = Math.round((w + 2 * MARGIN) * scale);
  const height = Math.round((h + 2 * MARGIN) * scale);
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${-MARGIN} ${-MARGIN} ${w + 2 * MARGIN} ${h + 2 * MARGIN}">`,
    `<title>${esc(spec.name)} (${side})</title>`,
  );
  const r = Math.max(0, Math.min(spec.corner ?? 0, w / 2, h / 2));
  out.push(`<rect x="0" y="0" width="${n2(w)}" height="${n2(h)}" rx="${n2(r)}" fill="${C.mask}" stroke="${C.edge}" stroke-width="0.15"/>`);

  // copper under the mask: pours, then tracks
  const pourPath = (net: string | undefined, other: boolean) =>
    b.pours
      .filter((p) => p.layer === layer && (net === undefined || (other ? p.net !== net : p.net === net)))
      .flatMap((p) => pourGroups(p.polys).flatMap((g) => g.map(ring)))
      .join("");
  const pours = hi ? pourPath(hi, true) : pourPath(undefined, false);
  // tracks a shade brighter than the pour so they read inside it
  if (pours) out.push(`<path d="${pours}" fill="${C.pour}" fill-rule="evenodd"/>`);
  if (hi) {
    const mine = pourPath(hi, false);
    if (mine) out.push(`<path d="${mine}" fill="${C.copperHi}" fill-opacity="0.55" fill-rule="evenodd"/>`);
  }
  const byWidth = new Map<string, string[]>();
  for (const t of b.tracks) {
    if (t.layer !== layer) continue;
    const key = `${t.net === hi ? C.copperHi : C.copper}|${n2(t.w)}`;
    byWidth.set(key, [...(byWidth.get(key) ?? []), line(t.pts)]);
  }
  for (const [key, ds] of byWidth) {
    const [col, sw] = key.split("|");
    out.push(`<path d="${ds.join("")}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  // tented vias: a copper ring under the mask with its hole
  for (const v of b.vias) out.push(`<circle cx="${X(v.x)}" cy="${Y(v.y)}" r="${n2(v.pad / 2)}" fill="${v.net === hi ? C.copperHi : C.copper}"/>`);

  // pads, tinned
  const pads = placedPads(spec);
  const shapeSvg = (s: Shape, fill: string) => {
    if (s.k === "cap") {
      if (s.ax === s.bx && s.ay === s.by) return `<circle cx="${X(s.ax)}" cy="${Y(s.ay)}" r="${n2(s.r)}" fill="${fill}"/>`;
      return `<path d="M${X(s.ax)} ${Y(s.ay)}L${X(s.bx)} ${Y(s.by)}" stroke="${fill}" stroke-width="${n2(2 * s.r)}" stroke-linecap="round"/>`;
    }
    const pts: Pt[] = [];
    for (let k = 0; k < s.p.length; k += 2) pts.push([s.p[k], s.p[k + 1]]);
    return `<path d="${ring(pts)}" fill="${fill}"/>`;
  };
  for (const p of pads) out.push(shapeSvg(padShape(p), hi && p.net === hi ? C.padHi : C.pad));

  // holes
  for (const p of pads) out.push(shapeSvg(holeShape(p), C.hole));
  for (const v of b.vias) out.push(`<circle cx="${X(v.x)}" cy="${Y(v.y)}" r="${n2(v.drill / 2)}" fill="${C.hole}"/>`);
  for (const hl of placedHoles(spec)) out.push(`<circle cx="${X(hl.x)}" cy="${Y(hl.y)}" r="${n2(hl.d / 2)}" fill="${C.bg}"/>`);

  // silkscreen
  const silk = boardSilk(spec)[layer];
  const sByW = new Map<string, string[]>();
  for (const l of silk.lines) {
    const k = n2(l.w);
    sByW.set(k, [...(sByW.get(k) ?? []), line(l.pts)]);
  }
  for (const [sw, ds] of sByW) out.push(`<path d="${ds.join("")}" fill="none" stroke="${C.silk}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`);
  for (const d of silk.dots) out.push(`<circle cx="${X(d.x)}" cy="${Y(d.y)}" r="${n2(d.d / 2)}" fill="${C.silk}"/>`);

  // one part picked out
  if (opts.highlightRef) {
    const part = spec.parts.find((p) => p.ref === opts.highlightRef);
    if (part) {
      let [x0, y0, x1, y1] = shapeBox(bodyShape(part));
      for (const p of pads)
        if (p.ref === part.ref) {
          const bb = shapeBox(padShape(p));
          x0 = Math.min(x0, bb[0]);
          y0 = Math.min(y0, bb[1]);
          x1 = Math.max(x1, bb[2]);
          y1 = Math.max(y1, bb[3]);
        }
      const m = 0.6;
      const left = side === "bottom" ? w - x1 - m : x0 - m;
      out.push(`<rect x="${n2(left)}" y="${Y(y1 + m)}" width="${n2(x1 - x0 + 2 * m)}" height="${n2(y1 - y0 + 2 * m)}" rx="0.6" fill="none" stroke="${C.focus}" stroke-width="0.3" stroke-dasharray="1 0.6"/>`);
    }
  }
  out.push("</svg>");
  return { svg: out.join(""), width, height };
}

const n2 = (v: number) => {
  const s = (Math.round(v * 100) / 100).toString();
  return s === "-0" ? "0" : s;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
