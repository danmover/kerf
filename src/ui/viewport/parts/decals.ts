// Decals (a part's decal:) drawn in the 3D view and renders: lettering or a
// project picture laid on the faces it covers, as a thin mesh of its own just
// off the part's surface. A picture loads from the project's files; until it
// has, its decal waits while the others show.

import * as THREE from "three";
import type { DecalSpec, EvalPart } from "../../../core/model";
import { decalBox, projectDecal } from "../../../core/decal";
import { LINE_H } from "../../../lang/decals";
import { getAsset, onAssetAdded } from "../../../persist/assets";
import type { Decorator, PartDecoration, PartSurface } from "../scene";
import { fitText, font } from "./labels";

/** How far a decal stands off the surface, mm: enough not to flicker, too little to see. */
const LIFT = 0.04;
/** Texture resolution: pixels per mm, and the most on a side. */
const PPM = 24;
const MAX_PX = 2048;

type Picture = { status: "loading" } | { status: "missing" } | { status: "ready"; img: HTMLCanvasElement; aspect: number };

export class DecalDecorator implements Decorator {
  private pictures = new Map<string, Picture>();
  private unsub: () => void;

  /** `ready` runs (later, never inside a scene call) when a picture has loaded. */
  constructor(
    private projectId: () => string | undefined,
    private ready: () => void,
  ) {
    // a picture added to the project after the decal that names it
    this.unsub = onAssetAdded((pid) => {
      let any = false;
      for (const [k, p] of this.pictures) {
        if (k.startsWith(`${pid}:`) && p.status === "missing") {
          this.pictures.delete(k);
          any = true;
        }
      }
      if (any) setTimeout(this.ready, 0);
    });
  }

  dispose() {
    this.unsub();
    this.pictures.clear();
  }

  private picture(id: string, clear?: string): Picture {
    const pid = this.projectId();
    if (!pid || typeof document === "undefined") return { status: "missing" };
    const k = `${pid}:${id}:${clear ?? ""}`;
    let p = this.pictures.get(k);
    if (!p) {
      p = { status: "loading" };
      this.pictures.set(k, p);
      const done = (r: Picture) => {
        this.pictures.set(k, r);
        setTimeout(this.ready, 0);
      };
      loadPicture(pid, id, clear).then(done, () => done({ status: "missing" }));
    }
    return p;
  }

  key(p: EvalPart, s?: PartSurface): string | null {
    if (!p.decals?.length || !s) return null;
    const pics = p.decals.map((d) => (d.image ? this.picture(d.image, d.clear).status[0] : "t")).join("");
    return `${s.key}|${pics}|${JSON.stringify(p.decals)}`;
  }

  make(p: EvalPart, s?: PartSurface): PartDecoration | null {
    if (!p.decals?.length || !s || typeof document === "undefined") return null;
    const pos = s.geometry.getAttribute("position");
    if (!pos) return null;
    const mesh = { position: pos.array, normal: s.geometry.getAttribute("normal")?.array ?? null, index: s.geometry.index?.array ?? null };
    const group = new THREE.Group();
    const owned: { dispose(): void }[] = [];
    for (const d of p.decals) {
      let tex: THREE.Texture;
      let height = d.height;
      if (d.text !== undefined) {
        height ??= d.width / 4;
        tex = textTexture(d, height);
      } else {
        const pic = d.image ? this.picture(d.image, d.clear) : null;
        if (pic?.status !== "ready") continue;
        height ??= d.width / pic.aspect;
        tex = pictureTexture(pic.img, d.width, height);
      }
      const m = projectDecal(mesh, decalBox(d, height), LIFT);
      if (!m.position.length) {
        tex.dispose();
        continue;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(m.position, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(m.normal, 3));
      g.setAttribute("uv", new THREE.BufferAttribute(m.uv, 2));
      g.computeBoundingSphere();
      const mat = new THREE.MeshPhysicalMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        alphaTest: 0.02,
        roughness: d.background ? 0.35 : 0.5,
        metalness: 0,
        clearcoat: d.background ? 0.4 : 0,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
      });
      const decal = new THREE.Mesh(g, mat);
      decal.userData.shadow = false;
      decal.receiveShadow = true;
      decal.renderOrder = 2;
      group.add(decal);
      owned.push(g, mat, tex);
    }
    return { object: group, dispose: () => owned.forEach((o) => o.dispose()) };
  }
}

