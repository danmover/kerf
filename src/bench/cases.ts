// The Kerf bench: real asks, run end to end with the user's own key and
// marked by Kerf, not by eye. Each case starts from a template (or a blank
// design), sends one message, answers any question with Claude's own
// recommendation, then measures the result. Conditions are written as in a
// require statement and read against the built design; "keep" marks hold
// before and after a good answer, the others only after it (tests/bench.test.ts
// checks both against the untouched templates).
//
// Every case is also marked on whether it builds and whether any check fails
// that passed before (or, for a question, whether the design was left alone).

export type BenchKind = "small" | "part" | "assembly" | "question";

export type Expect = { label: string; keep?: boolean } & (
  | { cond: string }
  /** the source matches, at least min times (default 1) */
  | { source: RegExp; min?: number }
  /** Claude's last reply matches */
  | { reply: RegExp }
  /** how many parts and components the design has */
  | { parts: { min?: number; max?: number } }
  /** the largest overall extent of the whole design, in mm */
  | { overall: { min?: number; max?: number } }
);

export interface BenchCase {
  id: string;
  title: string;
  kind: BenchKind;
  /** in the 12-ask core run as well as the full one */
  core: boolean;
  /** a template id (src/demos/templates.ts) */
  template: string;
  message: string;
  expect: Expect[];
}

