// Machine checks for the check report: wiring rules, motor loads from the
// design's `load:` values, and the honest list of what still needs a test.

import type { CheckItem } from "../core/checks";
import { fmtNum } from "../lang/values";
import { catalogPart } from "./catalog";
import { placementItems } from "./boardChecks";
import { circuitChecks } from "./circuit/analysis";
import { electricalChecks, motorSupplies } from "./erc";
import type { MachineData } from "./types";

/** How far a DC gearmotor's stall torque and current scale on its driver's supply (1 for its rated voltage or unknown). */
function supplyScale(supplies: Map<string, number>, comp: string, specs: Record<string, unknown>): number {
  const v = supplies.get(comp);
  return v !== undefined && typeof specs.v_rated === "number" && specs.v_rated > 0 && typeof specs.t_stall === "number" ? v / specs.v_rated : 1;
}

/** Operating current of a DC gearmotor at its `load:`, on its driver's supply (linear model, as calc.motor_point). */
export function motorCurrentFor(m: MachineData, supplies = motorSupplies(m)): (comp: string) => number | undefined {
  return (comp) => {
    const mc = m.components.find((c) => c.name === comp);
    const p = mc && catalogPart(mc.catalogId);
    if (!mc || !p || mc.load === undefined) return undefined;
    const s = p.specs;
    if (typeof s.t_stall !== "number" || typeof s.i_stall !== "number") return undefined;
    const k = supplyScale(supplies, comp, s);
    const i0 = typeof s.i_free === "number" ? s.i_free : 0;
    return i0 + (s.i_stall * k - i0) * Math.min(1, mc.load / (s.t_stall * k));
  };
}

export function machineChecks(m: MachineData): CheckItem[] {
  const out: CheckItem[] = [];
  const supplies = motorSupplies(m);
  const current = motorCurrentFor(m, supplies);
  out.push(...electricalChecks(m, { motorCurrent: current }));
  out.push(...circuitChecks(m));
  out.push(...placementItems(m));

  for (const mc of m.components) {
    const p = catalogPart(mc.catalogId);
    if (!p || mc.load === undefined) continue;
    const s = p.specs;
    // a DC motor's stall torque scales with the supply its driver gives it, as in calc.motor_point
    const k = supplyScale(supplies, mc.name, s);
    const stall = typeof s.t_stall === "number" ? s.t_stall * k : typeof s.t_hold === "number" ? s.t_hold : undefined;
    if (stall === undefined) continue;
    const at = k !== 1 ? ` at ${fmtNum(supplies.get(mc.name)!, 1)} V` : "";
    const frac = mc.load / stall;
    const name = mc.role ? `${mc.name} (${mc.role})` : mc.name;
    const base = { category: "engineering" as const, parts: [mc.name], span: mc.span, basis: "calculation" as const };
    if (frac >= 1) out.push({ ...base, id: `load:${mc.name}`, status: "fail", title: `${name} stalls`, detail: `Load ${fmtNum(mc.load / 1000, 2)} N·m is over its ${fmtNum(stall / 1000, 2)} N·m stall torque${at}.`, margin: stall / mc.load });
    else if (frac > 0.5) out.push({ ...base, id: `load:${mc.name}`, status: "warn", title: `${name} works hard`, detail: `Load is ${fmtNum(frac * 100, 0)} % of stall torque${at}. Above about 50 % a brushed gearmotor overheats in continuous use.`, margin: stall / mc.load });
    else out.push({ ...base, id: `load:${mc.name}`, status: "pass", title: `${name} torque`, detail: `Load ${fmtNum(mc.load / 1000, 2)} N·m is ${fmtNum(frac * 100, 0)} % of its ${fmtNum(stall / 1000, 2)} N·m stall torque${at}${current(mc.name) !== undefined ? `, about ${fmtNum(current(mc.name)!, 1)} A` : ""}.`, margin: stall / mc.load });
  }

  const rough = m.calcs.filter((c) => c.confidence === "rough");
  if (m.calcs.length) {
    out.push({
      id: "calc:summary",
      category: "engineering",
      status: "info",
      title: `${m.calcs.length} engineering calculation${m.calcs.length === 1 ? "" : "s"}`,
      detail: rough.length ? `${rough.map((c) => c.title).join(", ")} ${rough.length === 1 ? "is a rough estimate" : "are rough estimates"}: the test plan says how to confirm ${rough.length === 1 ? "it" : "them"}.` : "All are standard methods with stated assumptions. See the Build tab for the working.",
      basis: "calculation",
    });
  }

  const controllers = m.components.filter((c) => {
    const k = catalogPart(c.catalogId)?.kind;
    return k === "controller";
  });
  if (controllers.length && !m.firmware.length) {
    out.push({ id: "fw:none", category: "electrical", status: "warn", title: "No firmware", detail: `Add a firmware block (firmware main { board: ${controllers[0].name}, behaviour: "..." }) so Kerf can generate code that matches the wiring.`, parts: controllers.map((c) => c.name), basis: "electrical rules" });
  }
  for (const fw of m.firmware) {
    if (!fw.board) out.push({ id: `fw:board:${fw.name}`, category: "electrical", status: "fail", title: `Firmware ${fw.name}: which board?`, detail: "Give it board: <controller component>.", span: fw.span, basis: "electrical rules" });
  }

  // once per catalog part, as the build tab and pack count them
  const partTests = [...new Map(m.components.map((c) => [c.catalogId, catalogPart(c.catalogId)?.tests ?? []])).values()].flat();
  const n = m.tests.length + rough.length + partTests.length;
  if (n) {
    out.push({
      id: "test:plan",
      category: "testing",
      status: "info",
      title: `${n} physical test${n === 1 ? "" : "s"} before relying on it`,
      detail: [...m.tests.map((t) => t.label), ...rough.map((c) => c.verify ?? c.title)].slice(0, 6).join(" · ") + (n > 6 ? " …" : ""),
      basis: "physical test",
    });
  }
  return out;
}
