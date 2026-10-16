// A shot's own little studio: the product's parts with their materials, the
// set (studio floor, paper sweep or a surface), scale props, the key light
// and a camera solved from the shot's angle, lens and composition. It is a
// separate three.js scene that shares the viewport's renderer, geometry and
// lighting environments, so a shot renders the same parts the viewport shows
// without disturbing it. pose(t) moves everything for an animation frame.

import * as THREE from "three";
import type { Model, EvalPart } from "../../../core/model";
import type { V3 } from "../../../kernel/recipe";
import { aspectRatio, apertureDiameter, MOTIONS, type ShotSpec } from "../../../shots/spec";
import { depthOf, orbitCameras, shotBasis, solveFraming, type ShotCamera } from "../../../shots/camera";
import { applyAppearance, partUniforms, patchPartMaterial, type PartUniforms } from "../render/partShader";
import type { Appearance } from "../render/appearance";
import { concentricDisc, dirFrom, halton, lightingPreset, type LightingPreset, type StudioEnvironments } from "../render/studio";
import { surfaceLook } from "./surfaces";
import { buildProp, disposeProp, placeProps, propRadius } from "./props";

/** A part as the viewport holds it: geometry, placement and look. */
export interface ShotPart {
  id: string;
  part: EvalPart;
  geometry: THREE.BufferGeometry;
  geoKey: string;
  /** the part's placement in the assembly */
  placement: THREE.Matrix4;
  /** local-space centre, for the explode direction */
  center: THREE.Vector3;
  look: Appearance;
}

/** What a shot needs from the viewport. */
export interface ShotSource {
  renderer: THREE.WebGLRenderer;
  envs: StudioEnvironments;
  parts(): ShotPart[];
}

interface RigPart {
  src: ShotPart;
  group: THREE.Group;
  mesh: THREE.Mesh;
  cap: THREE.Mesh | null;
  mat: THREE.MeshPhysicalMaterial;
  capMat: THREE.MeshPhysicalMaterial | null;
  u: PartUniforms;
  ghost: boolean;
  /** world offset at explode 1 */
  explode: THREE.Vector3;
  /** world centre, assembled */
  worldCenter: THREE.Vector3;
  /** 0..1: when this part lands in an assemble animation */
  order: number;
  framed: boolean;
}

/** Seamless paper colour for each lighting, when the shot gives none. */
const PAPER: Record<string, string> = { studio: "#2b2e34", showroom: "#e8eaed", blueprint: "#14213a", workshop: "#3b342d", daylight: "#d8d3cb" };

