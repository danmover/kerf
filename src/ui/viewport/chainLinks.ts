// A roller chain's links drawn so they can move: rollers, pins and plates as
// instanced meshes, placed each frame where chainRollers puts them for the
// drive angle. The scene shows these in place of the chain's solid while the
// motion preview is away from its start, so the links run round the
// sprockets with the rollers dropping into each tooth gap.

import * as THREE from "three";
import { plateOffsets, rollerPlaces, type ChainInfo } from "../../machine/chains";

/** One plate's outline along x, centred: two round ends joined by a waist (the kernel's plateProfile). */
function plateShape(pitch: number, h: number): THREE.Shape {
  const r = h / 2;
  const w = 0.39 * h;
  const tw = Math.asin(w / r);
  const x = pitch / 2 - r * Math.cos(tw);
  const s = new THREE.Shape();
  s.moveTo(-x, w);
  s.lineTo(x, w);
  s.absarc(pitch / 2, 0, r, Math.PI - tw, tw - Math.PI, true);
  s.lineTo(-x, -w);
  s.absarc(-pitch / 2, 0, r, -tw, tw, true);
  return s;
}

export class ChainLinks {
  readonly object = new THREE.Group();
  readonly meshes: THREE.InstancedMesh[] = [];
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly frame = new THREE.Matrix4();
  private last = NaN;
  private readonly rollers: THREE.InstancedMesh;
  private readonly pins: THREE.InstancedMesh;
  /** inner plates either side, then outer plates either side, with how far each sits along the normal */
  private readonly plates: { mesh: THREE.InstancedMesh; z: number; odd: boolean }[] = [];

  constructor(
    readonly info: ChainInfo,
    mat: THREE.Material,
  ) {
    const c = info.spec;
    const N = info.links;
    const { o, u, v, n } = info.plane;
    this.frame.makeBasis(new THREE.Vector3(...u), new THREE.Vector3(...v), new THREE.Vector3(...n)).setPosition(o[0], o[1], o[2]);
    const cyl = (d: number, len: number) => {
      const g = new THREE.CylinderGeometry(d / 2, d / 2, len, 14);
      g.rotateX(Math.PI / 2);
      this.geos.push(g);
      return g;
    };
    const add = (g: THREE.BufferGeometry, count: number) => {
      const m = new THREE.InstancedMesh(g, mat, count);
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.userData.shadow = true;
      this.meshes.push(m);
      this.object.add(m);
      return m;
    };
    this.rollers = add(cyl(c.roller, c.inner), N);
    this.pins = add(cyl(c.pinD, c.inner + 4 * c.plateT + 0.4), N);
    const plate = new THREE.ExtrudeGeometry(plateShape(c.pitch, c.plateH), { depth: c.plateT, bevelEnabled: false, curveSegments: 10 });
    this.geos.push(plate);
    const off = plateOffsets(c);
    const half = Math.ceil(N / 2);
    for (const [z, odd] of [
      [off.inner, false],
      [-off.inner - c.plateT, false],
      [off.outer, true],
      [-off.outer - c.plateT, true],
    ] as [number, boolean][])
      this.plates.push({ mesh: add(plate, half), z, odd });
    this.object.visible = false;
  }

  /** Place the links for the drive angle; false when nothing moved. */
  update(angle: number): boolean {
    if (angle === this.last) return false;
    this.last = angle;
    const rs = rollerPlaces(this.info, angle);
    const m = new THREE.Matrix4();
    const local = new THREE.Matrix4();
    const rot = new THREE.Matrix4();
    rs.forEach(({ q, w }, k) => {
      m.copy(this.frame).multiply(local.makeTranslation(q[0], q[1], w));
      this.rollers.setMatrixAt(k, m);
      this.pins.setMatrixAt(k, m);
    });
    const at = { even: 0, odd: 0 };
    rs.forEach((ra, k) => {
      const rb = rs[(k + 1) % rs.length];
      const [a, b] = [ra.q, rb.q];
      const odd = k % 2 === 1;
      const i = odd ? at.odd++ : at.even++;
      rot.makeRotationZ(Math.atan2(b[1] - a[1], b[0] - a[0]));
      for (const p of this.plates) {
        if (p.odd !== odd) continue;
        m.copy(this.frame).multiply(local.makeTranslation((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (ra.w + rb.w) / 2)).multiply(rot).multiply(new THREE.Matrix4().makeTranslation(0, 0, p.z));
        p.mesh.setMatrixAt(i, m);
      }
    });
    for (const p of this.plates) p.mesh.count = p.odd ? at.odd : at.even;
    for (const x of this.meshes) x.instanceMatrix.needsUpdate = true;
    return true;
  }

  dispose() {
    for (const g of this.geos) g.dispose();
    for (const x of this.meshes) x.dispose();
  }
}
