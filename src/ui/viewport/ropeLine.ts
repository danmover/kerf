// A rope drawn so it can move: a round tube along the rope's centre line,
// laid again each frame from where its drum, sheaves and tied ends are
// (ropeLineAt). The scene shows it in place of the rope's solid whenever
// one of those has moved from where it is drawn: the motion preview, a
// drag, "let go". The rope keeps its length, so its turns wind onto the
// drum and off it as the load goes up and down.

import * as THREE from "three";

type V3 = [number, number, number];

/** Sides of the tube. */
const SIDES = 10;

export class RopeLine {
  readonly mesh: THREE.Mesh;
  private geo = new THREE.BufferGeometry();
  private room = 0;
  private pos = new Float32Array(0);
  private nrm = new Float32Array(0);
  private last = "";
  /** points the tube's triangles were last laid for */
  private rings = 0;

  constructor(
    /** the rope's diameter, mm */
    readonly d: number,
    mat: THREE.Material,
  ) {
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.userData.shadow = true;
    this.mesh.visible = false;
  }

  private grow(points: number) {
    if (points <= this.room) return;
    this.room = Math.ceil(points * 1.5) + 8;
    const rings = this.room;
    this.pos = new Float32Array((rings * SIDES + 2) * 3);
    this.nrm = new Float32Array((rings * SIDES + 2) * 3);
    this.geo.dispose();
    this.geo = new THREE.BufferGeometry();
    this.rings = 0;
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("normal", new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    this.mesh.geometry = this.geo;
  }

  /** Lay the tube along the centre line; false when it is where it was. */
  update(line: V3[]): boolean {
    // points closer together than a tenth of the rope's thickness are one point
    const pts: V3[] = [];
    for (const p of line) {
      const q = pts[pts.length - 1];
      if (!q || Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > this.d * 0.1) pts.push(p);
    }
    if (pts.length < 2) {
      if (!this.geo.drawRange.count) return false;
      this.geo.setDrawRange(0, 0);
      this.last = "";
      this.rings = 0;
      return true;
    }
    const key = pts.map((p) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)},${Math.round(p[2] * 100)}`).join(";");
    if (key === this.last) return false;
    this.last = key;
    const n = pts.length;
    this.grow(n);
    const r = (this.d * 0.96) / 2;
    const t = new THREE.Vector3();
    const prev = new THREE.Vector3();
    const u = new THREE.Vector3();
    const v = new THREE.Vector3();
    const q = new THREE.Quaternion();
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      t.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
      if (i === 0) {
        // any direction square to the rope to start from, then carried along it without twisting
        u.set(Math.abs(t.z) < 0.9 ? 0 : 1, 0, Math.abs(t.z) < 0.9 ? 1 : 0);
        u.addScaledVector(t, -u.dot(t)).normalize();
      } else {
        q.setFromUnitVectors(prev, t);
        u.applyQuaternion(q);
        u.addScaledVector(t, -u.dot(t)).normalize();
      }
      prev.copy(t);
      v.crossVectors(t, u);
      for (let k = 0; k < SIDES; k++) {
        const ang = (k / SIDES) * Math.PI * 2;
        const c = Math.cos(ang);
        const s = Math.sin(ang);
        const o = (i * SIDES + k) * 3;
        const nx = u.x * c + v.x * s;
        const ny = u.y * c + v.y * s;
        const nz = u.z * c + v.z * s;
        this.pos[o] = pts[i][0] + nx * r;
        this.pos[o + 1] = pts[i][1] + ny * r;
        this.pos[o + 2] = pts[i][2] + nz * r;
        this.nrm[o] = nx;
        this.nrm[o + 1] = ny;
        this.nrm[o + 2] = nz;
      }
      // the middle of each end, for its cap
      if (i === 0 || i === n - 1) {
        const o = (n * SIDES + (i === 0 ? 0 : 1)) * 3;
        const sgn = i === 0 ? -1 : 1;
        this.pos[o] = pts[i][0];
        this.pos[o + 1] = pts[i][1];
        this.pos[o + 2] = pts[i][2];
        this.nrm[o] = t.x * sgn;
        this.nrm[o + 1] = t.y * sgn;
        this.nrm[o + 2] = t.z * sgn;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
    if (n === this.rings) return true;
    this.rings = n;
    const idx: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      for (let k = 0; k < SIDES; k++) {
        const a = i * SIDES + k;
        const b = i * SIDES + ((k + 1) % SIDES);
        const c = a + SIDES;
        const e = b + SIDES;
        idx.push(a, b, c, b, e, c);
      }
    }
    for (let k = 0; k < SIDES; k++) {
      const k1 = (k + 1) % SIDES;
      idx.push(n * SIDES, k1, k);
      idx.push(n * SIDES + 1, (n - 1) * SIDES + k, (n - 1) * SIDES + k1);
    }
    this.geo.setIndex(idx);
    this.geo.setDrawRange(0, idx.length);
    return true;
  }

  dispose() {
    this.geo.dispose();
  }
}
