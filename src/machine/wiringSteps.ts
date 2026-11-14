// The wiring as steps a builder follows: what plugs into where. A lead or a
// bought cable that comes with its plugs on is one step (a servo's lead onto a
// channel of the servo board, a STEMMA QT cable between two sockets), with the
// colour of every wire and the contact it goes on wherever the plug could go
// on wrong or the ends are loose. The wires left over are the ones to cut,
// and for those the steps say what goes on each end. Everything comes from
// the wire list's rows, the catalog's connectors and leads, and the same plug
// kinds the 3D wiring draws, so the guide, the list and the picture agree.

import { catalogPart } from "./catalog";
import { plugFor, type PlugKind } from "./harness/plugs";
import type { CatalogPart, ConnDef, MachineData } from "./types";
import type { WireEnd, WireRow } from "./wiring";

export interface StepContact {
  /** the wire list's id for it */
  wire: string;
  color: string;
  /** where the wire goes, as the names read on the parts: "GND", "hub's SCL" */
  to: string;
  /** where it comes from, when that is not the step's own plug (a loose wire of a cable between two terminals) */
  from?: string;
}

export interface WiringStep {
  /** what to pick up: "servo_1's lead (3-way servo plug)", "STEMMA QT cable, 50 mm" */
  what: string;
  /** where it goes: "hub's channel 0", "feather's STEMMA QT socket and imu's left STEMMA QT socket" */
  where: string;
  /** the wire list rows it covers */
  wires: string[];
  /** one line per wire, where the plug does not make it obvious */
  contacts: StepContact[];
  /** how it goes together, and what to watch for */
  notes: string[];
  /** the lead's or cable's length, and the run it has to cover along its 3D route when the cables have been routed, mm */
  fixedMm?: number;
  runMm?: number;
  /** it connects a battery or a supply: the last thing to plug in, after everything else is checked */
  power?: boolean;
}

export interface WiringSteps {
  /** leads and cables that plug in or clamp in as they come */
  steps: WiringStep[];
  /** the rows no step covers: wires to cut from a reel */
  cut: WireRow[];
  /** what goes on each end of a wire to cut, by wire id: [at its from end, at its to end]; "" where nothing is known */
  fits: Map<string, [string, string]>;
}

/** Plugs that only go in one way round: their wires need no telling apart. */
const KEYED = new Set<PlugKind>(["sh", "xt60", "usb_c", "usb_micro", "usb_a", "xh", "ph", "barrel"]);

/** What a cut wire needs on its end for each kind of terminal. */
const FIT: Record<PlugKind, string> = {
  xh: "JST XH crimp in its housing",
  ph: "JST PH crimp in its housing",
  dupont: "Dupont socket",
  ferrule: "bootlace ferrule",
  fork: "fork crimp",
  ring: "ring crimp",
  usb_c: "USB-C plug",
  usb_micro: "micro-USB plug",
  usb_a: "USB-A plug",
  xt60: "XT60, soldered",
  lead: "joined to the part's own lead",
  solder: "soldered to the pad",
  lug: "soldered to the lug, under heat-shrink",
  barrel: "DC barrel plug",
  spade: "6.3 mm insulated spade crimp",
  sh: "STEMMA QT plug",
  lever: "stripped end in the lever",
  bare: "stripped end under the screw",
};

/** Copper area of an AWG size, mm². */
export const awgArea = (awg: number) => 0.012668 * 92 ** ((36 - awg) / 19.5);

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

interface Side {
  e: WireEnd;
  part?: CatalogPart;
  conn?: ConnDef;
  /** the end is the part's own lead */
  own: boolean;
  kind?: PlugKind;
  /** the name on the part, without the connector's name in front */
  label: string;
  /** groups ends in the same connector of the same part (or loose on the same part) */
  anchor: string;
}

/**
 * The wiring steps for a wire list: `rows` as wireList gives them (with the routed runs, when the cables have been
 * routed, so each step can say whether its lead reaches).
 */
