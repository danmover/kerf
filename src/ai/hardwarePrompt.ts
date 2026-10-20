// What the designer and the reviewer are told about fasteners and motors:
// real hardware in every joint, chosen by calc.fastener against the joint's
// rules, motors chosen by calc.motor_select and mounted from their own
// interface data, and parts the user has on hand preferred.

export function hardwarePromptSection(): string {
  return `## Fasteners and motors
Every joint between parts gets real hardware unless the brief asks for glue, a press fit or a snap fit, or one of those suits the use better (say why): screws with nuts, heat-set inserts, tapped holes or thread-forming screws, and washers, standoffs, pins and circlips where they belong.
- Choose each joint's screw with calc.fastener(grip:, into:, material:, ...). It runs every size, head, grade and stocked length against thread engagement, strength, head room and the process, and records what it ruled out. Give load: and shear: when the joint carries a real load, flush: true for a countersunk or counterbored head, space: for a tight spot, env: "outdoor" or "marine" for stainless, vibration: true for lock nuts. Place lib.screw(j) and its lib.nut(j), lib.insert(j) or lib.washer(j) from the result, and cut the holes from its fields: j.clearance through the clamped parts, hole(size, fit: "insert") for an insert, fit: "tap" for a tapped hole in metal, j.pilot for a thread-forming screw, cbore: or csink: when j.cbore_d or j.csink is set.
- Suit the process: heat-set inserts (or captive nut traps) in prints that come apart, thread-forming screws into plastic that is assembled once, tapped holes in metal, through bolts and nuts in sheet and extrusion slots (lib.nut(M5, type: "tslot20")). Keep about 2 × d of material round each hole and a straight tool path to every head.
- Use stocked lengths. A screw into a nut shows a full thread past it (two past a nyloc); in a blind hole it stops short of the bottom.
- Choose motors with calc.motor_select(torque:, speed:, voltage:, current_max:, kind:), or force:, travel_per_rev: and mass: for a linear axis, instead of reaching for a familiar part. The catalog has NEMA 8 to 34 steppers, goBILDA, Pololu 37D, JGA25, N20 and TT gearmotors, brushless outrunners, servos and linear actuators; keep at least 1.5 × torque margin on steppers at speed and DC motors under half their stall torque.
- Mount each motor from its own data: cut motor.mount from the plate it bolts to (pilot clearance and the screw holes in its real pattern), put a screw in every one of motor.holes, and choose them with calc.fastener(grip: <plate>, into: "tapped", material: "Aluminum 6061", depth: motor.screw_depth, size: motor.screw) so they do not bottom out. Through-hole flanges (NEMA 23 and 34, motor.screw_depth 0) take bolts and nuts: into: "nut", grip: plate + motor.flange_t. Drive the shaft through its flat or key: a grub screw on the D-flat, a key in a keyway.
- Prefer the parts the user has on hand (listed with the brief) when they pass; keep the have: list in the calls you record.
- The checks test every screw (something to thread into, enough thread, not bottoming out, reaching through its nut, strength when load: is given) and every motor (screws in its holes). Fix the failures before showing the design.`;
}

export function hardwareReviewSection(): string {
  return `## Fasteners and motors
- Every joint has hardware a builder can fit: a screw through the parts into a nut, insert, tapped hole or pilot hole, with a head a tool can reach. A missing nut, insert or hole is a blocker (the assembly checks name them).
- The hardware suits the process and the use: inserts or nut traps in prints that come apart, washers under heads on soft plastic that carries load, stainless outdoors, lock nuts where it shakes.
- Each motor is bolted through its real hole pattern with its pilot located, its screws do not bottom out, and its shaft is coupled through the flat or key. A motor that carries a real load with no sizing calculation (calc.motor_select or a motor calculation) is a major finding.`;
}
