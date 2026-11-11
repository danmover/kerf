// The view cube in the corner of the view: it turns with the camera. A face looks square at that side, an edge or a
// corner looks from between them, dragging it turns the view, and with a face square on the arrows beside it step
// round to the next face. X, Y and Z run along its edges from the corner nearest the origin.

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { SceneController } from "./scene";
import { requestCamera } from "../../app/view";
import { Icon } from "../icons";
import { CUBE_FACES, cellDir, cssMatrix, cubeMatrix, dirKey, dirName, faceFor, squareOn, toCss, type SquareOn, type V3 } from "./viewCubeMath";

/** half the cube's side, px (as .vc-face in app.css) */
const H = 25;
/** how far the axes run past the cube, and their labels past that */
const EXT = 9;
const TIP = 7;
/** axes sit this far off the cube's faces so they don't cut into them */
const OFF = 1.5;
const CELLS = [-1, 0, 1];

const AXES: { name: "x" | "y" | "z"; start: V3; turn: string; tip: V3 }[] = [
  { name: "x", start: [-H, -H - OFF, -H - OFF], turn: "", tip: [H + EXT + TIP, -H - OFF, -H - OFF] },
  { name: "y", start: [-H - OFF, -H, -H - OFF], turn: "rotateY(90deg)", tip: [-H - OFF, H + EXT + TIP, -H - OFF] },
  { name: "z", start: [-H - OFF, -H - OFF, -H], turn: "rotateZ(-90deg)", tip: [-H - OFF, -H - OFF, H + EXT + TIP] },
];

const px = (v: V3) => v.map((x) => `${+x.toFixed(2)}px`).join(", ");

function look(scene: SceneController | null, d: V3) {
  scene?.takeCamera();
  const face = faceFor(d);
  if (face) requestCamera(face);
  else requestCamera("fit", d);
}

export function ViewCube({ scene }: { scene: SceneController | null }) {
  const cube = useRef<HTMLDivElement>(null);
  const tips = useRef<(HTMLSpanElement | null)[]>([]);
  const [hot, setHot] = useState<string | null>(null);
  const [square, setSquare] = useState<SquareOn | null>(null);
  const drag = useRef<{ x: number; y: number; dir: V3 | null; moved: boolean } | null>(null);

  // follow the camera without re-rendering: only the arrows change with React
  useEffect(() => {
    if (!scene) return;
    const m = new THREE.Matrix4();
    const back = new THREE.Matrix4();
    let last = "";
    const follow = (q: THREE.Quaternion) => {
      cubeMatrix(q, m);
      if (cube.current) cube.current.style.transform = cssMatrix(m);
      // the axis labels turn back to face the screen
      const face = cssMatrix(back.copy(m).transpose());
      AXES.forEach((a, i) => {
        const t = tips.current[i];
        if (t) t.style.transform = `translate3d(${px(toCss(a.tip))}) ${face} translate(-50%, -50%)`;
      });
      const s = squareOn(q);
      const k = s ? `${s.face}${s.up}${s.right}` : "";
      if (k !== last) {
        last = k;
        setSquare(s);
      }
    };
    scene.onOrient = follow;
    follow(scene.camera.quaternion);
    return () => {
      scene.onOrient = () => undefined;
    };
  }, [scene]);

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-dir]");
    drag.current = { x: e.clientX, y: e.clientY, dir: cell ? (cell.dataset.dir!.split(",").map(Number) as V3) : null, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x,
      dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) setHot(null);
    d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    scene?.orbitBy(dx, dy);
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved && d.dir) look(scene, d.dir);
  };

  const step = (to: keyof Omit<SquareOn, "face">) => square && look(scene, CUBE_FACES.find((f) => f.name === square[to])!.n);

  return (
    <div className="vp-cube" role="group" aria-label="View cube" onPointerLeave={() => !drag.current && setHot(null)}>
      <div className="vc-stage" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => (drag.current = null)}>
        <div className="vc-cube" ref={cube}>
          {CUBE_FACES.map((f) => (
            <div key={f.name} className="vc-face" style={{ transform: `${f.css} translateZ(${H}px)` }}>
              {CELLS.map((j) =>
                CELLS.map((i) => {
                  const d = cellDir(f, i, j);
                  const key = dirKey(d);
                  return <div key={key} className={`vc-cell ${i || j ? (i && j ? "corner" : "edge") : "mid"} ${hot === key ? "hot" : ""}`} data-dir={key} aria-label={`Look from the ${dirName(d)}`} onPointerEnter={() => !drag.current && setHot(key)} />;
                }),
              )}
              <span className="vc-label" aria-hidden="true">
                {f.label}
                <small>{f.axis}</small>
              </span>
            </div>
          ))}
          {AXES.map((a) => (
            <div key={a.name} className={`vc-axis ${a.name}`} style={{ transform: `translate3d(${px(toCss(a.start))}) ${a.turn}`, width: 2 * H + EXT }}>
              <i />
              <i />
            </div>
          ))}
          {AXES.map((a, i) => (
            <span key={a.name} ref={(el) => (tips.current[i] = el)} className={`vc-tip ${a.name}`} aria-hidden="true">
              {a.name.toUpperCase()}
            </span>
          ))}
        </div>
      </div>
      <button className="vc-home" onClick={() => (scene?.takeCamera(), requestCamera("iso"))} data-tip="Home view (1)" data-tip-pos="right" aria-label="Home view">
        <Icon.Home size={12} />
      </button>
      {square &&
        (["up", "right", "down", "left"] as const).map((s) => (
          <button key={s} className={`vc-step ${s}`} onClick={() => step(s)} data-tip={`Turn to the ${square[s]}`} data-tip-pos="right" aria-label={`Turn to the ${square[s]} view`}>
            <svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">
              <path d="M1 5.5 5 1l4 4.5z" fill="currentColor" />
            </svg>
          </button>
        ))}
    </div>
  );
}
