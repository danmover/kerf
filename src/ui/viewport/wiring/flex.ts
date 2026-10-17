// Draws a moving cable's flex link: a drag chain of black nylon links with the
// cables lying side by side inside it and a bracket at each end, or a service
// loop in black spiral wrap with a cable tie at each end. Redrawn whenever the
// moving end moves, from the same flexPath the planner checked.

import * as THREE from "three";
import type { V3 } from "../../../kernel/recipe";
import type { Frame, HarnessWire } from "../../../machine/harness/harness";
import { flexPath, type FlexLink, type TravelPlan } from "../../../machine/harness/travel";
import { MeshBuilder } from "./builder";

const NYLON = "#1d1f23";
const NYLON_EDGE = "#2b2e33";
const WRAP = "#17181b";

const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** One chain link, centred, x along the run, y across, z through its depth. */
function linkGeometry(pitch: number, w: number, h: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const f: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const t = 1.7;
  for (const s of [-1, 1]) {
    const y0 = s < 0 ? -w / 2 : w / 2 - t;
    const y1 = y0 + t;
    // side plate with a round lug at each end, where it pins to the next link
    b.box(f, -pitch / 2 + h * 0.3, pitch / 2 - h * 0.3, y0, y1, -h / 2, h / 2, NYLON);
    for (const x of [-pitch / 2 + h * 0.3, pitch / 2 - h * 0.3]) b.cyl(f, x, h * 0, y0, y1, h / 2 - 0.2, NYLON, 14, "y");
    // the pin boss
    b.cyl(f, -pitch / 2 + h * 0.3, 0, s < 0 ? y0 - 0.5 : y1, s < 0 ? y0 : y1 + 0.5, 1.8, NYLON_EDGE, 10, "y");
  }
  // crossbars over and under the cables
  b.box(f, -2.6, 2.6, -w / 2 + t, w / 2 - t, h / 2 - 1.6, h / 2, NYLON_EDGE);
  b.box(f, -2.6, 2.6, -w / 2 + t, w / 2 - t, -h / 2, -h / 2 + 1.6, NYLON_EDGE);
  return b.build();
}

