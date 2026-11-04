// The bench report: a page a person can read, with the whole run as JSON at
// the end so it can be compared with the next one.

import type { BenchRun, CaseResult } from "./run";

const money = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
const secs = (n: number) => (n < 90 ? `${Math.round(n)} s` : `${(n / 60).toFixed(1)} min`);

export function benchTotals(run: BenchRun) {
  const done = run.cases;
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

function row(c: CaseResult) {
  const failed = c.marks.filter((m) => !m.ok);
  const why = c.error ? `Error: ${c.error}` : failed.map((m) => `${m.label} (${m.detail})`).join("; ");
  return `| ${c.passed ? "✓" : "✗"} ${c.title} | ${c.kind} | ${secs(c.seconds)} | ${money(c.cost)} | ${c.requests} | ${c.asks.pass}/${c.asks.pass + c.asks.fail} | ${why.replace(/\|/g, "/") || "all marks"} |`;
}

export function benchMarkdown(run: BenchRun): string {
  const t = benchTotals(run);
  const when = new Date(run.started).toISOString().slice(0, 16).replace("T", " ");
  const lines = [
    `# Kerf bench, ${when} UTC`,
    "",
    `${t.passed} of ${t.cases} asks passed every mark (${t.marksOk} of ${t.marks} marks). Took ${secs(t.seconds)} and cost about ${money(t.cost)} in ${t.requests} requests.${run.cancelled ? " Stopped before the end." : ""}`,
    "",
    `Model ${run.model}, effort ${run.effort}, speed ${run.speed}.`,
    "",
    "| Ask | Kind | Time | Cost | Requests | Claude's checklist | What missed |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...run.cases.map(row),
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
