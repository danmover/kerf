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
- A part that slides or swings back and forth (a piston, a rocker, a swing ship, a wiper) is driven by a connecting rod, not spin:. Give it slides: <axis> (a piston in its bore) or swings: <axis> with axis_at: <pivot> (a rocker), and give the rod links: [<turning part>, <follower>] and pins: [<crank pin centre>, <follower pin centre>], declared after both. The checks sweep a full turn: a rod that cannot reach all the way round fails (keep the crank shorter than the rod, the rocker and the pivot spacing), one that pushes nearly square across the travel warns (rods 3 to 4 times the crank throw), and pins must sit on the parts they join (a pressed crank pin counts).
- Something that hangs free on a pin carried round by a wheel (a gondola, a swinging seat) rides the wheel with spin: -1 against it, so the preview keeps it level; the simulation leaves the pin free and gravity levels it, so give it a plain pin with running clearance.
- Draw every screw, nut, washer, T-nut, insert, corner bracket and joining plate (lib.screw, lib.nut, lib.tnut, lib.insert, lib.washer, lib.corner_bracket, lib.joining_plate). After the parts have their holes and sit where they mount, call place_fasteners: it fills every empty screw hole with a hardware-store screw of the right length and what it goes into (a nut, a T-nut, an insert), and joins every touching pair of T-slot profiles with a corner bracket or joining plate. Then fix what it could not fasten. A hole with no screw in it, or two profiles that only touch, fail the checks.
- held: "..." on a part or component says how it is held when the model cannot show it: glue, tape, a strap, cable ties, solder or a press fit. Never name screws, nuts, T-nuts, inserts or brackets in held: (draw them), and never use it to quiet a check on a part that should be fastened. A bought part fixed by hardware that comes with it (a brake caliper's own bolts) says so: held: "its own two M5 bolts, supplied with it, into ...". Panel jacks, switches and pots are held by their own nuts; knobs by their shafts; seals by their bores.`;
}

export function assemblyReviewSection(): string {
  return `## Holding together and moving together
- Every part is fastened, fitted or pivoted to the base, or its held: names glue, tape, a strap, cable ties, solder or a press fit. A part that only rests, floats or is not held up (the assembly checks name them) is a blocker; a held: that names screws, nuts, T-nuts or brackets that are not drawn, or hides a part that should be screwed down, is a blocker.
- Every screw hole has its screw, and every joint between frame profiles has a bracket, plate or screws joining it. An empty hole or a joint that only touches is a blocker: call place_fasteners.
- Electronics are catalogue parts (lib.board, lib.motor, lib.sensor ...), each on a mount, wired to what powers and drives it; a plain box standing in for a board, battery or motor is a blocker.
- Every screw's head and nut sit on their parts, and a part that turns on a screw has a sleeve, a shoulder screw or a slack lock nut. A loose screw or a clamped pivot is major.
- Parts on a moving part ride on it (rides:, or a fastening to it), so the preview and the simulation carry them; a seat, cup or screw left behind while its carrier moves is a blocker.
- A piston, rocker or swinging part moves by a connecting rod (slides: or swings: on it, links: and pins: on the rod). A rod that locks part way round is a blocker; one that binds (transmission angle under 30°) or has a pin off its parts is major.`;
}
