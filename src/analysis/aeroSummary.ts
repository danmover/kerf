// Airflow results in words, for the assistant and the design overview:
// forces per yaw, which parts carry the drag, where on the surface it comes
// from (pressure on fronts, suction behind backs, friction), and how it
// moved between versions.

import { fmtNum } from "../lang/values";
import type { AirflowSpec, V3 } from "./spec";
import type { AirflowRun, AirflowVersion } from "./aeroRuntime";
import type { YawResult } from "./aero/types";

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const p3 = (v: V3) => `(${v.map((x) => fmtNum(x, 0)).join(", ")})`;

export interface HotSpot {
  part: string;
  at: V3;
  /** drag from this patch, N, and how much of it is pressure pushing on a front, suction on a back, or friction */
  drag: number;
  front: number;
  back: number;
  friction: number;
  /** mean pressure coefficient over the patch */
  cp: number;
}

/**
 * The surface patches (cubes of `cell` mm) that add the most drag at one yaw, from the pressure and friction on each
 * triangle along the way the design travels. Parts that are not part of the design (a rider) are left out unless asked
 * for: they would crowd the design's own patches off the list.
 */
export function dragHotSpots(y: YawResult, forward: V3, q: number, cell = 60, n = 6, extras = false): HotSpot[] {
  const back: V3 = [-forward[0], -forward[1], -forward[2]];
  const cells = new Map<string, HotSpot & { w: number; sx: number; sy: number; sz: number }>();
  for (const s of y.surface) {
    if (s.extra && !extras) continue;
    const P = s.positions;
    const I = s.indices;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t],
        b = I[t + 1],
        c = I[t + 2];
      const cp = (s.cp[a] + s.cp[b] + s.cp[c]) / 3;
      // past stagnation (1) or far below any suction seen on a body: a cell squeezed in a gap, not the flow
      if (!Number.isFinite(cp) || cp > 1.5 || cp < -8) continue;
      const ux = P[3 * b] - P[3 * a],
        uy = P[3 * b + 1] - P[3 * a + 1],
        uz = P[3 * b + 2] - P[3 * a + 2];
      const vx = P[3 * c] - P[3 * a],
        vy = P[3 * c + 1] - P[3 * a + 1],
        vz = P[3 * c + 2] - P[3 * a + 2];
      // area vector, m²
      const A: V3 = [(uy * vz - uz * vy) * 5e-7, (uz * vx - ux * vz) * 5e-7, (ux * vy - uy * vx) * 5e-7];
      const area = Math.hypot(...A);
      const nb = A[0] * back[0] + A[1] * back[1] + A[2] * back[2];
      const press = -cp * nb * q;
      let cf = 0;
      for (const v of [a, b, c]) cf += s.cf[3 * v] * back[0] + s.cf[3 * v + 1] * back[1] + s.cf[3 * v + 2] * back[2];
      const fric = Number.isFinite(cf) ? (cf / 3) * area * q : 0;
      const cx = (P[3 * a] + P[3 * b] + P[3 * c]) / 3,
        cy = (P[3 * a + 1] + P[3 * b + 1] + P[3 * c + 1]) / 3,
        cz = (P[3 * a + 2] + P[3 * b + 2] + P[3 * c + 2]) / 3;
      const key = `${s.name}|${Math.floor(cx / cell)},${Math.floor(cy / cell)},${Math.floor(cz / cell)}`;
      let h = cells.get(key);
      if (!h) cells.set(key, (h = { part: s.name, at: [0, 0, 0], drag: 0, front: 0, back: 0, friction: 0, cp: 0, w: 0, sx: 0, sy: 0, sz: 0 }));
      h.drag += press + fric;
      // a face toward the air (normal against the travel) pushed on, or one facing back pulled by suction
      if (nb < 0) h.front += press;
      else h.back += press;
      h.friction += fric;
      h.w += area;
      h.cp += cp * area;
      h.sx += cx * area;
      h.sy += cy * area;
      h.sz += cz * area;
    }
  }
  // the surface fields are sampled half a cell or more off the wall, so they give where the drag is; the forces on
  // the walls give how much: scale each part's patches to its measured drag
  const onSurface = new Map<string, number>();
  for (const h of cells.values()) onSurface.set(h.part, (onSurface.get(h.part) ?? 0) + h.drag);
  const gain = (part: string) => {
    const measured = y.parts.find((p) => p.name === part)?.drag;
    const sampled = onSurface.get(part) ?? 0;
    const k = measured !== undefined && sampled > 0 ? measured / sampled : 1;
    return k > 0.3 && k < 3 ? k : 1;
  };
  return [...cells.values()]
    .filter((h) => h.w > 0)
    .map((h) => {
      const k = gain(h.part);
      return { part: h.part, at: [h.sx / h.w, h.sy / h.w, h.sz / h.w] as V3, drag: k * h.drag, front: k * h.front, back: k * h.back, friction: k * h.friction, cp: h.cp / h.w };
    })
    .sort((a, b) => b.drag - a.drag)
    .slice(0, n);
}

