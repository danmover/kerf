// Plays how a design goes on by hand and what keeps it there (analysis/
// fitting.ts): the held part comes up to what the bands wrap, each band is
// drawn as its cord while a fingertip hooks it on, pulls it round and
// stretches it over the second pin's head (thinning and colouring with its
// stretch), a part that clicks in slides along its arm and clicks, and each
// seat check shows its loads while the parts shiver under them. Parts move
// through the scene's pose offsets; bands not yet on are drawn here instead
// of as solids, and a part not yet fitted (with what rides on it, like the
// print on a sign) stays hidden until its turn.

import * as THREE from "three";
import type { V3 } from "../../kernel/recipe";
import type { SceneOverlay } from "./scene";
import { bandCaption, bandPoseAt, bandStrainShare, holdDetails, moves, type FitStep } from "../../analysis/fitting";
import type { StructuralResult } from "../../analysis/fe/structural";

interface Host {
  setPose(offsets: Map<string, [number, number, number]> | null): void;
  overlaysChanged(): void;
  requestRender(): void;
}

export interface FitProgress {
  index: number;
  count: number;
  title: string;
  caption: string;
  done: boolean;
}

const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const easeOut = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - (1 - t) ** 3);
const v3 = (p: V3) => new THREE.Vector3(p[0], p[1], p[2]);

// slack → held stretch → beyond it: green, amber, red
const STRAIN = [new THREE.Color(0x3ccf7a), new THREE.Color(0xf2b134), new THREE.Color(0xff4d5e)];
function strainColour(share: number, out: THREE.Color) {
  const s = Math.max(0, Math.min(2, share));
  return s <= 1 ? out.copy(STRAIN[0]).lerp(STRAIN[1], s) : out.copy(STRAIN[1]).lerp(STRAIN[2], s - 1);
}

export class FitOverlay implements SceneOverlay {
  readonly object = new THREE.Group();
  readonly replaces = new Set<string>();
  onProgress: (p: FitProgress) => void = () => undefined;
  private starts: number[] = [];
  private total = 0;
  private t0 = -1;
  private bandMesh: THREE.Mesh;
  private bandMat: THREE.MeshStandardMaterial;
  private finger: THREE.Mesh;
  private click: THREE.Mesh;
  private arrows = new THREE.Group();
  private arrowsFor = -1;
  private holdCaption = "";
  private holdDir: V3 = [0, 0, 0];
  private shown = "";
  private shownStep = -1;
  private disposables: { dispose(): void }[] = [];
  private finished = false;

