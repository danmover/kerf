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

How to build one:
- Coordinates: X right, Y back, Z up, mm. The creature faces -Y and stands on z = 0; a floating one hovers just above it. About 100 mm tall unless asked.
- Order: torso, head, limbs and feet, ears, tail, wings, fins, horns and accessories, then paint for markings, then carve. Later shapes blend into earlier ones.
- Blend (mm) sets how softly a shape joins: 6–10 for a head into a body, 2–4 for limbs, ears and tails, 0–1.5 for crisp things (horns, crystals, nose, claws, accessories).
- Use mirror: true for left and right pairs, and organic.group to draw an ear, wing, leg or horn once round the origin and place it (with mirror: true for both sides).
- Colour: give each shape its colour (the model's color: covers the rest), and use organic.paint for markings that do not change the form: muzzles, bellies, socks, inner ears, spots, stripes, stars, patches. Paint volumes only need to pass through the surface where the marking goes.
- Count exactly: "FIVE puffs" is five shapes, "SIX tentacles" is six, evenly spaced when asked. Keep left and right symmetric unless told otherwise.
- Keep every feature at least about 3% of the height thick, so it survives meshing; thin strands, wires and loose bits become thick rounded shapes.
- style: "lowpoly" (faceted game asset, tris 1500–5000; Roblox takes up to 20000 per mesh), "smooth" (soft toy, figurine) or "detailed" (fine surface detail with detail: "fur", "scales", "skin" or "feathers").

Stylised game pets (a game pet, a reference sheet, "chunky", "cute"):
- Chunky proportions: an oversized round head about half the height (ears aside), a small compact body, short thick legs about a quarter of the height, little rounded feet.
- Leave the face blank: no painted eyes, eyebrows or mouth (the game puts expression decals there), but keep the muzzle, beak and nose shapes and fur colour markings.
- Neutral rest pose for rigging: legs straight down and apart, never touching; arms or flippers 30° out from the torso; wings half spread and clear of the body; the tail clear of the legs; a long body in an open S curve with no part touching another. A floating pet has no legs and its fins, flippers or tentacles spread clear of the body and each other.
- Everything solid and attached: no floating parts, no thin needles, ropes or particles; glowing parts are just bright colour.
- With a reference sheet attached, match its silhouette in the front, side, back and top views, its colour regions and its counts; compare with capture_view from front, side, back and top before you finish.
- The Export menu's "Game model" gives a .glb with a colour texture for Roblox, Unity and Godot.`;
}