export function wiringSteps(m: MachineData, rows: WireRow[]): WiringSteps {
  const comps = new Map(m.components.map((c) => [c.name, c]));
  const base = (comp: string) => comp.replace(/\[\d+\]$/, "");
  const partOf = (e: WireEnd) => {
    const c = comps.get(base(e.comp));
    return c ? catalogPart(c.catalogId) : undefined;
  };
  const side = (r: WireRow, s: "from" | "to"): Side => {
    const e = r[s];
    const other = r[s === "from" ? "to" : "from"];
    const part = partOf(e);
    const conn = e.conn ? part?.conns?.find((c) => c.id === e.conn) : undefined;
    const soldered = comps.get(base(e.comp))?.leads === "soldered" && !e.conn;
    const kind = soldered ? "solder" : part ? plugFor(part, e.pin, partOf(other), e.spot)?.kind : undefined;
    const prefix = conn ? `${conn.name}: ` : "";
    const label = prefix && e.label.startsWith(prefix) ? e.label.slice(prefix.length) : e.label;
    return { e, part, conn, own: !!r.own?.includes(s), kind, label, anchor: `${e.comp}|${e.conn ?? ""}` };
  };
  const sides = new Map(rows.map((r) => [r.id, [side(r, "from"), side(r, "to")] as [Side, Side]]));
  const byId = new Map(rows.map((r) => [r.id, r]));

  // ---- which rows are one lead or cable ----
  const leadRows = rows.filter((r) => r.lead);
  const group = new Map<string, WireRow[]>();
  const cables: { name: string; anchors: Set<string>; rows: WireRow[] }[] = [];
  for (const r of leadRows) {
    const [a, b] = sides.get(r.id)!;
    if (r.bought && !r.own?.length) {
      // conductors of one bought cable: the same name, meeting at a connector or loose on the same part
      const mine = cables.filter((c) => c.name === r.bought && (c.anchors.has(a.anchor) || c.anchors.has(b.anchor)));
      const into = mine[0] ?? { name: r.bought, anchors: new Set<string>(), rows: [] };
      if (!mine.length) cables.push(into);
      for (const c of mine.slice(1)) {
        c.rows.forEach((x) => into.rows.push(x));
        c.anchors.forEach((x) => into.anchors.add(x));
        cables.splice(cables.indexOf(c), 1);
      }
      into.rows.push(r);
      into.anchors.add(a.anchor).add(b.anchor);
      continue;
    }
    // a part's own lead: one step for each place it goes to
    const [first, second] = a.own ? [a, b] : [b, a];
    const key = `${first.anchor}>${second.anchor}`;
    group.set(key, [...(group.get(key) ?? []), r]);
  }

  /** a whole connector by its name; one contact of it, or a bare pin, by the name printed there */
  const name = (s: Side, whole = true) => `${s.e.comp}'s ${s.conn ? (whole ? s.conn.name : `${s.conn.name}, ${s.label}`) : s.label}`;
  const stripNote = (s: Side, r: WireRow, tinned: boolean): string | undefined => {
    if (s.kind === "lever") {
      const strip = num(s.part?.specs.strip_mm) ?? 11;
      const min = num(s.part?.specs.wire_mm2_min);
      const thin = min !== undefined && r.gauge !== undefined && awgArea(r.gauge) < min;
      return thin
        ? `This ${r.gauge} AWG wire is thinner than the lever connector ${s.e.comp} is made for: strip ${2 * strip} mm and fold the bare end back on itself, then lift the lever, push the end in to the back and close the lever. Pull on the wire to check it holds.`
        : `Strip ${strip} mm, lift ${s.e.comp}'s lever, push the bare end in until it shows at the back of the clear case, and close the lever. Pull on the wire to check it holds.`;
    }
    if (s.kind === "bare" && !s.conn?.how) return tinned ? `Loosen the screw of ${s.e.comp}'s ${s.label} terminal, push the tinned end in under the clamp and tighten.` : `Strip 6 mm, twist the strands, push the end under the clamp of ${s.e.comp}'s ${s.label} terminal and tighten the screw.`;
    return undefined;
  };
  const reach = (rs: WireRow[]): Pick<WiringStep, "fixedMm" | "runMm"> => {
    const fixed = rs.map((r) => r.fixedMm).find((x) => x !== undefined);
    const runs = rs.map((r) => r.runMm).filter((x): x is number => x !== undefined);
    return { fixedMm: fixed, runMm: runs.length ? Math.max(...runs) : undefined };
  };

  const steps: (WiringStep & { order: number })[] = [];
  const order = (rs: WireRow[]) => Math.min(...rs.map((r) => rows.indexOf(r)));
  const supply = (rs: WireRow[]) => rs.some((r) => sides.get(r.id)!.some((x) => x.part?.kind === "battery" || x.part?.kind === "psu")) || undefined;

  // ---- a part's own lead ----
  for (const rs of group.values()) {
    const pairs = rs.map((r) => {
      const [a, b] = sides.get(r.id)!;
      return a.own ? { r, lead: a, far: b } : { r, lead: b, far: a };
    });
    const { lead, far } = pairs[0];
    const def = lead.conn?.lead;
    const bare = !!def && /bare|tinned/.test(def.end);
    const one = pairs.length === 1 && (lead.conn?.pins.length ?? 1) > 1;
    const what = `${lead.e.comp}'s ${lead.conn?.name ?? "lead"}${one ? `, the ${pairs[0].r.color} wire` : ""}${def && !bare ? ` (${def.end})` : ""}`;
    const farOwn = far.own ? far.conn?.lead : undefined;
    const where = far.conn ? `${far.e.comp}'s ${far.conn.name}${farOwn && !/bare|tinned/.test(farOwn.end) ? ` (${farOwn.end})` : ""}` : pairs.length === 1 ? name(far, false) : far.e.comp;
    const keyed = !!far.conn?.keyed || (!!far.kind && KEYED.has(far.kind));
    // lead into lead (bullets, a battery plug): the plugs say what goes where unless the wires differ
    const contacts: StepContact[] = keyed || far.own || (pairs.length === 1 && !far.conn) ? [] : pairs.map((p) => ({ wire: p.r.id, color: p.r.color, to: p.far.label }));
    const notes: string[] = [];
    for (const how of new Set([lead.conn?.how, far.conn?.how])) if (how) notes.push(how);
    for (const p of pairs.slice(0, far.conn?.how ? 0 : 1)) {
      const n = stripNote(p.far, p.r, !!def && /tinned/.test(def.end));
      if (n) notes.push(n);
    }
    if (far.own && farOwn && def && bare && /bare|tinned/.test(farOwn.end)) notes.push("Both ends are bare: join them in a lever connector, or solder them and cover the joint with heat-shrink.");
    if (rs[0].bought) notes.push(`It goes on through the ${rs[0].bought}.`);
    const len = reach(rs);
    if (bare && len.fixedMm !== undefined && len.runMm !== undefined && len.fixedMm - len.runMm >= 40) notes.push(`The lead is ${len.fixedMm} mm long and this run needs about ${len.runMm} mm: tuck the spare away, or cut it back to about ${Math.ceil((len.runMm + 30) / 10) * 10} mm before stripping it.`);
    steps.push({ what, where, wires: rs.map((r) => r.id), contacts, notes, ...len, power: supply(rs), order: order(rs) });
  }

  // ---- a bought cable ----
  for (const c of cables) {
    const all = c.rows.map((r) => ({ r, s: sides.get(r.id)! }));
    // the connectors it plugs into whole, and the ends that are loose wires
    const count = new Map<string, number>();
    for (const { s } of all) for (const x of s) if (x.conn) count.set(x.anchor, (count.get(x.anchor) ?? 0) + 1);
    const whole = (x: Side) => !!x.conn && (!!x.conn.keyed || (!!x.kind && KEYED.has(x.kind))) && (count.get(x.anchor) ?? 0) > 1;
    const sockets = new Map<string, Side>();
    for (const { s } of all) for (const x of s) if (whole(x)) sockets.set(x.anchor, x);
    const contacts: StepContact[] = [];
    const notes: string[] = [];
    for (const how of new Set([...sockets.values()].map((x) => x.conn!.how))) if (how) notes.push(how);
    const told = new Set<string>();
    for (const { r, s } of all) {
      const loose = s.filter((x) => !whole(x));
      if (!loose.length) continue;
      if (loose.length === 1) contacts.push({ wire: r.id, color: r.color, to: name(loose[0], false) });
      else contacts.push({ wire: r.id, color: r.color, from: name(loose[0], false), to: name(loose[1], false) });
      for (const x of loose) {
        const n = x.conn?.how ?? stripNote(x, r, false);
        if (n && !told.has(n)) notes.push(n);
        if (n) told.add(n);
      }
    }
    const where = sockets.size ? list([...sockets.values()].map((x) => name(x))) : list([...new Set(all.flatMap(({ s }) => s.map((x) => x.e.comp)))]);
    steps.push({ what: c.name, where, wires: c.rows.map((r) => r.id), contacts, notes, ...reach(c.rows), power: supply(c.rows), order: order(c.rows) });
  }
  // the thin leads and cables first, in the wire list's order, then the heavy ones, and the battery's and supply's own plugs last
  const heavy = (st: WiringStep) => Number(st.wires.some((id) => (byId.get(id)?.gauge ?? 99) < 20));
  steps.sort((a, b) => Number(!!a.power) - Number(!!b.power) || heavy(a) - heavy(b) || a.order - b.order);

  // ---- wires to cut ----
  const cut = rows.filter((r) => !r.lead);
  const fits = new Map<string, [string, string]>();
  for (const r of cut) {
    const [a, b] = sides.get(r.id)!;
    fits.set(r.id, [a.kind ? FIT[a.kind] : "", b.kind ? FIT[b.kind] : ""]);
  }
  return { steps: steps.map(({ order: _o, ...s }) => s), cut, fits };
}

/** A step as one line of a checklist, with its wires underneath where they need telling apart. */
export function stepLines(s: WiringStep): string[] {
  const out = [`- [ ] **${s.what} → ${s.where}** (${s.wires.join(", ")}).${s.notes.length ? " " + s.notes.join(" ") : ""}`];
  for (const c of s.contacts) out.push(`  - ${c.color}${c.from ? `, from ${c.from}` : ""} → ${c.to} (${c.wire})`);
  if (s.fixedMm !== undefined && s.runMm !== undefined && s.fixedMm < s.runMm) out.push(`  - It is ${s.fixedMm} mm long and this run needs about ${s.runMm} mm: it does not reach. Move the parts closer or add an extension lead.`);
  return out;
}
