// An app's 3D panel: the design's parts in a small view of their own, moved
// by live values. On the simulated twin the whole scene the simulation draws
// (the bench, the mechanism's bodies where the physics puts them) is posed
// from the twin's channels; the panel's moves (slide, turn, spin) work on the
// real machine too, from its telemetry. Kerf hands it the design's own parts
// and meshes; a saved app hands it the copies it carries.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { MeshEntry } from "../../core/engine";
import type { EvalPart } from "../../core/model";
import { xformMatrix } from "../../kernel/recipe";
import type { ModelView } from "./panels";
import { palette } from "./draw";
import type { PanelSpec } from "../spec";
import type { SignalStore } from "../store";
import { SimOverlay } from "../../ui/viewport/simOverlay";
import type { Frames } from "../../sim/engine/run";
import type { SceneSpec } from "../../sim/worlds/types";

export interface ModelSource {
  parts: EvalPart[];
  meshes: Map<string, MeshEntry>;
  /** the twin's scene while the twin runs */
  scene(): SceneSpec | undefined;
}

const D2R = Math.PI / 180;
const VIEW: Record<string, THREE.Vector3> = {
  iso: new THREE.Vector3(1, -1.25, 0.85),
  front: new THREE.Vector3(0, -1, 0.12),
  side: new THREE.Vector3(1, 0, 0.12),
  top: new THREE.Vector3(0.001, -0.02, 1),
};

export function modelView3d(into: HTMLElement, panel: Extract<PanelSpec, { kind: "model" }>, store: SignalStore, src: ModelSource): ModelView {
  const meshes = src.meshes;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  into.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 1, 200000);
  camera.up.set(0, 0, 1);
  scene.add(new THREE.HemisphereLight(0xdfe7ff, 0x2a2f3a, 1.5));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(400, -600, 900);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x9fb4ff, 0.6);
  fill.position.set(-500, 400, 200);
  scene.add(fill);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;

  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x);
  const wanted = panel.parts.length ? new Set(panel.parts) : null;
  const parts = src.parts.filter((p) => !p.hidden && (!wanted || wanted.has(p.name)));
  const groups = new Map<string, { g: THREE.Group; base: THREE.Matrix4; centre: THREE.Vector3 }[]>();
  const box = new THREE.Box3();

  const matOf = (p: EvalPart) => keep(new THREE.MeshStandardMaterial({ color: new THREE.Color(p.color || "#8a93a6"), roughness: 0.55, metalness: /steel|alumin|brass|copper/i.test(p.material) ? 0.6 : 0.05 }));

  // the twin's scene, when it has bodies to pose and the panel asks for no moves of its own
  const twinScene = src.scene();
  let overlay: SimOverlay | null = null;
  const frames: Frames = { t: new Float32Array(1), series: {} };
  if (twinScene && parts.length && !panel.moves.length && (twinScene.bodies.length || twinScene.box || twinScene.ground)) {
    overlay = new SimOverlay(twinScene, parts, meshes);
    scene.add(overlay.object);
    box.copy(overlay.frameBox());
  } else {
    for (const p of parts) {
      const e = meshes.get(p.hash);
      const m = e?.preview ?? e?.final;
      if (!m) continue;
      const geo = keep(new THREE.BufferGeometry());
      geo.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
      geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
      const mesh = new THREE.Mesh(geo, matOf(p));
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      const base = new THREE.Matrix4().fromArray(xformMatrix(p.xf));
      g.matrix.copy(base);
      g.add(mesh);
      scene.add(g);
      const pb = new THREE.Box3(new THREE.Vector3(...e!.bbox[0]), new THREE.Vector3(...e!.bbox[1])).applyMatrix4(base);
      box.union(pb);
      const list = groups.get(p.name) ?? [];
      list.push({ g, base, centre: pb.getCenter(new THREE.Vector3()) });
      groups.set(p.name, list);
    }
  }
  if (box.isEmpty()) box.set(new THREE.Vector3(-100, -100, -100), new THREE.Vector3(100, 100, 100));
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(20, box.getSize(new THREE.Vector3()).length() / 2);
  const dir = (VIEW[panel.view] ?? VIEW.iso).clone().normalize();
  camera.position.copy(centre).addScaledVector(dir, radius * 3.1);
  camera.near = radius / 50;
  camera.far = radius * 60;
  camera.updateProjectionMatrix();
  controls.target.copy(centre);
  controls.update();

  const spinAngle = new Map<number, number>();
  let last = performance.now();
  let w = 0;
  let h = 0;
  let dirty = true;
  controls.addEventListener("change", () => (dirty = true));

  const resize = () => {
    const r = into.getBoundingClientRect();
    if (Math.round(r.width) === w && Math.round(r.height) === h) return;
    w = Math.max(1, Math.round(r.width));
    h = Math.max(1, Math.round(r.height));
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = `${w}px`;
    renderer.domElement.style.height = `${h}px`;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    dirty = true;
  };
  resize();

  let lastVersion = -1;
  const pose = (dt: number) => {
    if (overlay) {
      if (store.version === lastVersion) return false;
      lastVersion = store.version;
      const names = store.names();
      let rebuilt = false;
      for (const n of names) {
        const v = store.get(n);
        if (typeof v !== "number") continue;
        let s = frames.series[n];
        if (!s) {
          s = frames.series[n] = new Float32Array(1);
          rebuilt = true;
        }
        s[0] = v;
      }
      frames.t[0] = store.time;
      if (rebuilt) overlay.setFrames(frames);
      overlay.setTime(store.time);
      return true;
    }
    let moved = false;
    // every part back to where the design puts it, then each move on top
    for (const list of groups.values()) for (const x of list) x.g.matrix.copy(x.base);
    panel.moves.forEach((mv, i) => {
      const list = groups.get(mv.part);
      if (!list) return;
      const v = store.eval(mv.expr);
      const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
      const axis = new THREE.Vector3(...mv.axis).normalize();
      let m: THREE.Matrix4;
      if (mv.kind === "slide") m = new THREE.Matrix4().makeTranslation(axis.x * n, axis.y * n, axis.z * n);
      else {
        const a = mv.kind === "spin" ? (spinAngle.get(i) ?? 0) + n * 6 * dt * D2R : n * D2R;
        if (mv.kind === "spin") spinAngle.set(i, a % (Math.PI * 2));
        const about = mv.about ? new THREE.Vector3(...mv.about) : list[0].centre;
        m = new THREE.Matrix4().makeTranslation(about.x, about.y, about.z).multiply(new THREE.Matrix4().makeRotationAxis(axis, a)).multiply(new THREE.Matrix4().makeTranslation(-about.x, -about.y, -about.z));
        if (mv.kind === "spin" && n !== 0) moved = true;
      }
      for (const x of list) {
        x.g.matrix.premultiply(m);
        x.g.matrixWorldNeedsUpdate = true;
      }
      moved = moved || store.version !== lastVersion;
    });
    lastVersion = store.version;
    return moved;
  };

  return {
    update() {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      // 30 frames a second is plenty for a panel
      if (now - last < 30) return;
      last = now;
      resize();
      controls.update();
      if (pose(dt)) dirty = true;
      if (!dirty) return;
      dirty = false;
      const p = palette();
      scene.background = null;
      renderer.setClearColor(new THREE.Color(p.bg), 0);
      renderer.render(scene, camera);
    },
    resize() {
      resize();
      dirty = true;
    },
    stale: () => src.scene() !== twinScene,
    destroy() {
      controls.dispose();
      overlay?.dispose();
      for (const d of disposables) d.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
