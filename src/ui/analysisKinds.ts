// The kinds of analysis Kerf can run, each with what it answers and what to
// ask Claude to set one up. The analysis tab's Add menu and the find palette
// both offer these, so a design can gain a second kind (airflow on a frame
// that already has a strength run) without the user knowing the syntax.

import type { AnalysisSpec } from "../analysis/spec";

export interface AnalysisKind {
  id: "strength" | "drop" | "vibration" | "airflow" | "gears" | "uci";
  label: string;
  /** one line: what it tells you */
  detail: string;
  /** other words people use for it */
  keywords: string;
  /** key of ui/icons Icon */
  icon: "Stress" | "Alert" | "Graph" | "Orbit" | "Gear" | "Check";
  /** which of the design's analyses are this kind */
  is: (a: AnalysisSpec) => boolean;
  /** a draft for the chat: Claude works out the loads, speeds or rules from the brief */
  ask: string;
  /** only offered when the design looks like it needs it */
  fits?: "gears" | "bike";
}

export const ANALYSIS_KINDS: AnalysisKind[] = [
  {
    id: "strength",
    label: "Strength",
    detail: "Stress, deflection and safety factor under the loads it will see",
    keywords: "fea finite element stress strain deflection safety factor load break bend sag strong",
    icon: "Stress",
    is: (a) => a.kind === "structural" && !a.drop && !a.modal,
    ask: "Set up a strength analysis for this design from how it will be used: work out realistic loads and how it is held, then run it and tell me what you find.",
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

/** The kinds worth offering for a design: everything general, plus gears or bike rules when it has them. */
export function kindsFor(m: { parts: { gear?: unknown; chain?: unknown; tubes?: unknown[] }[]; analyses: AnalysisSpec[] } | null | undefined): AnalysisKind[] {
  const gears = !!m?.parts.some((p) => p.gear);
  const bike = !!m?.parts.some((p) => p.chain || p.tubes?.length) || !!m?.analyses.some((a) => a.kind === "uci");
  return ANALYSIS_KINDS.filter((k) => !k.fits || (k.fits === "gears" ? gears : bike));
}
