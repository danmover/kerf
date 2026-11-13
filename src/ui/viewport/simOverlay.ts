// Draws a simulation run in the viewport: the environment (a cut-away sand
// pit with its walls, floor and exit opening), the design's own parts posed on
// the bodies the world moves, screws turning with their motors, the tunnel it
// leaves behind, sand streaming along the flights, and LED boards lit in the
// colours the firmware showed. Plugs into the scene
// through SceneOverlay, which hides the normal solids while it is shown.

import * as THREE from "three";
import type { EvalPart } from "../../core/model";
import type { MeshEntry } from "../../core/engine";
import { xformMatrix } from "../../kernel/recipe";
import type { Frames } from "../../sim/engine/run";
import type { SceneBody, SceneSpec } from "../../sim/worlds/types";
import { frameAt, valueAt } from "../../sim/frames";
import { catalogPart } from "../../machine/catalog";
import { ledPoints } from "../../machine/geometry";
import type { SceneOverlay } from "./scene";

const D2R = Math.PI / 180;

const FLOOR_COLOUR: Record<string, number> = { concrete: 0x8b8f96, wood: 0x9a7650, tile: 0xb9bcc2, carpet: 0x6a5f74, grass: 0x4f7a3a, gravel: 0x8a8378, sand: 0xd8c08f, ice: 0xcfe3ee };

interface Body {
  spec: SceneBody;
  group: THREE.Group;
  spins: { group: THREE.Group; motor: string; sign: number }[];
}