const ease = (k: number) => (k <= 0 ? 0 : k >= 1 ? 1 : k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const easeOut = (k: number) => (k <= 0 ? 0 : k >= 1 ? 1 : 1 - Math.pow(1 - k, 3));
const v3 = (v: THREE.Vector3): V3 => [v.x, v.y, v.z];
const tv = (v: V3) => new THREE.Vector3(v[0], v[1], v[2]);

/** A pose of the animated things: everything a frame needs. */
interface Pose {
  explode: number;
  /** extra explode per part (assemble) */
  perPart?: (p: RigPart) => number;
  /** driver angle for mechanisms, degrees */
  drive: number;
  /** turntable: the product turned about the vertical axis through the pivot, degrees */
  spin: number;
  /** where the section plane is, as a fraction from its start (1 = the shot's plane) */
  cut: number;
}

export interface RigOptions {
  /** shadow map size */
  shadowSize?: number;
  /** points sampled for framing (fewer for live dragging) */
  framingPoints?: number;
}

export class ShotRig {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(30, 16 / 9, 1, 100000);
  readonly preset: LightingPreset;
  readonly aspect: number;
  readonly parts: RigPart[] = [];
  readonly set = new THREE.Group();
  readonly props = new THREE.Group();
  readonly key: THREE.DirectionalLight;
  readonly keyDir: THREE.Vector3;
  readonly lightAngle: number;
  /** the section plane, when the shot cuts */
  readonly clip: THREE.Plane | null = null;
  /** what keeps the shot from rendering as asked, found while setting up */
  readonly problems: string[] = [];
  floorZ = 0;
  /** centre and diagonal of the assembled, shown parts */
  readonly bc = new THREE.Vector3();
  readonly size: number;
  readonly subject = new THREE.Box3();
  /** the camera for the current pose */
  cam!: ShotCamera;
  /** focus distance along the view, mm */
  focusDist = 0;
  /** aperture diameter, mm (0: everything sharp) */
  aperture = 0;
  backdropColor = new THREE.Color();
  /** how the set looks around the edges, for the composite's background */
  bg = { top: new THREE.Color(), bottom: new THREE.Color(), glow: new THREE.Color(), glowAmt: 0 };
  /** the floor is a shadow catcher (studio and transparent backdrops) */
  readonly catcher: boolean = false;
  private catcherMesh: THREE.Mesh | null = null;
  private pivot = new THREE.Vector3();
  private cameraPlan: (t: number) => ShotCamera;
  private poseAt: (t: number) => Pose;
  private section: { axis: 0 | 1 | 2; at: number; keep: 1 | -1; from: number } | null = null;
  private baseProj = new THREE.Matrix4();
  private basePos = new THREE.Vector3();
  private disposed = false;
  readonly duration: number;

  constructor(
    src: ShotSource,
    readonly spec: ShotSpec,
    model: Model,
    private opts: RigOptions = {},
  ) {
    this.aspect = aspectRatio(spec.aspect);
    this.preset = lightingPreset(spec.lighting);
    this.lightAngle = spec.lightAngle ?? 0;
    this.duration = spec.motion === "none" ? 0 : spec.duration;
    const p = this.preset;
    this.scene.environment = src.envs.get(p);
    this.scene.environmentIntensity = p.envIntensity;
    this.scene.environmentRotation.set(0, 0, THREE.MathUtils.degToRad(this.lightAngle));
    this.camera.up.set(0, 0, 1);

    // ---- parts ----
    const named = (part: EvalPart, list: string[]) => list.some((n) => part.name === n || part.id === n || part.group === n);
    const frameAll = !spec.frame.length;
    const shown = src.parts().filter((sp) => !sp.part.hidden && !named(sp.part, spec.hide) && model.parts.some((m) => m.id === sp.id));
    const root = new THREE.Group();
    this.scene.add(root);
    for (const sp of shown) {
      const ghost = named(sp.part, spec.ghost);
      const u = partUniforms();
      const mat = new THREE.MeshPhysicalMaterial();
      patchPartMaterial(mat, u);
      applyAppearance(mat, u, sp.look);
      if (sp.part.imported?.faceColors && sp.geometry.getAttribute("color")) {
        mat.vertexColors = true;
        mat.color.set(0xffffff);
      }
      u.uNoiseScale.value = 7 / Math.max((sp.geometry.boundingSphere?.radius ?? 10) * 2, 1);
      if (ghost) {
        mat.transparent = true;
        mat.opacity = 0.16;
        mat.depthWrite = false;
        mat.roughness = Math.min(mat.roughness, 0.3);
      }
      const mesh = new THREE.Mesh(sp.geometry, mat);
      mesh.castShadow = !ghost;
      mesh.receiveShadow = true;
      mesh.userData.partId = sp.id;
      const group = new THREE.Group();
      group.matrixAutoUpdate = false;
      group.add(mesh);
      root.add(group);
      if (!sp.geometry.boundingBox) sp.geometry.computeBoundingBox();
      const worldCenter = sp.center.clone().applyMatrix4(sp.placement);
      this.parts.push({ src: sp, group, mesh, cap: null, mat, capMat: null, u, ghost, explode: new THREE.Vector3(), worldCenter, order: 0, framed: frameAll ? !ghost || shown.every((x) => named(x.part, spec.ghost)) : named(sp.part, spec.frame) });
    }
    if (!this.parts.length) this.problems.push("Nothing to photograph: every part is hidden");
    if (!frameAll && !this.parts.some((r) => r.framed)) {
      this.problems.push("None of the framed parts are shown; framing everything instead");
      for (const r of this.parts) r.framed = !r.ghost;
    }
    if (!this.parts.some((r) => r.framed)) for (const r of this.parts) r.framed = true;
    for (const r of this.parts) this.subject.union(r.src.geometry.boundingBox!.clone().applyMatrix4(r.src.placement));
    if (this.subject.isEmpty()) this.subject.set(new THREE.Vector3(-20, -20, 0), new THREE.Vector3(20, 20, 20));
    this.subject.getCenter(this.bc);
    this.size = Math.max(this.subject.getSize(new THREE.Vector3()).length(), 1);
    // explode directions, as the viewport does them
    for (const r of this.parts) {
      const d = r.worldCenter.clone().sub(this.bc);
      if (d.lengthSq() < 1e-6) d.set(0, 0, 1);
      r.explode.copy(d.normalize().multiplyScalar(this.size * 0.45 * (0.4 + r.worldCenter.distanceTo(this.bc) / this.size)));
    }
    // assembly order: from the bottom up, inner parts before outer ones at one height
    const byOrder = [...this.parts].sort((a, b) => a.worldCenter.z - b.worldCenter.z || a.worldCenter.distanceTo(this.bc) - b.worldCenter.distanceTo(this.bc));
    byOrder.forEach((r, i) => (r.order = byOrder.length > 1 ? i / (byOrder.length - 1) : 0));
    this.pivot.set(this.bc.x, this.bc.y, this.subject.min.z);

    // ---- section ----
    if (spec.section) {
      const axis = ({ x: 0, y: 1, z: 2 } as const)[spec.section.axis];
      const at = spec.section.at ?? (this.subject.min.getComponent(axis) + this.subject.max.getComponent(axis)) / 2;
      // keep the half away from the camera
      const camSide = Math.sign(shotBasis(spec.angle).forward[axis]) || 1;
      const keep = (camSide > 0 ? 1 : -1) as 1 | -1;
      const n = new THREE.Vector3().setComponent(axis, keep);
      this.clip = new THREE.Plane(n, -keep * at);
      const from = keep > 0 ? this.subject.min.getComponent(axis) - this.size * 0.02 : this.subject.max.getComponent(axis) + this.size * 0.02;
      this.section = { axis, at, keep, from };
      for (const r of this.parts) {
        r.mat.clippingPlanes = [this.clip];
        if (r.ghost) continue;
        // the cut face: the part's colour, lit as a flat face looking at the camera
        const capMat = new THREE.MeshPhysicalMaterial({ side: THREE.BackSide, color: new THREE.Color(r.src.look.color).multiplyScalar(0.82), roughness: 0.62, metalness: Math.min(0.5, r.mat.metalness), clippingPlanes: [this.clip] });
        const capNormal = { value: n.clone().negate() };
        capMat.onBeforeCompile = (sh) => {
          sh.uniforms.uCapN = capNormal;
          sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nuniform vec3 uCapN;").replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\n  normal = normalize((viewMatrix * vec4(uCapN, 0.0)).xyz);");
        };
        capMat.customProgramCacheKey = () => "kerf-shot-cap";
        const cap = new THREE.Mesh(r.src.geometry, capMat);
        r.group.add(cap);
        r.cap = cap;
        r.capMat = capMat;
      }
    }
    if (spec.motion === "mechanism" && !this.parts.some((r) => r.src.part.motion?.ratio)) this.problems.push("Nothing in this design moves, so the mechanism animation shows it still");

    // ---- key light ----
    this.keyDir = dirFrom(p.key.az + this.lightAngle, p.key.el);
    this.key = new THREE.DirectionalLight(p.key.color, p.key.i);
    this.key.castShadow = true;
    const ss = opts.shadowSize ?? 2048;
    this.key.shadow.mapSize.set(ss, ss);
    this.key.shadow.bias = -0.0002;
    this.key.shadow.normalBias = Math.max(0.02, this.size * 0.0025);
    this.scene.add(this.key, this.key.target);

    // ---- motion and camera ----
    this.poseAt = this.motionPoses();
    this.cameraPlan = this.planCamera();
    this.buildSet();
    this.scene.add(this.set);
    this.pose(0);
  }

  // ---------------- motion ----------------

  private motionPoses(): (t: number) => Pose {
    const s = this.spec;
    const still: Pose = { explode: s.explode, drive: 0, spin: 0, cut: 1 };
    const T = Math.max(0.5, s.duration);
    switch (s.motion) {
      case "turntable":
        return (t) => ({ ...still, spin: (360 * t) / T });
      case "explode": {
        const peak = Math.max(s.explode, 0.6);
        // out over the first 40%, hold, back over the last 40%
        return (t) => {
          const k = t / T;
          const e = k < 0.4 ? ease(k / 0.4) : k < 0.6 ? 1 : 1 - ease((k - 0.6) / 0.4);
          return { ...still, explode: s.explode + (peak - s.explode) * e };
        };
      }
      case "assemble": {
        const spread = 1.1;
        return (t) => {
          const k = t / T;
          return {
            ...still,
            perPart: (r: RigPart) => {
              // each part flies in over a quarter of the animation, staggered by its order
              const start = r.order * 0.62;
              const local = (k - start) / 0.3;
              return spread * (1 - easeOut(local));
            },
          };
        };
      }
      case "mechanism":
        return (t) => ({ ...still, drive: (360 * t) / T });
      case "section_sweep":
        return (t) => ({ ...still, cut: ease(Math.min(1, (t / T) * 1.25)) });
      default:
        return () => still;
    }
  }

  /** The poses a camera must keep in frame: samples across the motion. */
  private framingPoses(): Pose[] {
    const s = this.spec;
    const T = Math.max(0.5, s.duration);
    switch (s.motion) {
      case "turntable":
        return Array.from({ length: 16 }, (_, i) => this.poseAt((i / 16) * T));
      case "explode":
        return [this.poseAt(0), this.poseAt(T * 0.5)];
      case "assemble":
        return [this.poseAt(T), this.poseAt(0)];
      case "mechanism":
        return [0, 0.25, 0.5, 0.75].map((k) => this.poseAt(k * T));
      default:
        return [this.poseAt(0)];
    }
  }

  private planCamera(): (t: number) => ShotCamera {
    const s = this.spec;
    const framing = { angle: s.angle, roll: s.roll, lens: s.lens, fill: s.fill, offset: s.offset, aspect: this.aspect };
    const budget = this.opts.framingPoints ?? 6000;
    const poses = this.framingPoses();
    const per = Math.max(400, Math.floor(budget / poses.length));
    const pts: V3[] = poses.flatMap((p) => this.subjectPoints(p, per));
    // props are part of the picture: keep them in frame
    const basis = shotBasis(s.angle, s.roll);
    this.placeProps(basis);
    const box = new THREE.Box3();
    for (const c of this.props.children) {
      box.setFromObject(c);
      for (let i = 0; i < 8; i++) pts.push([i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z]);
    }
    const T = Math.max(0.5, s.duration);
    if (s.motion === "orbit") {
      const n = 41;
      const turns = Array.from({ length: n }, (_, i) => -20 + (40 * i) / (n - 1));
      const cams = orbitCameras(pts, framing, turns);
      return (t) => {
        // swing out and back
        const k = Math.sin((t / T) * Math.PI * 2) * 0.5 + 0.5;
        const f = k * (n - 1);
        const i = Math.min(n - 2, Math.floor(f));
        return lerpCamera(cams[i], cams[i + 1], f - i);
      };
    }
    if (s.motion === "push_in") {
      const a = solveFraming(pts, { ...framing, fill: Math.max(0.15, s.fill * 0.8) });
      const b = solveFraming(pts, { ...framing, fill: Math.min(1.1, s.fill * 1.12) });
      return (t) => lerpCamera(a, b, ease(t / T));
    }
    const cam = solveFraming(pts, framing);
    return () => cam;
  }

  /** World points of the framed parts in a pose (sampled vertices). */
  private subjectPoints(pose: Pose, budget: number): V3[] {
    const framed = this.parts.filter((r) => r.framed);
    const total = framed.reduce((n, r) => n + r.src.geometry.getAttribute("position").count, 0);
    const stride = Math.max(1, Math.ceil(total / budget));
    const out: V3[] = [];
    const m = new THREE.Matrix4();
    const v = new THREE.Vector3();
    for (const r of framed) {
      this.partMatrix(r, pose, m);
      const pos = r.src.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i += stride) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m);
        out.push([v.x, v.y, v.z]);
      }
      // the bounding box corners keep thin features that sampling may skip
      const b = r.src.geometry.boundingBox!;
      if (stride > 4) for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(m);
        // only corners near the real surface would be right; use the box centre pulled halfway out
        const c = r.worldCenter.clone().applyMatrix4(new THREE.Matrix4().copy(m).multiply(r.src.placement.clone().invert()));
        out.push(v3(v.lerp(c, 0.3)));
      }
    }
    return out;
  }

  /** A part's world matrix in a pose. */
  private partMatrix(r: RigPart, pose: Pose, out: THREE.Matrix4): THREE.Matrix4 {
    const e = pose.explode + (pose.perPart ? pose.perPart(r) : 0);
    out.makeTranslation(r.explode.x * e, r.explode.y * e, r.explode.z * e);
    const mo = r.src.part.motion;
    if (mo && mo.ratio && pose.drive) {
      const o = tv(mo.origin);
      const rot = new THREE.Matrix4().makeRotationAxis(tv(mo.axis).normalize(), THREE.MathUtils.degToRad(pose.drive * mo.ratio));
      out.multiply(new THREE.Matrix4().makeTranslation(o.x, o.y, o.z)).multiply(rot).multiply(new THREE.Matrix4().makeTranslation(-o.x, -o.y, -o.z));
    }
    out.multiply(r.src.placement);
    if (pose.spin) {
      const p = this.pivot;
      const spin = new THREE.Matrix4().makeTranslation(p.x, p.y, 0).multiply(new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(-pose.spin))).multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, 0));
      out.premultiply(spin);
    }
    return out;
  }

  /** Move everything to time t (seconds) of the shot's motion; 0 is the still. */
  pose(t: number) {
    const pose = this.poseAt(Math.max(0, Math.min(t, this.duration || 0)));
    for (const r of this.parts) {
      this.partMatrix(r, pose, r.group.matrix);
      r.group.matrixWorldNeedsUpdate = true;
    }
    if (this.clip && this.section) {
      const s = this.section;
      const at = s.from + (s.at - s.from) * pose.cut;
      this.clip.constant = -s.keep * at;
    }
    this.cam = this.cameraPlan(t);
    this.applyCamera();
    this.scene.updateMatrixWorld(true);
  }

  private applyCamera() {
    const c = this.cam;
    const cam = this.camera;
    cam.position.set(...c.position);
    cam.up.set(...c.up);
    cam.lookAt(c.position[0] + c.forward[0], c.position[1] + c.forward[1], c.position[2] + c.forward[2]);
    cam.fov = c.vfov;
    cam.aspect = this.aspect;
    const reach = Math.max(c.distance, this.size);
    cam.near = Math.max(0.05, Math.min(c.depth[0] * 0.25, reach * 0.02));
    cam.far = reach * 80 + this.size * 40;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    this.basePos.copy(cam.position);
    this.baseProj.copy(cam.projectionMatrix);
    // focus and aperture
    const s = this.spec;
    let focus: THREE.Vector3;
    if (typeof s.focus === "string") {
      const hit = this.parts.filter((r) => r.src.part.name === s.focus || r.src.id === s.focus || r.src.part.group === s.focus);
      const box = new THREE.Box3();
      for (const r of hit) box.union(r.src.geometry.boundingBox!.clone().applyMatrix4(r.group.matrix));
      focus = box.isEmpty() ? tv(c.center) : box.getCenter(new THREE.Vector3());
    } else if (Array.isArray(s.focus)) focus = tv(s.focus);
    else focus = tv(c.center);
    this.focusDist = Math.max(cam.near * 2, depthOf(c, v3(focus)));
    this.aperture = s.aperture ? apertureDiameter(s.lens, s.aperture) : 0;
    this.placeKey(0);
  }

  // ---------------- the set ----------------

  private placeProps(basis: { right: V3; forward: V3 }) {
    for (const c of [...this.props.children]) {
      this.props.remove(c);
      disposeProp(c);
    }
    if (!this.spec.props.length) return;
    const floor = this.floorFor();
    // a turning product sweeps a circle: keep props outside it
    const keepOut = this.spec.motion === "turntable" ? Math.hypot(this.subject.max.x - this.pivot.x, this.subject.max.y - this.pivot.y, this.subject.min.x - this.pivot.x) * 0.75 : 0;
    const away = new THREE.Vector3(-basis.forward[0], -basis.forward[1], 0);
    for (const pl of placeProps(this.spec.props, this.subject, floor, tv(basis.right), away, keepOut)) {
      const g = buildProp(pl.id);
      g.matrixAutoUpdate = false;
      g.matrix.copy(pl.matrix);
      this.props.add(g);
    }
    void propRadius;
  }

  /** The floor height: under the lowest point of any pose. */
  private floorFor(): number {
    let z = this.subject.min.z;
    const lowest = (p: Pose) => {
      const m = new THREE.Matrix4();
      for (const r of this.parts) {
        const b = r.src.geometry.boundingBox!.clone().applyMatrix4(this.partMatrix(r, p, m));
        z = Math.min(z, b.min.z);
      }
    };
    for (const p of this.framingPoses()) lowest(p);
    return z - Math.max(0.05, this.size * 0.002);
  }

  private buildSet() {
    const s = this.spec;
    const p = this.preset;
    this.floorZ = this.floorFor();
    const cam = this.cameraPlan(0);
    const dist = Math.max(cam.distance, this.size);
    const look = new THREE.Vector3(cam.forward[0], cam.forward[1], 0);
    if (look.lengthSq() < 1e-6) look.set(0, 1, 0);
    look.normalize();
    const camBelow = cam.position[2] < this.floorZ;
    const bgFromPreset = () => {
      this.bg.top.set(p.backdrop.top);
      this.bg.bottom.set(p.backdrop.bottom);
      this.bg.glow.set(p.backdrop.glow);
      this.bg.glowAmt = p.backdrop.glowAmt;
    };
    this.set.add(this.props);
    (this as { catcher: boolean }).catcher = false;
    if (camBelow || s.backdrop === "studio" || s.backdrop === "transparent") {
      bgFromPreset();
      if (!camBelow) {
        const mat = new THREE.ShadowMaterial({ opacity: p.shadow, transparent: true });
        const floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
        const span = dist * 60 + this.size * 20;
        floor.scale.set(span, span, 1);
        floor.position.set(this.bc.x, this.bc.y, this.floorZ);
        floor.receiveShadow = true;
        this.set.add(floor);
        this.catcherMesh = floor;
        (this as { catcher: boolean }).catcher = true;
      }
      return;
    }
    if (s.backdrop === "seamless") {
      const color = new THREE.Color(s.color ?? PAPER[p.id] ?? "#2b2e34");
      this.backdropColor.copy(color);
      const lin = color.clone();
      this.bg.top.copy(lin).multiplyScalar(0.8);
      this.bg.bottom.copy(lin);
      this.bg.glow.copy(lin);
      this.bg.glowAmt = 0;
      const vfov = THREE.MathUtils.degToRad(cam.vfov);
      const wall = this.size * 0.6 + dist * 0.35;
      const radius = Math.max(this.size * 0.9, dist * 0.25);
      const halfW = (dist + wall) * Math.tan(vfov / 2) * this.aspect * 3 + this.size * 4;
      const front = dist * 1.6 + this.size * 2;
      const height = (dist + wall) * Math.tan(vfov / 2 + 0.6) * 2 + Math.max(0, cam.position[2] - this.floorZ) * 2 + this.size * 2;
      const geo = sweepGeometry(halfW, front, radius, height, color);
      const mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
      const sweep = new THREE.Mesh(geo, mat);
      sweep.receiveShadow = true;
      // local +Y runs away from the camera; the curve starts behind the subject
      const yaw = Math.atan2(look.y, look.x) - Math.PI / 2;
      const subjectR = Math.max(this.subject.getSize(new THREE.Vector3()).length() / 2, 5);
      const start = this.bc.clone().addScaledVector(look, subjectR + wall);
      sweep.rotation.z = yaw;
      sweep.position.set(start.x, start.y, this.floorZ);
      sweep.matrixAutoUpdate = true;
      this.set.add(sweep);
      return;
    }
    // a surface: a big textured plane fading into a soft background
    const sl = surfaceLook(s.surface);
    const mat = new THREE.MeshPhysicalMaterial({ map: sl.map, normalMap: sl.normal, roughness: sl.roughness, metalness: sl.metalness, clearcoat: sl.clearcoat, clearcoatRoughness: 0.25, transparent: true, alphaMap: radialFade(), depthWrite: true });
    const R = Math.max(this.size * 4, dist * 1.8);
    const geo = new THREE.PlaneGeometry(R * 2, R * 2);
    // texture repeats in mm, offset so the grain doesn't line up with the product
    const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
    const uv2 = new Float32Array(uv.count * 2);
    for (let i = 0; i < uv.count; i++) {
      uv2[i * 2] = uv.getX(i);
      uv2[i * 2 + 1] = uv.getY(i);
    }
    geo.setAttribute("uv1", new THREE.BufferAttribute(uv2, 2));
    const rep = (R * 2) / sl.tile;
    for (const t of [sl.map, sl.normal]) t.repeat.set(rep, rep);
    mat.alphaMap!.channel = 1;
    const plane = new THREE.Mesh(geo, mat);
    plane.receiveShadow = true;
    plane.rotation.z = Math.atan2(look.y, look.x) + 0.21;
    plane.position.set(this.bc.x, this.bc.y, this.floorZ);
    this.set.add(plane);
    const tone = sl.tone.clone();
    this.bg.bottom.set(p.backdrop.bottom).lerp(tone.clone().multiplyScalar(0.5), 0.6);
    this.bg.top.set(p.backdrop.top).lerp(tone.clone().multiplyScalar(0.35), 0.5);
    this.bg.glow.copy(tone).multiplyScalar(0.4);
    this.bg.glowAmt = 0.25;
  }

  // ---------------- lighting ----------------

  /** Key light for sample i: the centre for 0, then spread over the light's area. */
  placeKey(i: number) {
    const c = this.bc;
    const d = this.keyDir.clone();
    if (i > 0) {
      const [x, y] = concentricDisc(halton(i, 5), halton(i, 7));
      const t1 = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 0, 1));
      if (t1.lengthSq() < 1e-6) t1.set(1, 0, 0);
      t1.normalize();
      const t2 = new THREE.Vector3().crossVectors(d, t1).normalize();
      const k = Math.tan(THREE.MathUtils.degToRad(this.preset.key.size));
      d.addScaledVector(t1, x * k).addScaledVector(t2, y * k).normalize();
    }
    const reach = Math.max(this.size, 20);
    this.key.position.copy(c).addScaledVector(d, reach * 2.5);
    this.key.target.position.copy(c);
    const sc = this.key.shadow.camera as THREE.OrthographicCamera;
    const propReach = this.props.children.length ? new THREE.Box3().setFromObject(this.props).union(this.subject).getSize(new THREE.Vector3()).length() : this.size;
    const ext = Math.max(propReach, 20) * (this.spec.motion === "turntable" || this.spec.explode > 0 || this.spec.motion === "explode" || this.spec.motion === "assemble" ? 1.4 : 0.9);
    sc.left = -ext;
    sc.right = ext;
    sc.top = ext;
    sc.bottom = -ext;
    sc.near = reach * 0.1;
    sc.far = reach * 6;
    sc.updateProjectionMatrix();
    this.key.updateMatrixWorld();
    this.key.target.updateMatrixWorld();
  }

  // ---------------- sampling ----------------

  /**
   * Set up the camera and light for accumulation sample i: the key light moves
   * over its area and, with an aperture, the camera moves over the lens
   * opening while the focus plane stays put.
   */
  beforeSample(i: number) {
    this.placeKey(i);
    const cam = this.camera;
    cam.position.copy(this.basePos);
    cam.projectionMatrix.copy(this.baseProj);
    if (this.aperture > 0 && i > 0) {
      const [x, y] = concentricDisc(halton(i, 11), halton(i, 13));
      const r = this.aperture / 2;
      const ox = x * r;
      const oy = y * r;
      const right = new THREE.Vector3(...this.cam.right);
      const up = new THREE.Vector3(...this.cam.up);
      cam.position.addScaledVector(right, ox).addScaledVector(up, oy);
      const e = cam.projectionMatrix.elements;
      e[8] -= (e[0] * ox) / this.focusDist;
      e[9] -= (e[5] * oy) / this.focusDist;
    }
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    cam.updateMatrixWorld();
  }

  /** Put the camera back after a run of samples. */
  restoreCamera() {
    const cam = this.camera;
    cam.position.copy(this.basePos);
    cam.projectionMatrix.copy(this.baseProj);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    cam.updateMatrixWorld();
    this.placeKey(0);
  }

  /** How many samples a converged image needs: more with a shallow focus. */
  samplesFor(base: number, heightPx: number): number {
    if (!this.aperture) return base;
    // blur disc of the farthest subject point, in pixels
    const c = this.cam;
    const f = this.spec.lens;
    const N = this.spec.aperture ?? 8;
    const worst = Math.max(Math.abs(c.depth[1] - this.focusDist), Math.abs(c.depth[0] - this.focusDist));
    const sensorH = 43.267 / Math.hypot(this.aspect, 1);
    const blurPx = ((((f * f) / (N * Math.max(1, this.focusDist - f))) * worst) / Math.max(1, this.focusDist + worst)) / sensorH * heightPx;
    return Math.round(Math.min(1024, Math.max(base, base * Math.min(8, blurPx / 6))));
  }

  // ---------------- for other passes ----------------

  /** Meshes of the shown, solid parts (for ID passes). */
  solidMeshes() {
    return this.parts.filter((r) => !r.ghost).map((r) => ({ id: r.src.id, name: r.src.part.name, mesh: r.mesh, cap: r.cap, framed: r.framed }));
  }

  /** World box of named parts in the current pose. */
  boxOf(name: string): THREE.Box3 | null {
    const box = new THREE.Box3();
    for (const r of this.parts) if (r.src.part.name === name || r.src.id === name || r.src.part.group === name) box.union(r.src.geometry.boundingBox!.clone().applyMatrix4(r.group.matrix));
    return box.isEmpty() ? null : box;
  }

  /** Path tracer inputs: the parts as placed, with their looks. */
  photoParts() {
    return this.parts.map((r) => ({ id: r.src.id, geoKey: r.src.geoKey, geometry: r.src.geometry, matrix: r.group.matrixWorld, look: r.src.look, opacity: r.ghost ? 0.16 : 1 }));
  }

  /** The set's meshes for the path tracer (sweep, surface and props); the catcher floor is its own. */
  photoExtras(): THREE.Object3D[] {
    return this.set.children.filter((c) => c !== this.catcherMesh);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const r of this.parts) {
      r.mat.dispose();
      r.capMat?.dispose();
    }
    for (const c of [...this.props.children]) disposeProp(c);
    this.set.traverse((o) => {
      if (o instanceof THREE.Mesh && !o.userData.prop && !(o.parent && o.parent.userData.prop)) {
        o.geometry.dispose();
        const m = o.material as THREE.MeshPhysicalMaterial;
        // surface textures are cached and shared; only the fade map is the set's own
        if (m.alphaMap && m.alphaMap !== fadeTex) m.alphaMap.dispose();
        m.dispose();
      }
    });
    this.key.shadow.map?.dispose();
    this.key.dispose();
  }
}

