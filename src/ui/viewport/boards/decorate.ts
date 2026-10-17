// Gives every circuit board in the scene its full model (boards/model.ts):
// bought boards get their solder mask, copper, silkscreen and the real parts
// on them, hiding the coarse component boxes they replace; boards Kerf routes
// itself get the router's copper, pads, holes, silkscreen and solder joints.
// Models are built in idle time so loading a design doesn't stall: a bought
// board once per catalog part, a routed board again when its copper changes.
// Each instance gets its own copy of the materials (fading, section cuts and
// selection change them per part).

import * as THREE from "three";
import type { EvalPart, Model } from "../../../core/model";
import type { PartRecipe, ShapeRecipe, V3 } from "../../../kernel/recipe";
import { boardSpecFor } from "../../../machine/boards";
import { routedLayout } from "../../../machine/boards3d/routed";
import { catalogPart } from "../../../machine/catalog";
import { boardHash } from "../../../machine/pcb/board";
import { useBoards } from "../../../machine/pcb/runtime";
import type { BoardSpec } from "../../../machine/pcb/types";
import type { Decorator, PartDecoration } from "../scene";
import { buildBoard, buildLayout, type BoardModel } from "./model";

/** Where a board's own frame (centre of its underside) sits in the part's frame, from its main solid's box. */
export function boardOrigin(r: PartRecipe, w: number, d: number): V3 | null {
  const off: V3 = [0, 0, 0];
  let s: ShapeRecipe | null = r.base;
  while (s && s.t === "xform") {
    for (const x of s.xf) {
      if (x.op !== "translate") return null;
      off[0] += x.v[0];
      off[1] += x.v[1];
      off[2] += x.v[2];
    }
    s = s.shape;
  }
  if (!s || s.t !== "box" || Math.abs(s.w - w) > 0.01 || Math.abs(s.d - d) > 0.01) return null;
  return [s.at[0] + off[0], s.at[1] + off[1], s.at[2] + off[2]];
}

const idle = (fn: () => void) => {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(fn, { timeout: 400 });
  else setTimeout(fn, 16);
};

/** What a part's decoration is made from: its key, where it sits, how to build it and what it hides. */
interface Plan {
  key: string;
  at: V3;
  /** none while the board is being routed: it keeps what it shows until the copper is ready */
  build?: () => BoardModel;
  hides: string[];
  /** kept after its last instance goes (bought boards come back often and never change) */
  keep: boolean;
}

interface Entry {
  model: BoardModel | null;
  users: number;
  keep: boolean;
}

export class BoardDecorator implements Decorator {
  private entries = new Map<string, Entry>();
  private queue: Plan[] = [];
  private busy = false;
  private dead = false;
  private specs = new Map<string, { spec: BoardSpec; hash: string; text: string }>();
  private unsub: () => void;

  /** `ready` runs (later, never inside a scene call) when there is something new to show. */
  constructor(private ready: () => void) {
    // a board finished routing: its copper can be drawn
    this.unsub = useBoards.subscribe(() => this.later());
  }

  /** The design the parts come from (its routed boards' specs). */
  setModel(model: Model | null) {
    this.specs.clear();
    const m = model?.machine;
    for (const def of m?.boards ?? []) {
      const spec = boardSpecFor(m!, def);
      const text = JSON.stringify([spec.name, spec.parts.map((p) => [p.ref, p.value]), spec.texts ?? []]);
      this.specs.set(def.name, { spec, hash: boardHash(spec), text });
    }
  }

  private plan(p: EvalPart): Plan | null {
    if (p.imported) return null;
    const id = p.bom?.catalogId;
    const part = id ? catalogPart(id) : undefined;
    if (!part) return null;
    if (part.geom.g === "board") {
      const d = part.geom.dims;
      const at = boardOrigin(p.recipe, d.w ?? 50, d.d ?? 30);
      if (!at) return null;
      return { key: `board:${part.id}`, at, build: () => buildBoard(part), hides: [`${p.id}.parts`], keep: true };
    }
    const s = p.kind === "component" ? this.specs.get(p.id) : undefined;
    if (!s) return null;
    const at = boardOrigin(p.recipe, s.spec.w, s.spec.h);
    if (!at) return null;
    const st = useBoards.getState().byHash.get(s.hash);
    if (st?.status === "routing") return { key: `pcb:${s.hash}:routing`, at, hides: [], keep: false };
    const routed = st?.status === "done" ? st.board : undefined;
    const t = p.recipe.base?.t === "box" ? p.recipe.base.h : 1.6;
    const color = p.color;
    const key = `pcb:${s.hash}:${routed ? "routed" : "bare"}:${color}:${t}:${s.text}`;
    return { key, at, build: () => buildLayout(routedLayout(s.spec, routed && { ...routed, spec: s.spec }, t, color)), hides: [], keep: false };
  }

  key(p: EvalPart): string | null {
    const pl = this.plan(p);
    return pl ? `${pl.key}@${pl.at.join(",")}` : null;
  }

  make(p: EvalPart): PartDecoration | null {
    const pl = this.plan(p);
    if (!pl?.build) return null;
    const e = this.entries.get(pl.key);
    if (!e) {
      this.request(pl);
      return null;
    }
    if (!e.model) return null;
    e.users++;
    return instance(e.model, pl.at, pl.hides, () => {
      e.users--;
      if (!e.users && !e.keep) {
        e.model?.dispose();
        this.entries.delete(pl.key);
      }
    });
  }

  private request(pl: Plan) {
    if (this.queue.some((q) => q.key === pl.key)) return;
    this.queue.push(pl);
    if (!this.busy) this.next();
  }

  private next() {
    this.busy = true;
    idle(() => {
      if (this.dead) return;
      const pl = this.queue.shift();
      if (pl && !this.entries.has(pl.key)) {
        let model: BoardModel | null = null;
        try {
          model = pl.build!();
        } catch (e) {
          console.warn(`[kerf] could not build the board model ${pl.key}`, e);
        }
        this.entries.set(pl.key, { model, users: 0, keep: pl.keep });
      }
      // show each board as soon as it is built
      this.ready();
      if (this.queue.length) this.next();
      else {
        this.busy = false;
        this.sweep();
      }
    });
  }

  /** Routed boards built but never shown (the design moved on before they were ready). */
  private sweep() {
    for (const [k, e] of this.entries)
      if (!e.keep && !e.users) {
        e.model?.dispose();
        this.entries.delete(k);
      }
  }

  private pending = false;
  private later() {
    if (this.pending || this.dead) return;
    this.pending = true;
    idle(() => {
      this.pending = false;
      if (!this.dead) this.ready();
    });
  }

  dispose() {
    this.dead = true;
    this.unsub();
    for (const e of this.entries.values()) e.model?.dispose();
    this.entries.clear();
    this.queue = [];
  }
}

/** One board in the scene: the shared meshes with materials of its own. */
function instance(model: BoardModel, at: V3, hides: string[], release: () => void): PartDecoration {
  const object = model.object.clone(true);
  object.position.set(at[0], at[1], at[2]);
  const copies = new Map<THREE.Material, THREE.Material>();
  object.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material)) return;
    let c = copies.get(m.material);
    if (!c) {
      c = m.material.clone();
      copies.set(m.material, c);
    }
    m.material = c;
  });
  let done = false;
  return {
    object,
    hides,
    dispose: () => {
      if (done) return;
      done = true;
      copies.forEach((c) => c.dispose());
      release();
    },
  };
}
