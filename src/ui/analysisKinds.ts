// The kinds of analysis Kerf can run, each with what it answers and what to
// ask Claude to set one up. The analysis tab's Add menu and the find palette
// both offer these, so a design can gain a second kind (airflow on a frame
// that already has a strength run) without the user knowing the syntax.

import type { AnalysisSpec } from "../analysis/spec";
import { electricMaterial } from "../analysis/electricMaterials";

export interface AnalysisKind {
  id: "strength" | "fatigue" | "drop" | "vibration" | "heat" | "current" | "buckling" | "topology" | "study" | "airflow" | "gears" | "uci";
  label: string;
  /** one line: what it tells you */
  detail: string;
  /** other words people use for it */
  keywords: string;
  /** key of ui/icons Icon */
  icon: "Stress" | "Refresh" | "Alert" | "Graph" | "Thermo" | "Bolt" | "Buckle" | "Wand" | "Sliders" | "Orbit" | "Gear" | "Check";
  /** which of the design's analyses are this kind */
  is: (a: AnalysisSpec) => boolean;
  /** a draft for the chat: Claude works out the loads, speeds or rules from the brief */
  ask: string;
  /** only offered when the design looks like it needs it */
  fits?: "gears" | "bike" | "metal";
}

export const ANALYSIS_KINDS: AnalysisKind[] = [
  {
    id: "strength",
    label: "Strength",
    detail: "Stress, deflection and safety factor under the loads it will see",
    keywords: "fea finite element stress strain deflection safety factor load break bend sag strong",
    icon: "Stress",
    is: (a) => a.kind === "structural" && !a.drop && !a.modal && !a.buckling && !a.fatigue && !a.topology && !(a.thermal && !a.supports.length),
    ask: "Set up a strength analysis for this design from how it will be used: work out realistic loads and how it is held, then run it and tell me what you find.",
  },
  {
    id: "fatigue",
    label: "Fatigue",
    detail: "How many load cycles it lasts, and where repeated loading cracks it first",
    keywords: "fatigue life cycles repeated loading s-n sn curve endurance durability crack wear out goodman rainflow load history miner",
    icon: "Refresh",
    is: (a) => a.kind === "structural" && !!a.fatigue && !a.buckling,
    ask: "Set up a fatigue check for this design: how often each load repeats over its life (on-off, or swinging both ways, with any bigger occasional loads as a load history) and each part's surface finish, then run it and tell me how long it lasts, where it cracks first and how to make it last.",
  },
  {
    id: "drop",
    label: "Drop test",
    detail: "A fall, knock or tip-over onto a hard floor: peak g and what cracks",
    keywords: "impact drop fall knock shock tip over crash survive",
    icon: "Alert",
    is: (a) => a.kind === "structural" && !!a.drop,
    ask: "Set up a drop test for this design: the height and floor it could realistically fall from and onto, the way it would land, then run it and tell me what would crack and how to stop it.",
  },
  {
    id: "vibration",
    label: "Vibration",
    detail: "Natural frequencies and whether a motor or the road will make it ring",
    keywords: "modal resonance natural frequency vibrate shake rattle hum stiffness",
    icon: "Graph",
    is: (a) => a.kind === "structural" && !!a.modal,
    ask: "Set up a vibration analysis for this design: find its natural frequencies, compare them with what will shake it in use (motors, fans, the road), then run it and tell me if anything will resonate and how to fix it.",
  },
  {
    id: "heat",
    label: "Heat",
    detail: "How hot each part runs from its electronics, motors or a hot surface, and the stress that heat causes",
    keywords: "thermal temperature heat hot warm cooling fan heatsink overheat melt soften expansion thermal stress warm-up",
    icon: "Thermo",
    is: (a) => a.kind === "structural" && ((!!a.thermal && !a.thermal.currents?.length) || a.uniformTemp !== undefined),
    ask: "Set up a heat analysis for this design: where heat is made (electronics, motors, anything hot it touches), how it is cooled and the hottest surroundings it will see, then run it and tell me which parts run too hot and how to cool them.",
  },
  {
    id: "current",
    label: "Current",
    detail: "Joule heating: the resistance, voltage drop and heat of the current through busbars, straps, heater elements and terminals",
    keywords: "joule heating electric current busbar bus bar resistance resistive heater element i2r voltage drop current density ampacity fuse wire strap terminal conductor",
    icon: "Bolt",
    is: (a) => a.kind === "structural" && !!a.thermal?.currents?.length,
    ask: "Set up a current analysis for this design: the real currents (or voltages) through its metal conductors (busbars, battery straps, heater elements, terminals) from where each goes in to where it comes out, how they are cooled and the hottest surroundings, then run it and tell me the resistance, voltage drop and heat of each, where the current crowds and whether anything runs too hot.",
    fits: "metal",
  },
  {
    id: "buckling",
    label: "Buckling",
    detail: "How much more load the slender walls, struts and tubes take before they fold",
    keywords: "buckle buckling collapse fold crumple column strut slender thin wall stability euler compression",
    icon: "Buckle",
    is: (a) => a.kind === "structural" && !!a.buckling,
    ask: "Set up a buckling check for this design: the loads that press on its slender walls, struts or tubes and how it is held, then run it and tell me how far it is from buckling and how to stiffen it.",
  },
  {
    id: "topology",
    label: "Topology optimisation",
    detail: "The stiffest shape for the loads from a share of the material: where to cut it away, as a shape to model, print or cut from plate",
    keywords: "topology optimisation optimization generative design lightweight lighten weight reduction remove material cut away truss organic shape simp lattice skeleton pockets lightening holes",
    icon: "Wand",
    is: (a) => a.kind === "structural" && !!a.topology,
    ask: "Set up a topology optimisation for the main load-carrying part of this design: how it is held and the real loads it carries, the share of its material to keep (about 30 to 40 %), and preserve: for its mounting faces and holes; use extrusion: (the axis through the plate) when it is cut from plate. Run it, then tell me the shape it finds, how much lighter and how much less stiff it is, and model that shape as a real part.",
  },
  {
    id: "study",
    label: "Design study",
    detail: "Try many sizes automatically and keep the lightest, stiffest or coolest design that still passes",
    keywords: "optimise optimize optimisation optimization design study sweep parameters lightest best size dimensions what if trade off generative",
    icon: "Sliders",
    is: (a) => a.kind === "study",
    ask: "Set up a design study for this design: vary the parameters that size the parts that matter most, aim for the lightest design (or what matters more here) and keep it passing its analyses and checks, then run it and tell me which design is best and what changed.",
  },
  {
    id: "airflow",
    label: "Airflow",
    detail: "Wind tunnel: drag, CdA, power, side force and the flow round it",
    keywords: "aero aerodynamics wind tunnel cfd drag cda air flow streamlines speed fairing",
    icon: "Orbit",
    is: (a) => a.kind === "airflow",
    ask: "Set up an airflow analysis for this design at the speed it will really move, with the wind head on and from the side, then run it and tell me where the drag comes from and how to cut it.",
  },
  {
    id: "gears",
    label: "Gear train",
    detail: "Tooth bending, bearing life and shaft twist from the input torque and speed",
    keywords: "drivetrain gearbox gears teeth bearing life shaft torsion torque rpm reducer",
    icon: "Gear",
    is: (a) => a.kind === "drivetrain",
    ask: "Set up a gear train analysis for this design from the motor's real torque and speed: check the teeth, bearings and shafts, then tell me what would wear out or break first.",
    fits: "gears",
  },
  {
    id: "uci",
    label: "UCI bike rules",
    detail: "Road racing rules: weight, sizes, saddle setback and tube sections",
    keywords: "bike bicycle cycling race legal uci rules frame",
    icon: "Check",
    is: (a) => a.kind === "uci",
    ask: "Add a UCI road rules check to this bike: say which parts are the wheels, saddle and bars and where the bottom bracket is, then tell me anything that isn't race legal.",
    fits: "bike",
  },
];

/** The kinds worth offering for a design: everything general, plus gears, bike rules or current when it has them. */
export function kindsFor(m: { parts: { gear?: unknown; chain?: unknown; tubes?: unknown[]; material?: string; kind?: string }[]; analyses: AnalysisSpec[] } | null | undefined): AnalysisKind[] {
  const gears = !!m?.parts.some((p) => p.gear);
  const bike = !!m?.parts.some((p) => p.chain || p.tubes?.length) || !!m?.analyses.some((a) => a.kind === "uci");
  // a part of its own in a metal (a bought component's body says little about what carries its current)
  const metal = !!m?.parts.some((p) => p.kind !== "component" && electricMaterial(p.material).conductor) || !!m?.analyses.some((a) => a.kind === "structural" && a.thermal?.currents?.length);
  return ANALYSIS_KINDS.filter((k) => !k.fits || (k.fits === "gears" ? gears : k.fits === "bike" ? bike : metal));
}
