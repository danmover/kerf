// What the assistant and the reviewer are told about holding electronics
// and running cables, next to the checks that test it (clash.ts, mounts.ts,
// checks.ts), so the advice and the checks change together.

/** For the designer's system prompt. */
export function wiringPromptSection(): string {
  return `## Holding electronics and running cables
After every build the app routes each cable round the parts (its full thickness clear of every part and of the other cables), then checks the cables, their plugs, and how each board and module is held. Its findings name the cables by their wire-list numbers (W1, W2...) and the parts by their names. Fix them like any other failure, and design for them from the start:
- Hold every board, module, supply and battery. Standoffs or bosses under its mounting holes with a lib.screw through at least two of them, biting into a heat-set lib.insert, a lib.nut or a threaded standoff; or a slot, cradle, clips or a lid that close it in on every side. A board resting on a shelf is not held. When it is held by something the model cannot show (foam tape, a strap, hook-and-loop), say so on its component: held: "double-sided foam tape".
- Leave room for every plug: its body, the cable straight out of its back for about three cable diameters, and room to pull it straight off and grip it. Face connectors into open space or an access opening, not into a wall, a shelf or the next board. Header pins that point down (small modules, an Arduino Nano) need the board raised on standoffs tall enough for the plug and its lead (about 25 mm), or a socket or carrier board, or the header soldered pointing up.
- Give the cables a path: a gap or channel at least as wide as the bundle between the parts they run past, a hole through each wall they cross, sized for every cable through it, with a grommet or a rounded edge, and tie points (a cable-tie slot or a pair of holes) along the run, one within a few centimetres of each plug for strain relief and then about every 100 mm. Keep the cables inside an enclosure rather than out through a small hole and back. Do not run them past moving parts without a drag chain or loop.
- More wires on one pin than its terminal takes (a ground or 5 V net feeding many boards) get crimp-spliced behind its plug, and the splice needs room too; for a big net, give it a terminal block, a lever connector or a bus bar where the wires meet.`;
}

/** For the reviewer's system prompt. */
export function wiringReviewSection(): string {
  return `## Electronics and cables
When the design has boards, modules or wiring, check that every board and module is fixed (screws into standoffs, bosses, inserts or nuts; a slot, cradle or clips; or a held: line for tape or a strap), that every plug has room to go on and come off, that the cables have a way through inside the enclosure, cross walls through grommeted holes, and are tied down near their plugs and along long runs. The automatic wiring checks report cables through parts, crowded bundles, plugs into parts or each other, boards not held down and cables hanging free; a failure among them is a blocker, and a warning about a plug that cannot be pulled off or a board on standoffs with no screws is major.`;
}
