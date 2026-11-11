// Dragging parts in the 3D view the ways they can move. Select a part its mates leave free (a lid on its hinge,
// a carriage on its rail) or one the mechanism moves (a crank, a gear, a rocker), then drag it: it follows the
// pointer only as far as its mates or the mechanism let it, and the parts mated to it come along. Letting go
// leaves it there to look at; Keep here writes a mated pose into the design, Put back returns it. Esc during a
// drag lets go of it where it started.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { create } from "zustand";
import { useDesign } from "../../core/engine";
import { dragHow, keepPose, mateDeltas, mateDragTo, motionDragTo, movedWords, startMateDrag, startMotionDrag, type MateDrag, type MotionDrag } from "../../core/mateDrag";
import type { BodyMove } from "../../core/mates";
import type { V3 } from "../../kernel/recipe";
import { fmtNum } from "../../lang/values";
import { commitSource, realSource } from "../../app/project";
import { toast } from "../../app/ui";
import { usePicks } from "../../app/picks";
import { useView } from "../../app/view";
import { useSketch } from "../sketch/session";
import { useMarkup } from "../Markup";
import { partMeshes, useMeasure } from "./MeasureTool";
import type { PickHost } from "./PickLayer";

/** What the view needs to show a dragged pose. */
export interface DragScene {
  setPose(offsets: Map<string, THREE.Matrix4> | null): void;
  readonly motionAngle: number;
  setMotionAngle(deg: number): void;
}

type Held = { kind: "mates"; body: string; moves: Map<string, BodyMove>; rev: number } | { kind: "motion"; part: string; label: string; from: number; angle: number };

/** A pose left showing after a drag, until it is kept, put back or the design changes. */
export const useDragPose = create<{ held: Held | null }>(() => ({ held: null }));

const raycaster = new THREE.Raycaster();

function rayAt(h: PickHost, x: number, y: number) {
  const r = h.canvas.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), h.camera);
  return raycaster.ray.clone();
}

const v3 = (v: THREE.Vector3): V3 => [v.x, v.y, v.z];

