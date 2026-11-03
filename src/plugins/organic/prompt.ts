// What the design assistant needs to know to model creatures and people.

import { Fn } from "../../lang/values";
import { organicNamespace } from "./lang";

export function organicPromptSection(): string {
  const fns = Object.values(organicNamespace().fields)
    .map((f) => (f instanceof Fn && f.doc ? `- ${f.doc}` : ""))
    .filter(Boolean)
    .join("\n");
  return `## Organic models: animals, people, characters and pets
For an animal, person, character, pet, plant or any soft organic form, make one part whose body is organic.model([...]) instead of boxes, cylinders and fillets. It blends simple shapes into one smooth body, paints colour regions on it and meshes it at the triangle budget you set; the user can tweak every shape afterwards. Mechanical rules above (hardware, fasteners, requirements, decisions, printability) do not apply to a character unless the user wants it made, for example 3D printed as a figurine.

${fns}

How to build one (work like a sculptor: big forms first, then features, then detail):
- Coordinates: X right, Y back, Z up, mm. The creature faces -Y and stands on z = 0; a floating one hovers just above it. About 100 mm tall unless asked.
- Plan proportions before writing shapes: write down the head, body, leg, ear and tail sizes as fractions of the height (from the reference if there is one), then place the big forms to match. Most of a creature's look is its proportions and silhouette.
- Order: torso, head, limbs and feet, ears, tail, wings, fins, horns, fur tufts and accessories, then paint for markings, then carve. Later shapes blend into earlier ones.
- Build each form from several overlapping shapes rather than one: a torso is a chest egg plus a rump egg; a head is a cranium plus cheeks plus a muzzle (organic.limb tapering toward the nose) plus a nose; a haunch is an egg over the top of a back leg; a paw is an egg flattened at the bottom. Smooth-blended overlaps read as anatomy; single balls read as toys.
- Blend (mm) sets how softly a shape joins: 6–10 for a head into a body, 3–5 for limbs, ears and tails, 0–1.5 for crisp things (horns, crystals, nose, claws, eyes, accessories).
- Curves: organic.tube for anything that bends (tails, necks, trunks, tentacles, snake bodies), with diameters per point for a bushy or tapering shape; organic.curl for spirals (ram horns, curly tails, shells).
- Fur and fluff: organic.tuft fans of pointed spikes give the jagged edges of stylised fur (cheek ruffs, chest ruffs, manes, crests, tail tips); blend 3–5 so they grow out of the body. organic.paint(organic.tuft(...)) paints a zigzag colour edge, like a white tail tip.
- Wool, clouds and foliage: many balls of one size spread evenly over a core shape with blend 2–3, sunk to about 90% of the core's radius.
- Use mirror: true for left and right pairs, and organic.group to draw an ear, wing, leg or horn once round the origin and place it (with mirror: true for both sides).
- Ears: a thick rounded slab outline, its inside carved with a smaller slab (color: the inner-ear colour) and the tip painted.
- Colour: give each shape its colour (the model's color: covers the rest), and use organic.paint for markings that do not change the form: muzzles, bellies, socks and boots, inner ears, spots, stripes, stars, patches. Paint volumes only need to pass through the surface where the marking goes.
- Count exactly: "FIVE puffs" is five shapes, "SIX tentacles" is six, evenly spaced when asked. Keep left and right symmetric unless told otherwise.
- Keep every feature at least about 3% of the height thick, so it survives meshing; thin strands, wires and loose bits become thick rounded shapes. Every shape must overlap what it attaches to: a loose piece shows as separate pieces in the checks.
- style: "smooth" is the default and right for most creatures (Roblox takes up to 20000 tris per mesh, so 8000–16000 for game pets); "lowpoly" only when faceted low-poly is asked for; "detailed" for close-ups with detail: "fur", "scales", "skin" or "feathers".
- Look at it: capture_view from the front, side, back and top after the first draft, compare with the reference or the description, and fix proportions, silhouettes and colour regions in a second pass. Repeat until it matches.

Example, the head and tail of a stylised fox (about 105 mm tall):
\`\`\`
let ear = [
  organic.slab(points: [(-13.5, 0), (13.5, 0), (0, 32)], t: 8, r: 3.8),
  organic.carve(organic.slab(points: [(-8.5, 5), (8.5, 5), (0, 25)], t: 5, at: (0, -4.6, 0), r: 2.6), color: pink, blend: 1.5),
  organic.paint(organic.egg(size: (50, 30, 36), at: (0, 0, 37)), color: dark),
]
// inside organic.model([...]), after the body and legs:
organic.egg(size: (56, 46, 46), at: (0, -6, 65), blend: 10),          // cranium
organic.egg(size: (60, 36, 30), at: (0, -12, 54), blend: 8),          // wide cheeks
organic.limb(from: (0, -16, 54), to: (0, -38, 49), d: 26, d2: 10, blend: 8),  // snout
organic.egg(size: (8.5, 6.5, 6.5), at: (0, -42.5, 50), color: nose, blend: 1),
organic.egg(size: (20, 30, 18), at: (17, -12, 47), color: cream, blend: 8, mirror: true),
organic.tuft(at: (21, -10, 46), toward: (1, 0.25, -0.6), length: 11, d: 16, count: 3, spread: 70, color: cream, blend: 5, mirror: true),
organic.group(ear, at: (19.5, -3, 79), rotate: (-6, 20, 14), mirror: true),
organic.tube(points: [(0, 25, 28), (0, 34, 32), (0, 46, 37), (0, 59, 42), (0, 73, 45)], d: [10, 26, 35, 28, 4], blend: 5),
organic.paint(organic.egg(size: (62, 36, 21), at: (0, -24, 45)), color: cream),
organic.paint(organic.tuft(at: (0, 82, 46), toward: (0, -1, -0.2), length: 27, d: 26, count: 6, around: true, spread: 56), color: cream),
\`\`\`

Stylised game pets (a game pet, a reference sheet, "chunky", "cute"):
- Chunky proportions: an oversized head about half the height (ears aside), a small compact body, short thick legs about a quarter of the height, little rounded feet.
- Leave the face blank: no eyes, eyebrows or mouth (the game puts expression decals there), but keep the muzzle, beak and nose shapes and fur colour markings. When the face is wanted, organic.eye gives glossy cartoon eyes.
- Neutral rest pose for rigging: legs straight down and apart, never touching; arms or flippers 30° out from the torso; wings half spread and clear of the body; the tail clear of the legs; a long body in an open S curve with no part touching another. A floating pet has no legs and its fins, flippers or tentacles spread clear of the body and each other.
- Everything solid and attached: no floating parts, no thin needles, ropes or particles; glowing parts are just bright colour.
- With a reference sheet attached, match its silhouette in the front, side, back and top views, its colour regions and its counts; compare with capture_view from front, side, back and top before you finish.
- The Export menu's "Game model" gives a .glb with the colours and shading baked into one texture, for Roblox, Unity and Godot.`;
}
