// The live state of a parallel build, as plain data. The chat card and the
// design to-do tree render it; the orchestrator is the only writer.

import { create } from "zustand";

export type BranchStatus = "queued" | "waiting" | "running" | "done" | "failed" | "stopped" | "skipped";
export type RunStatus = "review" | "running" | "integrating" | "done" | "stopped" | "failed" | "cancelled";

export interface AgentStep {
  id: string;
  title: string;
  status: "running" | "done" | "error";
  detail?: string;
  ts: number;
}

export interface ChangeRequest {
  id: string;
  from: string;
  /** "layout", "integration" or a subassembly id */
  target: string;
  change: string;
  reason: string;
}

export interface AgentBranch {
  id: string;
  title: string;
  brief: string;
  status: BranchStatus;
  /** live one-liner, e.g. "Building in geometry worker 2" */
  activity?: string;
  after: string[];
  uses: string[];
  steps: AgentStep[];
  /** notes from the user, delivered to the agent before its next model call; shared: a chat message every agent got */
  notes: { text: string; ts: number; delivered: boolean; shared?: boolean }[];
  requests: ChangeRequest[];
  summary?: string;
  /** the agent's own checks, from its last check_section */
  checks?: { pass: number; fail: number; warn: number };
  cost: number;
  tokens: number;
  model?: string;
  /** instance ids of the parts this branch owns in the current design */
  partIds: string[];
  /** false when the user left it out at review */
  include: boolean;
  /** true when the section already existed and the agent revises it */
  revising: boolean;
  startedAt?: number;
  endedAt?: number;
}

export interface CrossIssue {
  id: string;
  title: string;
  detail: string;
  status: "fail" | "warn";
  /** branch ids involved, plus "(layout)" or "(integration)" */
  owners: string[];
  parts: string[];
}

export interface AgentRunTree {
  runId: string;
  projectId: string;
  title: string;
  goal: string;
  mode: "build" | "revise";
  status: RunStatus;
  /** why the run ended early, or anything the user should know about the result */
  note?: string;
  model: string;
  effort: string;
  cost: number;
  estimate: { low: number; high: number };
  budget: number;
  branches: AgentBranch[];
  /** problems in the integrated design, by the subassemblies they involve */
  issues: CrossIssue[];
  integratedChecks?: { pass: number; fail: number; warn: number };
  /** the main chat's build_subassemblies call this run belongs to */
  toolUseId?: string;
  /** for a revision started from a build's card: that build */
  parentRunId?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  warnings: string[];
}

interface AgentsState {
  run: AgentRunTree | null;
  /** earlier runs this session, newest first, by tool call (so old chat cards keep their result) */
  history: AgentRunTree[];
}

export const useAgents = create<AgentsState>(() => ({ run: null, history: [] }));

/** The active or most recent run. */
export const useAgentRun = () => useAgents((s) => s.run);
export const getAgentRun = () => useAgents.getState().run;
export function subscribeAgentRun(fn: (t: AgentRunTree | null) => void) {
  return useAgents.subscribe((s, prev) => {
    if (s.run !== prev.run) fn(s.run);
  });
}

/** The run that belongs to a chat tool call, if it is still known. */
export function runForToolUse(toolUseId: string): AgentRunTree | null {
  const s = useAgents.getState();
  if (s.run?.toolUseId === toolUseId) return s.run;
  return s.history.find((r) => r.toolUseId === toolUseId) ?? null;
}

export function setRun(run: AgentRunTree | null) {
  useAgents.setState((s) => {
    const prev = s.run;
    const history = prev && run && prev.runId !== run.runId ? [prev, ...s.history.filter((h) => h.runId !== prev.runId)].slice(0, 12) : s.history;
    return { run, history };
  });
}

export function patchRun(fn: (r: AgentRunTree) => AgentRunTree) {
  useAgents.setState((s) => (s.run ? { run: fn(s.run) } : s));
}

export function patchBranch(id: string, fn: (b: AgentBranch) => AgentBranch) {
  patchRun((r) => ({ ...r, branches: r.branches.map((b) => (b.id === id ? fn(b) : b)) }));
}

export const isLive = (r: AgentRunTree | null) => !!r && (r.status === "review" || r.status === "running" || r.status === "integrating");

// ---------- recent runs per project, so chat cards and the tree survive a reload ----------

const KEY = (projectId: string) => `kerf.agents.runs.${projectId}`;
const KEEP = 8;

function slim(r: AgentRunTree): AgentRunTree {
  return {
    ...r,
    branches: r.branches.map((b) => ({ ...b, steps: b.steps.slice(-40).map((s) => ({ ...s, detail: s.detail?.slice(0, 600) })), summary: b.summary?.slice(0, 4000) })),
  };
}

function interrupted(r: AgentRunTree): AgentRunTree {
  if (!isLive(r)) return r;
  // the page closed mid-run: nothing is running any more
  return {
    ...r,
    status: r.status === "review" ? "cancelled" : "stopped",
    note: r.status === "review" ? undefined : "The page was closed during this run.",
    branches: r.branches.map((b) => (b.status === "running" || b.status === "queued" || b.status === "waiting" ? { ...b, status: "stopped", activity: undefined } : b)),
  };
}

export function saveRuns(projectId: string) {
  const s = useAgents.getState();
  const runs = [s.run, ...s.history].filter((r): r is AgentRunTree => !!r && r.projectId === projectId).slice(0, KEEP);
  try {
    localStorage.setItem(KEY(projectId), JSON.stringify(runs.map(slim)));
  } catch {
    /* storage full or blocked: runs stay in memory */
  }
}

/** Show a project's recent runs (the newest becomes the current one). */
export function loadRuns(projectId: string) {
  let runs: AgentRunTree[] = [];
  try {
    const raw = localStorage.getItem(KEY(projectId));
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    if (Array.isArray(v)) runs = v.filter((r): r is AgentRunTree => !!r && typeof r.runId === "string" && Array.isArray(r.branches)).map(interrupted);
  } catch {
    runs = [];
  }
  useAgents.setState({ run: runs[0] ?? null, history: runs.slice(1) });
}

export function forgetRuns(projectId: string) {
  try {
    localStorage.removeItem(KEY(projectId));
  } catch {
    /* ignore */
  }
}

/** Remove every project's run logs (when the user clears all data). */
export function forgetAllRuns() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith("kerf.agents.runs.")) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
  useAgents.setState({ run: null, history: [] });
}
