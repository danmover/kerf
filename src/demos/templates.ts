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
import seatpost from "./seatpost-number.kerf?raw";
import engine from "./engine.kerf?raw";
import teacups from "./teacups.kerf?raw";
import pirateShip from "./pirate-ship.kerf?raw";
import ferrisWheel from "./ferris-wheel.kerf?raw";
import sheetChassis from "./sheet-chassis.kerf?raw";
import castKnob from "./cast-knob.kerf?raw";

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
    id: "seatpost-number",
    name: "Seatpost Number Bracket",
    tagline: "Screwless 20 mm-tall ASA clip for a race number on an aero seatpost, held like a rear light: one O-ring on two double hooks, a TPU grip pad, the number tilted up 30° on a sprung pin through its centre hole into the far cheek, printed with no supports, and wind, knock and pothole checks.",
    source: seatpost,
    prompts: [
      "My seatpost measures 21 × 35 mm: update the saddle to fit",
      "Make the O-ring easier to put on without losing grip",
      "Show me how the number goes in and what keeps it there",
    ],
    stats: "8 parts · 10 requirements · wind and knock analysis",
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
    id: "engine",
    name: "Single-Cylinder Engine",
    tagline: "Crank, connecting rod and piston on 608 bearings: turn the flywheel and the piston runs its 40 mm stroke, checked all the way round and simulated at 300 rpm.",
    source: engine,
    prompts: [
      "Make the stroke 50 mm and keep the rod long enough that it doesn't bind",
      "Add a second cylinder at 180° on the same crankshaft",
      "Why is the rod four times the crank throw?",
    ],
    stats: "29 parts · 4 requirements · motion simulation",
  },
  {
    id: "teacups",
    name: "Teacup Ride",
    tagline: "A turning deck with three cups whose gears roll round a fixed sun gear, so each cup spins 2.8 times for every turn of the deck.",
    source: teacups,
    prompts: [
      "Give it four cups instead of three and keep them clear of each other",
      "Make the cups spin the opposite way to the deck",
      "Add a motor under the base to drive the deck, and show it in the ride simulation",
    ],
    stats: "18 parts · 3 requirements · ride simulation",
  },
  {
    id: "pirate-ship",
    name: "Pirate Ship Ride",
    tagline: "A stepper turns a crank, and a connecting rod rocks the ship 60° on its axle; every screw, pin and bearing that holds it together moves with it.",
    source: pirateShip,
    prompts: [
      "Make the ship swing higher, about 45° each way, and check the crank still goes all the way round",
      "Drive the ship with a tyre pushing on the hull instead, like the real ride",
      "What happens to the swing if the rod is 20 mm shorter?",
    ],
    stats: "37 parts · 2 requirements · ride simulation",
  },
  {
    id: "ferris-wheel",
    name: "Ferris Wheel",
    tagline: "A stepper turns the wheel through 12:60 gears; six gondolas hang free on their pins and gravity keeps them level all the way round.",
    source: ferrisWheel,
    prompts: [
      "Give it eight gondolas and check they still clear each other",
      "Make the wheel 300 mm across and pick a gear ratio for 3 rpm",
      "Why do the gondolas stay level, and what would make them tip?",
    ],
    stats: "40 parts · 4 requirements · ride simulation",
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
    id: "sheet-chassis",
    name: "Sheet-Metal Chassis",
    tagline: "Aluminium tray and cover, each bent from one sheet with sheet(): flat patterns with bend tables, a laser DXF, and bend, flange and fit checks.",
    source: sheetChassis,
    prompts: [
      "Make the chassis 200 mm wide and 60 mm tall, and keep every check passing",
      "Add a row of vent slots to the back and two holes in the floor for rubber feet",
      "Turn the top edge of the front panel into a 10 mm lip that folds inward",
    ],
    stats: "10 parts · 2 flat patterns",
  },
  {
    id: "cast-knob",
    name: "Cast Knob and Mould",
    tagline: "Polyurethane knob for a 6 mm D shaft with its own two-part printed mould, made from the knob with mould(): keys, clamping bolts, a pour hole and vents.",
    source: castKnob,
    prompts: [
      "Make the knob 45 mm across with a knurled grip and update the mould",
      "Add a skirt with a scale of ten marks round the bottom of the knob",
      "Split the mould halfway up the knob instead and show me why that's worse",
    ],
    stats: "3 parts · 2 mould halves",
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