function spotText(h: HotSpot): string {
  const kind = h.back > h.front && h.back > h.friction ? `suction behind it (Cp ${fmtNum(h.cp, 2)}: the air separates and leaves a wake; a longer, tapered tail or a smoother back helps)` : h.front >= h.friction ? `pressure on its front (Cp ${fmtNum(h.cp, 2)}: a blunt face stops the air; round or point it into the wind)` : "skin friction (smooth already; a smaller wetted area helps)";
  return `${h.part} near ${p3(h.at)}: ${fmtNum(h.drag, 2)} N, mostly ${kind}`;
}

/** The analysis's results for the assistant: numbers, breakdown, hot spots and the trend over versions. */
export function airflowSummary(spec: AirflowSpec, run: AirflowRun | undefined, versions: AirflowVersion[] | undefined): string {
  const head = `Airflow "${spec.label}" at ${fmtNum(spec.speed * 0.0036, 1)} km/h of air`;
  if (!run || run.status === "waiting" || run.status === "running") return `${head}: still running (${Math.round(100 * (run?.frac ?? 0))} %${run?.stage ? `, ${run.stage}` : ""}).${run?.result ? " The numbers below are from before the latest change." : ""}`;
  if (run.status === "error" || !run.result) return `${head}: did not run. ${run.error ?? ""}`;
  const r = run.result;
  const q = 0.5 * r.density * r.speed * r.speed;
  const lines = [`${head}, ${r.yaws.length} yaw angle(s), cells ${fmtNum(r.h, 1)} mm on the ${r.backend.toUpperCase()}:`];
  for (const y of r.yaws)
    lines.push(
      `  yaw ${fmtNum(y.yaw, 1)}°: CdA ${fmtNum(y.cda, 4)} m² (±${fmtNum((100 * y.stderr) / Math.max(1e-9, Math.abs(y.drag)), 1)} %${y.converged ? "" : ", not settled"}), drag ${fmtNum(y.drag, 2)} N, side force ${fmtNum(y.side, 2)} N, lift ${fmtNum(y.lift, 2)} N, ${fmtNum(y.watts, 0)} W; frontal area ${fmtNum(y.area, 3)} m², Cd ${fmtNum(y.cd, 3)}`,
    );
  if (r.yaws.length > 1) lines.push(`  mean CdA over the yaws ${fmtNum(mean(r.yaws.map((y) => y.cda)), 4)} m², mean ${fmtNum(mean(r.yaws.map((y) => y.watts)), 0)} W`);
  const zero = r.yaws.find((y) => y.yaw === 0) ?? r.yaws[0];
  const total = zero.parts.reduce((a, p) => a + p.drag, 0) || 1;
  lines.push(`Drag by part at ${fmtNum(zero.yaw, 1)}° (share, CdA, friction share):`);
  for (const p of [...zero.parts].sort((a, b) => b.drag - a.drag).slice(0, 12)) lines.push(`  ${p.name}${p.extra ? " (not part of the design)" : ""}: ${fmtNum((100 * p.drag) / total, 1)} %, ${fmtNum(p.cda, 4)} m², ${fmtNum(100 * p.friction, 0)} % friction`);
  const spots = dragHotSpots(zero, spec.forward, q);
  if (spots.length) {
    lines.push("Where the design's drag comes from (surface patches with the most drag):");
    for (const h of spots) lines.push(`  ${spotText(h)}`);
  }
  if (versions && versions.length > 1) {
    lines.push("Versions (oldest first): " + versions.map((v, i) => `${i + 1}: ${fmtNum(mean(v.yaws.map((y) => y.cda)), 4)} m² (${v.note})`).join("; "));
  }
  if (r.warnings.length) lines.push("Notes: " + r.warnings.join(" "));
  return lines.join("\n");
}

/** One line for the design overview. */
export function airflowLine(spec: AirflowSpec, run: AirflowRun | undefined): string {
  const setup = `${fmtNum(spec.speed * 0.0036, 0)} km/h, yaw ${spec.yaw.map((y) => fmtNum(y, 1)).join("/")}°${spec.rider ? `, rider ${spec.rider.position}` : ""}${spec.parts.length ? `, ${spec.parts.join(", ")}` : ""}`;
  let state = "not run yet";
  if (run?.status === "running" || run?.status === "waiting") state = "running";
  else if (run?.status === "error") state = `error: ${run.error ?? "did not finish"}`;
  else if (run?.result) state = `CdA ${fmtNum(mean(run.result.yaws.map((y) => y.cda)), 4)} m², drag ${fmtNum(mean(run.result.yaws.map((y) => y.drag)), 1)} N, ${fmtNum(mean(run.result.yaws.map((y) => y.watts)), 0)} W`;
  return `"${spec.label}" airflow (${setup}): ${state}`;
}
