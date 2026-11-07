// PMI on the 3D model (model-based definition): each part's drawing
// dimensions, fits, datums and feature control frames drawn where they
// belong on the solid, in thin lines with labels that keep their size on
// screen and stay on top of the model, the way MBD viewers show them.

import * as THREE from "three";
import type { Theme } from "../../app/theme";
import type { V3 } from "../../kernel/recipe";
import { fcfText, type Fcf, type GdtKind } from "../../drawing/gdt";
import type { PartPmi } from "../../drawing/pmi";
import type { SceneOverlay } from "./scene";

const LOOK = {
  dark: { line: 0x7cc4ff, text: "#bfe2ff", frame: "#ffd27a", datum: "#ffd27a", pill: "rgba(10, 13, 19, 0.86)" },
  light: { line: 0x1f5fd1, text: "#173f8f", frame: "#9a5b00", datum: "#9a5b00", pill: "rgba(255, 255, 255, 0.92)" },
};

const SYMBOL: Record<GdtKind, string> = {
  position: "⌖",
  flatness: "⏥",
  perpendicularity: "⟂",
  parallelism: "∥",
  runout: "↗",
  coaxiality: "◎",
  profile: "⌓",
};

export interface PmiShow {
  /** dimensions, fits and tolerances */
  dims: boolean;
  /** datums and geometric tolerances */
  gdt: boolean;
}

const v3 = (p: V3) => new THREE.Vector3(p[0], p[1], p[2]);

export class PmiOverlay implements SceneOverlay {
  readonly object = new THREE.Group();
  readonly replaces = new Set<string>();
  private disposables: { dispose(): void }[] = [];
  private look: (typeof LOOK)["dark"];

  constructor(pmi: PartPmi[], theme: Theme, show: PmiShow) {
    this.look = LOOK[theme];
    const segs: number[] = [];
    const seg = (a: THREE.Vector3, b: THREE.Vector3) => segs.push(a.x, a.y, a.z, b.x, b.y, b.z);
    for (const p of pmi) {
      const head = Math.max(1.2, p.step * 0.32);
      for (const d of p.dims) {
        const framed = d.frames.length > 0 || !!d.datum;
        if (!show.dims && !(show.gdt && framed)) continue;
        for (const [a, b] of d.lines) seg(v3(a), v3(b));
        // open arrowheads in the dimension's plane
        const n = new THREE.Vector3().crossVectors(v3(d.u), v3(d.v)).normalize();
        for (const ar of d.arrows) {
          const at = v3(ar.at);
          const dir = v3(ar.dir).normalize();
          const side = new THREE.Vector3().crossVectors(n, dir).normalize().multiplyScalar(head * 0.32);
          const back = at.clone().addScaledVector(dir, -head);
          seg(at, back.clone().add(side));
          seg(at, back.clone().sub(side));
        }
        const frames = show.gdt ? d.frames : [];
        const lines = show.dims ? [d.text] : [];
        if (show.gdt && d.datum) lines.push(`datum ${d.datum}`);
        if (lines.length || frames.length) this.label(lines, frames, v3(d.textAt), undefined, d.side);
      }
      if (!show.gdt) continue;
      for (const dt of p.datums) {
        // a short leader off the face to the boxed letter, with a filled triangle on the face
        const at = v3(dt.p);
        const tip = v3(dt.textAt);
        seg(at, tip);
        this.triangle(at, v3(dt.n), head);
        this.label([], dt.frame ? [dt.frame] : [], tip, dt.letter);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(segs, 3));
    const mat = new THREE.LineBasicMaterial({ color: this.look.line, depthTest: false, transparent: true, opacity: 0.95 });
    const lines = new THREE.LineSegments(geo, mat);
    lines.renderOrder = 28;
    this.object.add(lines);
    this.disposables.push(geo, mat);
  }

  /** a datum feature triangle standing on the face */
  private triangle(at: THREE.Vector3, n: THREE.Vector3, size: number) {
    const nn = n.clone().normalize();
    const side = new THREE.Vector3().crossVectors(nn, Math.abs(nn.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)).normalize().multiplyScalar(size * 0.6);
    const top = at.clone().addScaledVector(nn, size);
    const geo = new THREE.BufferGeometry().setFromPoints([at.clone().add(side), at.clone().sub(side), top]);
    const mat = new THREE.MeshBasicMaterial({ color: this.look.line, depthTest: false, side: THREE.DoubleSide, transparent: true });
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = 28;
    this.object.add(m);
    this.disposables.push(geo, mat);
  }

  /** text lines, then feature control frames as rows of boxed cells, and a boxed datum letter; one sprite that keeps its size on screen */
  private label(lines: string[], frames: Fcf[], at: THREE.Vector3, datum?: string, side: "left" | "right" = "right") {
    const dpr = 2;
    const px = 12 * dpr;
    const font = `500 ${px}px 'IBM Plex Mono', ui-monospace, monospace`;
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d")!;
    ctx.font = font;
    const pad = 6 * dpr;
    const rowH = 20 * dpr;
    const cellsOf = (f: Fcf) => [SYMBOL[f.kind], `${f.dia ? "Ø" : ""}${f.tol}${f.mmc ? " Ⓜ" : ""}`, ...f.datums];
    const cellW = (t: string) => Math.ceil(ctx.measureText(t).width) + 10 * dpr;
    const widths = [
      ...lines.map((l) => Math.ceil(ctx.measureText(l).width)),
      ...frames.map((f) => cellsOf(f).reduce((w, t) => w + cellW(t), 0)),
      datum ? cellW(datum) : 0,
    ];
    const w = Math.max(...widths, 1) + pad * 2;
    const h = (lines.length + frames.length + (datum ? 1 : 0)) * rowH + pad * 2;
    c.width = w;
    c.height = h;
    ctx.font = font;
    ctx.fillStyle = this.look.pill;
    ctx.beginPath();
    ctx.roundRect(0.5, 0.5, w - 1, h - 1, 5 * dpr);
    ctx.fill();
    ctx.textBaseline = "middle";
    let y = pad;
    ctx.fillStyle = this.look.text;
    for (const l of lines) {
      ctx.fillText(l, pad, y + rowH / 2 + dpr);
      y += rowH;
    }
    ctx.strokeStyle = this.look.frame;
    ctx.lineWidth = dpr;
    const boxed = (cells: string[], colour: string) => {
      let x = pad;
      for (const t of cells) {
        const cw = cellW(t);
        ctx.strokeRect(x + 0.5, y + 2 * dpr + 0.5, cw, rowH - 4 * dpr);
        ctx.fillStyle = colour;
        ctx.fillText(t, x + 5 * dpr, y + rowH / 2 + dpr);
        x += cw;
      }
      y += rowH;
    };
    for (const f of frames) boxed(cellsOf(f), this.look.frame);
    if (datum) boxed([datum], this.look.datum);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false }));
    const hgt = 0.026 * (h / (rowH + pad * 2));
    sp.scale.set((hgt * w) / h, hgt, 1);
    sp.center.set(side === "left" ? 1.04 : -0.04, 0.5);
    sp.position.copy(at);
    sp.renderOrder = 30;
    sp.userData.text = [...lines, ...frames.map(fcfText), datum ?? ""].join(" ").trim();
    this.object.add(sp);
    this.disposables.push(tex, sp.material);
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.object.clear();
  }
}
