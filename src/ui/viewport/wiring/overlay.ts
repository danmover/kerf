// Draws the design's wiring in the 3D view: every cable from the wire list
// along its routed path, with the wires inside it in their colours, a real
// connector body at each end and the headers and terminals it plugs into.
// Plugs and headers move with their parts; a cable stretches between its two
// ends when the view is exploded. A cable to a moving part runs through drag
// chains and loops (flex.ts) that flex as the machine moves. A picked cable
// stands out and the rest fade.

import * as THREE from "three";
import type { SceneOverlay, OverlayHit } from "../scene";
import type { V3 } from "../../../kernel/recipe";
import { xformMatrix } from "../../../kernel/recipe";
import type { EvalPart } from "../../../core/model";
import { PLUG_BACK, contactX, leadLength, placeFrame, type Harness, type HarnessWire, type PlugEnd } from "../../../machine/harness/harness";
import type { RoutedWire } from "../../../machine/harness/route";
import { endAxes, slotPoint, type FlexLink, type PieceEnd, type TravelPlan } from "../../../machine/harness/travel";
import { MeshBuilder, norm } from "./builder";
import { plugBody, socketBody } from "./bodies";
import { FlexDrawing } from "./flex";

interface Host {
  partGroup(id: string): THREE.Group | undefined;
  requestRender(): void;
}

/** What a hit on the wiring is: a cable, the plug at one of its ends, or a drag chain or loop (wire ""). */
export interface WireHit extends OverlayHit {
  wire: string;
  end: 0 | 1 | null;
  link?: string;
}

interface Follow {
  partId: string;
  /** the part's placement when the harness was built */
  base: THREE.Matrix4;
  inv: THREE.Matrix4;
  /** placement now (with explode and motion), relative to base */
  delta: THREE.Matrix4;
  key: string;
}

/** A run of a cable between two plugs, or between a plug and a chain or loop, or between two of those. */
interface Seg {
  cable: THREE.Mesh;
  base: Float32Array;
  span: Float32Array;
  /** the run's two ends in the assembly, to measure how far each has moved */
  origins: [THREE.Vector3, THREE.Vector3];
  follows: [Follow, Follow];
  key: string;
}

interface WireObj {
  w: HarnessWire;
  segs: Seg[];
  /** plug origins in the assembly */
  origins: [THREE.Vector3, THREE.Vector3];
  plugs: [THREE.Group, THREE.Group];
  plugFollows: [Follow, Follow];
  mats: THREE.MeshStandardMaterial[];
  key: string;
}

interface FlexObj {
  d: FlexDrawing;
  parent: Follow;
  child: Follow;
}

/** One end of a run: a plug, or where it leaves a chain or loop (its slot point and the way it leaves). */
type SegEnd = { plug: PlugEnd } | { at: V3; dir: V3; across: V3 };

interface SocketObj {
  group: THREE.Group;
  follow: Follow;
}

const DIM = 0.16;

