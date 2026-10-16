// Draws a structural analysis result on the model: a banded colour map of
// the chosen field on the real CAD surface, the deformed shape (exaggerated,
// optionally animated between unloaded and loaded), a ghost of the original
// outline, load arrows, support markers and labelled hot spots. Plugs into
// the scene through SceneOverlay and knows nothing else about it.

import * as THREE from "three";
import type { StructuralResult } from "../../analysis/fe/structural";
import { safetyT, type ScaleMode } from "../../analysis/colormap";
import type { ResultField } from "../../analysis/runtime";
import type { SceneOverlay } from "./scene";
import { fmtNum } from "../../lang/values";

export interface OverlayConfig {
  field: ResultField;
  /** displacement multiplier applied to the shape (1 = true scale) */
  scale: number;
  animate: boolean;
  safetyTarget: number;
}

export interface ProbeHit {
  value: number;
  field: ResultField;
  part: string;
  point: THREE.Vector3;
}

const LOAD_COLOR = 0xffb454;
const GRAVITY_COLOR = 0xc792ff;
const SUPPORT_COLOR = 0x4fd1c5;
const BANDS = 12;

interface PartMesh {
  mesh: THREE.Mesh;
  ghost: THREE.LineSegments;
  tAttr: THREE.BufferAttribute;
  name: string;
  index: number;
}

export function fieldMode(field: ResultField): ScaleMode {
  return field === "safety" ? "safety" : field === "strain" ? "diverging" : "sequential";
}

/** The value range a field's colour scale spans. */
export function fieldRange(r: StructuralResult, field: ResultField): [number, number] {
  if (field === "stress") return [0, Math.max(r.ranges.stress[1], 1e-9)];
  if (field === "disp") return [0, Math.max(r.ranges.disp[1], 1e-12)];
  if (field === "strain") {
    const a = Math.max(Math.abs(r.ranges.strain[0]), Math.abs(r.ranges.strain[1]), 1e-12);
    return [-a, a];
  }
  return [0, 0];
}

export class ResultsOverlay implements SceneOverlay {
  readonly object = new THREE.Group();
  readonly replaces: Set<string>;
  private parts: PartMesh[] = [];
  private material: THREE.MeshStandardMaterial;
  private ghostMat = new THREE.LineBasicMaterial({ color: 0x8fa8ff, transparent: true, opacity: 0.22, depthWrite: false });
  private uniforms = { uScale: { value: 0 }, uMode: { value: 0 }, uBands: { value: BANDS } };
  private cfg: OverlayConfig = { field: "stress", scale: 1, animate: false, safetyTarget: 2 };
  private t0 = performance.now();
  private markers = new THREE.Group();
  private labels = new THREE.Group();
  private spots: THREE.Sprite[] = [];
  private disposables: { dispose(): void }[] = [];
  private size: number;

