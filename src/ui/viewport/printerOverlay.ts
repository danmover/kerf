// Draws a printer run in the viewport: the design's own parts moving with the
// axes (the bed with Y, the toolhead with X, the gantry with Z) and the print
// growing on the bed move by move, as it really came out: layer shifts move
// it, under-extruded lines are thinner and redder. Which parts move with which
// axis comes from re-evaluating the design with its show_x, show_y and show_z
// parameters nudged (machine/pose), so any printer design that poses itself
// from those parameters plays back.

import * as THREE from "three";
import type { EvalPart, Model } from "../../core/model";
import type { MeshEntry } from "../../core/engine";
import { xformMatrix } from "../../kernel/recipe";
import { machinePose, POSE_PARAMS } from "../../machine/pose";
import type { PrintTrace } from "../../sim/printer/run";
import type { SceneOverlay } from "./scene";

export { POSE_PARAMS };

/** How each part moves per mm of each axis, from the design itself. */
export interface PrinterPose {
  /** the axis values the design is shown at */
  s0: [number, number, number];
  /** per part id: its displacement per mm of X, Y and Z */
  moves: Map<string, [THREE.Vector3, THREE.Vector3, THREE.Vector3]>;
  /** the nozzle tip at the shown pose, and the hotend and bed parts */
  nozzle?: THREE.Vector3;
  hotId?: string;
  bedId?: string;
}

const ZERO = () => new THREE.Vector3();

/** Re-evaluate the design with each pose parameter nudged and see what moves (machine/pose). */
export function posePrinter(source: string, model: Model): PrinterPose {
  const p = machinePose(source, model);
  const v = (a: number[]) => new THREE.Vector3(...a);
  const moves = new Map([...p.moves].map(([id, mv]) => [id, mv.map(v) as [THREE.Vector3, THREE.Vector3, THREE.Vector3]]));
  return { s0: p.s0, moves, nozzle: p.nozzle && v(p.nozzle), hotId: p.hotId, bedId: p.bedId };
}

export class PrinterOverlay implements SceneOverlay {
  readonly object = new THREE.Group();
  readonly replaces: Set<string>;
  private movers: { group: THREE.Group; mv: [THREE.Vector3, THREE.Vector3, THREE.Vector3] }[] = [];
  private printGroup = new THREE.Group();
  private printGeo: THREE.BufferGeometry | null = null;
  /** end time of each drawn segment, and how many indices draw up to it */
  private segT: Float32Array = new Float32Array(0);
  private disposables: { dispose(): void }[] = [];
  private modelBox = new THREE.Box3();
  private t = 0;
  private nozzleNow = new THREE.Vector3();
  private bedMv: [THREE.Vector3, THREE.Vector3, THREE.Vector3] = [ZERO(), ZERO(), ZERO()];
  /** the toolpath's own extent, at the bed's shown position */
  private printBox = new THREE.Box3();

  constructor(
    parts: EvalPart[],
    meshes: Map<string, MeshEntry>,
    private pose: PrinterPose,
    private trace: PrintTrace,
  ) {
    this.replaces = new Set(parts.map((p) => p.id));
    this.buildParts(parts, meshes);
    this.buildPrint();
    this.setTime(0);
  }

  private keep<T extends { dispose(): void }>(x: T): T {
    this.disposables.push(x);
    return x;
  }

