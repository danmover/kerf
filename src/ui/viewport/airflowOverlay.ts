// Draws an airflow result on the model: the surface coloured by pressure
// (red where the air pushes, blue where it pulls) or skin friction, smoke-
// like streamlines with pulses running along them at the local speed, the
// wake and the eddies as see-through surfaces, and a cut through the
// averaged flow. A second overlay shows the live flow while a run goes.
// Plugs into the scene through SceneOverlay and knows nothing else about it.

import * as THREE from "three";
import type { SceneOverlay } from "./scene";
import { divergingColor, turbo, type RGB } from "../../analysis/colormap";
import type { FlowVolume, IsoSurface, Lines, SurfaceField, YawResult } from "../../analysis/aero/types";
import type { SurfaceShown } from "../../analysis/aeroRuntime";

export interface AirflowLook {
  surface: SurfaceShown;
  lines: boolean;
  wake: boolean;
  vortices: boolean;
  slice: "off" | "side" | "top" | "front";
  sliceAt: number;
  animate: boolean;
}

export interface AirflowProbe {
  text: string;
  part: string;
}

const lin = (c: RGB): RGB => [c[0] ** 2.2, c[1] ** 2.2, c[2] ** 2.2];
/** Cp from −1 (blue, suction) through 0 to +1 (red, the air stopped against it). */
export const cpColor = (cp: number): RGB => (Number.isFinite(cp) ? divergingColor(Math.min(1, Math.max(0, 0.5 + 0.5 * cp))) : [0.34, 0.36, 0.4]);
/** Speed share 0 (still) to 1.5× the free stream. */
export const speedColor = (s: number): RGB => turbo(Math.min(1, Math.max(0, s / 1.5)));

function maxCf(y: YawResult): number {
  const v: number[] = [];
  for (const s of y.surface)
    for (let i = 0; i < s.cf.length; i += 9) {
      const m = Math.hypot(s.cf[i], s.cf[i + 1], s.cf[i + 2]);
      if (Number.isFinite(m)) v.push(m);
    }
  v.sort((a, b) => a - b);
  return Math.max(1e-6, v[Math.floor(0.97 * (v.length - 1))] ?? 1e-3);
}

export class AirflowOverlay implements SceneOverlay {
  readonly object = new THREE.Group();
  readonly replaces: Set<string>;
  private surfaces: { mesh: THREE.Mesh; field: SurfaceField; color: THREE.BufferAttribute }[] = [];
  private lineMat: THREE.ShaderMaterial | null = null;
  private lineObj: THREE.LineSegments | null = null;
  private wakeObj: THREE.Mesh | null = null;
  private vortObj: THREE.Mesh | null = null;
  private sliceObj: THREE.Mesh | null = null;
  private disposables: { dispose(): void }[] = [];
  private look: AirflowLook;
  private t0 = performance.now();
  private cfMax: number;