  constructor(private result: StructuralResult) {
    this.replaces = new Set(result.parts.map((p) => p.id));
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity);
    const hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const p of result.parts)
      for (let i = 0; i < p.positions.length; i += 3) {
        lo.min(new THREE.Vector3(p.positions[i], p.positions[i + 1], p.positions[i + 2]));
        hi.max(new THREE.Vector3(p.positions[i], p.positions[i + 1], p.positions[i + 2]));
      }
    this.size = Math.max(hi.distanceTo(lo), 1);

    this.material = new THREE.MeshStandardMaterial({ metalness: 0, roughness: 0.62, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nattribute vec3 aDisp;\nattribute float aT;\nuniform float uScale;\nvarying float vT;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\ntransformed += aDisp * uScale;\nvT = aT;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform float uMode;\nuniform float uBands;\nvarying float vT;\n" + GLSL_COLORMAPS)
        .replace("vec4 diffuseColor = vec4( diffuse, opacity );", "vec4 diffuseColor = vec4( kerfResultColor(vT, uMode, uBands), opacity );\nif (!gl_FrontFacing) diffuseColor.rgb = vec3(0.09, 0.1, 0.13);")
        .replace("vec3 totalEmissiveRadiance = emissive;", "vec3 totalEmissiveRadiance = emissive + diffuseColor.rgb * 0.22;");
    };
    this.material.customProgramCacheKey = () => "kerf-results-v1";
    this.disposables.push(this.material, this.ghostMat);

    result.parts.forEach((p, index) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(p.positions, 3));
      if (p.normals && p.normals.length === p.positions.length) g.setAttribute("normal", new THREE.BufferAttribute(p.normals, 3));
      else g.computeVertexNormals();
      g.setIndex(new THREE.BufferAttribute(p.indices, 1));
      g.setAttribute("aDisp", new THREE.BufferAttribute(p.disp, 3));
      const tAttr = new THREE.BufferAttribute(new Float32Array(p.stress.length), 1);
      g.setAttribute("aT", tAttr);
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, this.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.partIndex = index;
      const eg = new THREE.EdgesGeometry(g, 28);
      const ghost = new THREE.LineSegments(eg, this.ghostMat);
      ghost.renderOrder = 2;
      this.object.add(mesh, ghost);
      this.parts.push({ mesh, ghost, tAttr, name: p.name, index });
      this.disposables.push(g, eg);
    });

    this.buildMarkers();
    this.object.add(this.markers, this.labels);
    this.configure(this.cfg);
  }

  configure(cfg: OverlayConfig) {
    const fieldChanged = cfg.field !== this.cfg.field || cfg.safetyTarget !== this.cfg.safetyTarget;
    this.cfg = cfg;
    this.uniforms.uMode.value = cfg.field === "safety" ? 1 : cfg.field === "strain" ? 2 : 0;
    if (fieldChanged || !this.filled) this.fill();
    this.uniforms.uScale.value = cfg.animate ? this.uniforms.uScale.value : cfg.scale;
    for (const p of this.parts) p.ghost.visible = cfg.scale > 0;
    this.placeSpotLabels();
  }
  private filled = false;

  /** normalised colour position per vertex for the current field */
  private fill() {
    this.filled = true;
    const r = this.result;
    const [lo, hi] = fieldRange(r, this.cfg.field);
    for (const p of this.parts) {
      const f = r.parts[p.index];
      const out = p.tAttr.array as Float32Array;
      for (let v = 0; v < out.length; v++) {
        let t: number;
        if (this.cfg.field === "safety") t = safetyT(f.safety[v], this.cfg.safetyTarget);
        else if (this.cfg.field === "disp") t = Math.hypot(f.disp[3 * v], f.disp[3 * v + 1], f.disp[3 * v + 2]) / hi;
        else if (this.cfg.field === "strain") t = 0.5 + (0.5 * f.strain[v]) / hi;
        else t = (f.stress[v] - lo) / (hi - lo);
        out[v] = Math.min(1, Math.max(0, t));
      }
      p.tAttr.needsUpdate = true;
    }
  }

  tick(now: number): boolean {
    let active = false;
    if (this.cfg.animate && this.cfg.scale > 0) {
      const k = 0.5 - 0.5 * Math.cos(((now - this.t0) / 2400) * Math.PI * 2);
      this.uniforms.uScale.value = this.cfg.scale * k;
      active = true;
    } else if (this.uniforms.uScale.value !== this.cfg.scale) {
      this.uniforms.uScale.value = this.cfg.scale;
      active = true;
    }
    // hot spot rings breathe
    const pulse = 1 + 0.18 * Math.sin(now / 260);
    for (const s of this.spots) s.scale.setScalar(s.userData.base * pulse);
    if (this.spots.length) active = true;
    return active;
  }

  still() {
    this.uniforms.uScale.value = this.cfg.scale;
    for (const s of this.spots) s.scale.setScalar(s.userData.base);
  }

  setClipping(planes: THREE.Plane[] | null) {
    this.material.clippingPlanes = planes;
    this.ghostMat.clippingPlanes = planes;
    this.material.needsUpdate = true;
    this.ghostMat.needsUpdate = true;
  }

  /** The field value under a ray, interpolated inside the triangle hit. */
  probe(ray: THREE.Raycaster, section: THREE.Plane | null): ProbeHit | null {
    const hits = ray.intersectObjects(
      this.parts.map((p) => p.mesh),
      false,
    );
    for (const h of hits) {
      if (section && section.distanceToPoint(h.point) < 0) continue;
      if (!h.face) continue;
      const pi = h.object.userData.partIndex as number;
      const f = this.result.parts[pi];
      const { a, b, c } = h.face;
      const P = f.positions;
      const pa = new THREE.Vector3(P[3 * a], P[3 * a + 1], P[3 * a + 2]);
      const pb = new THREE.Vector3(P[3 * b], P[3 * b + 1], P[3 * b + 2]);
      const pc = new THREE.Vector3(P[3 * c], P[3 * c + 1], P[3 * c + 2]);
      const bary = new THREE.Triangle(pa, pb, pc).getBarycoord(h.point, new THREE.Vector3());
      if (!bary) continue;
      const pick = (arr: Float32Array) => arr[a] * bary.x + arr[b] * bary.y + arr[c] * bary.z;
      let value: number;
      if (this.cfg.field === "disp") {
        const d = (i: number) => Math.hypot(f.disp[3 * i], f.disp[3 * i + 1], f.disp[3 * i + 2]);
        value = d(a) * bary.x + d(b) * bary.y + d(c) * bary.z;
      } else if (this.cfg.field === "safety") {
        // interpolate utilisation, as the solver does, so near-zero stress does not blow up
        const u = (i: number) => 1 / Math.max(f.safety[i], 1e-6);
        value = 1 / Math.max(u(a) * bary.x + u(b) * bary.y + u(c) * bary.z, 1e-9);
      } else value = pick(this.cfg.field === "strain" ? f.strain : f.stress);
      return { value, field: this.cfg.field, part: f.name, point: h.point.clone() };
    }
    return null;
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && !this.disposables.includes(m.geometry)) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (mat && !Array.isArray(mat) && !this.disposables.includes(mat)) {
        const tex = (mat as THREE.SpriteMaterial).map;
        tex?.dispose();
        mat.dispose();
      }
    });
  }

  // ---------- loads, supports and hot spots ----------

  private buildMarkers() {
    const r = this.result;
    const s = this.size;
    const mk = s * 0.016;
    // supports: small cones pressing into the surface (spheres for rollers)
    const supportLabels = new Set<string>();
    for (const sup of r.supports) {
      // keep markers about two marker-widths apart so a dense zone reads as dots, not a slab
      const keep: number[] = [];
      const seen = new Set<string>();
      const cell = mk * 2.2;
      for (let i = 0; i < sup.markers.length / 6; i++) {
        const k = `${Math.floor(sup.markers[6 * i] / cell)},${Math.floor(sup.markers[6 * i + 1] / cell)},${Math.floor(sup.markers[6 * i + 2] / cell)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        keep.push(i);
      }
      const n = keep.length;
      if (!n) continue;
      const geo = sup.dir ? new THREE.SphereGeometry(mk * 0.45, 10, 8) : new THREE.ConeGeometry(mk * 0.5, mk, 10);
      if (!sup.dir) geo.translate(0, -mk / 2, 0); // tip at the origin
      const mat = new THREE.MeshStandardMaterial({ color: SUPPORT_COLOR, emissive: SUPPORT_COLOR, emissiveIntensity: 0.35, roughness: 0.4 });
      const inst = new THREE.InstancedMesh(geo, mat, n);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const up = new THREE.Vector3(0, -1, 0);
      for (let i = 0; i < n; i++) {
        const o = 6 * keep[i];
        const pos = new THREE.Vector3(sup.markers[o], sup.markers[o + 1], sup.markers[o + 2]);
        const nrm = new THREE.Vector3(sup.markers[o + 3], sup.markers[o + 4], sup.markers[o + 5]);
        if (nrm.lengthSq() < 1e-9) nrm.set(0, 0, 1);
        nrm.normalize();
        // the cone's tip points along -Y in its own frame: turn it to point into the surface
        q.setFromUnitVectors(up, nrm.clone().negate());
        m.compose(sup.dir ? pos.clone().addScaledVector(nrm, mk * 0.45) : pos, q, new THREE.Vector3(1, 1, 1));
        inst.setMatrixAt(i, m);
      }
      this.markers.add(inst);
      this.disposables.push(geo, mat);
      // one label per kind of support: several screw zones all saying "fixed" only crowd the view
      const text = sup.dir ? `roller ${axisName(sup.dir)}` : "fixed";
      if (!supportLabels.has(text)) {
        supportLabels.add(text);
        this.label(text, new THREE.Vector3(...sup.at), "#4fd1c5", 0.8, false, "left");
      }
    }
    // loads: arrows that end on the loaded surface
    for (const ld of r.loads) {
      const at = new THREE.Vector3(...ld.at);
      if (ld.kind === "torque") {
        this.torqueArrow(at, ld);
        continue;
      }
      const v = new THREE.Vector3(...ld.vector);
      if (v.lengthSq() < 1e-18) continue;
      const dir = v.clone().normalize();
      const len = s * 0.16;
      this.arrow(at.clone().addScaledVector(dir, -len), dir, len, LOAD_COLOR);
      const text = ld.kind === "pressure" ? `${fmtNum(ld.magnitude / Math.max(ld.area, 1e-9), 3)} MPa · ${fmtNum(ld.magnitude, 1)} N` : `${fmtNum(ld.magnitude, 1)} N`;
      this.label(text, at.clone().addScaledVector(dir, -len * 0.6), "#ffb454", 1);
    }
    // self-weight gets an arrow only when it matters next to the other loads
    const applied = r.loads.reduce((sum, l) => sum + l.magnitude, 0);
    if (r.gravity) {
      const at = new THREE.Vector3(...r.gravity.at);
      const v = new THREE.Vector3(...r.gravity.vector);
      if (v.lengthSq() > 0 && (applied === 0 || v.length() >= 0.05 * applied)) {
        const dir = v.clone().normalize();
        const len = s * 0.12;
        this.arrow(at, dir, len, GRAVITY_COLOR);
        this.label(`weight ${fmtNum(v.length(), 2)} N`, at.clone().addScaledVector(dir, len * 1.15), "#c792ff", 0.9);
      }
    }
    // hot spots
    r.hotSpots.forEach((h, i) => {
      const ring = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture(), color: i === 0 ? 0xffffff : 0xdde3f0, depthTest: false, transparent: true, sizeAttenuation: false }));
      ring.position.set(...h.at);
      ring.userData.base = i === 0 ? 0.05 : 0.038;
      ring.renderOrder = 20;
      this.markers.add(ring);
      this.spots.push(ring);
    });
  }

  private spotLabels: THREE.Sprite[] = [];

  /** labels for the extremes of the field on show */
  private placeSpotLabels() {
    for (const l of this.spotLabels) {
      this.labels.remove(l);
      l.material.map?.dispose();
      l.material.dispose();
    }
    this.spotLabels = [];
    const r = this.result;
    const add = (text: string, at: number[], color: string) => this.spotLabels.push(this.label(text, new THREE.Vector3(at[0], at[1], at[2]), color, 1, true));
    if (this.cfg.field === "stress") {
      add(`peak ${fmtNum(r.maxStress.value, 1)} MPa`, r.maxStress.at, "#ffffff");
    } else if (this.cfg.field === "safety") add(`safety ${fmtNum(r.minSafety.value, 2)}${r.minSafety.mode === "layers" ? " (layers)" : ""}`, r.minSafety.at, "#ffffff");
    else if (this.cfg.field === "disp") add(`${fmtNum(r.maxDisp.value, 3)} mm`, r.maxDisp.at, "#ffffff");
    else add(`${fmtNum(r.maxStrain.value * 100, 3)} % strain`, r.maxStrain.at, "#ffffff");
  }

  private arrow(from: THREE.Vector3, dir: THREE.Vector3, len: number, color: number) {
    const head = len * 0.24;
    const shaftGeo = new THREE.CylinderGeometry(len * 0.022, len * 0.022, len - head, 10);
    shaftGeo.translate(0, (len - head) / 2, 0);
    const headGeo = new THREE.ConeGeometry(len * 0.075, head, 16);
    headGeo.translate(0, len - head / 2, 0);
    const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.45, roughness: 0.35 });
    const g = new THREE.Group();
    g.add(new THREE.Mesh(shaftGeo, mat), new THREE.Mesh(headGeo, mat));
    g.position.copy(from);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    this.markers.add(g);
    this.disposables.push(shaftGeo, headGeo, mat);
  }

  private torqueArrow(at: THREE.Vector3, ld: StructuralResult["loads"][number]) {
    // counter-clockwise looking down the axis (right-hand rule); a negative torque arrives with its axis flipped
    const ax = new THREE.Vector3(...(ld.axis ?? [0, 0, 1])).normalize();
    const rad = this.size * 0.07;
    const tube = rad * 0.07;
    const arc = Math.PI * 1.5;
    const geo = new THREE.TorusGeometry(rad, tube, 8, 48, arc);
    const head = new THREE.ConeGeometry(tube * 2.6, tube * 7, 14);
    // the cone points along +Y: the counter-clockwise tangent at angle 0, then carried to the arc's end
    head.translate(rad, 0, 0);
    head.rotateZ(arc);
    const mat = new THREE.MeshStandardMaterial({ color: LOAD_COLOR, emissive: LOAD_COLOR, emissiveIntensity: 0.45, roughness: 0.35 });
    const g = new THREE.Group();
    g.add(new THREE.Mesh(geo, mat), new THREE.Mesh(head, mat));
    g.position.copy(at);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), ax);
    this.markers.add(g);
    this.disposables.push(geo, head, mat);
    this.label(`${fmtNum(ld.magnitude / 1000, 3)} N·m`, at.clone().add(new THREE.Vector3(rad, rad, 0).applyQuaternion(g.quaternion)), "#ffb454", 1);
  }

  /** a flat label that keeps its size on screen; it sits to the right of its point, or the left so support labels and result labels don't cover each other */
  private label(text: string, at: THREE.Vector3, color: string, weight: number, strong = false, side: "right" | "left" = "right"): THREE.Sprite {
    const dpr = 2;
    const font = `${strong ? 600 : 500} ${12 * dpr}px 'IBM Plex Mono', ui-monospace, monospace`;
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d")!;
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) + 14 * dpr;
    const h = 22 * dpr;
    c.width = w;
    c.height = h;
    ctx.font = font;
    ctx.fillStyle = "rgba(10, 13, 19, 0.82)";
    roundRect(ctx, 0.5, 0.5, w - 1, h - 1, 6 * dpr);
    ctx.fill();
    ctx.strokeStyle = color + "66";
    ctx.lineWidth = dpr;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textBaseline = "middle";
    ctx.fillText(text, 7 * dpr, h / 2 + dpr);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false, opacity: weight }));
    const hgt = 0.025;
    sp.scale.set((hgt * w) / h, hgt, 1);
    sp.center.set(side === "right" ? -0.08 : 1.08, -0.35);
    sp.position.copy(at);
    sp.renderOrder = 30;
    this.labels.add(sp);
    return sp;
  }
}

function axisName(d: number[]): string {
  const k = d.findIndex((v) => Math.abs(v) > 0.5);
  return k >= 0 ? "XYZ"[k] : "";
}

let ringTex: THREE.Texture | null = null;
function ringTexture(): THREE.Texture {
  // shared across overlays; never disposed with one
  if (ringTex) return ringTex.clone();
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(64, 64, 50, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(64, 64, 60, 0, Math.PI * 2);
  ctx.stroke();
  ringTex = new THREE.CanvasTexture(c);
  return ringTex.clone();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// GLSL copies of src/analysis/colormap.ts; colours are converted to linear for lighting
const GLSL_COLORMAPS = /* glsl */ `
vec3 kerfToLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 kerfTurbo(float x) {
  x = clamp(x, 0.0, 1.0);
  vec4 v4 = vec4(1.0, x, x * x, x * x * x);
  vec2 v2 = v4.zw * v4.z;
  return clamp(vec3(
    dot(v4, vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234)) + dot(v2, vec2(-152.94239396, 59.28637943)),
    dot(v4, vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333)) + dot(v2, vec2(4.27729857, 2.82956604)),
    dot(v4, vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771)) + dot(v2, vec2(-89.90310912, 27.34824973))
  ), 0.0, 1.0);
}
vec3 kerfSafety(float t) {
  if (t < 0.25) return mix(vec3(0.557, 0.043, 0.149), vec3(1.0, 0.302, 0.369), t / 0.25);
  if (t < 0.5) return mix(vec3(1.0, 0.541, 0.239), vec3(1.0, 0.824, 0.369), (t - 0.25) / 0.25);
  return mix(vec3(0.239, 0.863, 0.592), vec3(0.157, 0.659, 0.784), min(1.0, (t - 0.5) / 0.5));
}
vec3 kerfDiverging(float t) {
  vec3 neg = vec3(0.231, 0.424, 1.0), mid = vec3(0.91, 0.925, 0.961), pos = vec3(1.0, 0.302, 0.369);
  return t < 0.5 ? mix(neg, mid, t / 0.5) : mix(mid, pos, min(1.0, (t - 0.5) / 0.5));
}
vec3 kerfMap(float t, float mode) {
  if (mode > 1.5) return kerfDiverging(t);
  if (mode > 0.5) return kerfSafety(t);
  return kerfTurbo(t);
}
vec3 kerfResultColor(float t, float mode, float bands) {
  t = clamp(t, 0.0, 1.0);
  vec3 c;
  if (mode > 0.5 && mode < 1.5) {
    c = kerfMap(t, mode);
  } else {
    float tb = (floor(min(t, 0.9999) * bands) + 0.5) / bands;
    c = mix(kerfMap(t, mode), kerfMap(tb, mode), 0.7);
    // thin contour lines between bands
    float f = fract(t * bands);
    float w = fwidth(t * bands);
    float line = 1.0 - smoothstep(0.0, w * 1.3, min(f, 1.0 - f));
    c *= 1.0 - 0.28 * line;
  }
  return kerfToLinear(c);
}
`;
