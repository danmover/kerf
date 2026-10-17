import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { evaluate } from "../src/lang/evaluator";
import { buildPack } from "../src/machine/pack";
import { lifeText, schedule, serviceItems, serviceMd, servicePlan } from "../src/machine/service";

const demo = (name: string) => readFileSync(new URL(`../src/demos/${name}.kerf`, import.meta.url), "utf8");
const TUNNELLER = evaluate(demo("sand-tunneller"));
const PRINTER = evaluate(demo("printer"));

describe("wear and service life", () => {
  it("lists what wears on the tunneller, shortest life first, counted in runs of its job", () => {
    const plan = servicePlan(TUNNELLER);
    expect(plan.dirty).toBe(true);
    expect(plan.use).toMatchObject({ label: "Cross the pit", measured: false });
    expect(plan.use!.hours).toBeCloseTo(TUNNELLER.scenarios![0].spec.duration! / 3600);
    const names = plan.items.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["bat", "seal_f", "seal_r", "front_screw", "rear_screw", "m_front", "m_rear", "steer", "thrust_life"]));
    const lives = plan.items.flatMap((x) => (x.life === undefined ? [] : [x.life]));
    expect(lives).toEqual([...lives].sort((a, b) => a - b));
    // in sand the seals, not the bearing's L10, decide when the bearing goes
    const bearing = plan.items.find((x) => x.name === "thrust_life")!;
    expect(bearing).toMatchObject({ label: "Bearing 6810", life: 500, confidence: "rough" });
    // each screw is matched to the motor that turns it
    expect(plan.items.find((x) => x.name === "rear_screw")!.basis).toMatch(/turned by m_rear/);
    expect(plan.items.find((x) => x.name === "front_screw")!.basis).toMatch(/turned by m_front/);
  });

  it("uses what the simulation measured for the battery once the job has run", () => {
    const design = servicePlan(TUNNELLER).items.find((x) => x.name === "bat")!;
    const sim = servicePlan(TUNNELLER, { label: "Cross the pit", time: 840, batteryUsed: 440 }).items.find((x) => x.name === "bat")!;
    expect(design.basis).toMatch(/design's full working current/);
    expect(sim.basis).toMatch(/used 20 % in simulation/);
    expect(sim.cycles!).toBeGreaterThan(design.cycles!);
  });

  it("schedules the upkeep by interval, with the jobs before every run first", () => {
    const plan = servicePlan(TUNNELLER);
    const jobs = schedule(plan);
    expect(jobs[0].every).toBe(0);
    expect(jobs.map((j) => j.every)).toEqual([...jobs.map((j) => j.every)].sort((a, b) => a - b));
    expect(jobs.flatMap((j) => j.tasks)).toEqual(expect.arrayContaining([expect.stringMatching(/^front_screw: measure the flight diameter; reprint it once it is 86 mm/), expect.stringMatching(/^seal_f: wipe the lip clean and re-grease it/)]));
    const md = serviceMd(plan, "Sand Tunneller");
    expect(md).toMatch(/^# Service and wear: Sand Tunneller/);
    expect(md).toMatch(/\| bat \| cells \(capacity fades\) \| about \d+ h \(\d+ runs\), \d+ charges \|/);
    expect(md).toMatch(/### Before every run/);
    expect(md).toMatch(/### Every 5 h of running \(about \d+ runs\)/);
  });

  it("reports a summary, and warns or fails only for parts that wear out within a few runs", () => {
    const now = serviceItems(servicePlan(TUNNELLER));
    expect(now.map((i) => i.status)).toEqual(["info"]);
    expect(now[0].title).toMatch(/^Service life: bat wears first/);
    // twelve-hour jobs: the seals' 200 h is under 20 runs
    const long = serviceItems(servicePlan(TUNNELLER, { label: "Cross the pit", time: 12 * 3600, batteryUsed: 440 }));
    expect(long.filter((i) => i.status === "warn").map((i) => i.id).sort()).toEqual(["wear:seal_f", "wear:seal_r"]);
    const silly = serviceItems(servicePlan(TUNNELLER, { label: "Cross the pit", time: 300 * 3600, batteryUsed: 440 }));
    expect(silly.find((i) => i.id === "wear:seal_f")).toMatchObject({ status: "fail", title: "seal_f wears out within one run" });
  });

  it("lists the printer's nozzle and fans, with the hotend fan checked before every print", () => {
    const plan = servicePlan(PRINTER);
    expect(plan.dirty).toBe(false);
    expect(plan.items[0]).toMatchObject({ name: "hotend", life: 500 });
    expect(lifeText(plan, plan.items[0])).toBe(plan.use ? expect.stringMatching(/runs/) : "about 500 h");
    expect(schedule(plan)[0].tasks).toContain("hotend_fan: check it spins: if the hotend fan stops, the hotend jams");
  });

  it("puts service.md in the build pack and lists it in the README", () => {
    const files = buildPack(TUNNELLER, null, { date: new Date(2026, 9, 17) });
    const md = files.find((f) => f.path === "service.md");
    expect(md && String(md.data)).toMatch(/Maintenance schedule/);
    expect(String(files.find((f) => f.path === "README.md")!.data)).toMatch(/`service\.md` \| What wears out and when/);
  });
});
