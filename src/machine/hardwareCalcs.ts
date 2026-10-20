// Calculators that choose hardware: calc.fastener() runs every screw, nut,
// washer and insert in the catalogue against a joint's rules and keeps the
// best, and calc.motor_select() does the same for motors against a duty.
// Both record what they considered and why the rest were ruled out, so the
// choice can be read and changed in the Build tab like any calculation.

import type { Args } from "../lang/args";
import { Obj, type Value } from "../lang/values";
import { HEADS, HEAD_TYPES, INTO, chooseFastener, gradeFrom, type FastenRequest, type HeadType, type Into } from "../library/fasteners";
import { threadSpec } from "../library/standards";
import { MOTOR_DUTY_KINDS, chooseMotor, type MotorDuty } from "./motorSelect";
import type { CalcBody } from "./calcs";
import type { CalcLine } from "./types";

export interface CalcSpec {
  name: string;
  params: string[];
  doc: string;
  impl: (a: Args) => { fields: Record<string, number | string | boolean>; trace: CalcBody };
}

const sig3 = (n: number) => (Number.isFinite(n) && n !== 0 ? Number(n.toPrecision(3)) : n);
const L = (label: string, value: number, unit: string, note?: string): CalcLine => ({ label, value: sig3(value), unit, note });
const money = (x: number) => `$${x.toFixed(2)}`;
const fmt = (x: number) => String(Math.round(x * 100) / 100);

/** A list of text values (have: ["M3x10 socket", "M3 nut"]). */
function textList(v: Value | undefined): string[] {
  if (v === undefined) return [];
  const list = Array.isArray(v) ? v : [v];
  return list.map((x) => (typeof x === "string" ? x : x instanceof Obj && typeof x.fields.name === "string" ? x.fields.name : String(x)));
}

/** A thread argument as a name: M3 (a thread value) or "M3" or "1/4-20". */
function sizeName(a: Args, name: string): string | undefined {
  if (!a.has(name)) return undefined;
  const v = a.value(name);
  const n = v instanceof Obj && v.kind === "thread" ? String(v.fields.name) : typeof v === "string" ? v : undefined;
  if (!n || !threadSpec(n)) return a.ctx.error(`calc.fastener(): ${name}: should be a thread size like M3, or text like "1/4-20"`);
  return n;
}