function canvasFor(w: number, h: number): { c: HTMLCanvasElement; W: number; H: number } {
  const ppm = Math.min(PPM, MAX_PX / Math.max(w, h));
  const W = Math.max(16, Math.round(w * ppm));
  const H = Math.max(16, Math.round(h * ppm));
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  return { c, W, H };
}

function texture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Lettering centred in the decal's box, each line as tall as the box allows and squeezed to its width. */
function textTexture(d: DecalSpec, height: number): THREE.CanvasTexture {
  const { c, W, H } = canvasFor(d.width, height);
  const g = c.getContext("2d")!;
  if (d.background) {
    g.fillStyle = d.background;
    g.beginPath();
    g.roundRect(0, 0, W, H, Math.min(W, H) * 0.14);
    g.fill();
  }
  const lines = (d.text ?? "").split("\n");
  const lh = H / lines.length;
  const px = lh / LINE_H;
  g.font = font(d.bold ? 700 : 500, px);
  g.fillStyle = d.color;
  g.textAlign = "center";
  g.textBaseline = "middle";
  const pad = d.background ? px * 0.45 : px * 0.1;
  lines.forEach((l, i) => fitText(g, l, W / 2, lh * (i + 0.5), Math.max(1, W - 2 * pad)));
  return texture(c);
}

/** A picture fitted inside the decal's box, keeping its shape. */
function pictureTexture(img: HTMLCanvasElement, w: number, h: number): THREE.CanvasTexture {
  const { c, W, H } = canvasFor(w, h);
  const g = c.getContext("2d")!;
  const k = Math.min(W / img.width, H / img.height);
  const dw = img.width * k;
  const dh = img.height * k;
  g.imageSmoothingQuality = "high";
  g.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  return texture(c);
}

async function loadPicture(pid: string, id: string, clear?: string): Promise<Picture> {
  const a = await getAsset(pid, id);
  if (!a || a.kind !== "image") return { status: "missing" };
  const bmp = await createImageBitmap(a.data);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  const g = c.getContext("2d", { willReadFrequently: !!clear })!;
  g.drawImage(bmp, 0, 0);
  bmp.close();
  if (clear) knockOut(g, c.width, c.height, cssRgb(clear));
  return { status: "ready", img: c, aspect: c.width / Math.max(1, c.height) };
}

/** Leave a colour unprinted: see-through where a pixel is that colour, fading over the soft edge a JPEG gives it. */
export function knockOut(g: CanvasRenderingContext2D, W: number, H: number, rgb: [number, number, number]) {
  const im = g.getImageData(0, 0, W, H);
  const px = im.data;
  for (let i = 0; i < px.length; i += 4) {
    const d = Math.max(Math.abs(px[i] - rgb[0]), Math.abs(px[i + 1] - rgb[1]), Math.abs(px[i + 2] - rgb[2]));
    const keep = d <= 24 ? 0 : d >= 72 ? 1 : (d - 24) / 48;
    px[i + 3] = Math.round(px[i + 3] * keep);
  }
  g.putImageData(im, 0, 0);
}

function cssRgb(colour: string): [number, number, number] {
  const k = document.createElement("canvas");
  k.width = k.height = 1;
  const g = k.getContext("2d", { willReadFrequently: true })!;
  g.fillStyle = "#000000";
  g.fillStyle = colour;
  g.fillRect(0, 0, 1, 1);
  const d = g.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}