  constructor(
    private host: Host,
    private steps: FitStep[],
    private reduceMotion: boolean,
    /** the latest run of an analysis, read as its step starts */
    private results: (label: string) => StructuralResult | undefined = () => undefined,
  ) {
    let t = 0;
    for (const s of steps) {
      this.starts.push(t);
      t += s.dur;
    }
    this.total = t + 0.6;
    this.bandMat = this.keep(new THREE.MeshStandardMaterial({ color: 0x3ccf7a, roughness: 0.75, metalness: 0 }));
    this.bandMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.bandMat);
    this.bandMesh.visible = false;
    this.finger = new THREE.Mesh(this.keep(new THREE.SphereGeometry(4.2, 20, 14)), this.keep(new THREE.MeshStandardMaterial({ color: 0xe8b796, roughness: 0.6, transparent: true, opacity: 0.55, depthWrite: false })));
    this.finger.visible = false;
    this.click = new THREE.Mesh(this.keep(new THREE.TorusGeometry(3, 0.35, 8, 32)), this.keep(new THREE.MeshBasicMaterial({ color: 0x5ad1ff, transparent: true, opacity: 0, depthTest: false, depthWrite: false })));
    this.click.renderOrder = 12;
    this.click.visible = false;
    this.object.add(this.bandMesh, this.finger, this.click, this.arrows);
    // bands not on yet and parts not fitted yet are hidden until their turn
    this.hideUnfitted();
  }

  private hideUnfitted() {
    for (const s of this.steps) {
      if (s.kind === "band") this.replaces.add(s.part);
      else if (s.kind === "slide") for (const id of moves(s)) this.replaces.add(id);
    }
  }

  private keep<T extends { dispose(): void }>(x: T): T {
    this.disposables.push(x);
    return x;
  }

  /** Start (or start again) from the first step. */
  restart() {
    this.t0 = -1;
    this.finished = false;
    this.shownStep = -1;
    this.replaces.clear();
    this.hideUnfitted();
    this.host.overlaysChanged();
    this.host.requestRender();
  }

  tick(now: number): boolean {
    if (this.finished) return false;
    if (this.t0 < 0) this.t0 = now;
    const t = (now - this.t0) / 1000;
    if (t >= this.total) {
      this.finish();
      return false;
    }
    this.pose(t);
    return true;
  }

  still() {
    this.pose(this.total - 0.6);
  }

  private finish() {
    this.finished = true;
    this.bandMesh.visible = false;
    this.finger.visible = false;
    this.click.visible = false;
    this.clearArrows();
    if (this.replaces.size) {
      this.replaces.clear();
      this.host.overlaysChanged();
    }
    this.host.setPose(null);
    const last = this.steps[this.steps.length - 1];
    this.onProgress({ index: this.steps.length - 1, count: this.steps.length, title: last?.title ?? "", caption: this.shown, done: true });
  }

  /** Lay everything out as it is t seconds in. */
  private pose(t: number) {
    let i = this.starts.findIndex((s, k) => t >= s && t < s + this.steps[k].dur);
    if (i < 0) i = this.steps.length - 1;
    const step = this.steps[i];
    const raw = Math.min(1, (t - this.starts[i]) / step.dur);
    const k = this.reduceMotion ? 1 : raw;
    const offsets = new Map<string, [number, number, number]>();
    // parts still to come wait where their step starts them
    for (let j = i + 1; j < this.steps.length; j++) {
      const s = this.steps[j];
      if (s.kind === "seat") for (const id of moves(s)) if (!offsets.has(id)) offsets.set(id, s.from);
    }
    // fitted parts and bands show as themselves from the end of their step
    let hidden = false;
    const show = (ids: string[]) => {
      for (const id of ids) if (this.replaces.delete(id)) hidden = true;
    };
    for (let j = 0; j < i; j++) {
      const s = this.steps[j];
      if (s.kind === "band") show([s.part]);
      else if (s.kind === "slide") show(moves(s));
    }
    if (step.kind === "slide") show(moves(step));
    if (hidden) this.host.overlaysChanged();

    let caption = "";
    this.bandMesh.visible = false;
    this.finger.visible = false;
    this.click.visible = false;
    if (step.kind === "seat") {
      const f = 1 - easeOut(k);
      for (const id of moves(step)) offsets.set(id, [step.from[0] * f, step.from[1] * f, step.from[2] * f]);
      caption = step.caption;
    } else if (step.kind === "band") {
      const p = bandPoseAt(step, k);
      this.drawBand(p.loop, p.cord, bandStrainShare(step, p.stretch));
      if (p.phase !== "seated") {
        this.finger.visible = true;
        this.finger.position.copy(v3(p.hand));
      }
      caption = bandCaption(step, p);
    } else if (step.kind === "slide") {
      // in along the arm, a quick stop as the peg drops into the hole
      const s = Math.min(1, k / 0.8);
      const f = 1 - easeOut(s);
      for (const id of moves(step)) offsets.set(id, [step.from[0] * f, step.from[1] * f, step.from[2] * f]);
      if (k >= 0.8) {
        const c = (k - 0.8) / 0.2;
        this.click.visible = true;
        this.click.position.copy(v3(step.peg));
        this.click.lookAt(v3(step.peg).add(v3(step.from)));
        this.click.scale.setScalar(1 + 2.2 * c);
        (this.click.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - c);
      }
      caption = step.caption;
    } else {
      // the loads come on and the parts shiver under them, then settle
      if (this.arrowsFor !== i) {
        const d = holdDetails(step, this.results(step.spec.label));
        this.holdCaption = d.caption;
        this.holdDir = d.arrows[0]?.dir ?? [0, 0, 0];
        this.showArrows(i, d.arrows);
      }
      const env = Math.sin(Math.PI * Math.min(1, raw * 1.15));
      const wob = this.reduceMotion ? 0 : 0.5 * env * Math.sin(raw * Math.PI * 2 * 7);
      const d = this.holdDir;
      for (const id of step.parts) offsets.set(id, [d[0] * wob, d[1] * wob, d[2] * wob]);
      this.arrows.children.forEach((a) => ((a as THREE.Object3D).scale.setScalar(0.3 + 0.7 * ease(raw * 3))));
      caption = this.holdCaption;
    }
    if (step.kind !== "hold") this.clearArrows();
    this.host.setPose(offsets.size ? offsets : null);
    if (caption !== this.shown || i !== this.shownStep) {
      this.shown = caption;
      this.shownStep = i;
      this.onProgress({ index: i, count: this.steps.length, title: step.title, caption, done: false });
    }
    this.host.requestRender();
  }

  private drawBand(loop: V3[], cord: number, share: number) {
    const pts = loop.map(v3);
    // drop repeats: a closed curve through coincident points twists the tube
    const clean: THREE.Vector3[] = [];
    for (const p of pts) if (!clean.length || clean[clean.length - 1].distanceToSquared(p) > 0.04) clean.push(p);
    if (clean.length > 2 && clean[0].distanceToSquared(clean[clean.length - 1]) < 0.04) clean.pop();
    if (clean.length < 3) return;
    const curve = new THREE.CatmullRomCurve3(clean, true, "centripetal");
    this.bandMesh.geometry.dispose();
    this.bandMesh.geometry = new THREE.TubeGeometry(curve, Math.min(400, clean.length * 3), cord / 2, 10, true);
    strainColour(share, this.bandMat.color);
    this.bandMesh.visible = true;
  }

  private showArrows(i: number, list: { at: V3; dir: V3; size: number }[]) {
    this.clearArrows();
    const big = Math.max(1e-6, ...list.map((a) => a.size));
    for (const a of list) {
      // longer for the bigger loads, never too small to see
      const len = 14 + 26 * Math.sqrt(a.size / big);
      const dir = v3(a.dir).normalize();
      const from = v3(a.at).addScaledVector(dir, -len);
      const arrow = new THREE.ArrowHelper(dir, from, len, 0xff8a3d, Math.min(8, len * 0.35), Math.min(5, len * 0.22));
      (arrow.line.material as THREE.Material).depthTest = false;
      (arrow.cone.material as THREE.Material).depthTest = false;
      arrow.renderOrder = 11;
      // scaled about where the load lands, so it grows in toward the part
      const g = new THREE.Group();
      g.position.copy(v3(a.at));
      arrow.position.sub(g.position);
      g.add(arrow);
      this.arrows.add(g);
    }
    this.arrowsFor = i;
  }

  private clearArrows() {
    for (const g of [...this.arrows.children]) {
      g.traverse((o) => {
        const m = o as THREE.Mesh | THREE.Line;
        if ("geometry" in m && m.geometry) m.geometry.dispose();
        if ("material" in m && m.material) (m.material as THREE.Material).dispose();
      });
      this.arrows.remove(g);
    }
    this.arrowsFor = -1;
  }

  dispose() {
    this.clearArrows();
    this.bandMesh.geometry.dispose();
    for (const d of this.disposables) d.dispose();
    this.host.setPose(null);
  }
}
