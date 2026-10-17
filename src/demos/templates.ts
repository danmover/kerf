// Starting points offered on the home screen and during onboarding.

import enclosure from "./enclosure.kerf?raw";
import reducer from "./reducer.kerf?raw";
import blank from "./blank.kerf?raw";
import bracket from "./bracket.kerf?raw";
import shelf from "./shelf.kerf?raw";
import canister from "./canister.kerf?raw";
import tunneller from "./sand-tunneller.kerf?raw";
import printer from "./printer.kerf?raw";
import practiceAmp from "./practice-amp.kerf?raw";

export interface Template {
  id: string;
  name: string;
  tagline: string;
  source: string;
  /** prompts suggested in the chat for this starting point */
  prompts: string[];
  stats: string;
}

export const TEMPLATES: Template[] = [
  {
    id: "blank",
    name: "Blank design",
    tagline: "Start from nothing and describe what you need.",
    source: blank,
    prompts: [
      "Design a wall bracket for a 25 mm tube, held by two M4 screws",
      "Make a 3D-printable box for an Arduino Uno with a USB cutout",
      "Design a 3:1 spur gear pair on 8 mm shafts with a printed frame",
    ],
    stats: "Empty",
  },
  {
    id: "enclosure",
    name: "Sensor Hub Enclosure",
    tagline: "Two-part PETG case around a fixed 70 × 50 mm board, USB-C and heat-set inserts.",
    source: enclosure,
    prompts: [
      "Make this enclosure 20% narrower, keep the circuit board and USB-C connector unchanged, and preserve access to the mounting screws",
      "Add a second row of vent slots and check the lid still clears the board",
      "Switch the lid screws to M2.5 and update the bosses",
    ],
    stats: "21 parts · 8 requirements",
  },
  {
    id: "shelf",
    name: "Wall Shelf Bracket",
    tagline: "Printed PETG bracket on two M4 screws, with a stress analysis under the shelf's load.",
    source: shelf,
    prompts: [
      "Can this bracket hold 15 kg? Make it strong enough if not, with as little extra plastic as possible",
      "Show me where the bracket is most stressed and explain why",
      "Make the arm 200 mm long and keep the safety factor above 2.5",
    ],
    stats: "3 parts · stress analysis",
  },
  {
    id: "reducer",
    name: "Two-Stage Spur Reducer",
    tagline: "12:1 gearbox on a NEMA 17 stepper with bearings, shafts and a printed housing.",
    source: reducer,
    prompts: [
      "Change the reduction to 20:1 with a 10 mm output shaft and keep the mounting feet where they are",
      "Make the housing walls 4 mm and show me what changes",
      "Can this gearbox take the motor's full 0.4 N·m? Strengthen it if not",
      "Why are two of the gears marked removable?",
    ],
    stats: "26 parts · 8 requirements",
  },
  {
    id: "bracket",
    name: "Shaft Support Bracket",
    tagline: "Bent-plate bracket and flanged bushing, built from five constrained sketches you can edit by hand.",
    source: bracket,
    prompts: [
      "Make the foot 80 mm long and add a third mounting hole between the other two",
      "Round the top corners of the upright with a 2 mm fillet",
      "Make the gusset reach two thirds of the way up the upright",
    ],
    stats: "2 parts · 5 sketches · 2 requirements",
  },
  {
    id: "canister",
    name: "Screw-Top Canister",
    tagline: "Printed jar and knurled lid with real two-start threads, an O-ring seal and raised lettering.",
    source: canister,
    prompts: [
      "Make the canister 120 mm tall and 80 mm wide, keeping the same thread fit",
      "Change the lid lettering to COFFEE and engrave it instead of raising it",
      "Add a drip ridge below the thread and round the jar's shoulder more",
    ],
    stats: "2 parts · 4 requirements",
  },
  {
    id: "sand-tunneller",
    name: "Sand Tunneller",
    tagline: "Arduino robot that screws itself 2 m along the bottom of a 5 m deep sand pit and steers: brief, parts list, wiring, firmware and test plan.",
    source: tunneller,
    prompts: [
      "Make the pit 1 m wide and change the drill until every check passes again",
      "Use a bigger battery and update the wiring, the runtime and the parts list",
      "Why does the steering push the hinge through a slanted slot instead of directly?",
    ],
    stats: "91 parts · 11 requirements · firmware",
  },
  {
    id: "printer",
    name: "Kerf i3 220 Printer",
    tagline: "220 × 220 × 250 mm bed-slinger on rails: printed parts, wiring, Klipper config, parts list and test plan.",
    source: printer,
    prompts: [
      "Make the print volume 300 × 300 × 300 mm and check the bed heater, power supply and frame still work",
      "Give each Z motor its own driver so the gantry levels itself, and update the wiring and Klipper config",
      "Why is the power supply at 92 % with everything heating, and what would you change?",
    ],
    stats: "98 parts · 28 requirements · Klipper",
  },
  {
    id: "practice-amp",
    name: "Practice Amp with Tuner",
    tagline: "25 W guitar amp with clean-to-overdrive tone, a built-in tuner and one through-hole board: circuit you can hear, board layout, cabinet, parts list and firmware.",
    source: practiceAmp,
    prompts: [
      "Give it more gain for heavier overdrive, and keep every stage before the clipping diodes clean",
      "Swap the tone stack for a single tone knob and show me how the sound changes",
      "Make it battery powered for busking and check how long it plays",
    ],
    stats: "266 parts · 11 requirements · tuner firmware",
  },
];

export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id);
