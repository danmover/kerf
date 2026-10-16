// Draws manufacturing-process findings on the model: the flagged faces as a
// tinted skin and flagged edges as lines, attached to each part's group so
// they follow placement, explode and motion. Marks share their part's section
// cut and dim with it when it is ghosted. The focused finding pulses briefly.

import * as THREE from "three";
import type { EvalPart } from "../../core/model";
import type { ProcessFinding, ProcessResult } from "../../mfg/types";
import { parseFindingId } from "../../mfg/report";

interface Host {
  partGroup(id: string): THREE.Group | undefined;
  /** the part's current clipping planes and opacity */
  partLook(id: string): { planes: THREE.Plane[] | null; opacity: number } | undefined;
  requestRender(): void;
}

interface Drawn {
  key: string;
  group: THREE.Group;
  obj: THREE.Object3D;
  mats: THREE.Material[];
  geos: THREE.BufferGeometry[];
  emphasis: boolean;
}

const COLORS: Record<string, number> = { fail: 0xff5d6c, warn: 0xf5b84b, info: 0x6d8bff };
/** how long the focused finding pulses before it holds still, ms */
const PULSE_MS = 2400;

export class ProcessOverlay {
  private drawn = new Map<string, Drawn>();
  private raf = 0;
  private pulsed = "";
  private pulse = 1;

  constructor(private host: Host) {}

  update(parts: EvalPart[], results: Record<string, ProcessResult>, focus: string | null, showAll: boolean, reduceMotion: boolean) {
    const want = new Map<string, { part: string; finding: ProcessFinding; emphasis: boolean }>();
    const ref = focus ? parseFindingId(focus) : null;
    for (const p of parts) {
      const r = results[p.id];
      // results for older geometry would mark faces that have moved: wait for this shape's
      if (!r || p.hidden || !r.key.startsWith(`${p.hash}|`)) continue;
      const count = new Map<string, number>();
      r.findings.forEach((f, i) => {
        const n = count.get(f.rule) ?? 0;
        count.set(f.rule, n + 1);
        if (f.status === "pass" || (!f.marks?.length && !f.lines?.length)) return;
        const focused = !!ref && ref.part === p.id && ref.rule === f.rule && ref.n === n;
        if (!focused && !showAll) return;
        want.set(`${p.id}|${r.key}|${i}|${focused ? 1 : 0}`, { part: p.id, finding: f, emphasis: focused });
      });
    }
    for (const [key, d] of this.drawn) {
      const w = want.get(key);
      const group = w && this.host.partGroup(w.part);
      if (!w || !group) {
        this.dispose(d);
        this.drawn.delete(key);
      } else if (group !== d.group) {
        d.group.remove(d.obj);
        group.add(d.obj);
        d.group = group;
      }
    }
    for (const [key, w] of want) {
      if (this.drawn.has(key)) continue;
      const group = this.host.partGroup(w.part);
      if (!group) continue;
      const d = this.build(key, w.part, w.finding, w.emphasis, group);
      this.drawn.set(key, d);
    }
    // pulse when a new finding comes into focus, not on every redraw of the same one
    const focused = [...this.drawn.values()]
      .filter((d) => d.emphasis)
      .map((d) => d.key)
      .join(",");
    if (focused !== this.pulsed) {
      this.pulsed = focused;
      this.animate(!!focused && !reduceMotion);
    }
    this.host.requestRender();
  }

  private build(key: string, part: string, f: ProcessFinding, emphasis: boolean, group: THREE.Group): Drawn {
    const color = COLORS[f.status] ?? COLORS.info;
    const obj = new THREE.Group();
    obj.name = "process-overlay";
    const mats: THREE.Material[] = [];
    const geos: THREE.BufferGeometry[] = [];
    // follow the part's section cut and ghosting at draw time, whatever changed them
    const follow = (o: THREE.Object3D, m: THREE.Material, base: number) => {
      o.onBeforeRender = () => {
        const look = this.host.partLook(part);
        m.clippingPlanes = look?.planes ?? null;
        const dim = look && look.opacity < 1 && !emphasis ? 0.35 : 1;
        m.opacity = base * (emphasis && m instanceof THREE.MeshBasicMaterial ? this.pulse : 1) * dim;
      };
    };
    if (f.marks?.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(lift(f.marks, 0.05), 3));
      const m = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: emphasis ? 0.62 : 0.4,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
      });
      const mesh = new THREE.Mesh(g, m);
      mesh.renderOrder = emphasis ? 7 : 6;
      follow(mesh, m, emphasis ? 0.62 : 0.4);
      obj.add(mesh);
      mats.push(m);
      geos.push(g);
      if (emphasis) {
        // a faint copy drawn through the model, so faces hidden behind other geometry still show
        const ghost = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
        const through = new THREE.Mesh(g, ghost);
        through.renderOrder = 8;
        follow(through, ghost, 0.22);
        obj.add(through);
        mats.push(ghost);
      }
    }
    if (f.lines?.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(f.lines, 3));
      // the focused finding's edges show through the part so hidden corners are not missed
      const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity: emphasis ? 1 : 0.85, depthTest: !emphasis });
      const lines = new THREE.LineSegments(g, m);
      lines.renderOrder = 8;
      follow(lines, m, emphasis ? 1 : 0.85);
      obj.add(lines);
      mats.push(m);
      geos.push(g);
    }
    group.add(obj);
    return { key, group, obj, mats, geos, emphasis };
  }

  /** A few slow pulses, then steady, so a renderer that accumulates frames can settle. */
  private animate(on: boolean) {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.pulse = 1;
    if (!on) return;
    const t0 = performance.now();
    const tick = () => {
      const t = performance.now() - t0;
      if (t >= PULSE_MS) {
        this.pulse = 1;
        this.raf = 0;
      } else {
        this.pulse = 0.55 + 0.55 * (0.5 - 0.5 * Math.cos((t / 800) * 2 * Math.PI));
        this.raf = requestAnimationFrame(tick);
      }
      this.host.requestRender();
    };
    this.raf = requestAnimationFrame(tick);
  }

  private dispose(d: Drawn) {
    d.group.remove(d.obj);
    for (const m of d.mats) m.dispose();
    for (const g of d.geos) g.dispose();
  }

  destroy() {
    this.animate(false);
    this.pulsed = "";
    for (const d of this.drawn.values()) this.dispose(d);
    this.drawn.clear();
  }
}

/**
 * The marks come from the analysis mesh, which is finer than the display mesh;
 * lifting each triangle slightly along its normal keeps concave faces (holes,
 * inside fillets) from hiding behind the display mesh's chords.
 */
function lift(tris: Float32Array, d: number): Float32Array {
  const out = new Float32Array(tris.length);
  for (let i = 0; i + 8 < tris.length; i += 9) {
    const ux = tris[i + 3] - tris[i],
      uy = tris[i + 4] - tris[i + 1],
      uz = tris[i + 5] - tris[i + 2];
    const vx = tris[i + 6] - tris[i],
      vy = tris[i + 7] - tris[i + 1],
      vz = tris[i + 8] - tris[i + 2];
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx = (nx / l) * d;
    ny = (ny / l) * d;
    nz = (nz / l) * d;
    for (let k = 0; k < 9; k += 3) {
      out[i + k] = tris[i + k] + nx;
      out[i + k + 1] = tris[i + k + 1] + ny;
      out[i + k + 2] = tris[i + k + 2] + nz;
    }
  }
  return out;
}
