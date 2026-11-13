// The kinds of analysis Kerf can run, each with what it answers and what to
// ask Claude to set one up. The analysis tab's Add menu and the find palette
// both offer these, so a design can gain a second kind (airflow on a frame
// that already has a strength run) without the user knowing the syntax.

import type { AnalysisSpec } from "../analysis/spec";
import { electricMaterial } from "../analysis/electricMaterials";

export interface AnalysisKind {
  id: "strength" | "plies" | "fatigue" | "drop" | "vibration" | "shaking" | "heat" | "current" | "buckling" | "topology" | "study" | "airflow" | "cooling" | "ducts" | "gears" | "uci";
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
  fits?: "gears" | "bike" | "metal" | "layup" | "electronics";
}

export const ANALYSIS_KINDS: AnalysisKind[] = [
  {
    id: "strength",
    label: "Strength",
    detail: "Stress, deflection and safety factor under the loads it will see",
    keywords: "fea finite element stress strain deflection safety factor load break bend sag strong",
    icon: "Stress",
    is: (a) => a.kind === "structural" && !a.drop && !a.modal && !a.buckling && !a.fatigue && !a.topology && !a.layup?.length && !(a.thermal && !a.supports.length),
    ask: "Set up a strength analysis for this design from how it will be used: work out realistic loads and how it is held, then run it and tell me what you find.",
  },
  {
    id: "plies",
    label: "Composite plies",
    detail: "Ply by ply through a carbon layup: which ply gives way first and how (Tsai–Wu), with 0° along its tubes",
    keywords: "composite plies ply layup ply book stacking sequence fibre direction fiber orientation tsai-wu first ply failure carbon fibre laminate prepreg woven twill",
    icon: "Stress",
    is: (a) => a.kind === "structural" && !!a.layup?.length,
    ask: "Set up a ply-by-ply strength analysis of this design's carbon layups from how they will be used: the real loads and how they are held, and a layup that suits them (0° plies where it bends, ±45° where it twists, more plies in zones where loads go in, a woven outer ply), then run it and tell me which ply gives way first and how, and change the layup until every ply has a safety of at least 2.",
    fits: "layup",
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
    is: (a) => a.kind === "structural" && !!a.modal && !a.modal.shake && !a.modal.random,
    ask: "Set up a vibration analysis for this design: find its natural frequencies, compare them with what will shake it in use (motors, fans, the road), then run it and tell me if anything will resonate and how to fix it.",
  },
  {
    id: "shaking",
    label: "Shaking",
    detail: "A sine sweep or random vibration (a shaker table, a truck ride, an engine): how far it shakes, the stress and how long it lasts",
    keywords: "sine sweep harmonic response frequency response shaker table shake test random vibration psd grms navmat truck transport ride vibration fatigue steinberg",
    icon: "Graph",
    is: (a) => a.kind === "structural" && !!(a.modal?.shake || a.modal?.random),
    ask: "Set up a shaking analysis for this design from how it will be used: a sine sweep for a motor, engine or shaker test (the band and how hard), or random vibration for transport or a vehicle (a standard spectrum like the truck or NAVMAT one, and how long), with what it carries; then run it and tell me how far it shakes, the worst stress, how long it lasts and how to make it shake less.",
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
    id: "cooling",
    label: "Cooling",
    detail: "Air through the box from its fans or rising on its own: how hot every board, chip and battery gets, and where the air goes",
    keywords: "electronics cooling thermal cfd fan vent enclosure case box overheat hot chip board pcb battery heatsink airflow inside convection forced air natural convection icepak",
    icon: "Thermo",
    is: (a) => a.kind === "flow" && a.drive !== "set",
    ask: "Set up a cooling analysis for this design: the air its fans move through the box (or warm air rising on its own if it has no fan), every electronic part's own heat and the hottest room it will be in, then run it and tell me which parts run too hot, where the air goes and how to cool them better.",
    fits: "electronics",
  },
  {
    id: "ducts",
    label: "Duct flow",
    detail: "A set flow of air or water through ducts, manifolds and nozzles: the pressure it takes and how it shares out between the outlets",
    keywords: "internal flow duct pipe manifold nozzle pressure drop loss head loss flow split outlets plenum hose coolant water channel cfm lpm fluent",
    icon: "Orbit",
    is: (a) => a.kind === "flow" && a.drive === "set",
    ask: "Set up a duct flow analysis for this design's ducts or manifold: the real flow it carries (air or water), where it goes in and the outlets it leaves by, then run it and tell me the pressure it takes, how the flow shares out between the outlets and how to make it take less.",
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

/** The kinds worth offering for a design: everything general, plus gears, bike rules, current or plies when it has them. */
export function kindsFor(m: { parts: { gear?: unknown; chain?: unknown; tubes?: unknown[]; material?: string; kind?: string; process?: { id: string } | null }[]; analyses: AnalysisSpec[] } | null | undefined): AnalysisKind[] {
  const layup = !!m?.parts.some((p) => p.process?.id === "carbon_layup");
  const gears = !!m?.parts.some((p) => p.gear);
  const bike = !!m?.parts.some((p) => p.chain || p.tubes?.length) || !!m?.analyses.some((a) => a.kind === "uci");
  // a part of its own in a metal (a bought component's body says little about what carries its current)
  const metal = !!m?.parts.some((p) => p.kind !== "component" && electricMaterial(p.material).conductor) || !!m?.analyses.some((a) => a.kind === "structural" && a.thermal?.currents?.length);
  // bought electronics or a fan among the parts, or a cooling analysis already
  const electronics = !!m?.parts.some((p) => p.kind === "component") || !!m?.analyses.some((a) => a.kind === "flow");
  return ANALYSIS_KINDS.filter((k) => !k.fits || (k.fits === "gears" ? gears : k.fits === "bike" ? bike : k.fits === "layup" ? layup : k.fits === "electronics" ? electronics : metal));
}