export function DragLayer({ host, scene }: { host: () => PickHost | null; scene: DragScene }) {
  const model = useDesign((s) => s.model);
  const rev = useDesign((s) => s.rev);
  const selected = useView((s) => s.selected);
  const playing = useView((s) => s.playing);
  const explode = useView((s) => s.explode);
  const filter = usePicks((s) => s.filter);
  const box = usePicks((s) => s.box);
  const measureOn = useMeasure((s) => s.on);
  const sketching = useSketch((s) => !!s.active || s.picking);
  const markup = useMarkup((s) => s.on);
  const held = useDragPose((s) => s.held);
  const [, setTick] = useState(0);
  const drag = useRef<{ x0: number; y0: number; moved: boolean; normal: THREE.Vector3; at: THREE.Vector3; mates?: MateDrag; motion?: MotionDrag; angle0: number; before: Held | null } | null>(null);

  const part = selected.length === 1 ? model?.parts.find((p) => p.id === selected[0]) : undefined;
  const how = model && part ? dragHow(model, part) : null;
  const active = !!(how && how.kind !== "none" && filter === "part" && !box && !measureOn && !sketching && !markup && !playing && explode === 0);

  // a mated pose belongs to the design it was dragged in
  useEffect(() => {
    const h = useDragPose.getState().held;
    if (h?.kind === "mates" && h.rev !== rev) {
      scene.setPose(null);
      useDragPose.setState({ held: null });
    }
  }, [rev, scene]);

  // playing the mechanism takes over its angle
  useEffect(() => {
    if (playing && useDragPose.getState().held?.kind === "motion") useDragPose.setState({ held: null });
  }, [playing]);

  // a design without mates or motion has nothing left to show
  useEffect(() => {
    if (!model?.mates && !model?.parts.some((p) => p.motion)) {
      if (useDragPose.getState().held) useDragPose.setState({ held: null });
    }
  }, [model]);

  useEffect(() => {
    const h = host();
    if (!active || !h || !model || !part || !how) return;
    const el = h.canvas;
    const parent = el.parentElement ?? el;
    let raf = 0;
    let pending: PointerEvent | null = null;

    const showMates = (moves: Map<string, BodyMove>) => {
      const deltas = mateDeltas(model, moves);
      scene.setPose(deltas.size ? new Map([...deltas].map(([id, m]) => [id, new THREE.Matrix4().fromArray(m)])) : null);
    };

    const pd = (e: PointerEvent) => {
      if (e.button !== 0 || e.altKey || e.shiftKey || e.metaKey || e.ctrlKey || e.target !== el) return;
      if (h.hit && h.hit(e.clientX, e.clientY)?.id !== part.id) return;
      const mesh = partMeshes(h.scene).get(part.id);
      if (!mesh) return;
      const ray = rayAt(h, e.clientX, e.clientY);
      raycaster.ray.copy(ray);
      const hit = raycaster.intersectObject(mesh, false)[0];
      if (!hit) return;
      // hold the view still: this drag moves the part
      if (h.orbit) h.orbit.enabled = false;
      const normal = new THREE.Vector3();
      h.camera.getWorldDirection(normal);
      const before = useDragPose.getState().held;
      const d: NonNullable<typeof drag.current> = { x0: e.clientX, y0: e.clientY, moved: false, normal, at: hit.point.clone(), angle0: scene.motionAngle, before };
      if (how.kind === "mates") {
        const shown = before?.kind === "mates" && before.rev === rev ? before.moves : undefined;
        d.mates = startMateDrag(model, how.body, v3(hit.point), shown);
      } else {
        if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
        d.motion = startMotionDrag(part, v3(hit.point), scene.motionAngle, mesh.geometry.boundingSphere?.radius ?? 20) ?? undefined;
        if (!d.motion) return;
      }
      drag.current = d;
    };

    const apply = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const ray = rayAt(h, e.clientX, e.clientY);
      if (d.mates) {
        // the pointer on the plane through the grabbed point, square to the view
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(d.normal, d.at);
        const target = ray.intersectPlane(plane, new THREE.Vector3());
        if (!target) return;
        d.mates = mateDragTo(model, d.mates, v3(target));
        showMates(d.mates.moves);
      } else if (d.motion) {
        d.motion = motionDragTo(part, d.motion, { o: v3(ray.origin), d: v3(ray.direction) });
        scene.setMotionAngle(d.motion.angle);
      }
    };

    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
      d.moved = true;
      pending = e;
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (pending) apply(pending);
          pending = null;
        });
    };

    const pu = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || e.button !== 0) return;
      drag.current = null;
      if (h.orbit) h.orbit.enabled = true;
      if (!d.moved) return;
      if (pending) apply(pending);
      pending = null;
      if (d.mates) useDragPose.setState({ held: { kind: "mates", body: d.mates.body, moves: d.mates.moves, rev } });
      else if (d.motion) {
        const from = d.before?.kind === "motion" ? d.before.from : d.angle0;
        useDragPose.setState({ held: { kind: "motion", part: part.id, label: part.label, from, angle: d.motion.angle } });
      }
      setTick((t) => t + 1);
    };

    // Esc lets go where it started
    const key = (e: KeyboardEvent) => {
      const d = drag.current;
      if (e.key !== "Escape" || !d) return;
      e.stopPropagation();
      drag.current = null;
      if (h.orbit) h.orbit.enabled = true;
      const b = d.before;
      if (d.mates) {
        if (b?.kind === "mates" && b.rev === rev) showMates(b.moves);
        else scene.setPose(null);
      } else scene.setMotionAngle(d.angle0);
    };

    const prevCursor = el.style.cursor;
    const hover = (e: PointerEvent) => {
      if (drag.current || e.buttons) return;
      el.style.cursor = h.hit?.(e.clientX, e.clientY)?.id === part.id ? "grab" : prevCursor;
    };

    parent.addEventListener("pointerdown", pd, true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", pu);
    window.addEventListener("keydown", key, true);
    el.addEventListener("pointermove", hover);
    return () => {
      cancelAnimationFrame(raf);
      parent.removeEventListener("pointerdown", pd, true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", pu);
      window.removeEventListener("keydown", key, true);
      el.removeEventListener("pointermove", hover);
      el.style.cursor = prevCursor;
      if (drag.current && h.orbit) h.orbit.enabled = true;
      drag.current = null;
    };
  }, [active, host, model, part, how?.kind, rev, scene]);

  const putBack = () => {
    const h = useDragPose.getState().held;
    if (!h) return;
    if (h.kind === "mates") scene.setPose(null);
    else scene.setMotionAngle(h.from);
    useDragPose.setState({ held: null });
  };

  const keep = () => {
    const h = useDragPose.getState().held;
    if (!h || h.kind !== "mates" || !model) return;
    const r = keepPose(realSource(), model, h.moves);
    if (!r.kept.length) {
      toast({ kind: "warn", title: `Could not keep it there: ${r.skipped.map((s) => `${s.name}, ${s.why}`).join("; ") || "nothing moved"}` }, 5000);
      return;
    }
    commitSource(r.src, "you", `Kept ${r.kept.join(", ")} where ${r.kept.length > 1 ? "they were" : "it was"} dragged`);
    if (r.skipped.length) toast({ kind: "warn", title: `Not kept: ${r.skipped.map((s) => `${s.name} (${s.why})`).join("; ")}` }, 5000);
    // the design now draws them there; the pose goes when it is read again
  };

  const words = held && model ? (held.kind === "mates" ? movedWords(model, held.body, held.moves) : `${held.label}: mechanism at ${fmtNum(held.angle, 1)}°`) : "";
  const hint = active && !held && how ? (how.kind === "mates" ? `Drag ${part!.label} to move it: it ${how.words}` : `Drag ${part!.label} to turn the mechanism`) : "";

  return (
    <AnimatePresence>
      {held && (
        <motion.div
          key="held"
          className="vp-float drag-bar"
          style={{ left: "50%", bottom: 20, x: "-50%", maxWidth: "calc(100% - 32px)" }}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          role="status"
          aria-live="polite"
        >
          <span className="dim">{words}</span>
          {held.kind === "mates" && (
            <button className="btn sm primary" onClick={keep} data-tip="Write this pose into the design (the parts' at: and rotate:), so it is drawn here and its mates hold it">
              Keep here
            </button>
          )}
          <button className="btn sm ghost" onClick={putBack} data-tip={held.kind === "mates" ? "Back where the design puts it" : "Back to where the mechanism was"}>
            Put back
          </button>
        </motion.div>
      )}
      {!held && hint && (
        <motion.div key="hint" className="drag-hint" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          {hint}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
