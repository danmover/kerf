// Decals: lettering or a project image printed or stuck on a part's surface,
// decal: decal(text: "KERF", at: (0, 0, 20), dir: +Z, size: 8). The 3D view
// and renders draw them on the faces they cover. They are not part of the
// solid (exports, checks and drawings leave them out): for lettering in the
// material itself, use emboss() or engrave().

import type { DecalSpec } from "../core/model";
import { vdot, vlen, vnorm, vscale, vsub, type V3 } from "../kernel/recipe";
import { def } from "./builtins";
import { Obj, Vec, typeName, type CallCtx, type Fn, type Value } from "./values";

/** Lettering's average width over its height, to size a text decal before it is drawn. */
export const LETTER_W = 0.62;
/** Line spacing over letter height. */
export const LINE_H = 1.3;
/** The most decals a part takes, and the longest lettering. */
const MAX_DECALS = 24;
const MAX_TEXT = 400;
const IMAGE_ID = /^ast_[a-z0-9]{4,32}$/;
/** a CSS colour: #rgb, #rrggbb, #rrggbbaa or a name */
const COLOR = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|#[0-9a-f]{8}|[a-z]{3,20})$/i;

export class DecalV extends Obj {
  constructor(public spec: DecalSpec) {
    super(
      {
        at: new Vec(spec.at),
        dir: new Vec(spec.dir),
        width: spec.width,
        ...(spec.height !== undefined ? { height: spec.height } : {}),
        ...(spec.text !== undefined ? { text: spec.text } : {}),
      },
      "decal",
      "decal",
    );
  }
}

/** Up for a decal facing dir: Z when it faces sideways, else Y. */
export function defaultUp(dir: V3): V3 {
  return Math.abs(dir[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
}

function colour(a: { value(n: string): Value | undefined }, ctx: CallCtx, name: string, fallback?: string): string | undefined {
  const v = a.value(name);
  if (v === undefined || v === null || v === false) return fallback;
  if (typeof v !== "string" || !COLOR.test(v.trim())) ctx.error(`decal(): ${name}: should be a colour like "#ffffff" or "black"`);
  return v.trim();
}

const PARAMS = ["text", "image", "at", "dir", "up", "size", "width", "height", "depth", "color", "background", "bold", "clear"];

export const DECAL_FNS: Record<string, Fn> = Object.fromEntries([
  def(
    "decal",
    PARAMS,
    (a) => {
      const ctx = a.ctx;
      const text = a.value("text");
      const image = a.value("image");
      if (text !== undefined && typeof text !== "string") ctx.error(`decal(): text: is the lettering in quotes, like decal(text: "KERF", at: (0, 0, 20)), got ${typeName(text)}`);
      if (image !== undefined && (typeof image !== "string" || !IMAGE_ID.test(image)))
        ctx.error('decal(): image: is a picture added to the project, by its id, like image: "ast_k3j9x2"');
      if ((text === undefined) === (image === undefined)) ctx.error('decal() takes text: (lettering, like text: "KERF") or image: (a picture added to the project, like image: "ast_k3j9x2"), one of them');
      if (typeof text === "string" && !text.trim()) ctx.error("decal(): text: is empty");
      if (typeof text === "string" && text.length > MAX_TEXT) ctx.error(`decal(): text: is limited to ${MAX_TEXT} characters`);
      if (!a.has("at")) ctx.error("decal(): at: is where its middle sits on the part, in the part's own coordinates, like at: (0, 0, 20) on the top of a box 20 mm tall");
      const at = a.vec3("at");
      const dir = a.dir("dir", [0, 0, 1]);
      const up0 = a.has("up") ? a.dir("up") : defaultUp(dir);
      const across = vsub(up0, vscale(dir, vdot(up0, dir)));
      if (vlen(across) < 1e-6) ctx.error("decal(): up: is which way is up on the decal, so it should not point along dir:");
      const up = vnorm(across);
      if (a.has("size") && image !== undefined) ctx.error("decal(): size: is the letter height of a text decal; give an image its width: (and height: if it should be squashed into a box)");
      const lines = typeof text === "string" ? text.split("\n") : [];
      const longest = Math.max(1, ...lines.map((l) => l.length));
      let width: number;
      let height: number | undefined;
      if (typeof text === "string") {
        // the lettering fits a box: from its letter height, or the width and height it is given
        const size = a.has("size") ? a.positive("size") : undefined;
        if (size !== undefined && (a.has("width") || a.has("height"))) ctx.error("decal(): give a text decal its letter size:, or the width: and height: of the box its lettering fits in, not both");
        const w = a.has("width") ? a.positive("width") : undefined;
        const h = a.has("height") ? a.positive("height") : undefined;
        const letter = size ?? (h !== undefined ? h / (lines.length * LINE_H) : w !== undefined ? w / (longest * LETTER_W) : 8);
        width = w ?? letter * longest * LETTER_W + letter * 0.6;
        height = h ?? letter * lines.length * LINE_H;
      } else {
        width = a.positive("width", 40);
        height = a.has("height") ? a.positive("height") : undefined;
      }
      if (width > 10_000 || (height ?? 0) > 10_000) ctx.error("decal(): a decal is limited to 10 m across");
      const depth = a.has("depth") ? a.positive("depth") : Math.max(width, height ?? width) / 2;
      const spec: DecalSpec = {
        ...(typeof text === "string" ? { text } : {}),
        ...(typeof image === "string" ? { image } : {}),
        at,
        dir,
        up,
        width,
        ...(height !== undefined ? { height } : {}),
        depth,
        color: colour(a, ctx, "color", "#1b1d21")!,
      };
      const bg = colour(a, ctx, "background");
      if (bg) spec.background = bg;
      if (a.bool("bold")) spec.bold = true;
      const clear = colour(a, ctx, "clear");
      if (clear) {
        if (image === undefined) ctx.error("decal(): clear: leaves a colour of an image unprinted (a logo on white: clear: \"white\"); lettering has no background unless it is given one");
        spec.clear = clear;
      }
      return new DecalV(spec);
    },
    'decal(text: "KERF", at: (x, y, z), dir: +Z, size: 8) or decal(image: "ast_…", at:, dir:, width: 40) — lettering or a project picture printed on the part where it faces dir, in the part\'s own coordinates. up: turns it (default +Y facing up or down, else +Z), color: is the lettering colour, background: makes a sticker, bold: true, clear: "white" leaves an image\'s white unprinted, depth: how far it reaches (curved faces). Shown in the 3D view and renders, not in the solid: use engrave() or emboss() to cut or raise lettering',
  ),
]);

/** The decal: property of a part or component: one decal() or a list of them. */
export function decalsProp(v: Value | undefined, ctx: Pick<CallCtx, "error">): DecalSpec[] | undefined {
  if (v === undefined || v === null || v === false) return undefined;
  const list = Array.isArray(v) ? v : [v];
  if (list.length > MAX_DECALS) ctx.error(`decal: takes at most ${MAX_DECALS} decals`);
  return list.map((d, i) => {
    if (d instanceof DecalV) return d.spec;
    return ctx.error(`decal: ${list.length > 1 ? `item ${i + 1} ` : ""}should be decal(...), like decal: decal(text: "KERF", at: (0, 0, 20), dir: +Z), got ${typeName(d)}`);
  });
}
