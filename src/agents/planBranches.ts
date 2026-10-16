// Reports a parallel run into Kerf's live plan tree: one branch per
// subassembly agent, under the step the lead assistant is on. The branch
// shows the agent's status, its own to-do list (from its update_plan calls),
// each tool call as activity, its cost and its parts. Changes the user makes
// on the branch (notes, renames, added or skipped steps) reach that agent at
// its next tool boundary; skipping the whole branch stops the agent.

import { findStep, openBranch, usePlan, userNote, type PlanBranch, type StepInput } from "../ai/plan";
import { fmtUsd } from "./pricing";
import { getAgentRun, subscribeAgentRun, type AgentBranch, type AgentRunTree } from "./progress";

/** The plan tree's id for a subassembly's branch. */
export const branchRootId = (sectionId: string) => `b.${sectionId}`;

interface Mirror {
  branch: PlanBranch;
  /** our step id → the tree's activity id */
  logs: Map<string, string>;
  last: AgentBranch | null;
  closed: boolean;
}

let mirrors = new Map<string, Mirror>();
let stop: (() => void) | null = null;

/**
 * Open a branch for every agent in the run that is about to start, and keep
 * them in step with the run until closeRunBranches().
 */
export function openRunBranches(run: AgentRunTree, onSkip: (id: string) => void) {
  closeRunBranches();
  mirrors = new Map();
  for (const b of run.branches) {
    if (!b.include) continue;
    const branch = openBranch({ id: b.id, title: b.title, agent: run.mode === "revise" ? "revision" : "agent", parts: b.partIds.length ? b.partIds : undefined });
    branch.setStatus("todo", "Queued");
    mirrors.set(b.id, { branch, logs: new Map(), last: null, closed: false });
  }
  sync(getAgentRun());
  const unRun = subscribeAgentRun(sync);
  // skipping a branch in the tree stops its agent
  const unPlan = usePlan.subscribe(() => {
    for (const [id, m] of mirrors) {
      if (m.closed || !m.branch.skipped) continue;
      const st = m.last?.status;
      if (st === "queued" || st === "waiting" || st === "running") onSkip(id);
    }
  });
  stop = () => {
    unRun();
    unPlan();
  };
}

/** Close every branch still open (the run ended) and stop mirroring. */
export function closeRunBranches() {
  sync(getAgentRun());
  stop?.();
  stop = null;
  for (const m of mirrors.values()) if (!m.closed) finish(m, m.last);
  mirrors.clear();
}

/** The user's changes on this agent's branch, ready for its next request. */
export function takeBranchSteering(id: string): string | null {
  const m = mirrors.get(id);
  return m && !m.closed ? m.branch.takeSteering() : null;
}

/** An agent's own to-do list; returns a problem with it, or null. */
export function setBranchSteps(id: string, steps: StepInput[]): string | null {
  const m = mirrors.get(id);
  if (!m || m.closed) return null;
  return m.branch.setSteps(steps);
}

/** A note typed on the run card goes through the tree, so there is one way to steer an agent. */
export function noteForBranch(id: string, text: string) {
  if (findStep(usePlan.getState(), branchRootId(id))) userNote(branchRootId(id), text);
}

export function branchSkipped(id: string): boolean {
  return mirrors.get(id)?.branch.skipped ?? false;
}

function sync(run: AgentRunTree | null) {
  if (!run) return;
  for (const b of run.branches) {
    const m = mirrors.get(b.id);
    if (!m || m.closed || b === m.last) continue;
    const prev = m.last;
    m.last = b;
    if (b.status !== prev?.status || (b.status === "waiting" && b.activity !== prev?.activity)) {
      if (b.status === "queued") m.branch.setStatus("todo", "Queued");
      else if (b.status === "waiting") m.branch.setStatus("todo", b.activity);
      else if (b.status === "running") m.branch.setStatus("doing", "");
    }
    for (const s of b.steps) {
      const before = prev?.steps.find((x) => x.id === s.id);
      if (before === s) continue;
      const title = s.detail ? `${s.title} · ${s.detail.split("\n")[0]}` : s.title;
      let log = m.logs.get(s.id);
      if (!log) {
        log = m.branch.log(s.title, currentLocalStep(b.id));
        m.logs.set(s.id, log);
      }
      if (s.status !== "running") m.branch.endLog(log, s.status, title);
    }
    if (b.cost !== prev?.cost || b.checks !== prev?.checks) {
      const checks = b.checks ? (b.checks.fail ? `${b.checks.fail} failing` : `${b.checks.pass} pass`) : "";
      m.branch.setMeta([b.cost > 0 ? fmtUsd(b.cost) : "", checks].filter(Boolean).join(" · "));
    }
    if (b.partIds !== prev?.partIds && b.partIds.length) m.branch.setParts(b.partIds);
    if (b.status === "done" || b.status === "failed" || b.status === "stopped" || b.status === "skipped") finish(m, b);
  }
}

function finish(m: Mirror, b: AgentBranch | null) {
  m.closed = true;
  const first = (s?: string) => (s ?? "").split(/(?<=[.!?])\s|\n/)[0];
  // an agent usually reports without a last update_plan; the step it was on ends with it
  const root = m.branch.id;
  for (const s of usePlan.getState().steps) {
    if (s.owner === root && s.kind === "step" && s.status === "doing") m.branch.updateStep(s.id.slice(root.length + 1), { status: b?.status === "done" ? "done" : "blocked" });
  }
  if (m.branch.skipped) return m.branch.finish("skipped", "Skipped in the plan.");
  switch (b?.status) {
    case "done":
      return m.branch.finish("done", first(b.summary));
    case "skipped":
      return m.branch.finish("skipped", first(b.summary));
    default:
      return m.branch.finish("blocked", first(b?.summary) || "Stopped.");
  }
}

/** The agent's own step it is on, so activity sits under it. */
function currentLocalStep(id: string): string | undefined {
  const root = branchRootId(id);
  const s = usePlan.getState().steps.find((x) => x.owner === root && x.kind === "step" && x.status === "doing");
  return s ? s.id.slice(root.length + 1) : undefined;
}
