// Gathering a film's facts from the app: the design and its parts (with
// where the viewport puts them, exploded or not), mass and size, the parts
// list and cost, checks, wiring and firmware, and the analyses and
// simulations that have results to show.

import { meshes, useDesign } from "../core/engine";
import { partMass } from "../core/model";
import { designStats } from "../app/designStats";
import { bomRows, bomTotal } from "../persist/files";
import { useSettings } from "../app/settings";
import { materialDensity } from "../library/standards";
import { materialDef } from "../library/materials";
import { generateFirmware } from "../machine/firmware";
import { useAnalysis } from "../analysis/runtime";
import { useAirflow } from "../analysis/aeroRuntime";
import { pick, useSim } from "../sim/runtime";
import { duration } from "../sim/frames";
import { lightingPreset } from "../ui/viewport/render/studio";
import type { FilmLayout } from "../app/viewportApi";
import { prettyName, type FilmFacts, type FilmPart } from "./facts";
import type { FilmLook } from "./spec";
import { withOwnCode } from "../app/firmwareCode";

const HARDWARE = new Set(["screw", "nut", "washer", "insert", "pin", "rivet"]);

function langOf(path: string): string {
  if (/\.(ino|cpp|cc|h|hpp)$/i.test(path)) return "Arduino C++";
  if (/\.py$/i.test(path)) return "Python";
  if (/\.(gcode|g|cfg)$/i.test(path)) return "printer config";
  if (/\.c$/i.test(path)) return "C";
  return "code";
}

export function gatherFacts(layout: FilmLayout, look: FilmLook): FilmFacts {
  const { model, report } = useDesign.getState();
  // films use each lighting set as it is (see SceneController.beginFilm)
  const light = !!lightingPreset(look, "dark").light;
  if (!model) {
    return { name: "", title: "Untitled design", box: layout.box, exploded: null, parts: [], order: [], size: null, mass: 0, make: 0, buy: 0, materials: [], cost: null, bom: [], checks: null, wires: 0, boards: 0, firmware: null, airflow: [], structural: [], sims: [], light };
  }
  const stats = designStats(model, (h) => meshes.get(h));
  const parts: FilmPart[] = [];
  for (const p of model.parts) {
    const box = layout.parts.get(p.id);
    if (!box || p.hidden) continue;
    const info = meshes.get(p.hash);
    const mass = info ? (partMass(p, info.volume, materialDensity(p.material)) ?? 0) : 0;
    parts.push({
      id: p.id,
      name: p.name,
      label: p.label,
      kind: p.kind,
      material: p.kind === "component" ? "" : (materialDef(p.material)?.label ?? p.material),
      color: p.color,
      mass,
      box,
      exploded: layout.exploded.get(p.id) ?? null,
      moving: !!p.motion && (Math.abs(p.motion.ratio) > 1e-12 || !!p.motion.link || !!p.motion.parent),
      hardware: HARDWARE.has(p.libKind ?? "") || !!p.fastener,
      group: p.group,
    });
  }
  const rows = bomRows(model, useSettings.getState().onHand);
  const total = bomTotal(rows);
  const counts = report?.counts;
  const checked = counts ? counts.pass + counts.warn + counts.fail : 0;
  const machine = model.machine;
  let firmware: FilmFacts["firmware"] = null;
  if (machine?.firmware.length) {
    try {
      const fw = generateFirmware(withOwnCode(machine), model.name).find((f) => f.files.length);
      const file = fw?.files.find((f) => /\.(ino|cpp|c|py)$/i.test(f.path)) ?? fw?.files[0];
      if (fw && file) {
        const lines = file.content.split("\n").filter((l, i, all) => !(l.trim() === "" && all[i - 1]?.trim() === ""));
        firmware = { name: fw.name, file: file.path, lang: langOf(file.path), lines: lines.slice(0, 400), board: fw.board || undefined };
      }
    } catch {
      firmware = null;
    }
  }
  const aRuns = useAirflow.getState().runs;
  const airflow = (model.analyses ?? []).flatMap((a) => {
    if (a.kind !== "airflow") return [];
    const r = aRuns.get(a.label)?.result;
    if (!r?.yaws.length) return [];
    const y = r.yaws[0];
    return [{ label: a.label, cda: y.cda, watts: y.watts, speed: r.speed * 0.0036 }];
  });
  const sRuns = useAnalysis.getState().runs;
  const structural = (model.analyses ?? []).flatMap((a) => {
    if (a.kind !== "structural" || a.topology) return [];
    const r = sRuns.get(a.label)?.result;
    if (!r) return [];
    const sf = r.minSafety?.value;
    return [{ label: a.label, safety: sf !== undefined && sf < 1e5 ? sf : undefined, stress: r.maxStress?.value }];
  });
  const simRuns = useSim.getState().runs;
  const sims = (model.scenarios ?? []).flatMap((d) => {
    const v = simRuns.get(d.label)?.result?.variants;
    const run = v ? pick(v) : undefined;
    if (!run?.frames) return [];
    const seconds = duration(run.frames);
    return seconds > 0 ? [{ label: d.label, seconds, box: layout.simBox }] : [];
  });
  return {
    name: model.name,
    title: prettyName(model.name),
    purpose: model.brief?.purpose,
    box: layout.box,
    exploded: layout.explodedBox,
    parts,
    order: layout.order,
    size: stats.size,
    mass: stats.mass,
    make: stats.make,
    buy: stats.buy,
    materials: stats.materials.filter((m) => m.mass > 0).map((m) => ({ label: m.label, mass: m.mass })),
    cost: total.total > 0 || total.unpriced ? { total: total.total, unpriced: total.unpriced } : null,
    bom: rows.map((r) => ({ qty: r.qty, item: r.item, kind: r.kind === "Make" ? "Make" : "Buy", price: r.onHand ? undefined : r.price })),
    checks: checked ? { pass: counts!.pass, total: checked } : null,
    wires: machine ? machine.wires.length + machine.nets.length : 0,
    boards: machine?.boards.length ?? 0,
    firmware,
    airflow,
    structural,
    sims,
    light,
  };
}
