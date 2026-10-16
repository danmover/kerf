// Assistant tools for simulations: run the design's scenarios and read what
// happened in them (expectations, key numbers, events, the serial console
// and any recorded series). Each run shows in the live plan as a branch with
// one step per variant, so the user sees the virtual test while it runs.

import { z } from "zod";
import { useDesign, whenChecked } from "../core/engine";
import { openBranch } from "./plan";
import { estimateNote, outcomesFor, pick, runScenarioNow, useSim, whenSimulated, type SimRun } from "../sim/runtime";
import type { ScenarioDef } from "../sim/scenario";
import type { VariantRun } from "../sim/engine/run";
import { VARIANTS, VARIANT_LABEL, type VariantName } from "../sim/worlds/common";
import { fmtResult, resultInfo } from "../sim/results";
import { channelInfo } from "../sim/channels";
import { matchSeries, valueAt } from "../sim/frames";
import { fmtNum } from "../lang/values";
import type { ToolOutcome } from "./tools";

export const SIM_TOOL_DEFS = [
  {
    name: "run_scenario",
    description:
      "Run the design's scenario blocks (virtual tests: the generated firmware on a virtual controller, wired to simulated motors, drivers, sensors and battery, inside a world such as a sand pit) and return each expectation's verdict across the pessimistic, expected and optimistic runs, the key results, what happened (events, the firmware's last state) and the simulation's limits. Add or change a scenario with edit_design first. Runs take about 10 s of computer time per variant.",
    input_schema: {
      type: "object" as const,
      properties: {
        label: { type: "string", description: "Run only the scenario with this label; default all." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "scenario_results",
    description:
      "Details of one scenario's latest run: every result, the events, the serial console, or recorded series (motor rpm/amps/temp/turns, actuator pos, battery volts/soc, world channels such as pit.progress, pit.offset, pit.heading, pit.hinge, pit.resist, pit.thrust, the firmware's own variables as fw.<name>) sampled over time. Use it to find out why an expectation failed.",
    input_schema: {
      type: "object" as const,
      properties: {
        label: { type: "string", description: "Scenario label." },
        variant: { type: "string", enum: [...VARIANTS], description: "Which run (default expected)." },
        show: { type: "string", enum: ["results", "events", "console", "series"], description: "What to return (default results)." },
        series: { type: "array", items: { type: "string" }, maxItems: 8, description: 'For show: series. Names or patterns like "*.amps" (default the world\'s main series).' },
        from: { type: "number", description: "Start time, s (series and console)." },
        to: { type: "number", description: "End time, s (series and console)." },
      },
      required: ["label"],
      additionalProperties: false,
    },
  },
];

export const SIM_TOOL_TITLES: Record<string, string> = { run_scenario: "Running the simulation", scenario_results: "Reading the simulation" };

const RunInput = z.object({ label: z.string().max(200).optional() });
const ResultsInput = z.object({
  label: z.string().min(1).max(200),
  variant: z.enum(VARIANTS as [VariantName, ...VariantName[]]).optional(),
  show: z.enum(["results", "events", "console", "series"]).optional(),
  series: z.array(z.string().max(80)).max(8).optional(),
  from: z.number().min(0).optional(),
  to: z.number().min(0).optional(),
});

function invalid(e: z.ZodError): ToolOutcome {
  const msg = e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
  return { isError: true, content: `Invalid tool input: ${msg}`, card: { title: "Invalid tool input", detail: msg, status: "error" } };
}

const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/** Key results of a run, with units. */
function resultLines(world: string, v: VariantRun, limit = 40): string[] {
  return Object.entries(v.results)
    .filter(([k]) => !k.startsWith("fw."))
    .slice(0, limit)
    .map(([k, x]) => `${k} = ${fmtResult(x, resultInfo(k, world)?.unit)}`);
}

export function scenarioSummary(def: ScenarioDef, run: SimRun | undefined): string {
  const lines = [`Scenario "${def.label}" (${def.spec.world.kind}${def.uses.length ? `, for ${def.uses.join(", ")}` : ""}):`];
  if (!run) return [...lines, "  Not run yet."].join("\n");
  if (run.status === "error") return [...lines, `  The simulation failed: ${run.error}`].join("\n");
  if (run.status === "idle") return [...lines, "  Changed since its last run and not re-run (automatic runs are off)."].join("\n");
  const r = run.result;
  if (!r) return [...lines, "  Still running."].join("\n");
  if (r.error) return [...lines, `  Cannot run: ${r.error}`].join("\n");
  const outs = outcomesFor(def, r) ?? [];
  for (const o of outs) {
    lines.push(`  [${o.status}] ${o.label}${o.level === "soft" ? " (soft)" : ""}: ${o.detail}${o.estimate ? ` ${estimateNote(o, useDesign.getState().model?.machine?.tests)}` : ""}`);
    const per = o.variants.map((v) => `${v.variant} ${v.ok === null ? "error" : v.ok ? "pass" : "fail"}`).join(", ");
    if (o.variants.length > 1) lines.push(`      runs: ${per}`);
  }
  if (r.firmware.config.length) lines.push(`  Firmware changed for this run: ${r.firmware.config.map((c) => `${c.name} ${c.from} → ${c.to}`).join(", ")}`);
  const main = pick(r.variants);
  if (main) {
    lines.push(`  ${VARIANT_LABEL[main.variant]} run: ended at ${mmss(main.summary.time)} (${main.stop})${main.summary.state ? `, firmware state "${main.summary.state}"` : ""}${main.error ? `; error: ${main.error}` : ""}.`);
    lines.push(`  Results: ${resultLines(def.spec.world.kind, main, 30).join("; ")}`);
    const ev = main.events.filter((e) => e.kind !== "info" || /Firmware/.test(e.text)).slice(0, 14);
    if (ev.length) lines.push(`  Events: ${ev.map((e) => `${mmss(e.t)} ${e.text}`).join("; ")}`);
    if (main.faults.length) lines.push(`  Firmware mistakes: ${main.faults.map((f) => `${f.msg}${f.count > 1 ? ` (${f.count}×)` : ""}`).join("; ")}`);
    lines.push(`  Chip: RAM ${main.summary.ram.used}/${main.summary.ram.total} bytes, longest loop() ${fmtNum(main.summary.loopMax, 2)} ms, ${fmtNum(main.summary.isrLoad * 100, 1)} % of the time in interrupts.`);
    if (main.assumptions.length) lines.push(`  Assumed: ${main.assumptions.join("; ")}`);
    lines.push(`  Limits: ${main.limits.join(" ")}`);
  }
  for (const v of r.variants) if (v !== main) lines.push(`  ${VARIANT_LABEL[v.variant]} run: ${mmss(v.summary.time)} (${v.stop})${v.summary.state ? `, "${v.summary.state}"` : ""}; ${resultLines(def.spec.world.kind, v, 12).join("; ")}`);
  return lines.join("\n");
}

/** Mirror the runs into the live plan while the tool waits. */
function planBranch(defs: ScenarioDef[]) {
  const branch = openBranch({ id: "simulation", title: defs.length === 1 ? `Simulate: ${defs[0].label}` : `Simulate ${defs.length} scenarios`, agent: "simulation" });
  const steps = () =>
    defs.flatMap((d) => {
      const run = useSim.getState().runs.get(d.label);
      return d.spec.variants.map((v) => {
        const p = run?.progress[v];
        const done = run?.status === "done" || run?.status === "error";
        return {
          id: `${d.label}:${v}`.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 40),
          title: `${defs.length > 1 ? `${d.label}: ` : ""}${VARIANT_LABEL[v].toLowerCase()} run`,
          status: (done ? (run?.status === "error" ? "blocked" : "done") : p !== undefined && p > 0 ? "doing" : "todo") as "todo" | "doing" | "done" | "blocked",
          detail: !done && p ? `${Math.round(p * 100)} %` : undefined,
        };
      });
    });
  let last = "";
  const push = () => {
    const s = steps();
    const key = JSON.stringify(s);
    if (key === last) return;
    last = key;
    branch.setSteps(s);
  };
  push();
  const un = useSim.subscribe(push);
  return {
    finish(verdict: "done" | "blocked", detail: string) {
      un();
      push();
      branch.finish(verdict, detail);
    },
  };
}

export async function runSimTool(name: string, input: unknown, ctx: { signal?: AbortSignal } = {}): Promise<ToolOutcome | null> {
  if (name === "run_scenario") {
    const p = RunInput.safeParse(input ?? {});
    if (!p.success) return invalid(p.error);
    await whenChecked(60_000);
    const model = useDesign.getState().model;
    const all = model?.scenarios ?? [];
    if (!all.length)
      return {
        isError: true,
        content: "This design has no scenario block yet. Add one with edit_design (see Simulations in the language reference), then call run_scenario.",
        card: { title: "No scenario to run", status: "error" },
      };
    const defs = p.data.label ? all.filter((d) => d.label === p.data.label) : all;
    if (!defs.length) return { isError: true, content: `No scenario is labelled "${p.data.label}". Scenarios: ${all.map((d) => `"${d.label}"`).join(", ")}.`, card: { title: "Scenario not found", status: "error" } };
    for (const d of defs) {
      const st = useSim.getState().runs.get(d.label)?.status;
      if (!st || st === "idle" || st === "error") runScenarioNow(d.label);
    }
    const tree = planBranch(defs);
    await whenSimulated(900_000, defs.map((d) => d.label), ctx.signal);
    if (ctx.signal?.aborted) {
      tree.finish("blocked", "Stopped");
      return { isError: true, content: "Stopped waiting for the simulation: the user pressed Stop. The runs carry on in the Simulate tab.", card: { title: "Simulation wait stopped", status: "error" } };
    }
    const runs = useSim.getState().runs;
    const text = defs.map((d) => scenarioSummary(d, runs.get(d.label))).join("\n\n");
    let fails = 0;
    let warns = 0;
    let total = 0;
    for (const d of defs) {
      const run = runs.get(d.label);
      const outs = run?.result ? (outcomesFor(d, run.result) ?? []) : [];
      if (!run?.result || run.result.error || run.status === "error") fails++;
      total += outs.length;
      fails += outs.filter((o) => o.status === "fail").length;
      warns += outs.filter((o) => o.status === "warn").length;
    }
    const title = fails ? `${fails} of ${total} expectations fail` : warns ? `Passes, ${warns} to look at` : `All ${total} expectations pass`;
    tree.finish(fails ? "blocked" : "done", title);
    useSim.setState({ selected: defs[0].label });
    return { content: text, card: { title: defs.length === 1 ? `${defs[0].label}: ${title.toLowerCase()}` : title, status: fails ? "error" : "done" } };
  }
  if (name === "scenario_results") {
    const p = ResultsInput.safeParse(input ?? {});
    if (!p.success) return invalid(p.error);
    const model = useDesign.getState().model;
    const def = model?.scenarios?.find((d) => d.label === p.data.label);
    if (!def) return { isError: true, content: `No scenario is labelled "${p.data.label}". Scenarios: ${(model?.scenarios ?? []).map((d) => `"${d.label}"`).join(", ") || "none"}.`, card: { title: "Scenario not found", status: "error" } };
    const run = useSim.getState().runs.get(def.label);
    const v = run?.result ? pick(run.result.variants, p.data.variant ?? "expected") : undefined;
    if (!v) return { isError: true, content: `"${def.label}" has no results yet. Call run_scenario first.`, card: { title: "No results yet", status: "error" } };
    const world = def.spec.world.kind;
    const from = p.data.from ?? 0;
    const to = p.data.to ?? v.summary.time;
    const show = p.data.show ?? "results";
    let content: string;
    if (show === "results") content = [`${VARIANT_LABEL[v.variant]} run of "${def.label}":`, ...Object.entries(v.results).map(([k, x]) => `  ${k} = ${fmtResult(x, resultInfo(k, world)?.unit)}${resultInfo(k, world) ? `: ${resultInfo(k, world)!.doc}` : ""}`)].join("\n");
    else if (show === "events") content = v.events.length ? v.events.map((e) => `${mmss(e.t)} [${e.kind}] ${e.text}`).join("\n") : "Nothing happened worth an event.";
    else if (show === "console") {
      const lines = v.serial.filter((l) => l.t >= from && l.t <= to);
      content = lines.length ? lines.slice(0, 200).map((l) => `${mmss(l.t)} ${l.dir === "in" ? "> " : ""}${l.text}`).join("\n") + (lines.length > 200 ? `\n… ${lines.length - 200} more lines (narrow from/to)` : "") : "Nothing on the console in that time.";
    } else {
      const want = p.data.series?.length ? p.data.series : world === "sand_pit" ? ["pit.progress", "pit.offset", "pit.heading", "pit.hinge", "*.amps"] : ["*.rpm", "*.amps", "*.temp"];
      const names = [...new Set(want.flatMap((w) => matchSeries(v.frames, w)))].slice(0, 10);
      if (!names.length) content = `No series match ${want.join(", ")}. Recorded: ${Object.keys(v.frames.series).slice(0, 80).join(", ")}`;
      else {
        const n = 30;
        const head = ["t", ...names.map((s) => `${s}${channelInfo(s).unit ? ` (${channelInfo(s).unit})` : ""}`)].join(" | ");
        const rows: string[] = [];
        for (let i = 0; i <= n; i++) {
          const t = from + ((to - from) * i) / n;
          rows.push([mmss(t), ...names.map((s) => fmtNum(valueAt(v.frames, s, t), 2))].join(" | "));
        }
        content = [head, ...rows].join("\n");
      }
    }
    return { content, card: { title: `${def.label}: ${show}`, detail: `${VARIANT_LABEL[v.variant]} run` } };
  }
  return null;
}