export class WiringOverlay implements SceneOverlay {
  readonly object = new THREE.Group();
  readonly replaces = new Set<string>();
  readonly ghosts = new Map<string, number>();
  private wires = new Map<string, WireObj>();
  private flexes: FlexObj[] = [];
  private sockets: SocketObj[] = [];
  private follows = new Map<string, Follow>();
  private plastic = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0 });
  private metal = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.55 });
  private picked: string | null = null;
  private hovered: string | null = null;
  private pickedLink: string | null = null;
  private planes: THREE.Plane[] | null = null;
  onPick?: (hit: WireHit | null, additive: boolean) => void;
  onHover?: (hit: WireHit | null) => void;

  constructor(private host: Host) {
    this.object.name = "wiring";
  }

  get size() {
    return this.wires.size;
  }

  /**
   * Draw a harness. Covers (removable parts) fade so the plugs under them show,
   * and so, less, do made parts that a plug sits inside (an electronics box, a
   * carriage around the hotend's leads). `boxOf` is a part's box in its own frame.
   */
  set(h: Harness, routes: Map<string, RoutedWire> | null, parts: EvalPart[], boxOf?: (p: EvalPart) => [V3, V3] | undefined, plan?: TravelPlan | null) {
    this.clear();
    const byId = new Map(parts.map((p) => [p.id, p]));
    for (const p of parts) if (p.removable) this.ghosts.set(p.id, 0.14);
    const ends = h.wires.flatMap((w) => w.ends);
    for (const p of parts) {
      const box = p.kind === "component" || p.removable || p.hidden ? undefined : boxOf?.(p);
      if (!box) continue;
      const [lo, hi] = worldBox(xformMatrix(p.xf), box);
      if (ends.some((e) => e.partId !== p.id && e.frame.o.every((v, k) => v > lo[k] + 1 && v < hi[k] - 1))) this.ghosts.set(p.id, 0.3);
    }
    const follow = (id: string): Follow => {
      let f = this.follows.get(id);
      if (!f) {
        const p = byId.get(id);
        const base = new THREE.Matrix4().fromArray(p ? xformMatrix(p.xf) : new THREE.Matrix4().toArray());
        f = { partId: id, base, inv: base.clone().invert(), delta: new THREE.Matrix4(), key: "" };
        this.follows.set(id, f);
      }
      return f;
    };
    const links = new Map((plan?.links ?? []).map((l) => [l.id, l]));
    const rep = new Map((plan?.carriers ?? []).map((c) => [c.id, c.rep]));
    // a link's fixed end moves with the part it is fastened to, or its carrier; the moving end with its part
    const fixedPart = (l: FlexLink) => l.fixedOn ?? (l.parent ? (rep.get(l.parent) ?? "") : "");
    for (const w of h.wires) {
      const pieces = plan?.pieces[w.id];
      const segEnd = (e: PieceEnd): { end: SegEnd; follow: Follow } => {
        if ("plug" in e) return { end: { plug: w.ends[e.plug] }, follow: follow(w.ends[e.plug].partId) };
        const l = links.get(e.link)!;
        return { end: { at: slotPoint(plan!, l, e.end, w.id), dir: e.end === "F" ? l.outF : l.outG, across: endAxes(l, e.end).e1 }, follow: follow(e.end === "F" ? fixedPart(l) : l.movingOn) };
      };
      const runs = pieces ? pieces.map((pc) => ({ id: pc.id, a: segEnd(pc.a), b: segEnd(pc.b) })) : [{ id: w.id, a: segEnd({ plug: 0 }), b: segEnd({ plug: 1 }) }];
      this.wires.set(w.id, this.buildWire(w, runs.map((r) => ({ ...r, route: routes?.get(r.id) })), [follow(w.ends[0].partId), follow(w.ends[1].partId)]));
    }
    for (const l of plan?.links ?? []) {
      const d = new FlexDrawing(l, plan!, h.wires.filter((w) => l.wires.includes(w.id)));
      d.update(l.G0);
      this.object.add(d.group, d.moving);
      this.flexes.push({ d, parent: follow(fixedPart(l)), child: follow(l.movingOn) });
    }
    // headers and terminals, one mesh pair per part, in the part's frame
    const byPart = new Map<string, Harness["sockets"]>();
    for (const s of h.sockets) byPart.set(s.partId, [...(byPart.get(s.partId) ?? []), s]);
    for (const [id, list] of byPart) {
      const f = follow(id);
      const p = new MeshBuilder();
      const m = new MeshBuilder();
      for (const s of list) socketBody(p, m, placeFrame(f.base.toArray(), s.local), s.kind, s.ways, s.pitch, s.used);
      const group = new THREE.Group();
      group.matrixAutoUpdate = false;
      if (p.vertexCount) group.add(new THREE.Mesh(p.build(), this.plastic));
      if (m.vertexCount) group.add(new THREE.Mesh(m.build(), this.metal));
      this.object.add(group);
      this.sockets.push({ group, follow: f });
    }
    this.applyLook();
    this.host.requestRender();
  }

  private buildWire(w: HarnessWire, runs: { a: { end: SegEnd; follow: Follow }; b: { end: SegEnd; follow: Follow }; route?: RoutedWire }[], plugFollows: [Follow, Follow]): WireObj {
    const cableMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0 });
    const segs = runs.map((r) => this.buildSeg(w, r.a.end, r.b.end, r.route, [r.a.follow, r.b.follow], cableMat));
    const plugMats = [this.plastic.clone(), this.metal.clone()];
    const plugs = w.ends.map((e, k) => {
      const p = new MeshBuilder();
      const m = new MeshBuilder();
      plugBody(p, m, e.frame, { spec: e.spec, wires: w.wires });
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      for (const [b, mat] of [
        [p, plugMats[0]],
        [m, plugMats[1]],
      ] as const) {
        if (!b.vertexCount) continue;
        const mesh = new THREE.Mesh(b.build(), mat);
        mesh.userData.wire = w.id;
        mesh.userData.end = k;
        g.add(mesh);
      }
      this.object.add(g);
      return g;
    }) as [THREE.Group, THREE.Group];
    const [A, B] = w.ends;
    return { w, segs, origins: [new THREE.Vector3(...A.frame.o), new THREE.Vector3(...B.frame.o)], plugs, plugFollows, mats: [cableMat, ...plugMats], key: "" };
  }

  /** One run of a cable: its wires spread to the contacts at a plug, bundled and twisted elsewhere. */
  private buildSeg(w: HarnessWire, A: SegEnd, B: SegEnd, r: RoutedWire | undefined, follows: [Follow, Follow], mat: THREE.Material): Seg {
    const lead = leadLength(w);
    const back = (e: SegEnd) => ("plug" in e ? add(e.plug.frame.o, e.plug.frame.z, PLUG_BACK[e.plug.spec.kind]) : e.at);
    const dir = (e: SegEnd) => ("plug" in e ? e.plug.frame.z : e.dir);
    const backA = back(A);
    const backB = back(B);
    const route = r?.points ?? [add(backA, dir(A), lead), add(backB, dir(B), lead)];
    const centre = sample([backA, ...route, backB], w.d);
    const startX = "plug" in A ? A.plug.frame.x : A.across;
    const { pts, frames } = transport(centre, startX);
    const L = pts.length ? arcLength(pts) : 0;
    const s = cumulative(pts);
    const n = w.wires.length;
    const builder = new MeshBuilder();
    const span = s.map((v) => (L ? v / L : 0));
    // the far end's contact row, as an angle in the cable's own frame where it arrives
    const last = frames[frames.length - 1];
    const phiB = "plug" in B ? Math.atan2(dot(B.plug.frame.x, last.b), dot(B.plug.frame.x, last.n)) : 0;
    const radius = n === 1 ? 0 : w.wires[0].d * [0, 0, 0.5, 0.58, 0.71, 0.85, 1, 1.15][Math.min(n, 7)];
    const twist = n > 1 ? (Math.PI * 2) / (n > 2 ? 70 : 45) : 0;
    w.wires.forEach((wi, i) => {
      const xa = "plug" in A ? contactX(A.plug.spec, i, n) : 0;
      const xb = "plug" in B ? contactX(B.plug.spec, i, n) : 0;
      const out: V3[] = [];
      for (let k = 0; k < pts.length; k++) {
        const sk = s[k];
        // spread to the contacts only at a plug; at a chain or loop the wires stay bundled
        const wa = "plug" in A ? 1 - smoothstep(lead, lead + 14, sk) : 0;
        const wb = "plug" in B ? smoothstep(L - lead - 14, L - lead, sk) : 0;
        const wm = Math.max(0, 1 - wa - wb);
        const tot = wa + wb + wm || 1;
        const th = (i / n) * Math.PI * 2 + twist * sk;
        const u = (wa * xa + wb * xb * Math.cos(phiB) + wm * radius * Math.cos(th)) / tot;
        const v = (wb * xb * Math.sin(phiB) + wm * radius * Math.sin(th)) / tot;
        const f = frames[k];
        out.push([pts[k][0] + f.n[0] * u + f.b[0] * v, pts[k][1] + f.n[1] * u + f.b[1] * v, pts[k][2] + f.n[2] * u + f.b[2] * v]);
      }
      // each wire gets its own frames, since its offset path bends differently from the centre line
      const own = transport(out, startX).frames;
      builder.tube(out, own.map((f) => f.n), own.map((f) => f.b), wi.d / 2, wi.color, wi.d > 2 ? 10 : 7, span);
    });
    const geo = builder.build();
    const cable = new THREE.Mesh(geo, mat);
    cable.userData.wire = w.id;
    cable.matrixAutoUpdate = false;
    this.object.add(cable);
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    return {
      cable,
      base: (pos.array as Float32Array).slice(),
      span: (geo.getAttribute("span") as THREE.BufferAttribute).array as Float32Array,
      origins: [new THREE.Vector3(...backA), new THREE.Vector3(...backB)],
      follows,
      key: "",
    };
  }

  /** The picked cable stands out, the others fade; a hovered one brightens. */
  setFocus(picked: string | null, hovered: string | null, link: string | null = null) {
    if (picked === this.picked && hovered === this.hovered && link === this.pickedLink) return;
    this.picked = picked;
    this.hovered = hovered;
    this.pickedLink = link;
    this.applyLook();
    this.host.requestRender();
  }

  /** a cable fades when another is picked, or when a chain or loop it is not in is picked */
  private dimmed(wire: string) {
    if (this.picked) return this.picked !== wire;
    if (this.pickedLink) return !this.flexes.find((f) => f.d.link.id === this.pickedLink)?.d.link.wires.includes(wire);
    return false;
  }

  private applyLook() {
    for (const o of this.wires.values()) {
      const dim = this.dimmed(o.w.id);
      const lit = this.picked === o.w.id || this.hovered === o.w.id;
      for (const m of o.mats) {
        m.transparent = dim;
        m.opacity = dim ? DIM : 1;
        m.depthWrite = !dim;
        m.emissive.setRGB(lit ? 0.16 : 0, lit ? 0.16 : 0, lit ? 0.19 : 0);
        m.clippingPlanes = this.planes;
        m.needsUpdate = true;
      }
      for (const sg of o.segs) sg.cable.renderOrder = dim ? 2 : 0;
    }
    for (const f of this.flexes) f.d.setLook((wire) => (wire ? this.dimmed(wire) : false), this.planes);
    this.plastic.clippingPlanes = this.planes;
    this.metal.clippingPlanes = this.planes;
  }

  setClipping(planes: THREE.Plane[] | null) {
    this.planes = planes;
    this.applyLook();
  }

  /** The nearest cable or plug along a ray. */
  hitTest(ray: THREE.Raycaster): WireHit | null {
    const targets: THREE.Object3D[] = [];
    for (const o of this.wires.values()) {
      // a faded cable can still be picked: that is how you move to another one
      targets.push(...o.segs.map((sg) => sg.cable), ...o.plugs.flatMap((g) => g.children));
    }
    for (const f of this.flexes) targets.push(...f.d.targets);
    const hits = ray.intersectObjects(targets, false);
    for (const h of hits) {
      if (this.planes?.some((p) => p.distanceToPoint(h.point) < 0)) continue;
      const wire = h.object.userData.wire as string | undefined;
      const link = h.object.userData.link as string | undefined;
      if (link) return { distance: h.distance, wire: "", end: null, link };
      if (!wire) continue;
      const end = h.object.userData.end as 0 | 1 | undefined;
      return { distance: h.distance, wire, end: end ?? null };
    }
    return null;
  }

  pick(hit: OverlayHit | null, additive: boolean) {
    this.onPick?.(hit as WireHit | null, additive);
  }

  hover(hit: OverlayHit | null) {
    this.onHover?.(hit as WireHit | null);
  }

  /** Where a wire's plug is now on screen space terms: its origin in the world, following its part. */
  plugPoint(wire: string, end: 0 | 1): THREE.Vector3 | null {
    const o = this.wires.get(wire);
    if (!o) return null;
    return o.origins[end].clone().applyMatrix4(o.plugFollows[end].delta);
  }

  /** Follow the parts: plugs and headers move with them, cables stretch between their ends. */
  tick(): boolean {
    let moved = false;
    for (const f of this.follows.values()) {
      const g = this.host.partGroup(f.partId);
      if (!g) continue;
      g.updateWorldMatrix(true, false);
      const delta = new THREE.Matrix4().multiplyMatrices(g.matrixWorld, f.inv);
      const key = delta.elements.map((v) => v.toFixed(3)).join(",");
      if (key !== f.key) {
        f.key = key;
        f.delta.copy(delta);
        moved = true;
      }
    }
    if (!moved) return false;
    for (const s of this.sockets) {
      s.group.matrix.copy(s.follow.delta);
      s.group.matrixWorldNeedsUpdate = true;
    }
    for (const o of this.wires.values()) {
      const key = o.plugFollows[0].key + "|" + o.plugFollows[1].key;
      if (key !== o.key) {
        o.key = key;
        o.plugs.forEach((g, k) => {
          g.matrix.copy(o.plugFollows[k].delta);
          g.matrixWorldNeedsUpdate = true;
        });
      }
      for (const sg of o.segs) stretch(sg);
    }
    for (const f of this.flexes) {
      // the moving end where the child is now, in the parent's frame where the design shows it
      const g = new THREE.Vector3(...f.d.link.G0).applyMatrix4(f.child.delta).applyMatrix4(f.parent.delta.clone().invert());
      f.d.group.matrix.copy(f.parent.delta);
      f.d.group.matrixWorldNeedsUpdate = true;
      f.d.moving.matrix.copy(f.child.delta);
      f.d.moving.matrixWorldNeedsUpdate = true;
      f.d.update([g.x, g.y, g.z]);
    }
    return true;
  }

  private clear() {
    for (const o of this.wires.values()) {
      for (const sg of o.segs) sg.cable.geometry.dispose();
      for (const g of o.plugs) for (const c of g.children) (c as THREE.Mesh).geometry.dispose();
      for (const m of o.mats) m.dispose();
    }
    for (const f of this.flexes) f.d.dispose();
    this.flexes = [];
    for (const s of this.sockets) for (const c of s.group.children) (c as THREE.Mesh).geometry.dispose();
    this.object.clear();
    this.wires.clear();
    this.sockets = [];
    this.follows.clear();
    this.ghosts.clear();
  }

  dispose() {
    this.clear();
    this.plastic.dispose();
    this.metal.dispose();
  }
}

