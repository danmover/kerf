// Draws a flow and cooling result on the model: the parts coloured by temperature (a case, lid or duct that wraps round
// the rest drawn see-through so what is inside shows), streamlines through the air from the fans and openings with
// pulses running along them, coloured by speed or temperature, and a cut through the air and the parts. Plugs into
// the scene through SceneOverlay and knows nothing else about it.

import * as THREE from "three";
import type { SceneOverlay } from "./scene";
import { turbo, type RGB } from "../../analysis/colormap";
import type { FlowField, FlowLines, FlowResult, SurfaceTemps } from "../../analysis/flow/types";
import type { FlowColour } from "../../analysis/flowRuntime";

export interface FlowLook {
  surface: boolean;
  /** the parts that wrap round the rest drawn see-through */
  xray: boolean;
  lines: boolean;
  colour: FlowColour;
  slice: "off" | "x" | "y" | "z";
  sliceAt: number;
  animate: boolean;
}

/** The ends of the colour scales: °C from the surroundings to the hottest part, m/s from still to nearly the fastest air. */
export interface FlowScales {
  tLo: number;
  tHi: number;
  vHi: number;
}

export interface FlowProbe {
  text: string;
  part: string;
}

const lin = (c: RGB): RGB => [c[0] ** 2.2, c[1] ** 2.2, c[2] ** 2.2];
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const GREY: RGB = [0.34, 0.36, 0.4];
const SOLID_CUT: RGB = [0.2, 0.22, 0.25];

/** A round number at or above v: 1, 1.5, 2, 3, 5 or 7.5 times a power of ten. */
function niceUp(v: number): number {
  const e = 10 ** Math.floor(Math.log10(v));
  const m = v / e;
  return (m <= 1 ? 1 : m <= 1.5 ? 1.5 : m <= 2 ? 2 : m <= 3 ? 3 : m <= 5 ? 5 : m <= 7.5 ? 7.5 : 10) * e;
}

export function flowScales(r: FlowResult): FlowScales {
  let hi = r.ambient;
  for (const p of r.parts) if (Number.isFinite(p.max)) hi = Math.max(hi, p.max);
  if (Number.isFinite(r.maxAir)) hi = Math.max(hi, r.maxAir);
  const tLo = Math.floor(r.ambient);
  const tHi = Math.max(tLo + 2, Math.ceil(hi));
  // nearly the fastest: a fan's jet would wash out everything else
  const sp = Array.from(r.lines.speed)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  const v = sp.length ? sp[Math.floor(0.97 * (sp.length - 1))] : r.maxSpeed;
  return { tLo, tHi, vHi: niceUp(Math.max(0.02, v || r.maxSpeed || 0.1)) };
}

export const tempColor = (t: number, s: FlowScales): RGB => (Number.isFinite(t) ? turbo(clamp01((t - s.tLo) / (s.tHi - s.tLo))) : GREY);
export const flowSpeedColor = (v: number, s: FlowScales): RGB => (Number.isFinite(v) ? turbo(clamp01(v / s.vHi)) : GREY);

interface Box {
  lo: [number, number, number];
  hi: [number, number, number];
}

function boxOf(P: Float32Array): Box {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3)
    for (let a = 0; a < 3; a++) {
      if (P[i + a] < lo[a]) lo[a] = P[i + a];
      if (P[i + a] > hi[a]) hi[a] = P[i + a];
    }
  return { lo, hi };
}

/** The parts that wrap round the rest (a case and its lid, a duct): they reach the edge of everything on three sides or more. */
function outerParts(surfaces: SurfaceTemps[]): Set<string> {
  const boxes = surfaces.map((s) => boxOf(s.positions));
  const all: Box = { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] };
  for (const b of boxes)
    for (let a = 0; a < 3; a++) {
      all.lo[a] = Math.min(all.lo[a], b.lo[a]);
      all.hi[a] = Math.max(all.hi[a], b.hi[a]);
    }
  const tol = Math.max(0.5, 0.02 * Math.max(...[0, 1, 2].map((a) => all.hi[a] - all.lo[a])));
  const out = new Set<string>();
  surfaces.forEach((s, i) => {
    let n = 0;
    for (let a = 0; a < 3; a++) {
      if (boxes[i].lo[a] <= all.lo[a] + tol) n++;
      if (boxes[i].hi[a] >= all.hi[a] - tol) n++;
    }
    if (n >= 3) out.add(s.id);
  });
  return out;
}

