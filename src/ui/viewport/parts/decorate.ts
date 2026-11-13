// Detail drawn over bought electronics so they look like the real thing,
// without changing their solids (so checks, exports and drawings are as
// before): a LiPo pack's printed shrink wrap and its balance lead with the
// white JST-XH plug tucked on top, an ESC's label band, a servo's sticker,
// the lettering moulded into XT plugs, and the ribbed lid of a MAXI fuse
// holder. Also the decorator that runs several decorators side by side.

import * as THREE from "three";
import type { EvalPart } from "../../../core/model";
import type { V3 } from "../../../kernel/recipe";
import { catalogPart } from "../../../machine/catalog";
import type { CatalogPart } from "../../../machine/types";
import type { Decorator, PartDecoration, PartSurface } from "../scene";
import { boardOrigin } from "../boards/decorate";
import { escBand, labelTexture, moulded, packSide, packTop, servoSticker, type LabelSpec, type PackText } from "./labels";

/** How far a label stands off its face, mm: enough not to flicker, too little to see. */
const LIFT = 0.06;

type Face = "+z" | "-y" | "+y";

interface Plan {
  key: string;
  build: (tex: (k: string, s: () => LabelSpec) => THREE.Texture) => THREE.Object3D;
  hides: string[];
}

const num = (v: unknown, def: number) => (typeof v === "number" && isFinite(v) ? v : def);

/** The words of a catalog name before its specs, as a brand and model ("CNHL Ministar 4S ..." → CNHL, Ministar). */
export function packText(c: CatalogPart): PackText {
  const s = c.specs;
  const words = c.name.split(/\s+/);
  const stop = words.findIndex((w) => /^\d+S$/i.test(w) || /^LiPo$/i.test(w) || /^\d/.test(w));
  const lead = stop > 0 ? words.slice(0, stop) : [];
  return {
    brand: lead[0] ?? "",
    model: lead.slice(1).join(" "),
    mah: num(s.capacity_mah, 0),
    volts: num(s.v_nom, 0),
    cells: num(s.cells, 1),
    c: num(s.c_rating, 0),
  };
}

/** A label plane w × h centred at (cx, cy, cz) on a box face, facing out of it, in the part's frame. */
function labelPlane(face: Face, cx: number, cy: number, cz: number, w: number, h: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  if (face === "-y") m.rotation.x = Math.PI / 2;
  if (face === "+y") m.rotation.set(Math.PI / 2, 0, Math.PI, "ZXY");
  m.position.set(cx, cy, cz);
  m.userData.shadow = false;
  return m;
}

function printMat(map: THREE.Texture, clear = false, look: Partial<THREE.MeshPhysicalMaterialParameters> = {}) {
  return new THREE.MeshPhysicalMaterial({
    map,
    roughness: 0.38,
    clearcoat: 0.55,
    clearcoatRoughness: 0.22,
    transparent: clear,
    depthWrite: !clear,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
    ...look,
  });
}

/** A wire through points, as a tube. */
function wire(points: V3[], r: number, mat: THREE.Material): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(
    points.map((p) => new THREE.Vector3(...p)),
    false,
    "centripetal",
  );
  return new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(24, points.length * 10), r, 8, false), mat);
}

