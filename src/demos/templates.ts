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
import aeroBike from "./aero-road-bike.kerf?raw";

/** What kind of thing a starting point is, for grouping them on the home screen. */
export type TemplateCategory = "parts" | "mechanisms" | "machines" | "processes";

export const TEMPLATE_CATEGORIES: { id: TemplateCategory; label: string }[] = [
  { id: "parts", label: "Parts and products" },
  { id: "mechanisms", label: "Mechanisms" },
  { id: "machines", label: "Machines and electronics" },
  { id: "processes", label: "Sheet, cast and carbon" },
];

export interface Template {
  id: string;
  name: string;
  tagline: string;
  source: string;
  /** prompts suggested in the chat for this starting point */
  prompts: string[];
  stats: string;
  category?: TemplateCategory;
  /** the Kerf features it shows off, as short tags ("airflow", "mould") */
  shows?: string[];
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
    category: "parts",
    shows: ["fit checks", "heat-set inserts"],
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
    category: "parts",
    shows: ["strength analysis"],
  },
  {
    id: "seatpost-number",
    name: "Seatpost Number Bracket",
    tagline: "Screwless 20 mm-tall ASA clip for a race number behind any seatpost (round, D-shaped aero or the Giant Propel's), held like a rear light: one O-ring on double hooks at the tips of two clip-on arms that swing in or out to follow the post, a TPU pad shaped to the post, and one solid jaw whose V pocket holds the number tight with its tail up 15°, with a push-in snap pin through its centre hole. Prints with no supports, with wind, knock and pothole checks.",
    source: seatpost,
    prompts: [
      "My seatpost measures 24 × 34 mm with a 20 mm flat back: make the pad and O-ring fit it",
      "Make the O-ring easier to put on without losing grip",
      "Show me how the number goes in and what keeps it there",
    ],
    stats: "11 parts · 19 requirements · wind, knock and pothole analysis",
    category: "parts",
    shows: ["wind and knocks", "snap pin", "no supports"],
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
    category: "mechanisms",
    shows: ["gears", "bearings", "strength"],
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
    category: "mechanisms",
    shows: ["motion sweep", "simulation"],
  },
  {
    id: "teacups",
    name: "Teacup Ride",
    tagline: "Three layers of spin from one encoder gearmotor: the deck turns, three turntables spin backwards on it and three cups spin on each. An Arduino runs the ride with a ring of 60 LEDs, a station sensor and a booth with start and emergency stop.",
    source: teacups,
    prompts: [
      "Make the cups spin the same way as their turntables",
      "Slow the ride to 6 rpm and play a rainbow on the LED ring",
      "Give it four turntables and keep the cups clear of each other",
    ],
    stats: "119 parts · 7 requirements · ride and firmware simulation",
    category: "mechanisms",
    shows: ["planetary gears", "LEDs", "firmware", "ride sim"],
  },
  {
    id: "pirate-ship",
    name: "Pirate Ship Ride",
    tagline: "An encoder gearmotor turns a crank and a rod rocks the ship 60°. A masthead lantern and deck lights swing with it through a slip ring, and an Arduino stops it hanging level at the platform.",
    source: pirateShip,
    prompts: [
      "Make the ship swing higher, about 45° each way, and check the crank still goes all the way round",
      "Drive the ship with a tyre pushing on the hull instead, like the real ride",
      "Add a row of LED portholes along each side of the hull",
    ],
    stats: "89 parts · 2 requirements · ride and firmware simulation",
    category: "mechanisms",
    shows: ["linkage", "slip ring", "firmware", "ride sim"],
  },
  {
    id: "ferris-wheel",
    name: "Ferris Wheel",
    tagline: "An encoder gearmotor turns the wheel through 12:60 gears and the six gondolas hang level. 76 LEDs on the wheel play light shows through a slip ring, and an Arduino stops a gondola at the platform.",
    source: ferrisWheel,
    prompts: [
      "Give it eight gondolas and check they still clear each other",
      "Play a rainbow on the rim and make the hub ring twinkle",
      "Why do the gondolas stay level, and what would make them tip?",
    ],
    stats: "89 parts · 5 requirements · ride and firmware simulation",
    category: "mechanisms",
    shows: ["gravity", "slip ring", "LED shows", "ride sim"],
  },
  {
    id: "aero-road-bike",
    name: "Aero Road Bike",
    tagline: "Carbon aero race bike with Kammtail tubes and dropped stays; a real 11-speed chain runs 52 × 11 through the derailleur, and a UCI check proves it race legal.",
    source: aeroBike,
    prompts: [
      "Make the frame as aero as you can and keep it UCI legal",
      "Fit 30 mm tyres and check they clear the frame and fork",
      "Put the chain on the 36 × 30 and check the chain line",
    ],
    stats: "34 parts · UCI rules check · moving chain",
    category: "processes",
    shows: ["airflow", "carbon layup", "UCI rules", "chain"],
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
    category: "parts",
    shows: ["sketches", "constraints"],
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
    category: "processes",
    shows: ["sheet metal", "flat patterns", "DXF"],
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
    category: "processes",
    shows: ["mould", "casting"],
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
    category: "parts",
    shows: ["threads", "O-ring seal"],
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
    category: "machines",
    shows: ["Arduino", "wiring", "firmware", "test plan"],
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
    category: "machines",
    shows: ["Klipper", "wiring", "parts to buy"],
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
    category: "machines",
    shows: ["circuit you can hear", "circuit board", "firmware"],
  },
];