// sand: grains from 3D value noise, darker bands with depth, a lit cut face
const SAND_VERT = /* glsl */ `
varying vec3 vPos;
varying vec3 vNormal;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vPos = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const SAND_FRAG = /* glsl */ `
uniform float uOpacity;
uniform float uTop;
uniform vec3 uLight;
varying vec3 vPos;
varying vec3 vNormal;
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
void main() {
  float grain = noise(vPos * 0.9) * 0.55 + noise(vPos * 3.1) * 0.3 + noise(vPos * 0.08) * 0.15;
  float depth = clamp((uTop - vPos.z) / max(uTop, 1.0), 0.0, 1.0);
  // faint layers from how the pit was filled
  float bands = 0.5 + 0.5 * sin(vPos.z * 0.021 + noise(vPos * 0.004) * 6.0);
  vec3 dry = vec3(0.86, 0.72, 0.5);
  vec3 deep = vec3(0.62, 0.48, 0.31);
  vec3 col = mix(dry, deep, depth * 0.7 + bands * 0.12);
  col *= 0.82 + grain * 0.32;
  float lit = 0.55 + 0.45 * max(dot(normalize(vNormal), normalize(uLight)), 0.0);
  gl_FragColor = vec4(col * lit, uOpacity);
  #include <colorspace_fragment>
}`;

function sandMaterial(opacity: number, top: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: SAND_VERT,
    fragmentShader: SAND_FRAG,
    uniforms: { uOpacity: { value: opacity }, uTop: { value: top }, uLight: { value: new THREE.Vector3(-0.4, -0.7, 0.8) } },
    transparent: opacity < 1,
    depthWrite: opacity >= 1,
    side: THREE.DoubleSide,
  });
}

export class SimOverlay implements SceneOverlay {
  readonly object = new THREE.Group();
  readonly replaces: Set<string>;
  private bodies: Body[] = [];
  private frames: Frames | null = null;
  private t = 0;
  private disposables: { dispose(): void }[] = [];
  private trail: { mesh: THREE.Mesh; rings: number; samples: number[]; seg: number } | null = null;
  private grains: { pts: THREE.Points; data: Float32Array; motor: string; from: number; to: number; r: number; turn: number; body: Body }[] = [];
  private playing = false;
  /** LED boards: a dot and a soft glow per LED, coloured from the run's <comp>.led<i> series */
  private lights: { comp: string; n: number; dots: THREE.InstancedMesh; glow: THREE.InstancedMesh }[] = [];
  /** the design's own extent, for a bench under it and framing */
  private modelBox = new THREE.Box3();

  constructor(
    private spec: SceneSpec,
    parts: EvalPart[],
    meshes: Map<string, MeshEntry>,
    screws: { motor: string; from: number; to: number; d: number; turn: number }[] = [],
  ) {
    this.replaces = new Set(parts.map((p) => p.id));
    for (const p of parts) {
      const e = meshes.get(p.hash);
      if (!e || p.hidden) continue;
      const box = new THREE.Box3(new THREE.Vector3(...e.bbox[0]), new THREE.Vector3(...e.bbox[1]));
      this.modelBox.union(box.applyMatrix4(new THREE.Matrix4().fromArray(xformMatrix(p.xf))));
    }
    if (this.modelBox.isEmpty()) this.modelBox.set(new THREE.Vector3(-100, -100, 0), new THREE.Vector3(100, 100, 100));
    this.buildWorld();
    this.buildBodies(parts, meshes);
    this.buildParticles(screws);
  }

  // ---------- the environment ----------

  private keep<T extends { dispose(): void }>(x: T): T {
    this.disposables.push(x);
    return x;
  }

  private buildWorld() {
    const b = this.spec.box;
    const g = this.spec.ground;
    if (!b && g && g.label !== "bench top") {
      this.buildFloor(g);
      return;
    }
    if (!b) {
      // a bench: a table top under the machine
      const mb = this.modelBox;
      const size = mb.getSize(new THREE.Vector3());
      const c = mb.getCenter(new THREE.Vector3());
      const top = new THREE.Mesh(this.keep(new THREE.BoxGeometry(size.x * 1.6 + 300, size.y * 1.6 + 300, 30)), this.keep(new THREE.MeshStandardMaterial({ color: 0x3a3f4a, roughness: 0.85 })));
      top.position.set(c.x, c.y, mb.min.z - 15.5);
      this.object.add(top);
      return;
    }
    const [x0, y0, z0] = b.min;
    const [x1, y1, z1] = b.max;
    const L = x1 - x0;
    const W = y1 - y0;
    const H = z1 - z0;
    const wall = 40;
    const concrete = this.keep(new THREE.MeshStandardMaterial({ color: 0x8b8f96, roughness: 0.92, metalness: 0 }));
    const floor = new THREE.Mesh(this.keep(new THREE.BoxGeometry(L + 2 * wall + 200, W + 2 * wall + 200, 60)), concrete);
    floor.position.set((x0 + x1) / 2, (y0 + y1) / 2, z0 - 30);
    this.object.add(floor);
    // end walls with their openings: the launch hole and the exit
    const target = this.spec.target;
    const axisZ = target?.at[2] ?? 100;
    const holeD = this.spec.trail ? this.spec.trail.d + 10 : 100;
    const endWall = (x: number, hole: number) => {
      const s = new THREE.Shape();
      s.moveTo(y0 - wall, z0);
      s.lineTo(y1 + wall, z0);
      s.lineTo(y1 + wall, z1 + 120);
      s.lineTo(y0 - wall, z1 + 120);
      s.closePath();
      if (hole > 0) {
        const h = new THREE.Path();
        h.absarc(0, axisZ, hole / 2, 0, Math.PI * 2, true);
        s.holes.push(h);
      }
      const g = this.keep(new THREE.ExtrudeGeometry(s, { depth: wall, bevelEnabled: false, curveSegments: 40 }));
      const m = new THREE.Mesh(g, concrete);
      // the shape is drawn in (y, z); turn it so it stands across the pit
      m.matrixAutoUpdate = false;
      m.matrix.makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)).setPosition(x, 0, 0);
      this.object.add(m);
    };
    endWall(x0 - wall, holeD);
    endWall(x1, target?.d ?? 0);
    if (target) {
      const ring = new THREE.Mesh(this.keep(new THREE.TorusGeometry(target.d / 2, 4, 10, 64)), this.keep(new THREE.MeshStandardMaterial({ color: 0x3ddc97, emissive: 0x1d7a52, roughness: 0.4 })));
      ring.rotation.y = Math.PI / 2;
      ring.position.set(x1 + 2, target.at[1], target.at[2]);
      this.object.add(ring);
    }
    // side walls: glass-clear so the cut-away reads, with their outline
    const glass = this.keep(new THREE.MeshBasicMaterial({ color: 0x9fb4ff, transparent: true, opacity: 0.05, depthWrite: false, side: THREE.DoubleSide }));
    for (const y of [y0, y1]) {
      const p = new THREE.Mesh(this.keep(new THREE.PlaneGeometry(L, H + 120)), glass);
      p.rotation.x = Math.PI / 2;
      p.position.set((x0 + x1) / 2, y, z0 + (H + 120) / 2);
      this.object.add(p);
    }
    const edges = new THREE.LineSegments(this.keep(new THREE.EdgesGeometry(this.keep(new THREE.BoxGeometry(L, W, H + 120)))), this.keep(new THREE.LineBasicMaterial({ color: 0x8fa8ff, transparent: true, opacity: 0.35 })));
    edges.position.set((x0 + x1) / 2, (y0 + y1) / 2, z0 + (H + 120) / 2);
    this.object.add(edges);
    // the sand: solid behind the robot's path, a thin veil in front, so the robot shows through a cut-away
    if (b.fill === "sand" || b.fill === "soil") {
      const top = b.fillTop;
      const cut = Math.min(y1 - 20, 160);
      const back = new THREE.Mesh(this.keep(new THREE.BoxGeometry(L, y1 - cut, top - z0)), this.keep(sandMaterial(1, top)));
      back.position.set((x0 + x1) / 2, (cut + y1) / 2, z0 + (top - z0) / 2);
      this.object.add(back);
      const front = new THREE.Mesh(this.keep(new THREE.BoxGeometry(L, cut - y0, top - z0)), this.keep(sandMaterial(0.13, top)));
      front.position.set((x0 + x1) / 2, (y0 + cut) / 2, z0 + (top - z0) / 2);
      front.renderOrder = 2;
      this.object.add(front);
    }
  }

  /** an open floor round the machine, with its blocks; a sloping floor tilts the whole scene */
  private buildFloor(g: NonNullable<SceneSpec["ground"]>) {
    const mb = this.modelBox;
    const size = mb.getSize(new THREE.Vector3());
    const span = Math.max(1500, 6 * Math.max(size.x, size.y));
    const c = mb.getCenter(new THREE.Vector3());
    const colour = FLOOR_COLOUR[g.label] ?? 0x8b8f96;
    const floor = new THREE.Mesh(this.keep(new THREE.BoxGeometry(span, span, 20)), this.keep(new THREE.MeshStandardMaterial({ color: colour, roughness: 0.95 })));
    floor.position.set(c.x, c.y, g.p[2] - 10.2);
    this.object.add(floor);
    // a light grid so movement over the floor reads
    const grid = new THREE.GridHelper(span, Math.round(span / 100), 0x000000, 0x000000);
    const gm = grid.material as THREE.Material;
    gm.transparent = true;
    gm.opacity = 0.12;
    this.keep(grid.geometry);
    this.keep(gm);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(c.x, c.y, g.p[2] + 0.2);
    this.object.add(grid);
    const blockMat = this.keep(new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.9 }));
    for (const bl of g.blocks) {
      const sz = [bl.max[0] - bl.min[0], bl.max[1] - bl.min[1], bl.max[2] - bl.min[2]];
      const m = new THREE.Mesh(this.keep(new THREE.BoxGeometry(sz[0], sz[1], sz[2])), blockMat);
      m.position.set((bl.min[0] + bl.max[0]) / 2, (bl.min[1] + bl.max[1]) / 2, (bl.min[2] + bl.max[2]) / 2);
      this.object.add(m);
    }
    if (g.down) {
      // the run keeps the machine's axes level with the floor and tilts gravity: tilt the picture back
      this.object.quaternion.setFromUnitVectors(new THREE.Vector3(...g.down).normalize(), new THREE.Vector3(0, 0, -1));
    }
  }

  // ---------- the machine ----------

  private buildBodies(parts: EvalPart[], meshes: Map<string, MeshEntry>) {
    const geos = new Map<string, THREE.BufferGeometry>();
    const mats = new Map<string, THREE.Material>();
    this.bodies = this.spec.bodies.map((s) => {
      const group = new THREE.Group();
      group.matrixAutoUpdate = false;
      this.object.add(group);
      return { spec: s, group, spins: s.spin.map((sp) => ({ group: new THREE.Group(), motor: sp.motor, sign: sp.sign })) };
    });
    for (const b of this.bodies) for (const sp of b.spins) {
      sp.group.matrixAutoUpdate = false;
      b.group.add(sp.group);
    }
    // a mechanism's bodies name their parts; loose boxes are drawn as boxes
    const byPart = new Map<string, Body>();
    for (const b of this.bodies) for (const id of b.spec.parts ?? []) byPart.set(id, b);
    const crate = this.keep(new THREE.MeshStandardMaterial({ color: 0xc8a27a, roughness: 0.8 }));
    for (const b of this.bodies) {
      const bx = b.spec.box;
      if (!bx) continue;
      const m = new THREE.Mesh(this.keep(new THREE.BoxGeometry(bx[0], bx[1], bx[2])), crate);
      m.position.set(...b.spec.origin);
      b.group.add(m);
    }
    const off = new Set(this.spec.off ?? []);
    for (const p of parts) {
      if (p.hidden || off.has(p.id)) continue;
      const entry = meshes.get(p.hash);
      const data = entry?.final ?? entry?.preview;
      if (!data || !entry) continue;
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
      // which body carries it: the one whose X range holds the part's centre
      const c = new THREE.Vector3((entry.bbox[0][0] + entry.bbox[1][0]) / 2, (entry.bbox[0][1] + entry.bbox[1][1]) / 2, (entry.bbox[0][2] + entry.bbox[1][2]) / 2).applyMatrix4(m);
      const body = byPart.size ? (byPart.get(p.id) ?? this.bodies[0]) : (this.bodies.find((b) => c.x >= b.spec.xmin && c.x < b.spec.xmax) ?? this.bodies[0]);
      if (!body) continue;
      const spinIdx = p.motion ? body.spec.spin.findIndex((sp) => c.x >= sp.xmin && c.x <= sp.xmax) : -1;
      (spinIdx >= 0 ? body.spins[spinIdx].group : body.group).add(mesh);
      const cat = p.bom?.catalogId && p.id === p.name ? catalogPart(p.bom.catalogId) : undefined;
      if (cat?.kind === "led") this.addLights(p.name, ledPoints(cat), m, spinIdx >= 0 ? body.spins[spinIdx].group : body.group);
    }
  }

  private addLights(comp: string, pts: [number, number, number][], m: THREE.Matrix4, group: THREE.Group) {
    if (!pts.length) return;
    const dotGeo = this.keep(new THREE.SphereGeometry(2.2, 10, 8));
    const glowGeo = this.keep(new THREE.SphereGeometry(6, 12, 10));
    const dots = new THREE.InstancedMesh(dotGeo, this.keep(new THREE.MeshBasicMaterial({ color: 0xffffff })), pts.length);
    const glow = new THREE.InstancedMesh(glowGeo, this.keep(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false })), pts.length);
    const off = new THREE.Color(0x2a2c30);
    pts.forEach((p, i) => {
      const at = new THREE.Matrix4().makeTranslation(...(new THREE.Vector3(...p).applyMatrix4(m).toArray() as [number, number, number]));
      dots.setMatrixAt(i, at);
      glow.setMatrixAt(i, at);
      dots.setColorAt(i, off);
      glow.setColorAt(i, new THREE.Color(0));
    });
    glow.renderOrder = 2;
    group.add(dots, glow);
    this.lights.push({ comp, n: pts.length, dots, glow });
  }

  /** each LED in the colour it showed at the frame on or before t (colours are not blended between frames) */
  private showLights(f: Frames, t: number) {
    if (!this.lights.length) return;
    const i = frameAt(f, t);
    const off = new THREE.Color(0x2a2c30);
    const c = new THREE.Color();
    for (const l of this.lights) {
      for (let k = 0; k < l.n; k++) {
        const v = f.series[`${l.comp}.led${k}`]?.[i] ?? 0;
        if (v > 0) {
          c.setRGB(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, THREE.SRGBColorSpace);
          // the dot shows the hue at full strength, so a dim LED still reads as lit; the glow follows its brightness
          const m = Math.max(c.r, c.g, c.b, 1e-3);
          l.dots.setColorAt(k, c.clone().multiplyScalar(1 / m));
          l.glow.setColorAt(k, c.clone().multiplyScalar((0.4 + 0.6 * m) / m));
        } else {
          l.dots.setColorAt(k, off);
          l.glow.setColorAt(k, new THREE.Color(0));
        }
      }
      if (l.dots.instanceColor) l.dots.instanceColor.needsUpdate = true;
      if (l.glow.instanceColor) l.glow.instanceColor.needsUpdate = true;
    }
  }

  /** Sand grains travelling back along each buried screw's flights, in the screw's body frame. */
  private buildParticles(screws: { motor: string; from: number; to: number; d: number; turn: number }[]) {
    if (!this.spec.box) return;
    const mat = this.keep(new THREE.PointsMaterial({ color: 0xe8cf9a, size: 3.2, sizeAttenuation: true, transparent: true, opacity: 0.85, depthWrite: false }));
    const per = 260;
    for (const s of screws) {
      const mid = (s.from + s.to) / 2;
      const body = this.bodies.find((b) => mid >= b.spec.xmin && mid < b.spec.xmax);
      if (!body) continue;
      // per grain: position along the screw (0..1), angle, radius jitter
      const data = new Float32Array(per * 3);
      for (let i = 0; i < per; i++) {
        data[i * 3] = Math.random();
        data[i * 3 + 1] = Math.random() * Math.PI * 2;
        data[i * 3 + 2] = 0.8 + Math.random() * 0.35;
      }
      const geo = this.keep(new THREE.BufferGeometry());
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(per * 3), 3));
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      pts.visible = false;
      this.object.add(pts);
      this.grains.push({ pts, data, motor: s.motor, from: s.from, to: s.to, r: s.d / 2, turn: s.turn, body });
    }
  }

  // ---------- playback ----------

  setFrames(frames: Frames) {
    this.frames = frames;
    this.buildTrail();
    this.setTime(this.t);
  }

  setPlaying(on: boolean) {
    this.playing = on;
  }

  setTime(t: number) {
    this.t = t;
    const f = this.frames;
    if (!f) return;
    this.showLights(f, t);
    for (const b of this.bodies) {
      const id = b.spec.id;
      const px = valueAt(f, `${id}.px`, t);
      if (Number.isNaN(px)) {
        b.group.matrix.identity();
      } else {
        const m = new THREE.Matrix4().makeTranslation(px, valueAt(f, `${id}.py`, t), valueAt(f, `${id}.pz`, t));
        const r = f.series[`${id}.qw`]
          ? new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(valueAt(f, `${id}.qx`, t), valueAt(f, `${id}.qy`, t), valueAt(f, `${id}.qz`, t), valueAt(f, `${id}.qw`, t)).normalize())
          : new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(valueAt(f, `${id}.roll`, t) * D2R, -valueAt(f, `${id}.pitch`, t) * D2R, valueAt(f, `${id}.yaw`, t) * D2R, "ZYX"));
        const o = new THREE.Matrix4().makeTranslation(-b.spec.origin[0], -b.spec.origin[1], -b.spec.origin[2]);
        b.group.matrix.copy(m.multiply(r).multiply(o));
      }
      b.group.matrixWorldNeedsUpdate = true;
      for (const sp of b.spins) {
        const turns = valueAt(f, `${sp.motor}.turns`, t);
        sp.group.matrix.makeRotationX((Number.isNaN(turns) ? 0 : turns) * 2 * Math.PI * sp.sign);
        sp.group.matrixWorldNeedsUpdate = true;
      }
    }
    if (this.trail) {
      const i = frameAt(f, t);
      const upto = this.trail.samples.findIndex((k) => k > i);
      const rings = upto < 0 ? this.trail.samples.length : upto;
      this.trail.mesh.geometry.setDrawRange(0, Math.max(0, rings - 1) * this.trail.seg * 6);
    }
    this.updateParticles(0);
  }

  /** The tunnel: a tube along the nose's path, revealed up to the current time. */
  private buildTrail() {
    if (this.trail) {
      this.object.remove(this.trail.mesh);
      this.trail.mesh.geometry.dispose();
      this.trail = null;
    }
    const tr = this.spec.trail;
    const f = this.frames;
    if (!tr || !f) return;
    const X = f.series[tr.channelX];
    const Y = f.series[tr.channelY];
    const Z = f.series[tr.channelZ];
    if (!X || !Y || !Z) return;
    const pts: THREE.Vector3[] = [];
    const samples: number[] = [];
    for (let i = 0; i < X.length; i++) {
      const p = new THREE.Vector3(X[i], Y[i], Z[i]);
      if (!pts.length || p.distanceTo(pts[pts.length - 1]) > 12) {
        pts.push(p);
        samples.push(i);
      }
    }
    if (pts.length < 2) return;
    const seg = 14;
    const r = tr.d / 2 + 3;
    const pos = new Float32Array(pts.length * seg * 3);
    const idx: number[] = [];
    const up = new THREE.Vector3(0, 0, 1);
    for (let i = 0; i < pts.length; i++) {
      const d = (i < pts.length - 1 ? pts[i + 1].clone().sub(pts[i]) : pts[i].clone().sub(pts[i - 1])).normalize();
      const u = new THREE.Vector3().crossVectors(d, up).normalize();
      const v = new THREE.Vector3().crossVectors(u, d).normalize();
      for (let k = 0; k < seg; k++) {
        const a = (k / seg) * Math.PI * 2;
        const q = pts[i].clone().addScaledVector(u, Math.cos(a) * r).addScaledVector(v, Math.sin(a) * r);
        pos.set([q.x, q.y, q.z], (i * seg + k) * 3);
      }
      if (i < pts.length - 1)
        for (let k = 0; k < seg; k++) {
          const a = i * seg + k;
          const b = i * seg + ((k + 1) % seg);
          idx.push(a, b, a + seg, b, b + seg, a + seg);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, this.keep(new THREE.MeshStandardMaterial({ color: 0x5a4126, roughness: 1, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false })));
    mesh.renderOrder = 1;
    this.object.add(mesh);
    this.trail = { mesh, rings: pts.length, samples, seg };
  }

  private updateParticles(dt: number) {
    const f = this.frames;
    if (!f) return;
    for (const g of this.grains) {
      const rpm = valueAt(f, `${g.motor}.rpm`, this.t);
      const buried = valueAt(f, `${g.motor}.buried`, this.t);
      const on = Number.isFinite(rpm) && Math.abs(rpm) > 0.5 && (Number.isNaN(buried) || buried > 5);
      g.pts.visible = on;
      if (!on) continue;
      const len = g.to - g.from;
      // grains move back along the flights about a pitch a turn, shown faster so the flow reads
      const speed = (Math.abs(rpm) / 60) * 240;
      const spin = (rpm / 60) * 2 * Math.PI * g.turn;
      const pos = g.pts.geometry.getAttribute("position") as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      const m = g.body.group.matrix;
      const v = new THREE.Vector3();
      for (let i = 0; i < g.data.length / 3; i++) {
        let u = g.data[i * 3];
        let a = g.data[i * 3 + 1];
        if (this.playing && dt > 0) {
          u -= (speed * dt) / len;
          if (u < 0) u += 1;
          a += spin * dt;
          g.data[i * 3] = u;
          g.data[i * 3 + 1] = a;
        }
        const r = g.r * g.data[i * 3 + 2];
        v.set(g.from + u * len, Math.cos(a) * r, Math.sin(a) * r).applyMatrix4(m);
        arr[i * 3] = v.x;
        arr[i * 3 + 1] = v.y;
        arr[i * 3 + 2] = v.z;
      }
      pos.needsUpdate = true;
    }
  }

  tick(_now: number, dt: number): boolean {
    if (!this.playing) return false;
    this.updateParticles(Math.min(dt, 0.1));
    return true;
  }

  still() {
    this.playing = false;
  }

  /** The box the camera frames: the bottom of the pit around the path, or the bench. */
  frameBox(whole = false): THREE.Box3 {
    const b = this.spec.box;
    if (!b) return this.modelBox.clone().expandByScalar(Math.max(40, this.modelBox.getSize(new THREE.Vector3()).length() * 0.15));
    if (whole) return new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max));
    const zTop = Math.min(b.max[2], (this.spec.target?.at[2] ?? 100) + 500);
    return new THREE.Box3(new THREE.Vector3(b.min[0] - 150, b.min[1], b.min[2]), new THREE.Vector3(b.max[0] + 150, b.max[1], zTop));
  }

  /** Where the machine's nose (or the body the scene follows) is now, for a camera that follows it. */
  nose(): THREE.Vector3 | null {
    const tr = this.spec.trail;
    const f = this.frames;
    const fb = this.spec.follow;
    if (fb && f && !tr) {
      const x = valueAt(f, `${fb}.px`, this.t);
      return Number.isNaN(x) ? null : new THREE.Vector3(x, valueAt(f, `${fb}.py`, this.t), valueAt(f, `${fb}.pz`, this.t)).applyQuaternion(this.object.quaternion);
    }
    if (!tr || !f) return null;
    const x = valueAt(f, tr.channelX, this.t);
    return Number.isNaN(x) ? null : new THREE.Vector3(x, valueAt(f, tr.channelY, this.t), valueAt(f, tr.channelZ, this.t));
  }

  /** The box a following camera frames round the nose. */
  followBox(n: THREE.Vector3): THREE.Box3 {
    if (this.spec.box) return new THREE.Box3(n.clone().add(new THREE.Vector3(-650, -150, -150)), n.clone().add(new THREE.Vector3(150, 150, 150)));
    const r = Math.max(150, this.modelBox.getSize(new THREE.Vector3()).length() * 0.75);
    return new THREE.Box3(n.clone().subScalar(r), n.clone().addScalar(r));
  }

  dispose() {
    if (this.trail) this.trail.mesh.geometry.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