/** A LiPo's balance lead: out of the tab end, folded back over the top, into a white JST-XH plug lying on the pack. */
function balanceLead(w: number, d: number, h: number, cells: number): THREE.Group {
  const g = new THREE.Group();
  const n = cells + 1;
  const r = 0.62;
  const pitchLead = 1.3;
  const pitchPlug = 2.5;
  const y0 = -d / 2 + 4 + (n * pitchLead) / 2;
  const plugW = (n - 1) * pitchPlug + 4.9;
  const plugL = 9.8;
  const plugT = 5.75;
  const xPlug = w / 2 - 22;
  const yPlug = Math.max(-d / 2 + plugW / 2 + 2, Math.min(d / 2 - plugW / 2 - 2, y0));
  const black = new THREE.MeshPhysicalMaterial({ color: "#17181a", roughness: 0.55, sheen: 0.3, sheenRoughness: 0.6 });
  const red = new THREE.MeshPhysicalMaterial({ color: "#c4222c", roughness: 0.5, sheen: 0.3, sheenRoughness: 0.6 });
  for (let i = 0; i < n; i++) {
    const yl = y0 + (i - (n - 1) / 2) * pitchLead;
    const yp = yPlug + (i - (n - 1) / 2) * pitchPlug;
    const pts: V3[] = [
      [w / 2 - 0.6, yl, h * 0.72],
      [w / 2 + 3.5, yl, h * 0.74],
      [w / 2 + 6.5, yl, h * 0.9 + 1],
      [w / 2 + 4.5, yl, h + 1.6],
      [w / 2 - 2, (yl + yp) / 2, h + r + 0.15],
      [xPlug + plugL / 2 + 3, yp, h + r + 0.15 + (plugT / 2 - r) * 0.7],
      [xPlug + plugL / 2 - 0.5, yp, h + plugT / 2],
    ];
    g.add(wire(pts, r, i === 0 ? black : red));
  }
  // the housing, lying flat with its latch up and its open (socket) end toward -X
  const nylon = new THREE.MeshPhysicalMaterial({ color: "#efece2", roughness: 0.52, sheen: 0.2, sheenRoughness: 0.5 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(plugL, plugW, plugT), nylon);
  body.position.set(xPlug, yPlug, h + plugT / 2 + 0.05);
  g.add(body);
  const latch = new THREE.Mesh(new THREE.BoxGeometry(plugL * 0.45, plugW * 0.5, 0.7), nylon);
  latch.position.set(xPlug - plugL * 0.1, yPlug, h + plugT + 0.35);
  g.add(latch);
  // the contact windows on the open end
  const dark = new THREE.MeshStandardMaterial({ color: "#3b3a36", roughness: 0.8 });
  for (let i = 0; i < n; i++) {
    const hole = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.3, 1.3), dark);
    hole.position.set(xPlug - plugL / 2 - 0.05, yPlug + (i - (n - 1) / 2) * pitchPlug, h + plugT / 2);
    g.add(hole);
  }
  return g;
}

/** Ribs moulded into a lid's sides, for grip. */
function ribs(len: number, d: number, z0: number, z1: number, color: string): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshPhysicalMaterial({ color, roughness: 0.6 });
  const n = Math.max(3, Math.floor(len / 3.2));
  for (const side of [-1, 1])
    for (let i = 0; i < n; i++) {
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.45, (z1 - z0) * 0.7), mat);
      rib.position.set(-len / 2 + (len * (i + 0.5)) / n, side * (d / 2 + 0.2), (z0 + z1) / 2);
      g.add(rib);
    }
  return g;
}