export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id);

/** Who Kerf is for. The answer orders the starting points and picks the example briefs. */
export type Audience = "maker" | "engineer" | "student" | "manufacturer";

export const AUDIENCES: { id: Audience; label: string; detail: string; order: TemplateCategory[]; recommended: string; briefs: string[] }[] = [
  {
    id: "maker",
    label: "Making things at home",
    detail: "3D printing, electronics and projects for yourself",
    order: ["parts", "machines", "mechanisms", "processes"],
    recommended: "enclosure",
    briefs: [
      "A wall mount that holds my bike by the top tube, printed in PETG with two screws",
      "A box for an Arduino Uno with a USB cutout and a snap-on lid",
      "A replacement knob for a 6 mm D shaft with a grippy edge",
    ],
  },
  {
    id: "engineer",
    label: "Engineering and product design",
    detail: "Real loads, fits and tolerances, for work",
    order: ["mechanisms", "machines", "parts", "processes"],
    recommended: "reducer",
    briefs: [
      "A 3:1 spur gearbox on 8 mm shafts for a NEMA 17, with bearings and a printed housing",
      "A wall bracket that holds 15 kg with a safety factor of 3, as light as it can be",
      "A sheet-metal electronics chassis 200 × 120 × 60 mm with vents and rubber feet",
    ],
  },
  {
    id: "student",
    label: "Learning and school projects",
    detail: "See how things work and why they're shaped that way",
    order: ["mechanisms", "machines", "parts", "processes"],
    recommended: "engine",
    briefs: [
      "A see-through model of a four-stroke engine I can print and turn by hand",
      "A small robot arm with two servos and an Arduino",
      "A streamlined soapbox car body, tested in the wind tunnel for drag",
    ],
  },
  {
    id: "manufacturer",
    label: "Making products to sell",
    detail: "Batches, processes, costs and drawings for a factory",
    order: ["processes", "parts", "machines", "mechanisms"],
    recommended: "sheet-chassis",
    briefs: [
      "A two-part injection-moulded case for a handheld sensor, 5,000 a year",
      "A laser-cut and bent steel mounting bracket, drawn up ready to quote",
      "A cast aluminium motor housing with machined bearing seats and drawings for the factory",
    ],
  },
];

export const audienceById = (id: string | undefined) => AUDIENCES.find((a) => a.id === id);