  private buildParts(parts: EvalPart[], meshes: Map<string, MeshEntry>) {
    const geos = new Map<string, THREE.BufferGeometry>();
    const mats = new Map<string, THREE.Material>();
    const still = new THREE.Group();
    this.object.add(still);
    for (const p of parts) {
      const entry = meshes.get(p.hash);
      const data = entry?.final ?? entry?.preview;
      if (p.hidden || !data || !entry) continue;
      let geo = geos.get(p.hash);
      if (!geo) {
        geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
        geo.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
        geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
        geos.set(p.hash, this.keep(geo));
      }
      let mat = mats.get(p.color);
      if (!mat) {
        mat = this.keep(new THREE.MeshStandardMaterial({ color: new THREE.Color(p.color), roughness: p.kind === "component" ? 0.45 : 0.62, metalness: p.kind === "component" ? 0.35 : 0 }));
        mats.set(p.color, mat);
      }
      const mesh = new THREE.Mesh(geo, mat);
      const m = new THREE.Matrix4().fromArray(xformMatrix(p.xf));
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(m);
      this.modelBox.union(new THREE.Box3(new THREE.Vector3(...entry.bbox[0]), new THREE.Vector3(...entry.bbox[1])).applyMatrix4(m));
      const mv = this.pose.moves.get(p.id);
      if (!mv) {
        still.add(mesh);
        continue;
      }
      const g = new THREE.Group();
      g.add(mesh);
      this.object.add(g);
      this.movers.push({ group: g, mv });
      if (p.id === this.pose.bedId) {
        this.bedMv = mv;
        g.add(this.printGroup);
      }
    }
    if (!this.printGroup.parent) this.object.add(this.printGroup);
    if (this.modelBox.isEmpty()) this.modelBox.set(new THREE.Vector3(-150, -150, 0), new THREE.Vector3(150, 150, 300));
  }

  /** The bed-frame position of a print point (x, y, z in printer coordinates) at the shown pose. */
  private toDesign(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const s0 = this.pose.s0;
    const p = [x - s0[0], y - s0[1], z - s0[2]];
    out.copy(this.pose.nozzle ?? new THREE.Vector3(0, 0, 0));
    // where the nozzle was relative to the bed when it laid this point: its own move less the bed's
    const hot = this.nozzleMv;
    for (let i = 0; i < 3; i++) out.addScaledVector(hot[i], p[i]).addScaledVector(this.bedMv[i], -p[i]);
    return out;
  }