const fastener: CalcSpec = {
  name: "fastener",
  params: ["grip", "into", "material", "clamped", "depth", "load", "shear", "count", "factor", "head", "grade", "flush", "headroom", "space", "size", "min", "max", "env", "vibration", "inch", "insulated", "have"],
  doc: `Choose the screw (and its nut, washers or insert) for a joint by running every size, head, grade and stocked length in the fastener catalogue against the joint's rules, and keep the best. grip: thickness clamped under the head (mm; for a countersunk head, from the surface); into: what it threads into: "insert" (heat-set insert in a print), "nut", "nyloc", "tapped" (a tapped hole in metal) or "plastic" (a thread-forming screw in a plain pilot hole); material: what the thread is in (the tapped metal, the plastic, or the print holding the insert; "PLA" by default for prints, "Aluminum 6061" for tapped); clamped: what the head and nut bear on (adds washers on plastic); depth: most thread depth there is below the grip (a blind hole, a motor's tapped hole); load: tension on the joint, N (total); shear: N across it (total); count: screws sharing them (1); factor: safety factor (2); head: ${HEAD_TYPES.map((h) => `"${h}"`).join(", ")} or leave out to choose; grade; flush: true for a head that must not stand proud (countersunk, or sunk in a counterbore); headroom: height a head may stand above the surface; space: widest head that fits (mm); size, min, max: a fixed size or the range to consider (M3…, or inch sizes as text); env: "indoor", "outdoor" (stainless) or "marine" (A4); vibration: true for lock nuts or threadlocker; inch: true for inch sizes; insulated: true for nylon; have: what the user has on hand (["M3x10 socket", "M3 nut"]), preferred whenever it passes. Returns size, length, head, grade, drive, nut and washer (types or ""), insert (true/false), engage, clearance, pilot (the hole the thread goes in), cbore_d, cbore_h, csink (0 when none), capacity and need (N per screw), margin, price (one joint), total_price, on_hand, name. Pass the result straight to lib.screw(j), lib.nut(j), lib.washer(j) and lib.insert(j).`,
  impl(a) {
    const intoRaw = a.str("into", "insert");
    if (!(INTO as string[]).includes(intoRaw)) return a.ctx.error(`calc.fastener(): into: should be ${INTO.map((x) => `"${x}"`).join(", ")}`);
    const into = intoRaw as Into;
    const head = a.has("head") ? a.str("head") : undefined;
    if (head && !(HEAD_TYPES as string[]).includes(head)) return a.ctx.error(`calc.fastener(): head: should be ${HEAD_TYPES.map((x) => `"${x}"`).join(", ")}`);
    const gradeText = a.has("grade") ? a.str("grade") : undefined;
    const grade = gradeFrom(gradeText);
    if (gradeText && !grade) return a.ctx.error(`calc.fastener(): grade: "${gradeText}" is not a grade Kerf knows`);
    const env = a.str("env", "indoor");
    if (env !== "indoor" && env !== "outdoor" && env !== "marine") return a.ctx.error('calc.fastener(): env: should be "indoor", "outdoor" or "marine"');
    const req: FastenRequest = {
      grip: a.num("grip"),
      into,
      material: a.has("material") ? a.str("material") : undefined,
      clamped: a.has("clamped") ? a.str("clamped") : undefined,
      depth: a.has("depth") ? a.positive("depth") : undefined,
      load: a.num("load", 0),
      shear: a.num("shear", 0),
      count: a.num("count", 1),
      factor: a.num("factor", 2),
      head: head as HeadType | undefined,
      grade,
      flush: a.bool("flush"),
      headroom: a.has("headroom") ? a.num("headroom") : undefined,
      space: a.has("space") ? a.positive("space") : undefined,
      size: sizeName(a, "size"),
      min: sizeName(a, "min"),
      max: sizeName(a, "max"),
      env,
      vibration: a.bool("vibration"),
      inch: a.bool("inch"),
      insulated: a.bool("insulated"),
      have: textList(a.value("have")),
    };
    if (req.grip < 0) return a.ctx.error("calc.fastener(): grip: is the thickness clamped under the head, 0 or more");
    if (!((req.count ?? 1) >= 1)) return a.ctx.error("calc.fastener(): count: should be 1 or more");
    const { ranked, rejected } = chooseFastener(req);
    const best = ranked[0];
    if (!best) {
      const why = [...new Map(rejected.map((r) => [r.why, r])).values()].slice(0, 5).map((r) => `${r.name}: ${r.why}`);
      return a.ctx.error(`calc.fastener(): nothing in the catalogue passes this joint. ${why.join("; ")}${rejected.length > 5 ? "; …" : ""}. Loosen a limit (size, head, headroom, space, depth) or change what it threads into.`);
    }
    const count = Math.max(1, Math.round(req.count ?? 1));
    const others = ranked.filter((c) => c !== best && (c.thread !== best.thread || c.head !== best.head || c.grade !== best.grade)).slice(0, 4);
    const ruledOut = [...new Map(rejected.map((r) => [`${r.name.split("×")[0].split(" ")[0]}|${r.why}`, r])).values()].slice(0, 6);
    const extras = [best.nut && `${best.nut.dims.label.toLowerCase()} (${best.nut.dims.standard})`, best.washer && `${best.washer.dims.label.toLowerCase()}${best.washer.underHead && best.washer.underNut ? "s under the head and nut" : best.washer.underHead ? " under the head" : " under the nut"}`, best.insert && `heat-set insert ${best.thread.name}×${fmt(best.insert.dims.length)} in a Ø${fmt(best.insert.dims.hole)} mm hole`].filter(Boolean);
    const loads = (req.load ?? 0) > 0 || (req.shear ?? 0) > 0;
    return {
      fields: {
        size: best.thread.name,
        length: best.length,
        head: best.head,
        grade: best.grade,
        drive: best.head_dims.drive,
        key: best.head_dims.key,
        head_d: best.head_dims.d,
        head_h: best.head_dims.h,
        nut: best.nut?.type ?? "",
        washer: best.washer?.type ?? "",
        washer_under_head: !!best.washer?.underHead,
        washer_under_nut: !!best.washer?.underNut,
        washer_t: best.washer?.dims.h ?? 0,
        nut_h: best.nut?.dims.h ?? 0,
        nut_af: best.nut?.dims.af ?? 0,
        insert: !!best.insert,
        insert_length: best.insert?.dims.length ?? 0,
        engage: best.engage,
        engage_min: best.engageMin,
        clearance: best.clearance,
        pilot: best.pilot,
        cbore_d: best.cbore?.[0] ?? 0,
        cbore_h: best.cbore?.[1] ?? 0,
        csink: best.csink ?? 0,
        capacity: best.capacity,
        need: best.need,
        margin: best.margin,
        shear_capacity: best.shearCapacity,
        load_each: (req.load ?? 0) / count,
        shear_each: (req.shear ?? 0) / count,
        count,
        price: best.price,
        total_price: Math.round(best.price * count * 100) / 100,
        on_hand: best.onHand,
        name: best.name,
        description: best.description,
      },
      trace: {
        fn: "",
        title: `Fastener: ${best.thread.name} × ${fmt(best.length)} ${HEADS[best.head].label}${extras.length ? ` with ${extras.join(", ")}` : ""}`,
        inputs: [
          L("Clamped thickness (grip)", req.grip, "mm"),
          L(`Threads into: ${into}${req.material ? ` (${req.material})` : ""}`, req.depth ?? best.engageMax, "mm", req.depth !== undefined ? "thread depth available" : "thread depth allowed"),
          ...(loads ? [L("Tension on the joint", req.load ?? 0, "N"), L("Shear across it", req.shear ?? 0, "N"), L("Screws sharing it", count, ""), L("Safety factor", req.factor ?? 2, "")] : []),
          ...(req.space !== undefined ? [L("Room for the head", req.space, "mm")] : []),
          ...(req.headroom !== undefined ? [L("Head room above the surface", req.headroom, "mm")] : []),
        ],
        outputs: [
          L(`${best.description}${best.onHand ? " (on hand)" : ""}`, best.length, "mm long", `${best.standard}, ${best.head_dims.drive}`),
          L("Thread engaged", best.engage, "mm", `${fmt(best.engageMin)} to ${fmt(best.engageMax)} mm allowed`),
          ...(loads ? [L("Carries per screw", best.capacity, "N", best.limit === "screw" ? "the screw's proof load" : `${best.limit} limits it`), L("Needs per screw (with factor)", best.need, "N"), L("Margin", best.margin, "×")] : [L("Proof load per screw", best.capacity, "N", "no load given: size from the joint and the commonest choice")]),
          L(`Holes: clearance Ø${fmt(best.clearance)}, ${into === "insert" ? "insert" : into === "tapped" ? "tap drill" : into === "plastic" ? "pilot" : "clearance"} Ø${fmt(best.pilot)}${best.cbore ? `, counterbore Ø${fmt(best.cbore[0])} × ${fmt(best.cbore[1])}` : ""}${best.csink ? `, countersink Ø${fmt(best.csink)}` : ""}`, best.clearance, "mm"),
          L("Price per joint", best.price, "$", `${money(best.price * count)} for ${count}; typical pack prices`),
        ],
        method: [
          `${ranked.length} candidates passed and ${rejected.length} were ruled out, from every size${req.size ? "" : ` (${req.inch ? "inch" : "metric"})`}, head, grade and stocked length`,
          "Length: the shortest stocked length that puts the engagement in range: an insert's full length; a nut's height plus one thread (two past a nyloc); 1 × d in steel, 1.5 × d in aluminium, 2 × d in plastic",
          "Strength: the screw's proof load (stress area × proof stress), and the thread it goes into: insert pull-out scaled from about 600 N for an M3 in PLA, internal thread shear 0.6·π·d·engagement·0.6·UTS",
          "Ranking: what you have first, then the cheapest joint, common sizes and lengths, and the engagement nearest the ideal",
          ...others.map((c) => `Also passes: ${c.name}${c.onHand ? " (on hand)" : ""}, ${money(c.price)} a joint`),
          ...ruledOut.map((r) => `Ruled out ${r.name}: ${r.why}`),
          ...best.notes,
        ],
        assumptions: ["Typical catalogue strengths (ISO 898-1, ISO 3506) and pack prices", "Prying and fatigue are not included: keep the margin above 2 for joints that cycle", "Printed parts printed solid round the screw (4 or more perimeters)"],
        confidence: loads ? "estimate" : "standard",
        verify: loads ? "Pull-test one printed joint to failure and check it beats the need above" : undefined,
      },
    };
  },
};

