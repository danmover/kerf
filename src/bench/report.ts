// The bench report: a page a person can read, with the whole run as JSON at
// the end so it can be compared with the next one.

import type { BenchRun, CaseResult } from "./run";

const money = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
const secs = (n: number) => (n < 90 ? `${Math.round(n)} s` : `${(n / 60).toFixed(1)} min`);

/** The run's totals, or one set-up's in a comparison. */
export function benchTotals(run: BenchRun, setup?: string) {
  const done = setup ? run.cases.filter((c) => c.setup === setup) : run.cases;
  const marks = done.flatMap((c) => c.marks);
  return {
    cases: done.length,
    passed: done.filter((c) => c.passed).length,
    marks: marks.length,
    marksOk: marks.filter((m) => m.ok).length,
    seconds: done.reduce((t, c) => t + c.seconds, 0),
    cost: done.reduce((t, c) => t + c.cost, 0),
    requests: done.reduce((t, c) => t + c.requests, 0),
  };
}

const missed = (c: CaseResult) => (c.error ? `Error: ${c.error}` : c.marks.filter((m) => !m.ok).map((m) => `${m.label} (${m.detail})`).join("; ")).replace(/\|/g, "/");

function row(c: CaseResult, setups?: BenchRun["setups"]) {
  const setup = setups ? ` ${setups.find((x) => x.id === c.setup)?.label ?? c.setup ?? ""} |` : "";
  return `| ${c.passed ? "✓" : "✗"} ${c.title} |${setup} ${c.kind} | ${secs(c.seconds)} | ${money(c.cost)} | ${c.requests} | ${c.asks.pass}/${c.asks.pass + c.asks.fail} | ${missed(c) || "all marks"} |`;
}

/** A comparison's summary: each set-up's totals, then each ask under every set-up side by side. */
function comparison(run: BenchRun): string[] {
  const setups = run.setups!;
  const asks = [...new Map(run.cases.map((c) => [c.id, c.title])).entries()];
  const cell = (id: string, setup: string) => {
    const c = run.cases.find((x) => x.id === id && x.setup === setup);
    return c ? `${c.passed ? "✓" : "✗"} ${secs(c.seconds)}, ${money(c.cost)}` : "not run";
  };
  return [
    "## Set-ups compared",
    "",
    "| Set-up | Asks passed | Marks | Time | Cost | Requests |",
    "| --- | --- | --- | --- | --- | --- |",
    ...setups.map((w) => {
      const t = benchTotals(run, w.id);
      return `| ${w.label} | ${t.passed} of ${t.cases} | ${t.marksOk} of ${t.marks} | ${secs(t.seconds)} | ${money(t.cost)} | ${t.requests} |`;
    }),
    "",
    `| Ask | ${setups.map((w) => w.label).join(" | ")} |`,
    `| --- | ${setups.map(() => "---").join(" | ")} |`,
    ...asks.map(([id, title]) => `| ${title} | ${setups.map((w) => cell(id, w.id)).join(" | ")} |`),
    "",
    "## Every run",
    "",
  ];
}

export function benchMarkdown(run: BenchRun): string {
  const t = benchTotals(run);
  const when = new Date(run.started).toISOString().slice(0, 16).replace("T", " ");
  const lines = [
    `# Kerf bench, ${when} UTC`,
    "",
    `${t.passed} of ${t.cases} ${run.setups ? "runs" : "asks"} passed every mark (${t.marksOk} of ${t.marks} marks). Took ${secs(t.seconds)} and cost about ${money(t.cost)} in ${t.requests} requests.${run.cancelled ? " Stopped before the end." : ""}`,
    "",
    run.setups ? `Each ask ran under ${run.setups.length} set-ups: ${run.setups.map((w) => w.label).join("; ")}. Effort ${run.effort}, speed ${run.speed}.` : `Model ${run.model}, effort ${run.effort}, speed ${run.speed}.`,
    "",
    ...(run.setups ? comparison(run) : []),
    `| Ask |${run.setups ? " Set-up |" : ""} Kind | Time | Cost | Requests | Claude's checklist | What missed |`,
    `| --- |${run.setups ? " --- |" : ""} --- | --- | --- | --- | --- | --- |`,
    ...run.cases.map((c) => row(c, run.setups)),
    "",
    "## Run data",
    "",
    "```json",
    JSON.stringify(run, null, 1),
    "```",
    "",
  ];
  return lines.join("\n");
}

export const benchFileName = (run: BenchRun) => `kerf-bench-${new Date(run.started).toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`;