function planFor(p: EvalPart, c: CatalogPart): Plan | null {
  const g = c.geom;
  const d = g.dims ?? {};
  if (g.g === "box" && g.style) {
    const w = num(d.w, 50);
    const dd = num(d.d, 30);
    const h = num(d.h, 20);
    const r = Math.min(num(d.r, 1), Math.min(w, dd) / 2 - 0.1);
    const at = boardOrigin(p.recipe, w, dd);
    if (!at || at.some((v) => Math.abs(v) > 1e-6)) return null;
    switch (g.style) {
      case "lipo": {
        const t = packText(c);
        const accent = g.color2 ?? "#d4382c";
        const k = `lipo:${c.id}`;
        return {
          key: k,
          hides: [`${p.id}.wrap`, `${p.id}.foil`],
          build: (tex) => {
            const o = new THREE.Group();
            const topW = w - 2.6;
            const topD = dd - 1.6;
            o.add(labelPlane("+z", -0.5, 0, h + LIFT, topW, topD, printMat(tex(`${k}:top`, () => packTop(topW, topD, accent, t)))));
            const sideW = w - 2 * r - 1.6;
            const sideH = h - 1.2;
            const side = printMat(tex(`${k}:side`, () => packSide(sideW, sideH, accent, t)));
            o.add(labelPlane("-y", -0.8, -dd / 2 - LIFT, h / 2, sideW, sideH, side));
            o.add(labelPlane("+y", -0.8, dd / 2 + LIFT, h / 2, sideW, sideH, side));
            o.add(balanceLead(w, dd, h, t.cells));
            return o;
          },
        };
      }
      case "esc": {
        const fin = Math.min(1.6, h * 0.15);
        const bodyH = h - fin - 0.6;
        const band = Math.min(num(d.band, bodyH * 0.8), bodyH - 1);
        const bw = w * 0.7 - 1;
        const bh = band - 0.8;
        const words = c.name.replace(/\(.*$/, "").replace(/\bESC\b/i, "").trim().split(/\s+/);
        const name = words.length > 2 ? words.slice(1).join(" ") : words.join(" ");
        const sp = c.specs;
        const sub = [sp.cells_max ? `${sp.cells_min ?? 2}-${sp.cells_max}S LiPo` : "", sp.bec_v ? `BEC ${sp.bec_v}V${sp.bec_a ? `/${sp.bec_a}A` : ""}` : "", "BRUSHLESS ESC"].filter(Boolean).join("  ·  ");
        const color = g.color2 ?? "#2f6ad8";
        const k = `esc:${c.id}`;
        return {
          key: k,
          hides: [],
          build: (tex) => {
            const o = new THREE.Group();
            const m = printMat(tex(k, () => escBand(bw, bh, color, name, sub)), false, { roughness: 0.3, clearcoat: 0.8 });
            o.add(labelPlane("-y", 0, -(dd + 0.3) / 2 - LIFT, bodyH / 2, bw, bh, m));
            o.add(labelPlane("+y", 0, (dd + 0.3) / 2 + LIFT, bodyH / 2, bw, bh, m));
            return o;
          },
        };
      }
      case "xt": {
        const hm = h * 0.48;
        const label = (/XT\d+/i.exec(c.name)?.[0] ?? "XT").toUpperCase();
        const k = `xt:${label}`;
        return {
          key: `${k}:${w}x${dd}x${h}`,
          hides: [],
          build: (tex) => {
            const o = new THREE.Group();
            const m = printMat(tex(k, () => moulded(12, 5, [label], "#a57a0c")), true, { roughness: 0.55, clearcoat: 0 });
            const lw = Math.min(w - 2, 12);
            const lh = Math.min(h - hm - 1.5, 5);
            o.add(labelPlane("-y", 0, -dd / 2 - LIFT, (h - hm) / 2, lw, lh, m));
            o.add(labelPlane("+y", 0, dd / 2 + LIFT, (h - hm) / 2, lw, lh, m));
            o.add(labelPlane("-y", 0, -(dd - 0.8) / 2 - LIFT, h - hm / 2, lw, lh, m));
            o.add(labelPlane("+y", 0, (dd - 0.8) / 2 + LIFT, h - hm / 2, lw, lh, m));
            return o;
          },
        };
      }
      case "fuse_maxi": {
        const boot = Math.min(5, w * 0.12);
        const L = w - 2 * boot;
        const hb = h * 0.56;
        const amps = num(c.specs.rating_a, 0);
        const k = `fuse:${amps}`;
        return {
          key: `${k}:${w}x${dd}x${h}`,
          hides: [],
          build: (tex) => {
            const o = new THREE.Group();
            const m = printMat(tex(k, () => moulded(20, 9, ["MAXI", amps ? `${amps}A MAX` : "FUSE"], "#4a505a")), true, { roughness: 0.6, clearcoat: 0 });
            o.add(labelPlane("+z", 0, 0, h + LIFT, Math.min(L * 0.62, 22), Math.min(dd * 0.6, 10), m));
            o.add(ribs(L * 0.7, dd, hb + 1, h - 1.5, "#30353d"));
            return o;
          },
        };
      }
    }
    return null;
  }
  if (g.g === "servo") {
    const w = num(d.w, 40.7);
    const dd = num(d.d, 19.7);
    const h = num(d.h, 37);
    const fz = num(d.flange_z, 10);
    const ft = num(d.flange_t, 2.5);
    const sx = num(d.shaft_x, 10);
    const at = boardOrigin(p.recipe, w, dd);
    if (!at || Math.abs(at[0] + sx) > 1e-6 || Math.abs(at[2] + h) > 1e-6) return null;
    const z0 = -h + 1.2;
    const z1 = -fz - ft - 0.8;
    if (z1 - z0 < 4) return null;
    const sw = w - 2.4;
    const sh = z1 - z0;
    const model = c.name.split(/\s+/)[0];
    const sub = c.name.replace(/\(.*$/, "").split(/\s+/).slice(1).join(" ");
    const k = `servo:${c.id}`;
    return {
      key: k,
      hides: [],
      build: (tex) => {
        const o = new THREE.Group();
        const m = printMat(tex(k, () => servoSticker(sw, sh, model, sub)), false, { roughness: 0.45, clearcoat: 0.3 });
        o.add(labelPlane("-y", -sx, -dd / 2 - LIFT, (z0 + z1) / 2, sw, sh, m));
        o.add(labelPlane("+y", -sx, dd / 2 + LIFT, (z0 + z1) / 2, sw, sh, m));
        return o;
      },
    };
  }
  return null;
}

/** Labels, leads and moulded detail on bought electronics. Textures are kept per kind of part; meshes and materials per instance. */
export class PartDetailDecorator implements Decorator {
  private textures = new Map<string, THREE.Texture>();

  private plan(p: EvalPart): Plan | null {
    // the main solid of a bought part (a component's extra solids carry a suffix after a dot)
    if (p.imported || p.kind !== "component" || p.id.includes(".")) return null;
    const id = p.bom?.catalogId;
    const c = id ? catalogPart(id) : undefined;
    if (!c) return null;
    try {
      return planFor(p, c);
    } catch {
      return null;
    }
  }

  key(p: EvalPart): string | null {
    return this.plan(p)?.key ?? null;
  }

  make(p: EvalPart): PartDecoration | null {
    const pl = this.plan(p);
    if (!pl || typeof document === "undefined") return null;
    const object = pl.build((k, spec) => {
      let t = this.textures.get(k);
      if (!t) {
        t = labelTexture(spec());
        this.textures.set(k, t);
      }
      return t;
    });
    let done = false;
    return {
      object,
      hides: pl.hides,
      dispose: () => {
        if (done) return;
        done = true;
        object.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          m.geometry.dispose();
          for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose();
        });
      },
    };
  }

  dispose() {
    for (const t of this.textures.values()) t.dispose();
    this.textures.clear();
  }
}

/** Several decorators as one: each part takes the first decoration offered. */
export class Decorators implements Decorator {
  constructor(private list: Decorator[]) {}

  key(p: EvalPart, s?: PartSurface): string | null {
    const keys: string[] = [];
    for (let i = 0; i < this.list.length; i++) {
      const k = this.list[i].key(p, s);
      if (k !== null) keys.push(`${i}|${k}`);
    }
    return keys.length ? keys.join("||") : null;
  }

  /** Every decorator's decoration for the part together (a board's detail and the decals on it), once all are ready. */
  make(p: EvalPart, s?: PartSurface): PartDecoration | null {
    const made: PartDecoration[] = [];
    for (const d of this.list) {
      if (d.key(p, s) === null) continue;
      const m = d.make(p, s);
      if (!m) {
        for (const x of made) x.dispose();
        return null;
      }
      made.push(m);
    }
    if (made.length <= 1) return made[0] ?? null;
    const object = new THREE.Group();
    for (const m of made) object.add(m.object);
    return { object, hides: made.flatMap((m) => m.hides ?? []), dispose: () => made.forEach((m) => m.dispose()) };
  }
}
