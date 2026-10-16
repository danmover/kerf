// three.js scene for the CAD viewport: shared geometry per solid hash,
// build-in reveal animations, selection, ghosting, section cuts, exploded
// views, gear motion and interference highlights. Renders on demand.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { EvalPart } from "../../core/model";
import type { MeshEntry } from "../../core/engine";
import type { MeshData } from "../../kernel/build";
import type { Interference } from "../../kernel/protocol";
import { xformMatrix } from "../../kernel/recipe";
import type { ViewPreset } from "../../app/view";

const METALS = new Set(["Steel", "Stainless 304", "Aluminum 6061", "Brass"]);
const ACCENT = new THREE.Color("#6d8bff");
const HOVER = new THREE.Color("#9fb2ff");
const CAP = new THREE.Color("#ffb454");

interface GeoEntry {
  mesh: THREE.BufferGeometry;
  edges: THREE.BufferGeometry;
  users: number;
}

interface PartObj {
  id: string;
  part: EvalPart;
  group: THREE.Group;
  mesh: THREE.Mesh;
  cap: THREE.Mesh;
  edges: THREE.LineSegments;
  mat: THREE.MeshStandardMaterial;
  capMat: THREE.MeshBasicMaterial;
  edgeMat: THREE.LineBasicMaterial;
  geoKey: string;
  hash: string;
  placement: THREE.Matrix4;
  /** local-space centre, for explode direction */
  center: THREE.Vector3;
  explodeCur: THREE.Vector3;
  reveal: { t0: number; dur: number; zMin: number; zMax: number; plane: THREE.Plane } | null;
  removing: number | null;
}

/** What is under a point on screen: the part, and the spot on it in the part's own frame and in the assembly. */
export interface Hit {
  id: string;
  /** in the part's own frame, before its placement */
  local: [number, number, number];
  /** in assembly coordinates, without explode or motion */
  point: [number, number, number];
  /** outward face normal, in assembly coordinates */
  normal: [number, number, number];
}

const tuple = (v: THREE.Vector3): [number, number, number] => [v.x, v.y, v.z];

export interface DisplayState {
  hidden: Set<string>;
  selected: Set<string>;
  hovered: string | null;
  focus: Set<string>;
  isolate: boolean;
  xray: boolean;
  edges: boolean;
  grid: boolean;
  reduceMotion: boolean;
}