interface Surface {
  mesh: THREE.Mesh;
  field: SurfaceTemps;
  color: THREE.BufferAttribute;
  outer: boolean;
}

export class FlowOverlay implements SceneOverlay {
  readonly object = new THREE.Group();
  readonly replaces: Set<string>;
  readonly scales: FlowScales;
  private surfaces: Surface[] = [];
  private solidMat: THREE.MeshStandardMaterial;
  private glassMat: THREE.MeshStandardMaterial;
  private lineMat: THREE.ShaderMaterial | null = null;
  private lineObj: THREE.LineSegments | null = null;
  private sliceObj: THREE.Mesh | null = null;
  private sliceAxis = -1;
  private disposables: { dispose(): void }[] = [];
  private look: FlowLook;
  private t0 = performance.now();
  private anyInner: boolean;

  constructor(
    private r: FlowResult,
    look: FlowLook,
  ) {
    this.look = look;
    this.scales = flowScales(r);
    this.replaces = new Set(look.surface ? r.surfaces.map((s) => s.id) : []);
    const base = { vertexColors: true, metalness: 0, roughness: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 } as const;
    this.solidMat = new THREE.MeshStandardMaterial(base);
    this.glassMat = new THREE.MeshStandardMaterial({ ...base, transparent: true, opacity: 0.26, depthWrite: false });
    this.disposables.push(this.solidMat, this.glassMat);
    const outer = outerParts(r.surfaces);
    this.anyInner = r.surfaces.some((s) => !outer.has(s.id));
    if (look.surface)
      for (const s of r.surfaces) {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(s.positions, 3));
        g.setIndex(new THREE.BufferAttribute(s.indices, 1));
        g.computeVertexNormals();
        const color = new THREE.BufferAttribute(new Float32Array(s.positions.length), 3);
        g.setAttribute("color", color);
        g.computeBoundingSphere();
        const mesh = new THREE.Mesh(g, this.solidMat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.object.add(mesh);
        this.surfaces.push({ mesh, field: s, color, outer: outer.has(s.id) });
        this.disposables.push(g);
      }
    this.colourSurfaces();
    this.buildLines(r.lines);
    this.configure(look);
  }

  private colourSurfaces() {
    for (const s of this.surfaces) {
      const out = s.color.array as Float32Array;
      const t = s.field.temp;
      for (let v = 0; v < t.length; v++) {
        const c = lin(tempColor(t[v], this.scales));
        out[3 * v] = c[0];
        out[3 * v + 1] = c[1];
        out[3 * v + 2] = c[2];
      }
      s.color.needsUpdate = true;
    }
  }