const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

/** A run follows its two ends: rigid when they move together, stretched between them when they part (explode). */
function stretch(sg: Seg) {
  const key = sg.follows[0].key + "|" + sg.follows[1].key;
  if (key === sg.key) return;
  sg.key = key;
  const da = sg.origins[0].clone().applyMatrix4(sg.follows[0].delta).sub(sg.origins[0]);
  const db = sg.origins[1].clone().applyMatrix4(sg.follows[1].delta).sub(sg.origins[1]);
  const pos = sg.cable.geometry.getAttribute("position") as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  for (let i = 0; i < sg.span.length; i++) {
    const t = smoothstep(0.04, 0.96, sg.span[i]);
    arr[3 * i] = sg.base[3 * i] + da.x + (db.x - da.x) * t;
    arr[3 * i + 1] = sg.base[3 * i + 1] + da.y + (db.y - da.y) * t;
    arr[3 * i + 2] = sg.base[3 * i + 2] + da.z + (db.z - da.z) * t;
  }
  pos.needsUpdate = true;
  sg.cable.geometry.computeBoundingSphere();
  sg.cable.geometry.computeBoundingBox();
}

/** A box in a part's frame as an axis-aligned box in the world. */
function worldBox(m: number[], [lo, hi]: [V3, V3]): [V3, V3] {
  const a: V3 = [Infinity, Infinity, Infinity];
  const b: V3 = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const x = c & 1 ? hi[0] : lo[0];
    const y = c & 2 ? hi[1] : lo[1];
    const z = c & 4 ? hi[2] : lo[2];
    for (let k = 0; k < 3; k++) {
      const v = m[k] * x + m[4 + k] * y + m[8 + k] * z + m[12 + k];
      a[k] = Math.min(a[k], v);
      b[k] = Math.max(b[k], v);
    }
  }
  return [a, b];
}
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function smoothstep(a: number, b: number, x: number) {
  if (b <= a) return x >= b ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function cumulative(pts: V3[]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
  return out;
}

function arcLength(pts: V3[]) {
  const c = cumulative(pts);
  return c[c.length - 1];
}

/** A smooth centre line through the route, resampled about every 1.5 to 3 mm. */
function sample(points: V3[], d: number): V3[] {
  const clean: THREE.Vector3[] = [];
  for (const p of points) {
    const v = new THREE.Vector3(...p);
    if (!clean.length || clean[clean.length - 1].distanceTo(v) > 0.4) clean.push(v);
  }
  if (clean.length < 2) return clean.map((v) => [v.x, v.y, v.z]);
  const curve = new THREE.CatmullRomCurve3(clean, false, "centripetal");
  const len = curve.getLength();
  const step = Math.min(3, Math.max(1.5, d));
  const n = Math.max(2, Math.ceil(len / step));
  return curve.getSpacedPoints(n).map((v) => [v.x, v.y, v.z]);
}

/** Rotation-minimising frames along a line, starting with the normal closest to `start`. */
function transport(pts: V3[], start: V3): { pts: V3[]; frames: { n: V3; b: V3 }[] } {
  const frames: { n: V3; b: V3 }[] = [];
  let n: V3 | null = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const c = pts[Math.min(pts.length - 1, i + 1)];
    const t = norm([c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
    if (!n) {
      n = add(start, t, -dot(start, t));
      if (Math.hypot(...n) < 1e-4) n = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    }
    n = norm(add(n, t, -dot(n, t)));
    frames.push({ n, b: cross(t, n) });
  }
  return { pts, frames };
}
