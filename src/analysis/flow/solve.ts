// One flow and cooling run, start to finish: the grid, the flow to a steady state (with warm air rising when gravity
// is on, the heat solved along the way), the temperatures, and the results.

import { AMBIENT, FLUID, buildGrid, cellCentre } from "./grid";
import { FlowSolver } from "./flow";
import { HeatSolver, cellKinds } from "./energy";
import { crossSection, type Section } from "./section";
import { bodyCentres, fieldOf, partTemps, sectionFlow, seedPoints, streamlines, surfaceTemps, throughFlow } from "./post";
import type { DriveResult, FanResult, FlowInput, FlowProgress, FlowResult, SectionResult, V3 } from "./types";

export class FlowSetupError extends Error {}

/** The largest value (a spread into Math.max overflows the stack on a grid's worth of cells). */
function maxOf(a: ArrayLike<number>): number {
  let m = -Infinity;
  for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
  return m;
}

const fmt = (x: number, d = 1) => (Math.round(x * 10 ** d) / 10 ** d).toString();

/** An axial fan's curve is unsteady to the left of about this share of its free flow. */
const STALL_SHARE = 0.3;

export function solveFlow(input: FlowInput, onProgress?: (p: FlowProgress) => void, shouldStop?: () => boolean): FlowResult {
  const t0 = Date.now();
  const deadline = t0 + input.maxMinutes * 60_000;
  const warnings: string[] = [];
  const assumptions: string[] = [];
  const fl = input.fluid;
  onProgress?.({ stage: "Building the grid", frac: 0 });
  const g = buildGrid(input.bodies, input.fans, input.h, input.margin);
  const N = g.nx * g.ny * g.nz;
  if (g.leaky.length) warnings.push(`${g.leaky.slice(0, 4).join(", ")}${g.leaky.length > 4 ? ` and ${g.leaky.length - 4} more` : ""}: the mesh is not closed, so some rays could not tell inside from outside; check the parts' shapes there.`);
  const kinds = cellKinds(g);
  const flow = new FlowSolver(g, { rho: fl.rho, nu: fl.nu, gravity: input.gravity, beta: fl.beta, ambient: input.ambient });

  // fans: push their annulus along their curves
  input.fans.forEach((f, fi) => {
    const cells: number[] = [];
    for (let c = 0; c < N; c++) if (g.fan[c] === fi) cells.push(c);
    if (!cells.length) {
      warnings.push(`${f.name} is smaller than the cells (${fmt(input.h)} mm), so it moves no air here; use a finer resolution.`);
      return;
    }
    const area = (Math.PI / 4) * ((f.bore / 1000) ** 2 - (f.hub / 1000) ** 2);
    const depth = (cells.length * g.h ** 3) / area;
    flow.addPush("fan", fi, f.name, cells, f.axis, depth, area, { rise: 0.5 * f.curve[0][1], curve: f.curve });
  });
  // set flows: push across their opening until that flow goes through
  input.drives.forEach((d, di) => {
    const s = crossSection(g, d.at, d.dir, d.bounds);
    if (typeof s === "string") throw new FlowSetupError(`${d.label}: ${s}.`);
    const dir: V3 = [0, 0, 0];
    dir[s.axis] = s.sign;
    const v = d.flow / s.area;
    flow.addPush("drive", di, d.label, s.cells, dir, g.h, s.area, { rise: 2 * fl.rho * v * v, target: d.flow });
  });
  const sections: (Section | string)[] = input.sections.map((s) => crossSection(g, s.at, s.dir, s.bounds));
  sections.forEach((s, i) => {
    if (typeof s === "string") warnings.push(`${input.sections[i].label}: ${s}; its flow is not reported.`);
  });

  const heat = new HeatSolver(g, fl, input.ambient);
  const centres = bodyCentres(g);
  if (input.heat) {
    warnings.push(...heat.placeHeat(centres));
    if (input.bodies.some((b) => b.emissivity > 0)) heat.computeViews();
  }
  const heatMade = input.bodies.reduce((s, b) => s + (b.watts > 0 ? b.watts : 0), 0);
  const buoyant = !!input.gravity && input.heat && heatMade > 0;

  // a flow to measure the imbalance against: the fans' and set flows, or what rising warm air moves
  const pushed = input.fans.reduce((s, f) => s + 0.5 * f.curve[f.curve.length - 1][0], 0) + input.drives.reduce((s, d) => s + d.flow, 0);
  const L = (Math.max(g.nx, g.ny, g.nz) * g.h) / 2;
  const buoyantQ = buoyant ? Math.sqrt(9.81 * fl.beta * 10 * L) * (L / 4) ** 2 : 0;
  const qRef = Math.max(pushed, buoyantQ, 1e-7);
  const maxIt = input.maxIterations ?? Math.round(Math.min(900, Math.max(250, 200 + kinds.air / 2500)));
  const moving = flow.pushes.length > 0 || buoyant;
  let it = 0;
  let residual = 0;
  let converged = !moving;
  const history: number[][] = [];
  if (moving) {
    flow.updateTurbulence();
    for (it = 1; it <= maxIt; it++) {
      if (it % 4 === 1) flow.updateTurbulence();
      const imb = flow.iterate();
      residual = imb / (fl.rho * qRef);
      if (!Number.isFinite(residual) || flow.maxSpeed() > 400) throw new FlowSetupError("The flow solve blew up (the speeds ran away). Try a finer resolution, or check the fans point the way the air can go.");
      if (buoyant && it % 8 === 0) {
        heat.solve(flow, { tol: 1e-5, maxIter: 40, radiation: true });
        for (let c = 0; c < N; c++) flow.T[c] += 0.8 * (heat.T[c] - flow.T[c]);
      }
      history.push(flow.pushes.map((p) => p.flow));
      if (it > 60 && residual < 1e-3) {
        const old = history[history.length - 21];
        const now = history[history.length - 1];
        const steady = !old || now.every((q, i) => Math.abs(q - old[i]) <= 2e-3 * Math.max(Math.abs(q), qRef * 1e-3));
        if (steady) {
          converged = true;
          break;
        }
      }
      if (it % 5 === 0)
        onProgress?.({ stage: buoyant ? "Solving the flow and the heat" : "Solving the flow", frac: 0.05 + 0.8 * (it / maxIt), iteration: it, residual, fans: flow.pushes.map((p) => p.flow), ...(buoyant ? { maxTemp: maxOf(flow.T) } : {}) });
      if (Date.now() > deadline || shouldStop?.()) {
        warnings.push(`The flow stopped at its time limit after ${it} iterations, before it had fully settled (imbalance ${fmt(residual * 100, 2)} %).`);
        break;
      }
    }
    if (!converged && it > maxIt) warnings.push(`The flow had not fully settled after ${maxIt} iterations (mass imbalance ${fmt(residual * 100, 2)} % of the flow through); treat the numbers as close, not exact.`);
  }
  // the temperatures for the settled flow, radiation worked out from them
  if (input.heat) {
    onProgress?.({ stage: "Solving the temperatures", frac: 0.88 });
    for (let r = 0; r < 4; r++) heat.solve(flow, { tol: 1e-9, maxIter: 300, radiation: true });
  }
  const T = heat.T;
  onProgress?.({ stage: "Gathering the results", frac: 0.95 });

  const fans: FanResult[] = [];
  const drives: DriveResult[] = [];
  for (const ps of flow.pushes) {
    ps.flow = flow.pushFlow(ps);
    let tsum = 0;
    for (const c of ps.cells) tsum += T[c];
    const temp = ps.cells.length ? tsum / ps.cells.length : input.ambient;
    if (ps.kind === "fan") {
      const f = input.fans[ps.index];
      const free = f.curve[f.curve.length - 1][0];
      fans.push({ id: f.id, name: f.name, flow: ps.flow, rise: ps.rise, freeFlow: free, shutoff: f.curve[0][1], stalled: !f.blower && ps.flow > 0 && ps.flow < STALL_SHARE * free, reversed: ps.flow < 0, blower: !!f.blower, curve: f.curve, curveWhy: f.curveWhy, temp });
    } else {
      const d = input.drives[ps.index];
      const v = ps.flow / ps.area;
      drives.push({ label: d.label, flow: ps.flow, rise: ps.rise, speed: v, area: ps.area, lossCoefficient: v > 0 ? ps.rise / (0.5 * fl.rho * v * v) : 0 });
    }
  }
  const sectionResults: SectionResult[] = [];
  sections.forEach((s, i) => {
    if (typeof s === "string") return;
    const r = sectionFlow(flow, T, s);
    sectionResults.push({ label: input.sections[i].label, flow: r.flow, temp: r.temp, area: s.area });
  });
  const parts = partTemps(g, T, centres);
  const through = throughFlow(flow, T, input.ambient);
  const bal = input.heat ? heat.balance(flow) : { made: 0, air: 0, radiated: 0 };
  let maxAir = input.ambient;
  for (let c = 0; c < N; c++) if (g.kind[c] === FLUID && T[c] > maxAir) maxAir = T[c];
  const meanOf = (i: number) => parts[i]?.mean ?? input.ambient;
  const surfaces = surfaceTemps(g, T, g.bodies, meanOf);
  // streamlines from each push's cells, then the busiest air
  const pushSeeds = flow.pushes.map((ps) => Array.from(ps.cells, (c) => cellCentre(g, c)));
  const lines = streamlines(flow, T, seedPoints(flow, pushSeeds));
  if (input.heat && bal.made > 0 && Math.abs(bal.made - bal.air - bal.radiated) > 0.05 * bal.made)
    warnings.push(`The heat balance is out by ${fmt((Math.abs(bal.made - bal.air - bal.radiated) / bal.made) * 100, 0)} % (made ${fmt(bal.made, 2)} W, carried off ${fmt(bal.air, 2)} W, radiated ${fmt(bal.radiated, 2)} W): the flow had not settled; trust the temperatures less.`);
  for (const f of fans) {
    if (f.reversed) warnings.push(`${f.name} has air going through it backwards: another fan or the warm air is beating it. Check which way it blows.`);
    else if (f.stalled) warnings.push(`${f.name} works at ${fmt((100 * f.flow) / f.freeFlow, 0)} % of its free flow, on the steep part of its curve where fans are noisy and unsteady: the box pushes back hard. Bigger vents would help.`);
  }
  const ambientCells = g.kind.reduce((s, k) => s + (k === AMBIENT ? 1 : 0), 0);
  void ambientCells;
  assumptions.push(
    `Steady flow on ${fmt(input.h, 1)} mm cells (${(N / 1e6).toFixed(2)} million, ${(kinds.air / 1e6).toFixed(2)} million of air), with LVEL turbulence and wall functions: the way electronics-cooling tools model it.`,
    "Walls thinner than a cell are drawn a cell thick, so gaps narrower than about two cells pass less air than they would; a finer resolution resolves them.",
  );
  if (input.fans.length) assumptions.push("Fans push evenly over their annulus and add no swirl; their curves are for the fan alone at the rated voltage.");
  if (input.heat) {
    assumptions.push(
      "Bought components are blocks with averaged insides, so their temperatures are case temperatures: a chip's junction is hotter by its power times its junction-to-case resistance.",
      "Parts that touch are in perfect thermal contact (no gap pads or contact resistance); surfaces that can see the surroundings radiate to them, inside a closed box radiation between parts is left out.",
    );
    if (buoyant) assumptions.push(`Warm ${fl.name} rises (Boussinesq), solved together with the flow.`);
  }
  if (input.notes) assumptions.push(...input.notes);
  return {
    label: input.label,
    fluid: fl.name,
    ambient: input.ambient,
    h: input.h,
    dims: [g.nx, g.ny, g.nz],
    cells: N,
    fluidCells: kinds.air,
    fans,
    drives,
    sections: sectionResults,
    parts,
    throughFlow: through.flow,
    airRise: through.rise,
    heatIn: bal.made,
    heatAir: bal.air,
    heatRadiated: bal.radiated,
    maxSpeed: flow.maxSpeed(),
    maxAir,
    iterations: it,
    converged,
    residual,
    balance: bal.made > 0 ? (bal.made - bal.air - bal.radiated) / bal.made : 0,
    surfaces,
    lines,
    field: N <= 4e6 ? fieldOf(flow, T) : null,
    warnings,
    assumptions,
    ms: Date.now() - t0,
  };
}