  private buildLines(L: FlowLines) {
    const n = L.starts.length - 1;
    if (n <= 0) return;
    const pos: number[] = [];
    const spd: number[] = [];
    const tmp: number[] = [];
    const arc: number[] = [];
    const box = boxOf(L.points);
    const size = Math.max(1, ...[0, 1, 2].map((a) => box.hi[a] - box.lo[a]));
    for (let k = 0; k < n; k++) {
      let s = 0;
      for (let i = L.starts[k]; i + 1 < L.starts[k + 1]; i++) {
        const a = 3 * i;
        const b = 3 * (i + 1);
        const d = Math.hypot(L.points[b] - L.points[a], L.points[b + 1] - L.points[a + 1], L.points[b + 2] - L.points[a + 2]);
        pos.push(L.points[a], L.points[a + 1], L.points[a + 2], L.points[b], L.points[b + 1], L.points[b + 2]);
        spd.push(L.speed[i], L.speed[i + 1]);
        tmp.push(L.temp[i], L.temp[i + 1]);
        // an offset per line so the pulses do not march in step
        const off = ((k * 0.618034) % 1) * size;
        arc.push(s + off, s + d + off);
        s += d;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aSpeed", new THREE.Float32BufferAttribute(spd, 1));
    g.setAttribute("aTemp", new THREE.Float32BufferAttribute(tmp, 1));
    g.setAttribute("aArc", new THREE.Float32BufferAttribute(arc, 1));
    const sc = this.scales;
    this.lineMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      clipping: true,
      uniforms: {
        uTime: { value: 0 },
        uPeriod: { value: Math.min(400, Math.max(12, 0.3 * size)) },
        uMove: { value: 1 },
        uMode: { value: 0 },
        uVHi: { value: sc.vHi },
        uTLo: { value: sc.tLo },
        uTHi: { value: sc.tHi },
      },
      vertexShader: /* glsl */ `
        attribute float aSpeed;
        attribute float aTemp;
        attribute float aArc;
        varying float vSpeed;
        varying float vTemp;
        varying float vArc;
        #include <clipping_planes_pars_vertex>
        void main() {
          vSpeed = aSpeed;
          vTemp = aTemp;
          vArc = aArc;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <clipping_planes_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uPeriod;
        uniform float uMove;
        uniform float uMode;
        uniform float uVHi;
        uniform float uTLo;
        uniform float uTHi;
        varying float vSpeed;
        varying float vTemp;
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
          float x = uMode < 0.5 ? vSpeed / uVHi : (vTemp - uTLo) / max(1e-3, uTHi - uTLo);
          // pulses travel along each line; the arc is in mm
          float ph = fract(vArc / uPeriod - uTime * uMove * 0.35);
          float pulse = smoothstep(0.0, 0.12, ph) * (1.0 - smoothstep(0.12, 0.55, ph));
          vec3 c = pow(clamp(turbo(x), 0.0, 1.0), vec3(2.2));
          gl_FragColor = vec4(c, mix(0.3, 0.95, uMove > 0.0 ? pulse : 0.7));
        }`,
    });
    this.lineObj = new THREE.LineSegments(g, this.lineMat);
    this.lineObj.renderOrder = 3;
    this.object.add(this.lineObj);
    this.disposables.push(g, this.lineMat);
  }

  private clearSlice() {
    if (!this.sliceObj) return;
    this.object.remove(this.sliceObj);
    this.sliceObj.geometry.dispose();
    const m = this.sliceObj.material as THREE.MeshBasicMaterial;
    m.map?.dispose();
    m.dispose();
    this.sliceObj = null;
    this.sliceAxis = -1;
  }

