// What the designer and the reviewer are told about assemblies that hold
// together the way real ones do: every part held (fastened, fitted, pivoted
// or declared), every screw closed on its stack, and parts that ride on a
// moving part said to ride on it, so the checks, the motion preview and the
// simulation all move them together.

export function assemblyPromptSection(): string {
  return `## Parts that hold together and move together
Build every assembly the way it would stand on the bench under gravity. The checks measure it and fail what would fall apart:
- Every part is held: fastened, fitted or pivoted to the parts standing on the floor. A part that only touches another rests where gravity leaves it ("only rests on"), one touching nothing floats, and one touching from the side or below is not held up. Put each part against what it mounts to (faces meeting within 0.15 mm) and fasten it there.
- Every screw closes on its stack: the head on the first part, each part against the next, and the nut against the last part (lib.nut's at: is the face that touches), or the thread in an insert or tapped hole. A nut or head that stands off its part is a loose screw that holds nothing, as on the bench. Place nuts and heads from the same numbers as the faces they sit on (at: (x, y, plate_z - plate_t)), never a guessed z.
- Countersunk holes (csink: true) take countersunk screws (head: "flat", or calc.fastener(..., head: "flat")); a socket head in a countersink stands on the rim.
- A part that turns on a screw (a hinge, a lever) needs running clearance and a lock nut left slack (lib.nut(M4, type: "nyloc"), or a thin nut with threadlocker), or a sleeve or shoulder screw through it, so the screw clamps the sleeve and the part turns on it. A screw tightened down on a turning part stops it.
- Do not fasten a turning part to the frame, or two parts that turn differently to each other: the checks report the fastening that would lock the drive.
- Parts carried on a moving part say so: rides: deck on a seat, car, cup or gear that goes round with a turning deck, arm or wheel. A gear that rides and meshes (a planet round a fixed centre gear, a teacup ride's cups) gets rides: carrier and mesh: centre_gear, and turns relative to the carrier. Screws, nuts, washers and parts bolted to a moving part move with it on their own; do not give them spin:.
- held: "..." on a part or component says how it is held when the model cannot show it: glue, tape, a strap, or hardware listed with buy "..." but not drawn (T-nuts in an extrusion slot, wood screws). Use it only for those, never to quiet a check on a part that should be fastened. Panel jacks, switches and pots are held by their own nuts; knobs by their shafts; seals by their bores.`;
}

export function assemblyReviewSection(): string {
  return `## Holding together and moving together
- Every part is fastened, fitted or pivoted to the base, or its held: names glue, tape, a strap or undrawn hardware on the parts list. A part that only rests, floats or is not held up (the assembly checks name them) is a blocker; a held: that hides a part that should be screwed down is a major finding.
- Every screw's head and nut sit on their parts, and a part that turns on a screw has a sleeve, a shoulder screw or a slack lock nut. A loose screw or a clamped pivot is major.
- Parts on a moving part ride on it (rides:, or a fastening to it), so the preview and the simulation carry them; a seat, cup or screw left behind while its carrier moves is a blocker.`;
}
