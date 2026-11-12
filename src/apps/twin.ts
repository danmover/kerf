// The simulated twin an app talks to: the design's own firmware running on
// the virtual chip, wired to the plant built from its netlist, in a
// scenario's world (the bench, the tunnel, the sand pit), stepped in real
// time for as long as the app is open. It prints to its serial console and
// takes typed commands exactly as the real machine does over USB, so an app
// built against the twin works on the real machine unchanged.
//
// This is the scenario runner (sim/engine/run.ts) turned inside out: the same
// pieces, set up the same way, but driven a slice at a time by whoever holds
// it instead of running to a fixed end. Browser-free, so it runs in a worker,
// in a saved app page and in the tests. It takes the firmware's files ready
// made (twinFirmware.ts makes them from the design), so a saved app carries
// the firmware and not the generators.

import type { MachineData } from "../machine/types";
import { boardForPart, CError, Halt, loadFirmware } from "../sim/mcu";
import { Plant } from "../sim/engine/plant";
import { SimHal } from "../sim/engine/hal";
import { applyConfig } from "../sim/engine/run";
import { worldFor } from "../sim/build";
import type { ScenarioSpec } from "../sim/scenario";
import { rngFrom, VARIANTS, type VariantName } from "../sim/worlds/common";
import type { SceneSpec, World, WorldEvent } from "../sim/worlds/types";

export interface TwinOptions {
  /** the scenario whose world the twin runs (its mechanism resolved against the built parts) */
  spec: ScenarioSpec;
  machine: MachineData;
  designName: string;
  /** firmware block; the scenario's, or the first one */
  firmware?: string;
  variant?: VariantName;
  seed?: number;
  /** the firmware's files (twinFirmware() makes them from the design) and the board they run on */
  files: Record<string, string>;
  board: { mcu: string; partId?: string };
}

export interface TwinInfo {
  firmware: string;
  board: string;
  boardName: string;
  /** what the twin leaves out, for the app's footer */
  limits: string[];
  assumptions: string[];
  scene: SceneSpec;
}

const SCALAR = new Set(["int", "float", "bool", "enum"]);

export class LiveTwin {
  readonly hal: SimHal;
  readonly plant: Plant;
  readonly world: World & { assumptions?: string[] };
  readonly info: TwinInfo;
  /** why it stopped running (a crash, a brown-out); undefined while it runs */
  stopped?: string;
  /** a firmware that does not compile, or a world that cannot be built */
  error?: string;
  private fw: ReturnType<typeof loadFirmware> | null = null;
  private watch: string[] = [];
  private lineBuf: { t: number; text: string }[] = [];
  private eventsSeen = 0;
  private plantEventsSeen = 0;
  private faultsSeen = 0;

  constructor(o: TwinOptions) {
    const variant = o.variant ?? "expected";
    const seed = (o.seed ?? o.spec.seed ?? 1) + VARIANTS.indexOf(variant) * 7919;
    const files = { ...o.files };
    const mcuName = o.board.mcu;
    const partId = o.board.partId;
    const fwName = o.firmware ?? o.spec.firmware ?? "";
    const changed = applyConfig(files, o.spec.config ?? {});
    if (typeof changed === "string") throw new Error(changed);
    const board = boardForPart(partId);
    this.hal = new SimHal(board, { seed });
    this.world = worldFor(o.spec, o.machine)(variant, seed);
    this.plant = new Plant(o.machine, mcuName, board, this.hal, this.world, { soc: o.spec.charge ?? 1, rng: rngFrom(seed * 31 + 7) });
    this.hal.onLine = (text) => this.lineBuf.push({ t: this.hal.time, text });
    this.info = {
      firmware: fwName,
      board: mcuName,
      boardName: board.name,
      limits: [...this.world.limits, "The firmware runs as compiled C++ on a cycle-counted virtual chip, not as the real machine code: timing is close but not exact."],
      assumptions: [...this.plant.assumptions, ...(this.world.assumptions ?? [])],
      scene: this.world.scene(),
    };
    this.hal.endCyc = Infinity;
    try {
      this.fw = loadFirmware(files, board, this.hal);
      this.hal.bindVectors(this.fw.fw);
      this.watch = [...(this.fw.fw.globals as Map<string, { t: { k: string } }>)].filter(([, g]) => SCALAR.has(g.t.k)).map(([n]) => n);
      this.fw.fw.reset();
      this.guard(0);
      this.fw.fw.call("setup");
    } catch (e) {
      this.fail(e);
    }
  }