  constructor(
    private y: YawResult,
    look: AirflowLook,
  ) {
    this.look = look;
    this.cfMax = maxCf(y);
    // the design's own parts are drawn coloured instead of plain, when the surface is coloured
    this.replaces = new Set(look.surface === "none" ? [] : y.surface.filter((s) => !s.extra).map((s) => s.id));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0, roughness: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const riderMat = new THREE.MeshStandardMaterial({ color: 0x8a919c, metalness: 0, roughness: 0.75 });
    this.disposables.push(mat, riderMat);
    for (const s of y.surface) {
      if (look.surface === "none" && !s.extra) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(s.positions, 3));
      if (s.normals && s.normals.length === s.positions.length) g.setAttribute("normal", new THREE.BufferAttribute(s.normals, 3));
      g.setIndex(new THREE.BufferAttribute(s.indices, 1));
      if (!s.normals) g.computeVertexNormals();
      const color = new THREE.BufferAttribute(new Float32Array(s.positions.length), 3);
      g.setAttribute("color", color);
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, look.surface === "none" ? riderMat : mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.object.add(mesh);
      this.surfaces.push({ mesh, field: s, color });
      this.disposables.push(g);
    }
    this.colourSurfaces();
    this.buildLines(y.streamlines);
    this.wakeObj = this.iso(y.wake, 0.42);
    this.vortObj = this.iso(y.vortices, 0.8);
    this.configure(look);
  }

  private colourSurfaces() {
    const mode = this.look.surface;
    for (const s of this.surfaces) {
      const out = s.color.array as Float32Array;
      const f = s.field;
      for (let v = 0; v < f.cp.length; v++) {
        let c: RGB;
        if (mode === "cf") {
          const m = Math.hypot(f.cf[3 * v], f.cf[3 * v + 1], f.cf[3 * v + 2]);
          c = Number.isFinite(m) ? turbo(Math.min(1, m / this.cfMax)) : [0.34, 0.36, 0.4];
        } else c = cpColor(f.cp[v]);
        const l = lin(c);
        out[3 * v] = l[0];
        out[3 * v + 1] = l[1];
        out[3 * v + 2] = l[2];
      }
      s.color.needsUpdate = true;
    }
  }

  private buildLines(L: Lines) {
    const n = L.starts.length - 1;
    if (n <= 0) return;
    const pos: number[] = [];
    const spd: number[] = [];
    const arc: number[] = [];
    for (let k = 0; k < n; k++) {
      let s = 0;
      for (let i = L.starts[k]; i + 1 < L.starts[k + 1]; i++) {
        const a = 3 * i,
          b = 3 * (i + 1);
        const d = Math.hypot(L.points[b] - L.points[a], L.points[b + 1] - L.points[a + 1], L.points[b + 2] - L.points[a + 2]);
        pos.push(L.points[a], L.points[a + 1], L.points[a + 2], L.points[b], L.points[b + 1], L.points[b + 2]);
        spd.push(L.speed[i], L.speed[i + 1]);
        // a random offset per line so the pulses do not march in step
        arc.push(s + k * 137.0, s + d + k * 137.0);
        s += d;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aSpeed", new THREE.Float32BufferAttribute(spd, 1));
    g.setAttribute("aArc", new THREE.Float32BufferAttribute(arc, 1));
    this.lineMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: { value: 0 }, uPeriod: { value: 260 }, uMove: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float aSpeed;
        attribute float aArc;
        varying float vSpeed;
        varying float vArc;
        #include <clipping_planes_pars_vertex>
        void main() {
          vSpeed = aSpeed;
          vArc = aArc;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <clipping_planes_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uPeriod;
        uniform float uMove;
        varying float vSpeed;
        varying float vArc;
        #include <clipping_planes_pars_fragment>
        vec3 turbo(float x) {
          x = clamp(x, 0.0, 1.0);
          vec4 v4 = vec4(1.0, x, x * x, x * x * x);
          vec2 v2 = v4.zw * v4.z;
          return vec3(
            dot(v4, vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234)) + dot(v2, vec2(-152.94239396, 59.28637943)),
            dot(v4, vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333)) + dot(v2, vec2(4.27729857, 2.82956604)),
            dot(v4, vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771)) + dot(v2, vec2(-89.90310912, 27.34824973)));
        }
        void main() {
          #include <clipping_planes_fragment>
          // pulses travel along each line; the arc is in mm, the time in seconds of a slowed-down flow
          float ph = fract(vArc / uPeriod - uTime * uMove);
          float pulse = smoothstep(0.0, 0.12, ph) * (1.0 - smoothstep(0.12, 0.55, ph));
          vec3 c = pow(clamp(turbo(vSpeed / 1.5), 0.0, 1.0), vec3(2.2));
          gl_FragColor = vec4(c, mix(0.28, 0.95, uMove > 0.0 ? pulse : 0.7));
        }`,
    });
    this.lineObj = new THREE.LineSegments(g, this.lineMat);
    this.lineObj.renderOrder = 3;
    this.object.add(this.lineObj);
    this.disposables.push(g, this.lineMat);
  }

  private iso(m: IsoSurface | null, opacity: number): THREE.Mesh | null {
    if (!m || !m.indices.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    const col = new Float32Array(m.positions.length);
    for (let v = 0; v < m.value.length; v++) {
      const c = lin(speedColor(m.value[v]));
      col.set(c, 3 * v);
    }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, roughness: 0.4, metalness: 0 });
    const mesh = new THREE.Mesh(g, mat);
    mesh.renderOrder = 4;
    this.object.add(mesh);
    this.disposables.push(g, mat);
    return mesh;
  }

  private buildSlice(v: FlowVolume | null) {
    if (this.sliceObj) {
      this.object.remove(this.sliceObj);
      this.sliceObj.geometry.dispose();
      const m = this.sliceObj.material as THREE.MeshBasicMaterial;
      m.map?.dispose();
      m.dispose();
      this.sliceObj = null;
    }
    const cut = this.look.slice;
    if (!v || cut === "off") return;
    const [dx, dy, dz] = v.dims;
    // texture axes (u, w) and the cut axis
    const axes = cut === "side" ? [0, 2, 1] : cut === "top" ? [0, 1, 2] : [1, 2, 0];
    const dims = [dx, dy, dz];
    const W = dims[axes[0]],
      H = dims[axes[1]];
    const at = Math.round(Math.min(1, Math.max(0, this.look.sliceAt)) * (dims[axes[2]] - 1));
    const px = new Uint8Array(W * H * 4);
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const c = [0, 0, 0];
        c[axes[0]] = i;
        c[axes[1]] = j;
        c[axes[2]] = at;
        const o = 4 * (c[0] + dx * (c[1] + dy * c[2]));
        const s = Math.hypot(v.data[o], v.data[o + 1], v.data[o + 2]);
        const k = 4 * (i + W * j);
        if (!Number.isFinite(s)) continue;
        const col = speedColor(s);
        px[k] = Math.round(col[0] * 255);
        px[k + 1] = Math.round(col[1] * 255);
        px[k + 2] = Math.round(col[2] * 255);
        px[k + 3] = 215;
      }
    const tex = new THREE.DataTexture(px, W, H, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    const ax = [v.ex, v.ey, v.ez];
    const corner = (i: number, j: number) => {
      const c = [0, 0, 0];
      c[axes[0]] = i;
      c[axes[1]] = j;
      c[axes[2]] = at;
      return new THREE.Vector3(...v.origin).addScaledVector(new THREE.Vector3(...ax[0]), c[0] * v.h).addScaledVector(new THREE.Vector3(...ax[1]), c[1] * v.h).addScaledVector(new THREE.Vector3(...ax[2]), c[2] * v.h);
    };
    this.sliceObj = quad(corner(0, 0), corner(W - 1, 0), corner(W - 1, H - 1), corner(0, H - 1), tex);
    this.object.add(this.sliceObj);
  }

  configure(look: AirflowLook) {
    const recolour = look.surface !== this.look.surface;
    const reslice = look.slice !== this.look.slice || look.sliceAt !== this.look.sliceAt || !this.sliceObj;
    this.look = look;
    if (recolour) this.colourSurfaces();
    if (this.lineObj) this.lineObj.visible = look.lines;
    if (this.lineMat) this.lineMat.uniforms.uMove.value = look.animate ? 1 : 0;
    if (this.wakeObj) this.wakeObj.visible = look.wake;
    if (this.vortObj) this.vortObj.visible = look.vortices;
    if (reslice) this.buildSlice(this.y.volume);
  }

  tick(now: number): boolean {
    if (!this.lineMat || !this.look.lines || !this.look.animate) return false;
    this.lineMat.uniforms.uTime.value = (now - this.t0) / 1000;
    return true;
  }

  still() {
    if (this.lineMat) this.lineMat.uniforms.uTime.value = 0.35;
  }

  setClipping(planes: THREE.Plane[] | null) {
    this.object.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) {
        m.clippingPlanes = planes;
        m.needsUpdate = true;
      }
    });
  }

  /** The pressure (or friction) under a ray. */
  probe(ray: THREE.Raycaster): AirflowProbe | null {
    const hits = ray.intersectObjects(
      this.surfaces.map((s) => s.mesh),
      false,
    );
    for (const h of hits) {
      const s = this.surfaces.find((x) => x.mesh === h.object);
      if (!s || !h.face) continue;
      const { a, b, c } = h.face;
      const P = s.field.positions;
      const tri = new THREE.Triangle(new THREE.Vector3(P[3 * a], P[3 * a + 1], P[3 * a + 2]), new THREE.Vector3(P[3 * b], P[3 * b + 1], P[3 * b + 2]), new THREE.Vector3(P[3 * c], P[3 * c + 1], P[3 * c + 2]));
      const w = tri.getBarycoord(h.point, new THREE.Vector3());
      if (!w) continue;
      const cp = s.field.cp[a] * w.x + s.field.cp[b] * w.y + s.field.cp[c] * w.z;
      if (this.look.surface === "cf") {
        const m = (i: number) => Math.hypot(s.field.cf[3 * i], s.field.cf[3 * i + 1], s.field.cf[3 * i + 2]);
        const cf = m(a) * w.x + m(b) * w.y + m(c) * w.z;
        return { text: Number.isFinite(cf) ? `Cf ${cf.toFixed(4)}` : "no air reaches here", part: s.field.name };
      }
      return { text: Number.isFinite(cp) ? `Cp ${cp >= 0 ? "+" : ""}${cp.toFixed(2)}` : "no air reaches here", part: s.field.name };
    }
    return null;
  }

  dispose() {
    this.buildSlice(null);
    for (const d of this.disposables) d.dispose();
  }
}

function quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, tex: THREE.Texture): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([...a.toArray(), ...b.toArray(), ...c.toArray(), ...d.toArray()], 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
  m.renderOrder = 2;
  return m;
}

/** The flow as it develops: the speed on a vertical plane through the design, updated while the run goes. */
export class LiveFlowOverlay implements SceneOverlay {
  readonly object = new THREE.Group();
  readonly replaces = new Set<string>();
  private mesh: THREE.Mesh | null = null;
  private tex: THREE.DataTexture | null = null;
  private px: Uint8Array<ArrayBuffer> | null = null;

  update(s: { w: number; h: number; data: Float32Array; origin: [number, number, number]; ex: [number, number, number]; ez: [number, number, number]; cell: number }) {
    if (!this.tex || this.tex.image.width !== s.w || this.tex.image.height !== s.h) {
      this.clear();
      this.px = new Uint8Array(s.w * s.h * 4);
      this.tex = new THREE.DataTexture(this.px, s.w, s.h, THREE.RGBAFormat);
      this.tex.colorSpace = THREE.SRGBColorSpace;
      this.tex.magFilter = THREE.LinearFilter;
      this.tex.minFilter = THREE.LinearFilter;
      const o = new THREE.Vector3(...s.origin);
      const ex = new THREE.Vector3(...s.ex).multiplyScalar(s.cell);
      const ez = new THREE.Vector3(...s.ez).multiplyScalar(s.cell);
      const at = (i: number, j: number) => o.clone().addScaledVector(ex, i).addScaledVector(ez, j);
      this.mesh = quad(at(0, 0), at(s.w - 1, 0), at(s.w - 1, s.h - 1), at(0, s.h - 1), this.tex);
      this.object.add(this.mesh);
    }
    const px = this.px!;
    for (let k = 0; k < s.w * s.h; k++) {
      const v = s.data[k];
      if (v < 0 || !Number.isFinite(v)) {
        px[4 * k + 3] = 0;
        continue;
      }
      const c = speedColor(v);
      px[4 * k] = Math.round(c[0] * 255);
      px[4 * k + 1] = Math.round(c[1] * 255);
      px[4 * k + 2] = Math.round(c[2] * 255);
      px[4 * k + 3] = 200;
    }
    this.tex!.needsUpdate = true;
  }

  private clear() {
    if (this.mesh) {
      this.object.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
    }
    this.tex?.dispose();
    this.mesh = null;
    this.tex = null;
  }

  dispose() {
    this.clear();
  }
}