function lerpCamera(a: ShotCamera, b: ShotCamera, k: number): ShotCamera {
  const l = (x: V3, y: V3): V3 => [x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k];
  const n = (v: V3): V3 => {
    const len = Math.hypot(...v) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
  };
  return { ...a, position: l(a.position, b.position), forward: n(l(a.forward, b.forward)), right: n(l(a.right, b.right)), up: n(l(a.up, b.up)), center: l(a.center, b.center), distance: a.distance + (b.distance - a.distance) * k, depth: [a.depth[0] + (b.depth[0] - a.depth[0]) * k, a.depth[1] + (b.depth[1] - a.depth[1]) * k] };
}

/**
 * A paper sweep: floor from the front up to a curve and a back wall, in local
 * axes (X across, +Y away from the camera, Z up), with a soft fall-off of
 * brightness away from the middle like a lit studio sweep.
 */
function sweepGeometry(halfW: number, front: number, radius: number, height: number, color: THREE.Color): THREE.BufferGeometry {
  const prof: { y: number; z: number; ny: number; nz: number }[] = [];
  const floorSteps = 12;
  for (let i = 0; i <= floorSteps; i++) prof.push({ y: -front + (front * i) / floorSteps, z: 0, ny: 0, nz: 1 });
  const arc = 28;
  for (let i = 1; i <= arc; i++) {
    const a = (i / arc) * (Math.PI / 2);
    prof.push({ y: radius * Math.sin(a), z: radius - radius * Math.cos(a), ny: -Math.sin(a), nz: Math.cos(a) });
  }
  const wallSteps = 10;
  for (let i = 1; i <= wallSteps; i++) prof.push({ y: radius, z: radius + ((height - radius) * i) / wallSteps, ny: -1, nz: 0 });
  const cols = 24;
  const P: number[] = [];
  const Nn: number[] = [];
  const C: number[] = [];
  const idx: number[] = [];
  const lin = color.clone();
  for (let j = 0; j <= cols; j++) {
    const x = -halfW + (2 * halfW * j) / cols;
    for (const p of prof) {
      P.push(x, p.y, p.z);
      Nn.push(0, p.ny, p.nz);
      // brightest behind the product, falling off to the sides and up the wall
      const side = Math.min(1, Math.abs(x) / (halfW * 0.55));
      const up = Math.min(1, Math.max(0, (p.z - radius) / Math.max(1, height - radius)));
      const k = (1 - 0.32 * side * side) * (1 - 0.45 * Math.pow(up, 0.8));
      C.push(lin.r * k, lin.g * k, lin.b * k);
    }
  }
  const rows = prof.length;
  for (let j = 0; j < cols; j++)
    for (let i = 0; i < rows - 1; i++) {
      const a = j * rows + i;
      const b = (j + 1) * rows + i;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(Nn, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(C, 3));
  g.setIndex(idx);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

let fadeTex: THREE.Texture | null = null;
/** Opaque in the middle, fading to clear at the rim: the surface melts into the background. */
function radialFade(): THREE.Texture {
  if (fadeTex) return fadeTex;
  const n = 256;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const dx = (x + 0.5) / n - 0.5;
      const dy = (y + 0.5) / n - 0.5;
      const r = Math.hypot(dx, dy) * 2;
      const t = Math.min(1, Math.max(0, (r - 0.42) / 0.5));
      const a = Math.round(255 * (1 - t * t * (3 - 2 * t)));
      const i = (y * n + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = a;
      data[i + 3] = 255;
    }
  fadeTex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  fadeTex.magFilter = THREE.LinearFilter;
  fadeTex.minFilter = THREE.LinearFilter;
  fadeTex.needsUpdate = true;
  return fadeTex;
}

export const RIG_MOTIONS = MOTIONS;
