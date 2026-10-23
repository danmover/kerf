// What the designer and the reviewer are told about the checks that catch
// what a quick model most often gets wrong: moving parts that hit or rub
// something part way through their motion, designs that fall over, overlaps,
// and wiring that browns out the controller, reuses a pin or clashes on the
// I2C bus. Each check's finding carries the numbers to fix it with.

export function checksPromptSection(): string {
  return `## Moving parts, standing up and power that starts
The checks also test what only shows once the design runs. Each finding gives the numbers to fix it with: apply them, do not guess.
- Moving parts are swept through a whole cycle of the drive against every part that does not move with them. One that runs into a part on the way round fails (it says at what angle, how deep, and for a turning part how far out it reaches from its axis and how close the other part comes in); one that comes into contact with a part it is clear of at rest warns that it rubs. Lay out each swept envelope before placing still parts near it: a turning arm or wheel sweeps a circle out to its furthest point from the axis, a crank web and its rod sweep the whole throw, a piston its stroke. Keep still parts at least 0.5 mm outside it for printed parts (0.2 mm machined), and place them from the same lets as the moving part (\`arm_len + clear\`), so a longer arm moves them too.
- A shaft turns in a bore with running clearance (about +0.3 mm on a printed hole) or in a bearing. A hole the size of the shaft is a press fit, and the part turns with the shaft.
- Machines and designs that move must stand on their own: the centre of mass of everything over the footprint of what touches the floor, and still standing when tilted 10° (the test for equipment that stands on its own), at every position of the motion. Put heavy parts (motors, batteries, power supplies, weights) low and near the middle, and make the base wide enough: from the centre of mass to the edge of the footprint at least 0.18 times its height, plus how far it moves as the design runs. When the design is bolted, clamped or hung, say so in the brief's setting or with held: "bolted to the bench" on the part on the floor, never to quiet the check.
- An overlap's fix says which way and how far to move which part. Place faces that meet from the same expression, so they touch without overlapping. A part wholly inside another needs its seat cut (cut <part> from <body>, with clearance); a copy in the same place as its twin is deleted.
- Motors and servos draw their stall current every time they start. Never power them from a controller's 5 V or 3.3 V pin: give servos their own 5 to 6 V BEC or buck converter rated for the sum of their stall currents, and size a motor supply for its starting current (or ramp the PWM up in firmware), with every ground joined.
- One signal per controller pin: only buses (I2C, SPI, serial) and a line that must switch several modules together share a pin. Move a second signal to one of the free pins the check names.
- Every device on an I2C bus answers at its own address. Two of the same module need an address jumper set differently, a second bus, or an I2C multiplexer (TCA9548A).`;
}

export function checksReviewSection(): string {
  return `## Motion, standing up and power
- Static clearance in the drawn pose proves nothing for a moving part: look at what each moving part passes on its way round. A motion sweep failure (a part that hits something part way through its motion) or a design that falls over is a blocker; a part that rubs, or a free-standing design that tips at under 10°, is major unless the brief says it is held down.
- Servos or motors powered from a controller's own supply pin, two I2C devices at one address, and one controller pin wired to two signals are blockers: each stops the machine working once it runs.`;
}