const motorSelect: CalcSpec = {
  name: "motor_select",
  params: ["torque", "speed", "kind", "voltage", "current_max", "continuous", "force", "travel_per_rev", "efficiency", "mass", "accel", "vertical", "stroke", "max_size", "max_mass", "have", "prefer"],
  doc: `Choose a motor from the catalog for a duty: runs every motor of the kinds asked for against it with the motor models (DC line, stepper corner speed, servo stall, brushless Kv) and keeps the best. torque: needed at the output shaft (N·mm, write 0.5Nm); speed: rpm needed at that torque; kind: ${MOTOR_DUTY_KINDS.map((k) => `"${k}"`).join(", ")} ("any" by default: gearmotors, steppers, and brushless above 2000 rpm; servos and linear actuators only when asked for); voltage: the supply (V); current_max: what the driver or supply gives per motor (A); continuous: the largest fraction of a DC motor's stall torque it may run at (0.5). A linear axis instead: force (N), travel_per_rev (mm per motor turn: 40 for a GT2 20T pulley, 8 for a T8×8 screw), efficiency (0.9 belts, 0.4 lead screws), mass (moving, g), accel (mm/s², 3000), vertical (true when lifting), speed in mm/s. kind "actuator": force (N), speed (mm/s), stroke (mm). max_size: largest body (frame, diameter or case width, mm); max_mass: g; have: catalog ids or part numbers the user has, preferred when they pass; prefer: "cheap", "small" or "strong". Returns id (pass it to lib.part(m.id) or lib.<kind>(m.id)), kind, name, torque_available, speed_available, torque_needed, margin, current, voltage, price, mass, on_hand.`,
  impl(a) {
    const kind = a.str("kind", "any");
    if (!(MOTOR_DUTY_KINDS as readonly string[]).includes(kind)) return a.ctx.error(`calc.motor_select(): kind: should be ${MOTOR_DUTY_KINDS.map((k) => `"${k}"`).join(", ")}`);
    const prefer = a.str("prefer", "cheap");
    if (prefer !== "cheap" && prefer !== "small" && prefer !== "strong") return a.ctx.error('calc.motor_select(): prefer: should be "cheap", "small" or "strong"');
    const linear = a.has("travel_per_rev");
    const tpr = linear ? a.positive("travel_per_rev") : 0;
    const eff = a.num("efficiency", 0.9);
    const massKg = a.num("mass", 0) / 1000;
    const accel = a.num("accel", massKg > 0 ? 3000 : 0) / 1000;
    const force = a.num("force", 0) + massKg * accel + (a.bool("vertical") ? massKg * 9.81 : 0);
    const torque = linear ? (force * tpr) / (2 * Math.PI * eff) : a.num("torque", 0);
    const speed = linear ? (a.num("speed", 0) / tpr) * 60 : a.num("speed", 0);
    const duty: MotorDuty = {
      torque,
      speed: kind === "actuator" ? a.num("speed", 0) : speed,
      force,
      stroke: a.has("stroke") ? a.positive("stroke") : undefined,
      kind: kind as MotorDuty["kind"],
      voltage: a.has("voltage") ? a.positive("voltage") : undefined,
      currentMax: a.has("current_max") ? a.positive("current_max") : undefined,
      continuous: a.num("continuous", 0.5),
      maxSize: a.has("max_size") ? a.positive("max_size") : undefined,
      maxMass: a.has("max_mass") ? a.positive("max_mass") : undefined,
      have: textList(a.value("have")),
      prefer,
    };
    if (kind === "actuator" ? !(force > 0) : !(torque > 0)) return a.ctx.error(kind === "actuator" ? "calc.motor_select(): force: the push or pull needed, more than 0 N" : "calc.motor_select(): torque: the torque needed at the output, more than 0 (write 0.5Nm), or force with travel_per_rev for a linear axis");
    const act = kind === "actuator";
    const { ranked, rejected } = chooseMotor(duty);
    const best = ranked[0];
    if (!best) {
      const why = [...new Map(rejected.map((r) => [r.why.replace(/[\d.]+/g, "#"), r])).values()].slice(0, 5).map((r) => `${r.id}: ${r.why}`);
      return a.ctx.error(`calc.motor_select(): no motor in the catalog meets this duty. ${why.join("; ")}${rejected.length > 5 ? "; …" : ""}. Add gearing (a belt or gear stage), allow a bigger motor or another kind, or search the web for one and add it as a buy item.`);
    }
    return {
      fields: {
        id: best.part.id,
        kind: best.part.kind,
        name: best.part.name,
        torque_available: best.torque,
        speed_available: best.speed,
        torque_needed: duty.torque,
        margin: best.margin,
        current: best.current,
        voltage: best.voltage,
        price: best.part.price_usd ?? 0,
        mass: typeof best.part.specs.mass_g === "number" ? best.part.specs.mass_g : 0,
        on_hand: best.onHand,
      },
      trace: {
        fn: "",
        title: `Motor: ${best.part.name}`,
        inputs: [
          ...(act ? [L("Force needed", force, "N"), L("Speed needed", duty.speed, "mm/s")] : [L("Torque needed at the output", duty.torque / 1000, "N·m", linear ? `${sig3(force)} N through ${tpr} mm a turn at ${Math.round(eff * 100)} %` : undefined), L("Speed needed", duty.speed, "rpm")]), ...(duty.voltage ? [L("Supply", duty.voltage, "V")] : []), ...(duty.currentMax ? [L("Current available per motor", duty.currentMax, "A")] : [])],
        outputs: [
          L(`${best.part.name}${best.onHand ? " (on hand)" : ""}`, best.part.price_usd ?? 0, "$", best.part.id),
          act ? L("Force it gives", best.torque, "N", best.basis) : L("Torque it gives at that speed", best.torque / 1000, "N·m", best.basis),
          L(act ? "Speed it gives at that force" : "Speed it gives at that torque", best.speed, act ? "mm/s" : "rpm"),
          L("Margin", best.margin, "×"),
          L("Current", best.current, "A"),
        ],
        method: [
          `${ranked.length} motors passed and ${rejected.length} were ruled out`,
          "DC gearmotors: linear torque–speed line from the maker's stall torque and free speed (scaled to the supply), loaded to no more than the continuous fraction of stall",
          "Steppers: about 85 % of holding torque at the driver current up to the corner speed V/(2·L·I), falling as 1/speed above it",
          "Servos: stall torque with a 2 × margin, and the speed from its 60° time",
          "Brushless: torque from Kv (Kt = 9549 / Kv N·mm per A) at 80 % of the current limit, speed from Kv × volts",
          "Linear actuators: the maker's force with a 1.25 × margin, speed falling from the free speed toward stall",
          ...(linear ? [`Linear axis: torque = force × travel per turn / (2π × efficiency); force = ${a.has("force") ? "force + " : ""}mass × acceleration${a.bool("vertical") ? " + weight" : ""}`] : []),
          "Ranking: what you have first, then " + (prefer === "small" ? "the smallest and lightest" : prefer === "strong" ? "the largest margin" : "the cheapest") + " that passes, then the margin nearest 2 ×",
          ...ranked.slice(1, 5).map((c) => `Also passes: ${c.part.name} (${c.part.id}), ${fmt(c.margin)} × margin${c.part.price_usd ? `, about $${c.part.price_usd}` : ""}${c.onHand ? ", on hand" : ""}`),
          ...[...new Map(rejected.map((r) => [r.why.replace(/[\d.]+/g, "#"), r])).values()].slice(0, 5).map((r) => `Ruled out ${r.id}: ${r.why}`),
        ],
        assumptions: ["Catalog torque and speed figures at room temperature; a hot motor gives less", "Gearbox losses are inside the maker's figures", "Inertia and acceleration torque are not included unless you add them to torque"],
        confidence: "estimate",
        verify: "Run the motor at the real load and measure current and speed against the figures above",
      },
    };
  },
};

export const HARDWARE_CALCS: CalcSpec[] = [fastener, motorSelect];