  /** A cut through the grid across an axis: the air by speed or temperature, the parts by temperature. */
  private buildSlice(f: FlowField | null) {
    this.clearSlice();
    const cut = this.look.slice;
    if (!f || cut === "off") return;
    const a = cut === "x" ? 0 : cut === "y" ? 1 : 2;
    const [ua, va] = a === 0 ? [1, 2] : a === 1 ? [0, 2] : [0, 1];
    const [nx, ny] = f.dims;
    // leave out the outer layer of cells: the surroundings
    const W = f.dims[ua] - 2;
    const H = f.dims[va] - 2;
    if (W < 2 || H < 2 || f.dims[a] < 3) return;
    const at = 1 + Math.round(clamp01(this.look.sliceAt) * (f.dims[a] - 3));
    const speed = this.look.colour === "speed";
    const px = new Uint8Array(W * H * 4);
    const idx = [0, 0, 0];
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        idx[ua] = i + 1;
        idx[va] = j + 1;
        idx[a] = at;
        const c = idx[0] + nx * (idx[1] + ny * idx[2]);
        const kind = f.kind[c];
        if (kind === 2) continue;
        const o = 5 * c;
        const col = kind === 1 ? (speed ? SOLID_CUT : tempColor(f.data[o + 3], this.scales)) : speed ? flowSpeedColor(Math.hypot(f.data[o], f.data[o + 1], f.data[o + 2]), this.scales) : tempColor(f.data[o + 3], this.scales);
        const k = 4 * (i + W * j);
        px[k] = Math.round(col[0] * 255);
        px[k + 1] = Math.round(col[1] * 255);
        px[k + 2] = Math.round(col[2] * 255);
        px[k + 3] = kind === 1 ? 235 : 205;
      }
    const tex = new THREE.DataTexture(px, W, H, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    const corner = (i: number, j: number) => {
      const p = [0, 0, 0];
      p[ua] = f.origin[ua] + (i + 1.5) * f.h;
      p[va] = f.origin[va] + (j + 1.5) * f.h;
      p[a] = f.origin[a] + (at + 0.5) * f.h;
      return new THREE.Vector3(p[0], p[1], p[2]);
    };
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([...corner(0, 0).toArray(), ...corner(W - 1, 0).toArray(), ...corner(W - 1, H - 1).toArray(), ...corner(0, H - 1).toArray()], 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
    m.renderOrder = 2;
    this.sliceObj = m;
    this.sliceAxis = a;
    this.object.add(m);
  }

  configure(look: FlowLook) {
    const reslice = look.slice !== this.look.slice || look.sliceAt !== this.look.sliceAt || look.colour !== this.look.colour || (look.slice !== "off" && !this.sliceObj);
    this.look = look;
    // the outer parts go see-through when there is something inside them to see: other parts, or the air going through
    const glass = look.xray && (this.anyInner || (look.lines && !!this.lineObj) || look.slice !== "off");
    for (const s of this.surfaces) {
      const g = glass && s.outer;
      s.mesh.material = g ? this.glassMat : this.solidMat;
      s.mesh.renderOrder = g ? 5 : 0;
      s.mesh.castShadow = !g;
    }
    if (this.lineObj) this.lineObj.visible = look.lines;
    if (this.lineMat) {
      this.lineMat.uniforms.uMove.value = look.animate ? 1 : 0;
      this.lineMat.uniforms.uMode.value = look.colour === "speed" ? 0 : 1;
    }
    if (reslice) this.buildSlice(this.r.field);
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
    // the cut through the air stays whole: it often lies on the section plane itself
    for (const m of [this.solidMat, this.glassMat, this.lineMat]) {
      if (!m) continue;
      m.clippingPlanes = planes;
      m.needsUpdate = true;
    }
  }

  /** The temperature under a ray: on the cut through the air if that is nearest, else on the nearest part. */
  probe(ray: THREE.Raycaster): FlowProbe | null {
    const hits = ray.intersectObjects(
      this.surfaces.map((s) => s.mesh),
      false,
    );
    const glassy = (o: THREE.Object3D) => (o as THREE.Mesh).material === this.glassMat;
    const part = hits.find((h) => !glassy(h.object)) ?? hits[0];
    const cut = this.sliceObj ? ray.intersectObject(this.sliceObj, false)[0] : undefined;
    if (cut && (!part || cut.distance < part.distance)) {
      const at = this.sample(cut.point);
      if (at) return at;
    }
    if (!part || !part.face) return null;
    const s = this.surfaces.find((x) => x.mesh === part.object);
    if (!s) return null;
    const { a, b, c } = part.face;
    const P = s.field.positions;
    const tri = new THREE.Triangle(new THREE.Vector3(P[3 * a], P[3 * a + 1], P[3 * a + 2]), new THREE.Vector3(P[3 * b], P[3 * b + 1], P[3 * b + 2]), new THREE.Vector3(P[3 * c], P[3 * c + 1], P[3 * c + 2]));
    const w = tri.getBarycoord(part.point, new THREE.Vector3());
    if (!w) return null;
    const T = s.field.temp;
    const t = T[a] * w.x + T[b] * w.y + T[c] * w.z;
    return { text: Number.isFinite(t) ? `${t.toFixed(1)} °C` : "no temperature here", part: s.field.name };
  }

  private sample(p: THREE.Vector3): FlowProbe | null {
    const f = this.r.field;
    if (!f || this.sliceAxis < 0) return null;
    const [nx, ny, nz] = f.dims;
    const i = Math.floor((p.x - f.origin[0]) / f.h);
    const j = Math.floor((p.y - f.origin[1]) / f.h);
    const k = Math.floor((p.z - f.origin[2]) / f.h);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return null;
    const c = i + nx * (j + ny * k);
    const kind = f.kind[c];
    if (kind === 2) return null;
    const o = 5 * c;
    const t = f.data[o + 3];
    if (kind === 1) return { text: `${t.toFixed(1)} °C`, part: "inside a part" };
    const v = Math.hypot(f.data[o], f.data[o + 1], f.data[o + 2]);
    return { text: `${t.toFixed(1)} °C · ${v < 0.1 ? `${(v * 1000).toFixed(0)} mm/s` : `${v.toFixed(2)} m/s`}`, part: this.r.fluid };
  }

  dispose() {
    this.clearSlice();
    for (const d of this.disposables) d.dispose();
  }
}
