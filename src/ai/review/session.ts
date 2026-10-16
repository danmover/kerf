// A review session: the rounds of review for one piece of work (a chat reply,
// or one subassembly agent's task). It numbers findings, carries the
// designer's responses into the next round, and writes the designer's brief.

import type { Finding, FindingResponse, ReviewResult } from "./types";

export class ReviewSession {
  results: ReviewResult[] = [];
  private latest = new Map<string, Finding>();

  constructor(public maxRounds = 2) {}

  get round() {
    return this.results.length;
  }
  get canReview() {
    return this.round < this.maxRounds;
  }
  get roundsLeft() {
    return Math.max(0, this.maxRounds - this.round);
  }
  /** source the last review saw, to tell whether the design changed since */
  get lastSource(): string | null {
    return this.results.at(-1)?.source ?? null;
  }
  /** every finding so far, with its newest status */
  get findings(): Finding[] {
    return [...this.latest.values()];
  }
  get nextId() {
    return this.latest.size + 1;
  }

  /** Apply the designer's answers before the next round. Unknown ids are reported back. */
  respond(responses: FindingResponse[]): string[] {
    const unknown: string[] = [];
    for (const r of responses) {
      const f = this.latest.get(r.id.trim().toUpperCase());
      if (!f) {
        unknown.push(r.id);
        continue;
      }
      this.latest.set(f.id, { ...f, status: r.status, note: r.note.trim() || f.note });
    }
    return unknown;
  }

  add(result: ReviewResult) {
    this.results.push(result);
    for (const f of [...result.earlier, ...result.findings]) this.latest.set(f.id, f);
  }

  /** Findings to hand the next round: everything not settled. */
  carried(): Finding[] {
    return this.findings.filter((f) => f.status !== "verified" && f.status !== "accepted");
  }
}

const SEV_ORDER = { blocker: 0, major: 1, minor: 2 } as const;

/** What the designer reads after a review: the verdict, every open finding and what to do next. */
export function designerReport(r: ReviewResult, roundsLeft: number, auto: boolean): string {
  const open = [...r.earlier.filter((f) => f.status === "still_open"), ...r.findings].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const counts = (["blocker", "major", "minor"] as const).map((s) => [s, open.filter((f) => f.severity === s).length] as const).filter(([, c]) => c);
  const lines: string[] = [];
  lines.push(
    `${auto ? "Automatic self-review" : "Self-review"} round ${r.round}, by an independent reviewer who saw the brief, ${r.views.length} renders, the measured details, the checks and the source. ` +
      (r.verdict === "pass" ? "Verdict: passes." : r.verdict === "decide" ? "Verdict: needs the user's decision." : "Verdict: changes needed.") +
      (counts.length ? ` Open: ${counts.map(([s, c]) => `${c} ${s}`).join(", ")}.` : ""),
  );
  lines.push(`Reviewer's summary: ${r.summary}`);
  if (r.assumptions) lines.push(`Reviewer assumed: ${r.assumptions}`);
  const settled = r.earlier.filter((f) => f.status === "verified" || f.status === "accepted");
  if (settled.length) lines.push(`Settled from earlier rounds: ${settled.map((f) => `${f.id} ${f.status === "verified" ? "fixed and verified" : "kept, reason accepted"}`).join("; ")}.`);
  if (open.length) {
    lines.push("", "Findings:");
    for (const f of open) {
      lines.push(`- ${f.id} [${f.severity} · ${f.area}${f.needsUser ? " · needs the user" : ""}${f.status === "still_open" ? " · still open" : ""}] ${f.title}${f.parts.length ? ` (parts: ${f.parts.join(", ")})` : ""}`);
      lines.push(`  Why: ${f.detail}`);
      lines.push(`  Fix: ${f.fix}`);
      if (f.status === "still_open" && f.note) lines.push(`  Reviewer on your last response: ${f.note}`);
    }
  }
  const issues = r.checked.filter((c) => c.result === "issues").map((c) => c.area);
  if (issues.length) lines.push("", `Areas with issues: ${issues.join(", ")}.`);
  lines.push("");
  const mustFix = open.filter((f) => f.severity !== "minor" && !f.needsUser);
  const forUser = open.filter((f) => f.needsUser);
  if (!open.length) {
    lines.push("Nothing to fix. Mention the review in one short clause at most; the user sees its card.");
  } else if (roundsLeft > 0) {
    lines.push(
      `Next: ${mustFix.length ? "fix every blocker and major finding (edit_design, then run_checks)" : "no blocker or major findings are open"}${open.some((f) => f.severity === "minor") ? "; fix minor ones only when they are quick and safe" : ""}. ` +
        (forUser.length ? `Findings marked "needs the user" change what they asked for: put them to the user with ask_user rather than deciding. ` : "") +
        `If you disagree with a finding, keep the design and say why. Then call review_design again with a response for every finding you touched (${roundsLeft} review round${roundsLeft === 1 ? "" : "s"} left for this reply).`,
    );
  } else {
    lines.push("This was the last review round for this reply. Fix what you safely can, run_checks, and tell the user plainly which findings are still open and why.");
  }
  if (auto) lines.push("Your earlier reply is already visible to the user; when you finish, write a short update that says what the review changed, not a repeat.");
  return lines.join("\n");
}

/** Verdict from the findings themselves, so a lenient summary cannot hide an open major finding. */
export function verdictOf(findings: Finding[]): ReviewResult["verdict"] {
  const open = findings.filter((f) => f.status === "open" || f.status === "still_open" || f.status === "needs_user");
  if (open.some((f) => !f.needsUser && f.severity !== "minor")) return "revise";
  if (open.some((f) => f.needsUser && f.severity !== "minor")) return "decide";
  return "pass";
}