export class SceneController {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private root = new THREE.Group();
  private interGroup = new THREE.Group();
  private parts = new Map<string, PartObj>();
  private geos = new Map<string, GeoEntry>();
  private seenHashByPart = new Map<string, string>();
  private grid: THREE.Mesh;
  private gridMat: THREE.ShaderMaterial;
  private ground: THREE.Mesh;
  private key: THREE.DirectionalLight;
  private triadScene = new THREE.Scene();
  private triadCam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
  private dirty = true;
  private raf = 0;
  private last = performance.now();
  private camAnim: { t0: number; dur: number; fromPos: THREE.Vector3; toPos: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3 } | null = null;
  private display: DisplayState = { hidden: new Set(), selected: new Set(), hovered: null, focus: new Set(), isolate: false, xray: false, edges: true, grid: true, reduceMotion: false };
  private section = { on: false, axis: "x" as "x" | "y" | "z", t: 0.5, flip: false };
  private sectionPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  private explode = 0;
  private playing = false;
  private speed = 1;
  private angle = 0;
  private bounds = new THREE.Box3(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 40));
  private hasFitted = false;
  private interferences: { obj: THREE.Mesh; id: string }[] = [];
  private focusCheck: string | null = null;
  private ro: ResizeObserver;
  private raycaster = new THREE.Raycaster();
  onHover: (id: string | null) => void = () => undefined;
  onPick: (id: string | null, additive: boolean) => void = () => undefined;
  onDoublePick: (id: string | null) => void = () => undefined;
  /** a right-click without dragging: what is under the pointer, and where on screen */
  onContext: (hit: Hit | null, clientX: number, clientY: number) => void = () => undefined;
  onFirstFrame: () => void = () => undefined;
  /** until the user moves the camera, the first complete build re-frames the model */
  private autoFit = true;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.localClippingEnabled = true;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.autoClear = false;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.classList.add("vp-canvas");

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.75;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.5, 20000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(220, -260, 190);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener("change", () => (this.dirty = true));
    this.controls.addEventListener("start", () => {
      this.camAnim = null;
      this.autoFit = false;
    });

    this.scene.add(new THREE.HemisphereLight(0xdde6ff, 0x1a1d24, 0.55));
    this.key = new THREE.DirectionalLight(0xffffff, 1.6);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.6;
    this.scene.add(this.key, this.key.target);
    const rim = new THREE.DirectionalLight(0x8fa8ff, 0.5);
    rim.position.set(-300, 400, 200);
    this.scene.add(rim);

    this.gridMat = gridMaterial();
    this.grid = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.gridMat);
    this.grid.renderOrder = -1;
    this.scene.add(this.grid);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.28, transparent: true }));
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.scene.add(this.root, this.interGroup);
    this.buildTriad();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.layoutStage();

    const el = this.renderer.domElement;
    let down: { x: number; y: number } | null = null;
    el.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
    el.addEventListener("pointerup", (e) => {
      const still = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5;
      if (still && e.button === 0) this.onPick(this.pick(e), e.shiftKey || e.metaKey || e.ctrlKey);
      else if (still && e.button === 2) this.onContext(this.hitAt(e.clientX, e.clientY), e.clientX, e.clientY);
      down = null;
    });
    let pending: PointerEvent | null = null;
    el.addEventListener("pointermove", (e) => {
      if (e.buttons) return;
      if (!pending) requestAnimationFrame(() => {
        if (pending) this.onHover(this.pick(pending));
        pending = null;
      });
      pending = e;
    });
    el.addEventListener("pointerleave", () => this.onHover(null));
    el.addEventListener("dblclick", (e) => this.onDoublePick(this.pick(e)));

    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    for (const p of this.parts.values()) this.disposePart(p, true);
    for (const g of this.geos.values()) {
      g.mesh.dispose();
      g.edges.dispose();
    }
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---------- parts ----------

  setParts(parts: EvalPart[], meshes: Map<string, MeshEntry>) {
    const want = new Set<string>();
    const now = performance.now();
    for (const part of parts) {
      const entry = meshes.get(part.hash);
      const data = entry?.final ?? entry?.preview;
      if (!data) continue;
      want.add(part.id);
      const quality = entry?.final ? "final" : "preview";
      const geoKey = `${part.hash}:${quality}`;
      let obj = this.parts.get(part.id);
      const isNewGeometry = this.seenHashByPart.get(part.id) !== part.hash;
      if (!obj || obj.removing !== null) {
        if (obj) this.disposePart(obj, true);
        obj = this.createPart(part, geoKey, data);
        this.parts.set(part.id, obj);
      } else if (obj.geoKey !== geoKey) {
        this.swapGeometry(obj, geoKey, data);
      }
      obj.part = part;
      obj.hash = part.hash;
      obj.placement.fromArray(xformMatrix(part.xf));
      this.applyMaterial(obj);
      if (isNewGeometry) {
        this.seenHashByPart.set(part.id, part.hash);
        if (!this.display.reduceMotion) this.startReveal(obj, now);
      }
    }
    for (const [id, obj] of this.parts) {
      if (!want.has(id) && obj.removing === null) {
        if (this.display.reduceMotion) this.disposePart(obj, true);
        else obj.removing = now;
      }
    }
    this.computeBounds();
    if (!this.hasFitted && this.parts.size) {
      this.hasFitted = true;
      this.fit("iso", false);
      this.onFirstFrame();
    }
    this.dirty = true;
  }

  private geometry(key: string, data: MeshData): GeoEntry {
    let g = this.geos.get(key);
    if (!g) {
      const mesh = new THREE.BufferGeometry();
      mesh.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
      mesh.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
      mesh.setIndex(new THREE.BufferAttribute(data.indices, 1));
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
      const edges = new THREE.BufferGeometry();
      edges.setAttribute("position", new THREE.BufferAttribute(data.edges, 3));
      g = { mesh, edges, users: 0 };
      this.geos.set(key, g);
    }
    g.users++;
    return g;
  }

  private release(key: string) {
    const g = this.geos.get(key);
    if (!g) return;
    g.users--;
    if (g.users <= 0) {
      g.mesh.dispose();
      g.edges.dispose();
      this.geos.delete(key);
    }
  }

  private createPart(part: EvalPart, geoKey: string, data: MeshData): PartObj {
    const g = this.geometry(geoKey, data);
    const metal = METALS.has(part.material);
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(part.color),
      metalness: metal ? 0.85 : 0.05,
      roughness: metal ? 0.32 : part.material === "FR4" ? 0.7 : 0.48,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const capMat = new THREE.MeshBasicMaterial({ color: CAP, side: THREE.BackSide });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x06080c, transparent: true, opacity: 0.55 });
    const mesh = new THREE.Mesh(g.mesh, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.partId = part.id;
    const cap = new THREE.Mesh(g.mesh, capMat);
    cap.visible = false;
    const edges = new THREE.LineSegments(g.edges, edgeMat);
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.add(mesh, cap, edges);
    this.root.add(group);
    const center = new THREE.Vector3();
    g.mesh.boundingBox!.getCenter(center);
    return { id: part.id, part, group, mesh, cap, edges, mat, capMat, edgeMat, geoKey, hash: part.hash, placement: new THREE.Matrix4(), center, explodeCur: new THREE.Vector3(), reveal: null, removing: null };
  }

  private swapGeometry(obj: PartObj, geoKey: string, data: MeshData) {
    const g = this.geometry(geoKey, data);
    this.release(obj.geoKey);
    obj.geoKey = geoKey;
    obj.mesh.geometry = g.mesh;
    obj.cap.geometry = g.mesh;
    obj.edges.geometry = g.edges;
    g.mesh.boundingBox!.getCenter(obj.center);
  }

  private disposePart(obj: PartObj, now: boolean) {
    if (!now) return;
    this.root.remove(obj.group);
    obj.mat.dispose();
    obj.capMat.dispose();
    obj.edgeMat.dispose();
    this.release(obj.geoKey);
    this.parts.delete(obj.id);
  }

  private startReveal(obj: PartObj, now: number) {
    const box = new THREE.Box3().setFromBufferAttribute(obj.mesh.geometry.getAttribute("position") as THREE.BufferAttribute).applyMatrix4(obj.placement);
    obj.reveal = { t0: now + Math.random() * 120, dur: 650, zMin: box.min.z - 0.5, zMax: box.max.z + 0.5, plane: new THREE.Plane(new THREE.Vector3(0, 0, -1), box.min.z - 0.5) };
  }

  private applyMaterial(obj: PartObj) {
    const d = this.display;
    const p = obj.part;
    obj.mat.color.set(p.color);
    const selected = d.selected.has(obj.id);
    const hovered = d.hovered === obj.id;
    const focusSet = d.focus.size ? d.focus : d.isolate && d.selected.size ? d.selected : null;
    const ghost = (focusSet && !focusSet.has(obj.id)) || (d.xray && !selected);
    obj.mat.emissive.copy(selected ? ACCENT : hovered ? HOVER : new THREE.Color(0));
    obj.mat.emissiveIntensity = selected ? 0.32 : hovered ? 0.16 : 0;
    const opacity = ghost ? (d.xray ? 0.22 : 0.1) : 1;
    obj.mat.transparent = opacity < 1;
    obj.mat.opacity = opacity;
    obj.mat.depthWrite = opacity >= 1;
    obj.mesh.castShadow = opacity >= 1;
    obj.edgeMat.color.set(selected ? ACCENT : hovered ? HOVER : 0x06080c);
    obj.edgeMat.opacity = selected || hovered ? 0.95 : ghost ? 0.12 : 0.55;
    obj.edges.visible = d.edges || selected || hovered;
    obj.group.visible = !d.hidden.has(obj.id) && !p.hidden;
    this.updateClipping(obj);
  }

  private updateClipping(obj: PartObj) {
    const planes: THREE.Plane[] = [];
    if (this.section.on) planes.push(this.sectionPlane);
    if (obj.reveal) planes.push(obj.reveal.plane);
    const changed = (obj.mat.clippingPlanes?.length ?? 0) !== planes.length;
    obj.mat.clippingPlanes = planes.length ? planes : null;
    obj.edgeMat.clippingPlanes = planes.length ? planes : null;
    obj.capMat.clippingPlanes = planes.length ? planes : null;
    obj.cap.visible = this.section.on && obj.mat.opacity >= 1;
    if (changed) {
      obj.mat.needsUpdate = true;
      obj.edgeMat.needsUpdate = true;
      obj.capMat.needsUpdate = true;
    }
  }

  setDisplay(d: DisplayState) {
    this.display = d;
    for (const obj of this.parts.values()) this.applyMaterial(obj);
    this.grid.visible = d.grid;
    this.updateInterferenceLook();
    this.dirty = true;
  }

  setSection(s: { on: boolean; axis: "x" | "y" | "z"; t: number; flip: boolean }) {
    this.section = { ...s };
    this.placeSection();
    for (const obj of this.parts.values()) this.updateClipping(obj);
    this.dirty = true;
  }

  private placeSection() {
    const ax = this.section.axis === "x" ? 0 : this.section.axis === "y" ? 1 : 2;
    const lo = this.bounds.min.getComponent(ax);
    const hi = this.bounds.max.getComponent(ax);
    const c = lo + (hi - lo) * this.section.t;
    const n = new THREE.Vector3();
    n.setComponent(ax, this.section.flip ? 1 : -1);
    this.sectionPlane.set(n, this.section.flip ? -c : c);
  }

  setExplode(f: number) {
    this.explode = f;
    this.dirty = true;
  }

  setMotion(playing: boolean, speed: number) {
    this.playing = playing;
    this.speed = speed;
    this.dirty = true;
  }

  setInterferences(list: Interference[], focus: string | null) {
    for (const i of this.interferences) {
      this.interGroup.remove(i.obj);
      i.obj.geometry.dispose();
      (i.obj.material as THREE.Material).dispose();
    }
    this.interferences = [];
    this.focusCheck = focus;
    for (const it of list) {
      if (!it.mesh) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(it.mesh.positions, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(it.mesh.normals, 3));
      g.setIndex(new THREE.BufferAttribute(it.mesh.indices, 1));
      const m = new THREE.MeshBasicMaterial({ color: 0xff3b5c, transparent: true, opacity: 0.85, depthTest: false });
      const obj = new THREE.Mesh(g, m);
      obj.renderOrder = 10;
      this.interGroup.add(obj);
      this.interferences.push({ obj, id: `int:${it.a}|${it.b}` });
    }
    this.updateInterferenceLook();
    this.dirty = true;
  }

  private updateInterferenceLook() {
    for (const i of this.interferences) {
      const m = i.obj.material as THREE.MeshBasicMaterial;
      m.opacity = !this.focusCheck || this.focusCheck === i.id ? 0.85 : 0.25;
    }
  }

  // ---------- camera ----------

  private computeBounds() {
    const box = new THREE.Box3();
    for (const obj of this.parts.values()) {
      if (obj.removing !== null || !obj.group.visible) continue;
      const g = obj.mesh.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      box.union(g.boundingBox!.clone().applyMatrix4(obj.placement));
    }
    if (!box.isEmpty()) this.bounds.copy(box);
    this.layoutStage();
    this.placeSection();
  }

  private layoutStage() {
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    this.bounds.getSize(size);
    this.bounds.getCenter(center);
    const r = Math.max(size.x, size.y, size.z, 20);
    const zFloor = this.bounds.min.z - Math.max(0.5, r * 0.004);
    const span = r * 14;
    this.grid.scale.set(span, span, 1);
    this.grid.position.set(center.x, center.y, zFloor);
    this.ground.scale.set(r * 6, r * 6, 1);
    this.ground.position.set(center.x, center.y, zFloor + 0.01);
    const cell = Math.pow(10, Math.floor(Math.log10(r / 4)));
    this.gridMat.uniforms.uCell.value = Math.max(cell, 1);
    this.gridMat.uniforms.uFade.value = r * 3.5;
    this.gridMat.uniforms.uCenter.value.set(center.x, center.y, zFloor);
    this.key.position.set(center.x + r * 1.2, center.y - r * 1.5, center.z + r * 2.4);
    this.key.target.position.copy(center);
    const sc = this.key.shadow.camera as THREE.OrthographicCamera;
    sc.left = -r * 1.4;
    sc.right = r * 1.4;
    sc.top = r * 1.4;
    sc.bottom = -r * 1.4;
    sc.near = 1;
    sc.far = r * 8;
    sc.updateProjectionMatrix();
    this.camera.near = Math.max(0.1, r / 400);
    this.camera.far = r * 60;
    this.camera.updateProjectionMatrix();
  }

  private presetDir(p: ViewPreset): THREE.Vector3 {
    switch (p) {
      case "front":
        return new THREE.Vector3(0, -1, 0.0001);
      case "back":
        return new THREE.Vector3(0, 1, 0.0001);
      case "left":
        return new THREE.Vector3(-1, 0, 0.0001);
      case "right":
        return new THREE.Vector3(1, 0, 0.0001);
      case "top":
        return new THREE.Vector3(0, -0.0001, 1);
      case "bottom":
        return new THREE.Vector3(0, -0.0001, -1);
      default:
        return new THREE.Vector3(0.9, -1.25, 0.85).normalize();
    }
  }

  /** Called when a build completes: frames the whole model once, unless the user already moved the camera. */
  settle() {
    if (!this.autoFit || !this.parts.size) return;
    this.autoFit = false;
    this.fit("iso", true);
  }

  /** Frame the given parts from the current viewing direction. */
  focusOn(ids: string[]) {
    const box = new THREE.Box3();
    for (const id of ids) {
      const p = this.parts.get(id);
      if (p && p.removing === null) box.expandByObject(p.group);
    }
    if (box.isEmpty()) return;
    this.fit("current", true, box);
  }

  private framing(p: ViewPreset | "current", aspect: number, box: THREE.Box3 = this.bounds, viewDir?: THREE.Vector3) {
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, box === this.bounds ? 5 : 2);
    const dir = viewDir ? viewDir.clone().normalize() : p === "current" ? this.camera.position.clone().sub(this.controls.target).normalize() : this.presetDir(p);
    const fov = (this.camera.fov * Math.PI) / 180;
    const fit = r / Math.sin(Math.min(fov, fov * aspect) / 2);
    return { pos: sphere.center.clone().add(dir.multiplyScalar(fit * 1.08)), target: sphere.center.clone() };
  }

  fit(p: ViewPreset | "current" = "current", animate = true, box?: THREE.Box3) {
    const { pos, target } = this.framing(p, this.camera.aspect, box);
    if (!animate || this.display.reduceMotion) {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
    } else {
      this.camAnim = { t0: performance.now(), dur: 650, fromPos: this.camera.position.clone(), toPos: pos, fromTarget: this.controls.target.clone(), toTarget: target };
    }
    this.dirty = true;
  }

  // ---------- picking ----------

  private pick(e: MouseEvent): string | null {
    return this.rayHit(e.clientX, e.clientY)?.object.userData.partId ?? null;
  }

  private rayHit(clientX: number, clientY: number): THREE.Intersection | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = [...this.parts.values()].filter((p) => p.group.visible && p.removing === null && p.mat.opacity > 0.5).map((p) => p.mesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    for (const h of hits) {
      if (this.section.on && this.sectionPlane.distanceToPoint(h.point) < 0) continue;
      if (h.object.userData.partId) return h;
    }
    return null;
  }

  /** The part and spot under a screen position. */
  hitAt(clientX: number, clientY: number): Hit | null {
    const h = this.rayHit(clientX, clientY);
    const obj = h && this.parts.get(h.object.userData.partId as string);
    if (!h || !obj) return null;
    const local = h.point.clone().applyMatrix4(h.object.matrixWorld.clone().invert());
    const n = (h.face?.normal ?? new THREE.Vector3(0, 0, 1)).clone();
    return { id: obj.id, local: tuple(local), point: tuple(local.clone().applyMatrix4(obj.placement)), normal: tuple(n.transformDirection(obj.placement)) };
  }

  /**
   * Where a spot on a part shows in the viewport, in CSS pixels from its top
   * left, following the camera, explode and motion. Without a spot, the part's
   * centre. Null when the part is not on screen.
   */
  anchor(id: string, local?: [number, number, number]): { x: number; y: number; front: boolean } | null {
    const obj = this.parts.get(id);
    if (!obj || obj.removing !== null) return null;
    const v = (local ? new THREE.Vector3(...local) : obj.center.clone()).applyMatrix4(obj.mesh.matrixWorld);
    const front = v.clone().sub(this.camera.position).dot(this.camera.getWorldDirection(new THREE.Vector3())) > 0;
    v.project(this.camera);
    return { x: ((v.x + 1) / 2) * this.container.clientWidth, y: ((1 - v.y) / 2) * this.container.clientHeight, front };
  }

  /** The model's bounds in assembly coordinates. */
  modelBounds(): [[number, number, number], [number, number, number]] {
    return [tuple(this.bounds.min), tuple(this.bounds.max)];
  }

  /** The direction from the view's target toward the camera. */
  viewDir(): [number, number, number] {
    return tuple(this.camera.position.clone().sub(this.controls.target).normalize());
  }

  // ---------- frame ----------

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + "px";
    this.renderer.domElement.style.height = h + "px";
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  private frame() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    let active = this.controls.update();

    if (this.camAnim) {
      const k = Math.min(1, (now - this.camAnim.t0) / this.camAnim.dur);
      const e = 1 - Math.pow(1 - k, 3);
      this.camera.position.lerpVectors(this.camAnim.fromPos, this.camAnim.toPos, e);
      this.controls.target.lerpVectors(this.camAnim.fromTarget, this.camAnim.toTarget, e);
      this.controls.update();
      if (k >= 1) this.camAnim = null;
      active = true;
    }

    if (this.playing) {
      this.angle += dt * 90 * this.speed;
      active = true;
    }

    const bc = new THREE.Vector3();
    this.bounds.getCenter(bc);
    const size = this.bounds.getSize(new THREE.Vector3()).length();
    for (const obj of [...this.parts.values()]) {
      // reveal sweep
      if (obj.reveal) {
        const k = (now - obj.reveal.t0) / obj.reveal.dur;
        if (k >= 1) {
          obj.reveal = null;
          this.updateClipping(obj);
          obj.edgeMat.color.set(this.display.selected.has(obj.id) ? ACCENT : 0x06080c);
        } else {
          const e = k <= 0 ? 0 : 1 - Math.pow(1 - k, 2);
          obj.reveal.plane.constant = obj.reveal.zMin + (obj.reveal.zMax - obj.reveal.zMin) * e;
          obj.edgeMat.color.copy(ACCENT).lerp(new THREE.Color(0x06080c), Math.max(0, k));
          this.updateClipping(obj);
        }
        active = true;
      }
      // fade-out removal
      if (obj.removing !== null) {
        const k = (now - obj.removing) / 260;
        if (k >= 1) {
          this.disposePart(obj, true);
          continue;
        }
        obj.mat.transparent = true;
        obj.mat.opacity = 1 - k;
        obj.edgeMat.opacity = 0.55 * (1 - k);
        active = true;
      }
      // explode offset, eased toward its target
      const target = new THREE.Vector3();
      if (this.explode > 0) {
        const worldC = obj.center.clone().applyMatrix4(obj.placement);
        target.copy(worldC).sub(bc);
        if (target.lengthSq() < 1e-6) target.set(0, 0, 1);
        target.normalize().multiplyScalar(this.explode * size * 0.45 * (0.4 + worldC.distanceTo(bc) / (size || 1)));
      }
      if (obj.explodeCur.distanceToSquared(target) > 1e-4) {
        obj.explodeCur.lerp(target, this.display.reduceMotion ? 1 : 0.18);
        active = true;
      }
      // motion about the part's axis
      const m = new THREE.Matrix4().makeTranslation(obj.explodeCur.x, obj.explodeCur.y, obj.explodeCur.z);
      const mo = obj.part.motion;
      if (mo && Math.abs(this.angle) > 1e-9 && mo.ratio) {
        const o = new THREE.Vector3(...mo.origin);
        const rot = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(...mo.axis).normalize(), THREE.MathUtils.degToRad(this.angle * mo.ratio));
        m.multiply(new THREE.Matrix4().makeTranslation(o.x, o.y, o.z)).multiply(rot).multiply(new THREE.Matrix4().makeTranslation(-o.x, -o.y, -o.z));
      }
      obj.group.matrix.copy(m.multiply(obj.placement));
      obj.group.matrixWorldNeedsUpdate = true;
    }

    if (this.interferences.length) {
      const pulse = 0.55 + 0.35 * Math.sin(now / 220);
      for (const i of this.interferences) {
        const mm = i.obj.material as THREE.MeshBasicMaterial;
        if (!this.focusCheck || this.focusCheck === i.id) mm.opacity = pulse;
      }
      active = true;
    }

    if (active) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    this.render();
  }

  private render() {
    const r = this.renderer;
    r.clear();
    r.setViewport(0, 0, r.domElement.width / r.getPixelRatio(), r.domElement.height / r.getPixelRatio());
    r.render(this.scene, this.camera);
    // axis triad in the corner
    const s = 86;
    r.clearDepth();
    r.setScissorTest(true);
    r.setScissor(10, 10, s, s);
    r.setViewport(10, 10, s, s);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.triadCam.position.copy(dir.multiplyScalar(4));
    this.triadCam.up.copy(this.camera.up);
    this.triadCam.lookAt(0, 0, 0);
    r.render(this.triadScene, this.triadCam);
    r.setScissorTest(false);
  }

  private buildTriad() {
    const axes: [THREE.Vector3, string, string][] = [
      [new THREE.Vector3(1, 0, 0), "#ff5d6c", "X"],
      [new THREE.Vector3(0, 1, 0), "#3ddc97", "Y"],
      [new THREE.Vector3(0, 0, 1), "#6d8bff", "Z"],
    ];
    for (const [v, color, label] of axes) {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), v.clone().multiplyScalar(0.9)]);
      this.triadScene.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color })));
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), new THREE.MeshBasicMaterial({ color }));
      tip.position.copy(v.clone().multiplyScalar(0.9));
      this.triadScene.add(tip);
      const c = document.createElement("canvas");
      c.width = c.height = 64;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = color;
      ctx.font = "600 40px 'IBM Plex Mono', monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, 32, 34);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
      sp.position.copy(v.clone().multiplyScalar(1.28));
      sp.scale.setScalar(0.5);
      this.triadScene.add(sp);
    }
  }

  // ---------- capture ----------

  async capture(opts: {
    view: ViewPreset | "current";
    width: number;
    height: number;
    focus?: string[];
    section?: "x" | "y" | "z";
    mime?: string;
    quality?: number;
    box?: [[number, number, number], [number, number, number]];
    dir?: [number, number, number];
  }): Promise<string> {
    const r = this.renderer;
    const prev = { pos: this.camera.position.clone(), target: this.controls.target.clone(), aspect: this.camera.aspect, w: this.container.clientWidth, h: this.container.clientHeight, display: this.display, section: this.section, pr: r.getPixelRatio() };
    // let pending reveal animations finish first
    for (const o of this.parts.values()) {
      if (o.reveal) {
        o.reveal = null;
        this.updateClipping(o);
      }
    }
    try {
      r.setPixelRatio(1);
      r.setSize(opts.width, opts.height, false);
      this.camera.aspect = opts.width / opts.height;
      const box = opts.box ? new THREE.Box3(new THREE.Vector3(...opts.box[0]), new THREE.Vector3(...opts.box[1])) : undefined;
      const { pos, target } = this.framing(opts.view, this.camera.aspect, box, opts.dir && new THREE.Vector3(...opts.dir));
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.camera.lookAt(target);
      this.camera.updateProjectionMatrix();
      if (opts.focus?.length) this.setDisplay({ ...this.display, focus: new Set(opts.focus), hovered: null });
      if (opts.section) this.setSection({ on: true, axis: opts.section, t: 0.5, flip: false });
      this.frameMatricesOnly();
      this.scene.background = new THREE.Color("#0d1016");
      r.setClearColor(0x0d1016, 1);
      r.clear();
      r.setViewport(0, 0, opts.width, opts.height);
      r.render(this.scene, this.camera);
      return r.domElement.toDataURL(opts.mime ?? "image/png", opts.quality ?? 0.9);
    } finally {
      this.scene.background = null;
      r.setClearColor(0x000000, 0);
      r.setPixelRatio(prev.pr);
      this.camera.position.copy(prev.pos);
      this.controls.target.copy(prev.target);
      this.setDisplay(prev.display);
      this.setSection(prev.section);
      this.resize();
      this.controls.update();
      this.dirty = true;
    }
  }

  /** update part matrices without advancing animations (for captures) */
  private frameMatricesOnly() {
    for (const obj of this.parts.values()) {
      const m = new THREE.Matrix4().makeTranslation(obj.explodeCur.x, obj.explodeCur.y, obj.explodeCur.z);
      obj.group.matrix.copy(m.multiply(obj.placement));
      obj.group.matrixWorldNeedsUpdate = true;
    }
  }
}

function gridMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uCell: { value: 10 },
      uFade: { value: 400 },
      uCenter: { value: new THREE.Vector3() },
      uMinor: { value: new THREE.Color("#2a3142") },
      uMajor: { value: new THREE.Color("#3d4a66") },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      uniform float uCell;
      uniform float uFade;
      uniform vec3 uCenter;
      uniform vec3 uMinor;
      uniform vec3 uMajor;
      float line(vec2 p, float cell) {
        vec2 q = p / cell;
        vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
        return 1.0 - min(min(g.x, g.y), 1.0);
      }
      void main() {
        vec2 p = vWorld.xy;
        float minor = line(p, uCell);
        float major = line(p, uCell * 10.0);
        float d = length(p - uCenter.xy);
        float fade = 1.0 - smoothstep(uFade * 0.25, uFade, d);
        vec3 col = mix(uMinor, uMajor, major);
        float a = max(minor * 0.45, major * 0.8);
        float ax = 1.0 - min(abs(p.y) / fwidth(p.y) / 1.5, 1.0);
        float ay = 1.0 - min(abs(p.x) / fwidth(p.x) / 1.5, 1.0);
        col = mix(col, vec3(0.95, 0.35, 0.42), ax);
        col = mix(col, vec3(0.24, 0.86, 0.59), ay);
        a = max(a, max(ax, ay) * 0.75);
        gl_FragColor = vec4(col, a * fade * 0.9);
      }`,
  });
}