/** A tube with a helical groove shaded into it, like spiral wrap. */
function wrapTube(pts: V3[], r: number, start: V3): THREE.BufferGeometry {
  const seg = 14;
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const base = new THREE.Color(WRAP);
  let n: V3 | null = null;
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i) s += Math.hypot(...sub(pts[i], pts[i - 1]));
    const t = norm(sub(pts[Math.min(pts.length - 1, i + 1)], pts[Math.max(0, i - 1)]));
    if (!n) n = add(start, t, -dot(start, t));
    n = norm(add(n, t, -dot(n, t)));
    const bn = cross(t, n);
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const d: V3 = [n[0] * Math.cos(a) + bn[0] * Math.sin(a), n[1] * Math.cos(a) + bn[1] * Math.sin(a), n[2] * Math.cos(a) + bn[2] * Math.sin(a)];
      // the wrap's edge winds round every 9 mm
      const groove = 0.5 + 0.5 * Math.cos(a - (s / 9) * Math.PI * 2);
      const k = 0.55 + 0.45 * Math.pow(groove, 0.35);
      const rr = r * (0.96 + 0.04 * k);
      pos.push(pts[i][0] + d[0] * rr, pts[i][1] + d[1] * rr, pts[i][2] + d[2] * rr);
      nor.push(...d);
      col.push(base.r * k, base.g * k, base.b * k);
    }
  }
  for (let i = 0; i < pts.length - 1; i++)
    for (let j = 0; j < seg; j++) {
      const a = i * (seg + 1) + j;
      const b = a + seg + 1;
      idx.push(a, b + 1, b, a, a + 1, b + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export class FlexDrawing {
  /** in the parent's frame where the design shows it; the overlay places it with the parent */
  readonly group = new THREE.Group();
  /** follows the child: the moving end's bracket or tie */
  readonly moving = new THREE.Group();
  /** what a pick can land on: cables inside a chain (by wire id) and the link itself */
  readonly targets: THREE.Object3D[] = [];
  private chain: THREE.InstancedMesh | null = null;
  private sleeve: THREE.Mesh | null = null;
  private cables = new Map<string, THREE.Mesh>();
  private links = 0;
  private key = "";
  readonly mats: THREE.MeshStandardMaterial[] = [];
  private plastic = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0 });

  constructor(
    readonly link: FlexLink,
    private plan: TravelPlan,
    private wires: HarnessWire[],
  ) {
    this.group.matrixAutoUpdate = false;
    this.moving.matrixAutoUpdate = false;
    this.mats.push(this.plastic);
    const c = link.chain;
    if (c) {
      this.links = Math.max(2, Math.round(link.L / c.pitch));
      const geo = linkGeometry(link.L / this.links, c.w, c.h);
      this.chain = new THREE.InstancedMesh(geo, this.plastic, this.links);
      this.chain.userData.link = link.id;
      this.chain.frustumCulled = false;
      this.group.add(this.chain);
      this.targets.push(this.chain);
      for (const w of wires) {
        const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0 });
        this.mats.push(mat);
        const m = new THREE.Mesh(new THREE.BufferGeometry(), mat);
        m.userData.wire = w.id;
        m.frustumCulled = false;
        this.cables.set(w.id, m);
        this.group.add(m);
        this.targets.push(m);
      }
      this.brackets();
    } else {
      this.sleeve = new THREE.Mesh(new THREE.BufferGeometry(), this.plastic);
      this.sleeve.userData.link = link.id;
      this.sleeve.frustumCulled = false;
      this.group.add(this.sleeve);
      this.targets.push(this.sleeve);
      this.ties();
    }
  }

  /** A mounting bracket clipped to each end link, and a printed strut from the moving one down to its carrier. */
  private brackets() {
    const l = this.link;
    const c = l.chain!;
    const block = (b: MeshBuilder, at: V3, out: V3): Frame => {
      // base and two cheeks round the cables as they leave the chain
      const x = norm(out);
      const z = norm(add(c.b, x, -dot(c.b, x)));
      const f: Frame = { o: at, x, y: cross(z, x), z };
      const w = c.w / 2 + 1.2;
      b.box(f, -1, 9, -w, w, -c.h / 2 - 0.5, -c.h / 2 + 1.2, NYLON_EDGE);
      b.box(f, -1, 9, -w, -w + 1.6, -c.h / 2, c.h / 2, NYLON_EDGE);
      b.box(f, -1, 9, w - 1.6, w, -c.h / 2, c.h / 2, NYLON_EDGE);
      return f;
    };
    const fixed = new MeshBuilder();
    block(fixed, l.F, l.outF);
    this.group.add(new THREE.Mesh(fixed.build(), this.plastic));
    const mv = new MeshBuilder();
    const f = block(mv, l.G0, l.outG);
    const top: V3 = add(add(f.o, f.x, 4), f.z, -c.h / 2 - 0.5);
    const d = sub(c.bracket, top);
    const reach = Math.hypot(...d);
    if (reach > 2) {
      const z = norm(d);
      const x = norm(Math.abs(dot(f.x, z)) < 0.95 ? add(f.x, z, -dot(f.x, z)) : add(c.v, z, -dot(c.v, z)));
      mv.box({ o: top, x, y: cross(z, x), z }, -1.5, 1.5, -c.w / 2 - 1.2, c.w / 2 + 1.2, 0, reach + 1, NYLON_EDGE);
    }
    this.moving.add(new THREE.Mesh(mv.build(), this.plastic));
  }

  /** A cable tie round the wrap at each end, on a stick-on mount. */
  private ties() {
    const l = this.link;
    const r = l.bundle / 2 + 0.8;
    for (const [o, t, group] of [
      [l.F, l.outF, this.group],
      [l.G0, l.outG, this.moving],
    ] as const) {
      const b = new MeshBuilder();
      const z = norm(t as V3);
      const x = norm(Math.abs(z[2]) < 0.9 ? cross(z, [0, 0, 1]) : cross(z, [1, 0, 0]));
      const f: Frame = { o: add(o as V3, z, -6), x, y: cross(z, x), z };
      b.cyl(f, 0, 0, -1.8, 1.8, r + 0.9, "#24262a", 16);
      b.box(f, r + 0.4, r + 3.2, -1.6, 1.6, -2.2, 2.2, "#24262a");
      group.add(new THREE.Mesh(b.build(), this.plastic));
    }
  }

  /** Redraw with the moving end at G (the parent's frame where the design shows it). */
  update(G: V3): boolean {
    const key = G.map((v) => v.toFixed(2)).join(",");
    if (key === this.key) return false;
    this.key = key;
    const l = this.link;
    const { pts } = flexPath(l, G, 2);
    // arc length along the line
    const s = [0];
    for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(...sub(pts[i], pts[i - 1])));
    const total = s[s.length - 1];
    const at = (d: number): V3 => {
      let i = 1;
      while (i < s.length - 1 && s[i] < d) i++;
      const f = (d - s[i - 1]) / Math.max(1e-9, s[i] - s[i - 1]);
      return add(pts[i - 1], sub(pts[i], pts[i - 1]), Math.min(1, Math.max(0, f)));
    };
    if (this.chain) {
      const c = l.chain!;
      const p = total / this.links;
      const m = new THREE.Matrix4();
      for (let i = 0; i < this.links; i++) {
        // each link is straight: it spans the chord between its two pins
        const a = at(i * p);
        const b = at((i + 1) * p);
        const x = norm(sub(b, a));
        const z = cross(x, c.v);
        m.makeBasis(new THREE.Vector3(...x), new THREE.Vector3(...c.v), new THREE.Vector3(...z));
        m.setPosition((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
        this.chain.setMatrixAt(i, m);
      }
      this.chain.instanceMatrix.needsUpdate = true;
      this.drawCables(pts);
    } else if (this.sleeve) {
      this.sleeve.geometry.dispose();
      this.sleeve.geometry = wrapTube(pts, l.bundle / 2 + 0.6, [0, 0, 1]);
    }
    return true;
  }

  /** The cables inside the chain, each in its slot, their wires twisted as outside it. */
  private drawCables(pts: V3[]) {
    const c = this.link.chain!;
    const slots = this.plan.slots[this.link.id] ?? {};
    for (const w of this.wires) {
      const mesh = this.cables.get(w.id)!;
      const [sx, sy] = slots[w.id] ?? [0, 0];
      const n = w.wires.length;
      const radius = n === 1 ? 0 : w.wires[0].d * [0, 0, 0.5, 0.58, 0.71, 0.85, 1, 1.15][Math.min(n, 7)];
      const b = new MeshBuilder();
      const lines: V3[][] = w.wires.map(() => []);
      const tans: V3[] = [];
      let s = 0;
      for (let i = 0; i < pts.length; i++) {
        if (i) s += Math.hypot(...sub(pts[i], pts[i - 1]));
        const t = norm(sub(pts[Math.min(pts.length - 1, i + 1)], pts[Math.max(0, i - 1)]));
        tans.push(t);
        const e2 = cross(t, c.v);
        const o = add(add(pts[i], c.v, sx), e2, sy);
        w.wires.forEach((_, k) => {
          const th = (k / n) * Math.PI * 2 + (n > 1 ? ((Math.PI * 2) / (n > 2 ? 70 : 45)) * s : 0);
          lines[k].push(add(add(o, c.v, radius * Math.cos(th)), e2, radius * Math.sin(th)));
        });
      }
      const span = pts.map(() => 0);
      w.wires.forEach((wi, k) => {
        const nrm = tans.map(() => c.v);
        const bin = tans.map((t) => cross(t, c.v));
        b.tube(lines[k], nrm, bin, wi.d / 2, wi.color, 6, span);
      });
      mesh.geometry.dispose();
      mesh.geometry = b.build();
    }
  }

  setLook(dim: (wire: string | null) => boolean, planes: THREE.Plane[] | null) {
    const allDim = this.link.wires.every((id) => dim(id));
    for (const m of this.mats) {
      const id = [...this.cables].find(([, mesh]) => mesh.material === m)?.[0] ?? null;
      const d = id ? dim(id) : allDim;
      m.transparent = d;
      m.opacity = d ? 0.16 : 1;
      m.depthWrite = !d;
      m.clippingPlanes = planes;
      m.needsUpdate = true;
    }
  }

  dispose() {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.moving.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    for (const m of this.mats) m.dispose();
  }
}