const BRIEF: Expect = { label: "Records a brief", source: /\bbrief\s*\{/ };

export const BENCH: BenchCase[] = [
  // ---- the core 12 ----
  {
    id: "walls-3mm",
    title: "Enclosure walls to 3 mm",
    kind: "small",
    core: true,
    template: "enclosure",
    message: "Make the walls 3 mm thick.",
    expect: [
      { label: "Walls are 3 mm", cond: "wall == 3" },
      { label: "Outside stays 90 × 70 mm", keep: true, cond: 'size(base, "x") > 89.9 && size(base, "x") < 90.1 && size(base, "y") > 69.9 && size(base, "y") < 70.1' },
    ],
  },
  {
    id: "plate-8mm",
    title: "Bracket plate to 8 mm",
    kind: "small",
    core: true,
    template: "bracket",
    message: "Make the plate 8 mm thick.",
    expect: [
      { label: "Plate is 8 mm", cond: "thickness == 8" },
      { label: "Foot and upright lengths unchanged", keep: true, cond: "base_len == 60 && height == 55" },
    ],
  },
  {
    id: "shelf-15kg",
    title: "Shelf bracket for 15 kg",
    kind: "part",
    core: true,
    template: "shelf",
    message: "It needs to hold 15 kg now. Make it strong enough.",
    expect: [
      { label: "Designed for at least 15 kg", cond: "load_kg >= 15" },
      { label: "Arm still reaches 150 mm", keep: true, cond: 'size(bracket, "y") > 149.5 && size(bracket, "y") < 150.5' },
    ],
  },
  {
    id: "knob-45",
    title: "Knob to 45 mm, same shaft",
    kind: "small",
    core: true,
    template: "cast-knob",
    message: "Make the knob 45 mm across and keep the shaft hole the same.",
    expect: [
      { label: "Knob is 45 mm across", cond: 'size(knob, "x") > 44.8 && size(knob, "x") < 45.2' },
      { label: "Shaft hole unchanged", keep: true, cond: "shaft_d == 6" },
      { label: "The mould still wraps the knob", keep: true, cond: 'size(mould_bottom, "x") > size(knob, "x") + 15' },
    ],
  },
  {
    id: "jar-taller",
    title: "Jar 30 mm taller, same lid",
    kind: "small",
    core: true,
    template: "canister",
    message: "Make the jar 30 mm taller but keep the lid exactly as it is.",
    expect: [
      { label: "Jar is 126 mm tall", cond: 'size(jar, "z") > 125.5 && size(jar, "z") < 126.5' },
      { label: "Lid unchanged", keep: true, cond: 'size(lid, "z") > 14.4 && size(lid, "z") < 14.6 && size(lid, "x") > 71.9 && size(lid, "x") < 72.1 && volume(lid) > 19630 && volume(lid) < 19730' },
      { label: "Lid still sits on the jar", keep: true, cond: 'bbox_min(lid, "z") > bbox_max(jar, "z") - 15' },
    ],
  },
  {
    id: "lid-vents",
    title: "Vent slots in the lid",
    kind: "small",
    core: true,
    template: "enclosure",
    message: "Add a row of ventilation slots to the lid.",
    expect: [
      { label: "The lid has openings", cond: "volume(lid) < 14400" },
      { label: "Base unchanged", keep: true, cond: "volume(base) > 38000 && volume(base) < 38140" },
    ],
  },
  {
    id: "foot-holes",
    title: "Two M5 holes in the foot",
    kind: "small",
    core: true,
    template: "bracket",
    message: "Add two M5 mounting holes to the foot.",
    expect: [
      { label: "Uses M5 holes", source: /\bM5\b/ },
      { label: "Material removed for two holes", cond: "volume(bracket) < 21450" },
      { label: "Height unchanged", keep: true, cond: 'size(bracket, "z") > 54.9 && size(bracket, "z") < 55.1' },
    ],
  },
  {
    id: "broom-hook",
    title: "Wall hook for a broom",
    kind: "part",
    core: true,
    template: "blank",
    message: "Design a wall hook for a 25 mm broom handle. It's printed in PETG, holds 2 kg and screws to the wall with two 4 mm screws.",
    expect: [BRIEF, { label: "PETG", source: /PETG/i }, { label: "M4 screws", source: /\bM4\b/ }, { label: "A sensible size (40 to 250 mm)", overall: { min: 40, max: 250 } }],
  },
  {
    id: "phone-stand",
    title: "Phone stand at 60°",
    kind: "part",
    core: true,
    template: "blank",
    message: "Make a desk stand that holds a phone at 60 degrees from the desk, for phones up to 80 mm wide and 10 mm thick.",
    expect: [BRIEF, { label: "Uses the 60° angle", source: /\b60\b/ }, { label: "A sensible size (60 to 250 mm)", overall: { min: 60, max: 250 } }],
  },
  {
    id: "cable-clip",
    title: "Desk-edge cable clip",
    kind: "part",
    core: true,
    template: "blank",
    message: "Design a clip that holds three 6 mm cables side by side on the edge of a desk up to 25 mm thick.",
    expect: [BRIEF, { label: "At least one part", parts: { min: 1 } }, { label: "A sensible size (25 to 150 mm)", overall: { min: 25, max: 150 } }],
  },
  {
    id: "uno-box",
    title: "Arduino Uno enclosure",
    kind: "assembly",
    core: true,
    template: "blank",
    message: "Design a printed enclosure for an Arduino Uno, with a lid held by four M3 screws and an opening for the USB port.",
    expect: [
      BRIEF,
      { label: "Holds an Arduino Uno", source: /arduino|uno/i },
      { label: "M3 screws", source: /\bM3\b/ },
      { label: "Base, lid and board at least", parts: { min: 3 } },
      { label: "A sensible size (60 to 200 mm)", overall: { min: 60, max: 200 } },
    ],
  },
  {
    id: "lid-question",
    title: "How thick is the lid?",
    kind: "question",
    core: true,
    template: "enclosure",
    message: "How thick is the lid?",
    expect: [{ label: "Answers 2.4 mm", reply: /2\.4\s*mm/ }],
  },

  // ---- the other 12 ----
  {
    id: "three-asks",
    title: "Walls, corners, same height",
    kind: "small",
    core: false,
    template: "enclosure",
    message: "Make the walls 2.5 mm, round the outside corners to 8 mm, and keep the height the same.",
    expect: [
      { label: "Walls are 2.5 mm", cond: "wall == 2.5" },
      { label: "Corners are 8 mm", cond: "corner_r == 8" },
      { label: "Height stays 34 mm", keep: true, cond: 'bbox_max(lid, "z") > 33.9 && bbox_max(lid, "z") < 34.1' },
    ],
  },
  {
    id: "seatpost-tilt",
    title: "Seatpost number at 30°",
    kind: "small",
    core: false,
    template: "seatpost-number",
    message: "Tilt the number up 30 degrees instead of 15.",
    expect: [
      { label: "Tilted 30°", cond: "rise == 30" },
      { label: "Same O-ring and fit", keep: true, cond: "oring_cs == 3.53 && fit_gap == 0.2" },
    ],
  },
  {
    id: "lighter-bracket",
    title: "Lighter, as strong",
    kind: "part",
    core: false,
    template: "bracket",
    message: "Make the bracket lighter without losing strength.",
    expect: [{ label: "At least 12 % lighter", cond: "volume(bracket) < 19000" }],
  },
  {
    id: "thread-pitch",
    title: "Thread pitch to 4 mm",
    kind: "small",
    core: false,
    template: "canister",
    message: "Change the thread pitch to 4 mm.",
    expect: [
      { label: "Pitch is 4 mm", cond: "pitch == 4" },
      { label: "Jar height unchanged", keep: true, cond: 'size(jar, "z") > 95.9 && size(jar, "z") < 96.1' },
    ],
  },
  {
    id: "knob-grip",
    title: "Ribbed grip on the knob",
    kind: "small",
    core: false,
    template: "cast-knob",
    message: "Add a ribbed grip round the knob's edge.",
    expect: [
      { label: "The knob's edge changed", cond: "volume(knob) < 6610 || volume(knob) > 6710" },
      { label: "Height unchanged", keep: true, cond: 'size(knob, "z") > 15.9 && size(knob, "z") < 16.1' },
    ],
  },
  {
    id: "shelf-arm",
    title: "Shelf arm to 200 mm",
    kind: "small",
    core: false,
    template: "shelf",
    message: "Make the arm reach 200 mm.",
    expect: [
      { label: "Arm reaches 200 mm", cond: 'size(bracket, "y") > 199.5 && size(bracket, "y") < 200.5' },
      { label: "Wall plate height unchanged", keep: true, cond: "height == 120" },
    ],
  },
  {
    id: "hinge",
    title: "Print-in-place hinge",
    kind: "part",
    core: false,
    template: "blank",
    message: "Design a print-in-place hinge with two 40 × 30 mm leaves and a 4 mm pin that opens to 180 degrees.",
    expect: [BRIEF, { label: "Two leaves at least", parts: { min: 2 } }, { label: "A sensible size (40 to 120 mm)", overall: { min: 40, max: 120 } }],
  },
  {
    id: "bar-light",
    title: "Handlebar light clamp",
    kind: "part",
    core: false,
    template: "blank",
    message: "Design a clamp for a 31.8 mm handlebar that holds a 50 mm round bike light, tightened with one M5 screw.",
    expect: [BRIEF, { label: "Fits a 31.8 mm bar", source: /31\.8/ }, { label: "M5 screw", source: /\bM5\b/ }, { label: "A sensible size (35 to 150 mm)", overall: { min: 35, max: 150 } }],
  },
  {
    id: "gearbox",
    title: "3:1 gear reduction",
    kind: "assembly",
    core: false,
    template: "blank",
    message: "Design a 3:1 spur gear reduction with a 20-tooth module 1 pinion on 5 mm shafts, in a printed housing.",
    expect: [BRIEF, { label: "Uses gears", source: /gear/i }, { label: "60-tooth gear for 3:1", source: /\b60\b/ }, { label: "Gears and a housing", parts: { min: 3 } }],
  },
  {
    id: "fan-mount",
    title: "40 mm fan on 2020 extrusion",
    kind: "part",
    core: false,
    template: "blank",
    message: "Design a bracket that holds a 40 mm fan on a 2020 aluminium extrusion, with M3 screws for the fan and an M5 T-nut for the extrusion.",
    expect: [BRIEF, { label: "M3 for the fan", source: /\bM3\b/ }, { label: "M5 for the extrusion", source: /\bM5\b/ }, { label: "A sensible size (40 to 150 mm)", overall: { min: 40, max: 150 } }],
  },
  {
    id: "printer-taller",
    title: "Printer 300 mm tall build",
    kind: "assembly",
    core: false,
    template: "printer",
    message: "Make the build volume 300 mm tall.",
    expect: [
      { label: "Prints 300 mm tall", cond: "bed_z == 300" },
      { label: "Bed size unchanged", keep: true, cond: "bed_x == 220 && bed_y == 220" },
    ],
  },
  {
    id: "bushing-question",
    title: "What is the bushing made of?",
    kind: "question",
    core: false,
    template: "bracket",
    message: "What is the bushing made of, and how much does it weigh?",
    expect: [{ label: "Gives the weight in grams", reply: /\d\s*g\b|gram/i }],
  },
];

export const CORE = BENCH.filter((c) => c.core);
