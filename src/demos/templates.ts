// Starting points offered on the home screen and during onboarding.

import enclosure from "./enclosure.kerf?raw";
import reducer from "./reducer.kerf?raw";
import blank from "./blank.kerf?raw";
import bracket from "./bracket.kerf?raw";

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
    stats: "21 parts · 6 requirements",
  },
  {
    id: "bracket",
    name: "Wall Shelf Bracket",
    tagline: "Printed PETG bracket on two M4 screws, with a stress analysis under the shelf's load.",
    source: bracket,
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
];

export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id);