  /** how the nozzle moves per mm of each axis; X right, Y back, Z up when the design does not pose itself */
  private get nozzleMv(): [THREE.Vector3, THREE.Vector3, THREE.Vector3] {
    const mv = this.pose.hotId ? this.pose.moves.get(this.pose.hotId) : undefined;
    if (mv) return mv;
    return this.pose.moves.size ? [ZERO(), ZERO(), ZERO()] : [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  }

  /** Every extruding move as a flat bead: a top and two sides, width from the plastic it laid. */
  private buildPrint() {
    const tr = this.trace;
    const h = Math.max(0.05, tr.layer);
    const n = tr.t.length;
    const nominal = median(tr.a.filter((a) => a > 0));
    const MAX = 160_000;
    let segs = 0;
    for (let i = 1; i < n; i++) if (tr.a[i] > 0) segs++;
    const keep = Math.min(segs, MAX);
    const pos = new Float32Array(keep * 8 * 3);
    const col = new Float32Array(keep * 8 * 3);
    const idx = new Uint32Array(keep * 18);
    const segT = new Float32Array(keep);
    const base = new THREE.Color(0xff8a3d);
    const thin = new THREE.Color(0xd8343a);
    const c = new THREE.Color();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const side = new THREE.Vector3();
    const up = new THREE.Vector3(0, 0, 1);
    let k = 0;
    for (let i = 1; i < n && k < keep; i++) {
      if (!(tr.a[i] > 0)) continue;
      this.toDesign(tr.x[i - 1], tr.y[i - 1], tr.z[i], a);
      this.toDesign(tr.x[i], tr.y[i], tr.z[i], b);
      dir.subVectors(b, a);
      if (dir.lengthSq() < 1e-10) dir.set(1, 0, 0);
      side.crossVectors(dir, up).normalize();
      const w = Math.min(3 * (tr.nozzle || 0.4), Math.max(0.05, tr.a[i] / h));
      side.multiplyScalar(w / 2);
      const short = Math.max(0, 1 - tr.a[i] / Math.max(nominal, 1e-6));
      c.copy(base).lerp(thin, Math.min(1, short * 3));
      const v = k * 8;
      // top four corners, then the same four half a layer down
      const corners = [
        [a, 1, 0],
        [a, -1, 0],
        [b, -1, 0],
        [b, 1, 0],
        [a, 1, 1],
        [a, -1, 1],
        [b, -1, 1],
        [b, 1, 1],
      ] as const;
      corners.forEach(([p, s, low], j) => {
        pos[(v + j) * 3] = p.x + side.x * s;
        pos[(v + j) * 3 + 1] = p.y + side.y * s;
        pos[(v + j) * 3 + 2] = p.z - (low ? h : 0);
        col[(v + j) * 3] = c.r * (low ? 0.75 : 1);
        col[(v + j) * 3 + 1] = c.g * (low ? 0.75 : 1);
        col[(v + j) * 3 + 2] = c.b * (low ? 0.75 : 1);
      });
      const q = k * 18;
      const quad = (o: number, i0: number, i1: number, i2: number, i3: number) => {
        idx.set([v + i0, v + i1, v + i2, v + i0, v + i2, v + i3], q + o);
      };
      quad(0, 0, 1, 2, 3);
      quad(6, 0, 3, 7, 4);
      quad(12, 1, 5, 6, 2);
      segT[k] = tr.t[i];
      this.printBox.expandByPoint(a).expandByPoint(b);
      k++;
    }
    const geo = this.keep(new THREE.BufferGeometry());
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.setDrawRange(0, 0);
    this.printGeo = geo;
    this.segT = segT;
    const mat = this.keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0, side: THREE.DoubleSide }));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    this.printGroup.add(mesh);
  }

  setFrames(_frames?: unknown) {}

  setPlaying(_playing?: boolean) {}

  setTime(t: number) {
    this.t = t;
    const tr = this.trace;
    // where the nozzle is: between the moves either side of t
    const i = upper(tr.t, t);
    let x: number;
    let y: number;
    let z: number;
    if (i <= 0) [x, y, z] = [tr.x[0], tr.y[0], tr.z[0]];
    else if (i >= tr.t.length) [x, y, z] = [tr.x[tr.t.length - 1], tr.y[tr.t.length - 1], tr.z[tr.t.length - 1]];
    else {
      const f = (t - tr.t[i - 1]) / Math.max(1e-9, tr.t[i] - tr.t[i - 1]);
      x = tr.x[i - 1] + (tr.x[i] - tr.x[i - 1]) * f;
      y = tr.y[i - 1] + (tr.y[i] - tr.y[i - 1]) * f;
      z = tr.z[i - 1] + (tr.z[i] - tr.z[i - 1]) * f;
    }
    const d = [x - this.pose.s0[0], y - this.pose.s0[1], z - this.pose.s0[2]];
    for (const m of this.movers) {
      m.group.position.set(0, 0, 0);
      for (let k = 0; k < 3; k++) m.group.position.addScaledVector(m.mv[k], d[k]);
      m.group.updateMatrix();
    }
    this.nozzleNow.copy(this.pose.nozzle ?? new THREE.Vector3());
    const hot = this.nozzleMv;
    for (let k = 0; k < 3; k++) this.nozzleNow.addScaledVector(hot[k], d[k]);
    // the print so far
    if (this.printGeo) this.printGeo.setDrawRange(0, upper(this.segT, t) * 18);
  }

  frameBox(whole = false): THREE.Box3 {
    if (whole || this.printBox.isEmpty()) return this.modelBox.clone().expandByScalar(40);
    // close in on the print, where the bed has carried it, and the nozzle above it
    const b = this.printBox.clone();
    if (this.printGroup.parent && this.printGroup.parent !== this.object) b.translate(this.printGroup.parent.position);
    return b.expandByPoint(this.nozzleNow).expandByScalar(40);
  }

  nose(): THREE.Vector3 | null {
    return this.nozzleNow.clone();
  }

  dispose() {
    for (const x of this.disposables) x.dispose();
  }

  get time() {
    return this.t;
  }
}

function median(xs: Float32Array): number {
  if (!xs.length) return 0;
  const s = Float32Array.from(xs).sort();
  return s[Math.floor(s.length / 2)];
}

/** How many entries of a sorted array are at or below t. */
function upper(a: Float32Array, t: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