  /** simulated seconds since power-up */
  get time() {
    return this.hal.time;
  }

  /** a loop() pass that runs this long past where it was asked to stop has hung */
  private guard(until: number) {
    this.hal.endCyc = Math.round((until + 30) * this.hal.fcpu);
  }

  private fail(e: unknown) {
    if (e instanceof Halt) this.stopped = e.reason === "end" ? "the firmware stayed inside one pass of loop() for 30 simulated seconds" : e.reason;
    else if (e instanceof CError) {
      this.error = `${e.file}:${e.line}: ${e.message}`;
      this.stopped = "the firmware does not compile";
    } else {
      this.error = e instanceof Error ? e.message : String(e);
      this.stopped = "the simulation failed";
    }
    this.hal.finishSerial();
  }

  /**
   * Run whole passes of loop() until simulated time reaches `until` (s) or
   * `budgetMs` of wall-clock time is used. Returns the simulated time reached.
   */
  runTo(until: number, budgetMs = 20): number {
    if (this.stopped || !this.fw) return this.time;
    const hal = this.hal;
    const fw = this.fw.fw;
    const end = performance.now() + budgetMs;
    this.guard(until);
    try {
      let k = 0;
      while (hal.time < until) {
        const c0 = hal.cyc;
        fw.call("loop");
        const used = hal.cyc - c0;
        if (used < hal.stepCycles) hal.spend(hal.stepCycles - used);
        else if (hal.cyc >= hal.nextEvt) hal.service();
        // the clock is read every few passes: it costs more than a pass of a small loop()
        if ((++k & 15) === 0 && performance.now() > end) break;
      }
    } catch (e) {
      this.fail(e);
    }
    // the log is only for the scenario runner; the app reads lines as they come
    if (hal.serial.length > 2000) hal.serial.splice(0, hal.serial.length - 200);
    return this.time;
  }

  /** Type a line into the serial console, as the app's console or a button does. */
  type(text: string) {
    if (this.stopped) return;
    this.hal.typeAt(this.hal.time, text.endsWith("\n") ? text : `${text}\n`);
  }

  /** Every number the simulation records: motors, supplies, sensors, the world, the firmware's own variables. */
  channels(): Record<string, number> {
    const row: Record<string, number> = {};
    this.plant.channels(row);
    Object.assign(row, this.world.channels());
    if (this.fw)
      for (const g of this.watch) {
        const v = this.fw.fw.read(g);
        if (typeof v === "number") row[`fw.${g}`] = v;
      }
    return row;
  }

  /** Lines printed since the last call. */
  takeLines(): { t: number; text: string }[] {
    const out = this.lineBuf;
    this.lineBuf = [];
    return out;
  }

  /** World, plant and firmware-mistake events since the last call. */
  takeEvents(): WorldEvent[] {
    const out: WorldEvent[] = [];
    const we = this.world.events;
    for (; this.eventsSeen < we.length; this.eventsSeen++) out.push(we[this.eventsSeen]);
    const pe = this.plant.events;
    for (; this.plantEventsSeen < pe.length; this.plantEventsSeen++) out.push(pe[this.plantEventsSeen]);
    const fs = this.hal.faults;
    for (; this.faultsSeen < fs.length; this.faultsSeen++) out.push({ t: fs[this.faultsSeen].t, kind: "warn", text: `Firmware mistake: ${fs[this.faultsSeen].msg}` });
    return out;
  }
}
