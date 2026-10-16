// Parallel builds: the lead assistant plans the layout and the subassemblies,
// then one agent per subassembly writes its own section of the design at the
// same time. The orchestrator schedules agents by dependency, shows their
// work live in the main view, merges the result (keeping anything the user
// edited meanwhile), commits it as one undoable change and reports the
// integrated checks back to the lead assistant.

import Anthropic from "@anthropic-ai/sdk";
import { getApiKey } from "../persist/vault";
import { useSettings, type Effort } from "../app/settings";
import { setSource, useDesign, whenChecked } from "../core/engine";
import { commitSource, onProjectOpen, setUndoGuard, useProject } from "../app/project";
import { viewport } from "../app/viewportApi";
import { requestCamera } from "../app/view";
import type { CheckItem } from "../core/checks";
import type { ToolOutcome } from "../ai/tools";
import { composeSections, definedNames, INTEGRATION, LAYOUT, mergeByRegion, newSection, ownerAt, splitSections, withMeta, type Section, type Sectioned } from "./sections";
import { checkPlan, sectionOrder, type SubPlan } from "./plan";
import { addUsage, emptyTally, estimateRun, fmtUsd, roughTokens, type Tally } from "./pricing";
import { recordSpend } from "../ai/spend";
import { kickoffMessage, subagentSystemPrompt } from "./prompts";
import { runAgent, SUBAGENT_TOOLS, type AgentEnd, type Workspace } from "./subagent";
import { defaultWorkers, pool } from "./isolated";
import { closeRunBranches, noteForBranch, openRunBranches, setBranchSteps, takeBranchSteering } from "./planBranches";
import { getAgentRun, isLive, loadRuns, patchBranch, patchRun, saveRuns, setRun, type AgentBranch, type AgentRunTree, type CrossIssue } from "./progress";

export interface BuildInput {
  title: string;
  goal: string;
  subassemblies: SubPlan[];
  integration?: string;
}

const AGENT_MAX_STEPS = 30;

/** Runtime state of the active run (not rendered; the store holds what the UI shows). */
interface Live {
  runId: string;
  projectId: string;
  startSource: string;
  /** parts in the design when the run started */
  startParts: number;
  doc: Sectioned;
  /** ids of sections agents write in this run */
  planIds: string[];
  previewTail: boolean;
  lastPushed: string;
  userEdited: boolean;
  runAbort: AbortController;
  controllers: Map<string, AbortController>;
  decide: ((d: "start" | "cancel") => void) | null;
  warm: Promise<void>;
  warmed: () => void;
  pushTimer: ReturnType<typeof setTimeout> | null;
  tally: Map<string, Tally>;
  requests: { from: string; target: string; change: string; reason: string }[];
  fatal: string | null;
}

let live: Live | null = null;
let idn = 0;
const nid = (p: string) => `${p}${Date.now().toString(36)}${(++idn).toString(36)}`;

export const agentModel = () => {
  const s = useSettings.getState();
  return s.agentModel === "same" ? s.model : s.agentModel;
};

export function isBuilding() {
  return !!live;
}

// the live preview is not on the undo stack, so an undo mid-build would make the merge drop the agents' work
setUndoGuard(() => (live ? "Undo waits for the parallel build. Stop it from its card first if you need to undo now." : null));

// ---------- the lead assistant's tool ----------

export async function startBuild(input: BuildInput, ctx: { signal?: AbortSignal; toolUseId?: string }): Promise<ToolOutcome> {
  if (live) return fail("A parallel build is already running. Wait for it to finish.", "Another build is running");
  if (!getApiKey()) return fail("No API key is available for the agents.", "No API key");
  const projectId = useProject.getState().current?.id;
  if (!projectId) return fail("No project is open.", "No project open");

  const source = useDesign.getState().source;
  const split = splitSections(source);
  if (!split.ok) return fail(`The subassembly markers in the design are broken (line ${split.line}: ${split.error}). Fix them with edit_design first: every "// ┌─ subassembly <id> · <name>" needs a matching "// └─ end <id>".`, "Section markers are broken");

  const subs = normalize(input.subassemblies);
  const existing = split.doc.sections.map((s) => s.id).filter((id) => !subs.some((p) => p.id === id));
  const check = checkPlan(subs, existing);
  if (check.errors.length) return fail(`The plan has problems; nothing was started:\n${check.errors.map((e) => `- ${e}`).join("\n")}`, "Plan needs fixing");

  const settings = useSettings.getState();
  const doc = planDoc(split.doc, subs, input.integration);
  const runId = nid("run");
  const tree: AgentRunTree = {
    runId,
    projectId,
    title: input.title.trim().slice(0, 120) || "Parallel build",
    goal: input.goal.trim().slice(0, 4000),
    mode: "build",
    status: settings.agentReview ? "review" : "running",
    model: agentModel(),
    effort: settings.effort,
    cost: 0,
    estimate: { low: 0, high: 0 },
    budget: settings.agentBudget,
    branches: subs.map((s) => branchFor(s, doc)),
    issues: [],
    toolUseId: ctx.toolUseId,
    createdAt: Date.now(),
    warnings: check.warnings,
  };
  tree.estimate = estimateFor(tree, doc);
  return run(tree, doc, source, ctx.signal);
}

/** Re-run one subassembly's agent with an instruction from the user (outside the chat). */
export async function reviseSubassembly(id: string, instruction: string, parentRunId?: string): Promise<void> {
  if (live || !instruction.trim() || !getApiKey()) return;
  const projectId = useProject.getState().current?.id;
  if (!projectId) return;
  const source = useDesign.getState().source;
  const split = splitSections(source);
  if (!split.ok) return;
  const sec = split.doc.sections.find((s) => s.id === id);
  if (!sec) return;
  const meta: SubPlan = { id: sec.id, name: sec.name, brief: sec.brief, after: sec.after.filter((d) => split.doc.sections.some((s) => s.id === d)), uses: sec.uses };
  const prev = getAgentRun();
  const settings = useSettings.getState();
  const tree: AgentRunTree = {
    runId: nid("run"),
    projectId,
    title: `Revise ${sec.name}`,
    goal: prev?.projectId === projectId && prev.goal ? prev.goal : "Revise one subassembly of the existing design.",
    mode: "revise",
    status: "running",
    model: agentModel(),
    effort: settings.effort,
    cost: 0,
    estimate: { low: 0, high: 0 },
    budget: settings.agentBudget,
    branches: [{ ...branchFor(meta, split.doc), revising: true, notes: [{ text: instruction.trim(), ts: Date.now(), delivered: true }] }],
    issues: [],
    parentRunId,
    createdAt: Date.now(),
    warnings: [],
  };
  tree.estimate = estimateFor(tree, split.doc);
  await run(tree, split.doc, source, undefined, instruction.trim());
}

// ---------- user controls (the chat card and the to-do tree call these) ----------

export function approveRun() {
  live?.decide?.("start");
}

export function cancelReview() {
  live?.decide?.("cancel");
}

/** Edit a branch while the plan is in review. */
export function editBranch(id: string, patch: Partial<Pick<AgentBranch, "title" | "brief" | "include">>) {
  const r = getAgentRun();
  if (!r || r.status !== "review") return;
  patchBranch(id, (b) => ({ ...b, ...patch }));
  if (live) patchRun((t) => ({ ...t, estimate: estimateFor(t, live!.doc) }));
}

export function setRunBudget(usd: number) {
  if (!live) return;
  patchRun((t) => ({ ...t, budget: Math.max(0.1, Math.min(100, usd)) }));
}

export function setRunModel(model: string) {
  const r = getAgentRun();
  if (!r || r.status !== "review" || !live) return;
  patchRun((t) => ({ ...t, model, estimate: estimateFor({ ...t, model }, live!.doc) }));
}

/** A note for one agent, delivered through the plan tree before its next model call. */
export function steerAgent(id: string, note: string) {
  const text = note.trim().slice(0, 2000);
  if (!live || !text) return;
  const b = getAgentRun()?.branches.find((x) => x.id === id);
  if (!b || (b.status !== "running" && b.status !== "queued" && b.status !== "waiting")) return;
  noteForBranch(id, text);
  patchBranch(id, (x) => ({ ...x, notes: [...x.notes, { text, ts: Date.now(), delivered: false }] }));
}

export function stopAgent(id: string) {
  if (!live) return;
  const c = live.controllers.get(id);
  if (c) c.abort();
  else patchBranch(id, (b) => (b.status === "queued" || b.status === "waiting" ? { ...b, status: "stopped", activity: undefined, summary: "Stopped before it started." } : b));
}

/** Stop every agent; the work so far is still merged and kept. */
export function stopRun() {
  if (!live) return;
  live.decide?.("cancel");
  live.runAbort.abort();
}

// ---------- the run ----------

async function run(tree: AgentRunTree, doc: Sectioned, startSource: string, signal?: AbortSignal, instruction?: string): Promise<ToolOutcome> {
  let warmed!: () => void;
  const warm = new Promise<void>((r) => (warmed = r));
  const l: Live = {
    runId: tree.runId,
    projectId: tree.projectId,
    startSource,
    startParts: useDesign.getState().model?.parts.length ?? 0,
    doc,
    planIds: tree.branches.map((b) => b.id),
    previewTail: false,
    lastPushed: startSource,
    userEdited: false,
    runAbort: new AbortController(),
    controllers: new Map(),
    decide: null,
    warm,
    warmed,
    pushTimer: null,
    tally: new Map(),
    requests: [],
    fatal: null,
  };
  live = l;
  setRun(tree);
  const onAbort = () => stopRun();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (tree.status === "review") {
      const d = await new Promise<"start" | "cancel">((resolve) => {
        l.decide = resolve;
        if (signal?.aborted) resolve("cancel");
      });
      l.decide = null;
      if (d === "cancel") {
        patchRun((r) => ({ ...r, status: "cancelled", endedAt: Date.now() }));
        persist();
        return {
          content: "The user cancelled the parallel build at the plan review; nothing changed. Ask what they would like to change about the plan.",
          card: { title: "Parallel build cancelled", status: "error" },
        };
      }
      applyReviewEdits(l);
    }

    patchRun((r) => ({ ...r, status: "running", startedAt: Date.now() }));
    openRunBranches(getAgentRun()!, stopAgent);
    // a revision keeps its integration requirements visible; a fresh build adds them once every section exists
    l.previewTail = getAgentRun()!.branches.every((b) => !b.include || b.revising);
    pushPreview(true);

    await schedule(l, instruction);
    return await integrate(l);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    closeRunBranches();
    if (l.pushTimer) clearTimeout(l.pushTimer);
    if (live === l) live = null;
    pool.closeSoon();
    persist();
    if (loadAfterRun) {
      loadRuns(loadAfterRun);
      loadAfterRun = null;
    }
  }
}

function applyReviewEdits(l: Live) {
  const tree = getAgentRun()!;
  const dropped = new Set(tree.branches.filter((b) => !b.include).map((b) => b.id));
  // a new section nobody will write is left out of the design entirely
  l.doc = {
    ...l.doc,
    sections: l.doc.sections
      .filter((s) => !(dropped.has(s.id) && !s.body.trim()))
      .map((s) => {
        const b = tree.branches.find((x) => x.id === s.id);
        return b && !dropped.has(b.id) ? withMeta(s, { id: s.id, name: b.title, brief: b.brief, after: s.after, uses: s.uses }) : s;
      }),
  };
  l.planIds = tree.branches.filter((b) => b.include).map((b) => b.id);
  patchRun((r) => ({ ...r, branches: r.branches.map((b) => (b.include ? b : { ...b, status: "skipped", summary: "Left out at review." })) }));
}

async function schedule(l: Live, instruction?: string) {
  const settings = useSettings.getState();
  pool.size = settings.agentWorkers || defaultWorkers();
  const anthropic = new Anthropic({ apiKey: getApiKey()!, dangerouslyAllowBrowser: true, maxRetries: 3, timeout: 10 * 60 * 1000 });
  const system = subagentSystemPrompt();
  const pending = l.planIds.slice();
  const running = new Map<string, Promise<void>>();
  let started = 0;

  const statusOf = (id: string) => getAgentRun()?.branches.find((b) => b.id === id)?.status;
  while (pending.length || running.size) {
    for (const id of pending.slice()) {
      if (running.size >= settings.agentParallel) break;
      if (l.runAbort.signal.aborted || l.fatal) {
        pending.splice(pending.indexOf(id), 1);
        patchBranch(id, (b) => (b.status === "queued" || b.status === "waiting" ? { ...b, status: "stopped", activity: undefined, summary: l.fatal ?? "Stopped before it started." } : b));
        continue;
      }
      if (statusOf(id) === "stopped") {
        pending.splice(pending.indexOf(id), 1);
        continue;
      }
      const deps = (l.doc.sections.find((s) => s.id === id)?.after ?? []).filter((d) => l.planIds.includes(d));
      const bad = deps.find((d) => ["failed", "stopped", "skipped"].includes(statusOf(d) ?? ""));
      if (bad) {
        pending.splice(pending.indexOf(id), 1);
        patchBranch(id, (b) => ({ ...b, status: "skipped", activity: undefined, summary: `Not built: it needs ${titleOf(bad)}, which did not finish.` }));
        continue;
      }
      if (!deps.every((d) => statusOf(d) === "done")) {
        patchBranch(id, (b) => (b.status === "queued" ? { ...b, status: "waiting", activity: `Waiting for ${deps.filter((d) => statusOf(d) !== "done").map(titleOf).join(", ")}` } : b));
        continue;
      }
      pending.splice(pending.indexOf(id), 1);
      const first = started++ === 0;
      const p = startAgent(l, id, anthropic, system, first, instruction).finally(() => running.delete(id));
      running.set(id, p);
    }
    if (!running.size) {
      if (!pending.length) break;
      // nothing can start: every pending agent waits on something that will never finish
      for (const id of pending) patchBranch(id, (b) => ({ ...b, status: "skipped", activity: undefined, summary: "Not built: its dependencies did not finish." }));
      break;
    }
    await Promise.race(running.values());
  }
}

const titleOf = (id: string) => getAgentRun()?.branches.find((b) => b.id === id)?.title ?? id;

async function startAgent(l: Live, id: string, anthropic: Anthropic, system: string, first: boolean, instruction?: string) {
  const ctl = new AbortController();
  const stopOnRun = () => ctl.abort();
  l.runAbort.signal.addEventListener("abort", stopOnRun, { once: true });
  l.controllers.set(id, ctl);
  patchBranch(id, (b) => ({ ...b, status: "running", activity: first ? "Starting" : "Waiting for the shared prompt cache", startedAt: Date.now(), model: getAgentRun()!.model }));
  // the first agent writes the shared prompt to the cache; the others read it a moment later
  if (!first) await Promise.race([l.warm, new Promise((r) => setTimeout(r, 12_000))]);

  const tree = getAgentRun()!;
  const sec = l.doc.sections.find((s) => s.id === id)!;
  const branch = tree.branches.find((b) => b.id === id)!;
  const brief = instruction ? `${sec.brief}\n\nRevision requested by the user: ${instruction}` : branch.brief;
  const kickoff = kickoffMessage({
    goal: tree.goal,
    layout: l.doc.head,
    integration: l.doc.tail,
    me: { id, name: sec.name, brief, after: sec.after, uses: sec.uses },
    others: l.doc.sections.filter((s) => s.id !== id).map((s) => ({ id: s.id, name: s.name, brief: s.brief, running: l.planIds.includes(s.id) })),
    dependencies: sec.after.flatMap((d) => {
      const s = l.doc.sections.find((x) => x.id === d);
      return s ? [{ id: d, name: s.name, source: s.body }] : [];
    }),
    current: sec.body,
    revising: branch.revising,
  });

  let stepN = 0;
  let end: AgentEnd;
  try {
    end = await runAgent(
      { anthropic, model: tree.model, effort: tree.effort as Effort, system, kickoff, maxSteps: AGENT_MAX_STEPS, signal: ctl.signal },
      workspace(l, id),
      {
        activity: (text) => patchBranch(id, (b) => ({ ...b, activity: text })),
        step: (s) => {
          const sid = `${id}:${++stepN}`;
          patchBranch(id, (b) => ({ ...b, steps: [...b.steps, { ...s, id: sid, ts: Date.now() }].slice(-80) }));
          return sid;
        },
        updateStep: (sid, p) => patchBranch(id, (b) => ({ ...b, steps: b.steps.map((s) => (s.id === sid ? { ...s, ...p } : s)) })),
        usage: (model, u) => {
          recordSpend("agents", model, u);
          const t = addUsage(l.tally.get(id) ?? emptyTally(), model, u);
          l.tally.set(id, t);
          const total = [...l.tally.values()].reduce((a, x) => a + x.cost, 0);
          patchBranch(id, (b) => ({ ...b, cost: t.cost, tokens: t.input + t.output + t.cacheRead + t.cacheWrite }));
          patchRun((r) => ({ ...r, cost: total }));
        },
        budgetOk: () => {
          const r = getAgentRun();
          return !r || r.cost < r.budget;
        },
        takeSteering: () => {
          const text = takeBranchSteering(id);
          if (text) patchBranch(id, (b) => ({ ...b, notes: b.notes.map((x) => ({ ...x, delivered: true })) }));
          return text;
        },
        setSteps: (steps) => setBranchSteps(id, steps),
        firstEvent: () => l.warmed(),
      },
    );
  } catch (e) {
    end = { status: "failed", summary: e instanceof Error ? e.message : String(e) };
  } finally {
    l.runAbort.signal.removeEventListener("abort", stopOnRun);
    l.controllers.delete(id);
    l.warmed();
  }
  if (end.status === "failed" && end.fatal) {
    l.fatal = end.summary;
    l.runAbort.abort();
  }
  const r = getAgentRun();
  const capped = end.status === "stopped" && !!r && r.cost >= r.budget;
  patchBranch(id, (b) => ({ ...b, status: end.status, summary: capped ? `Stopped at the ${fmtUsd(r!.budget)} spending cap. ${end.summary}` : end.summary, activity: undefined, endedAt: Date.now() }));
  if (capped) patchRun((x) => ({ ...x, note: `Stopped at the ${fmtUsd(x.budget)} spending cap for this run.` }));
  pushPreview(true);
}

function workspace(l: Live, id: string): Workspace {
  const sec = () => l.doc.sections.find((s) => s.id === id)!;
  return {
    id,
    name: sec().name,
    body: () => sec().body,
    setBody: (body) => {
      l.doc = { ...l.doc, sections: l.doc.sections.map((s) => (s.id === id ? { ...s, body } : s)) };
      pushPreview(false);
    },
    isolated: (body) => {
      // the layout, every finished section that does not build on this one, and this one
      const tree = getAgentRun();
      const done = (s: Section) => !l.planIds.includes(s.id) || tree?.branches.find((b) => b.id === s.id)?.status === "done";
      const sections = l.doc.sections.filter((s) => s.id === id || (done(s) && !s.after.includes(id))).map((s) => (s.id === id ? { ...s, body } : s));
      const src = composeSections({ head: l.doc.head, sections, tail: "" });
      const split = splitSections(src);
      const own = split.ok ? split.doc.sections.find((s) => s.id === id) : undefined;
      return { src, start: own?.bodyStart ?? 0, end: own?.bodyEnd ?? 0 };
    },
    otherNames: () => {
      const m = new Map<string, string>();
      for (const n of definedNames(l.doc.head)) m.set(n, "the layout");
      for (const s of l.doc.sections) if (s.id !== id) for (const n of definedNames(s.body)) m.set(n, `subassembly ${s.id}`);
      return m;
    },
    readOther: (other) => l.doc.sections.find((s) => s.id === other)?.body ?? null,
    requestChange: (target, change, reason) => {
      l.requests.push({ from: id, target, change, reason });
      patchBranch(id, (b) => ({ ...b, requests: [...b.requests, { id: nid("req"), from: id, target, change, reason }] }));
      return "Recorded. The lead engineer sees your request when every agent has finished. Continue with the best design you can make within the current contracts, and mention the assumption in your report.";
    },
    look: async (view, section) => {
      pushPreview(true);
      await whenChecked(45_000);
      const vp = viewport();
      if (!vp) return { text: "The 3D view is not available right now." };
      const ids = partsOf(useDesign.getState().source, id);
      const url = await vp.capture({ view, width: 1024, height: 704, focus: ids, section, mime: "image/jpeg", quality: 0.85, samples: 24 });
      const note = l.userEdited ? " The user is editing the design, so this may not show your latest changes." : "";
      return { image: url.split(",")[1] ?? "", text: `Rendered the ${view} view of the assembled model${section ? `, sectioned across ${section}` : ""}, with your ${ids.length} solid(s) highlighted and other parts ghosted. Other subassemblies may still be in progress. Z is up.${note}` };
    },
    onChecks: (c) => patchBranch(id, (b) => ({ ...b, checks: c })),
  };
}

/** Instance ids of the parts a section defines in the given source. */
function partsOf(src: string, id: string): string[] {
  const split = splitSections(src);
  const model = useDesign.getState().model;
  if (!split.ok || !model) return [];
  const s = split.doc.sections.find((x) => x.id === id);
  if (!s) return [];
  return model.parts.filter((p) => p.span.start >= s.bodyStart && p.span.start < s.bodyEnd).map((p) => p.id);
}

/** Show the agents' work in the main view, unless someone has edited the design since the last push. */
function pushPreview(now: boolean) {
  const l = live;
  if (!l || l.userEdited) return;
  if (!now) {
    if (l.pushTimer) return;
    l.pushTimer = setTimeout(() => {
      l.pushTimer = null;
      pushPreview(true);
    }, 700);
    return;
  }
  if (l.pushTimer) clearTimeout(l.pushTimer);
  l.pushTimer = null;
  if (useProject.getState().current?.id !== l.projectId) return;
  const cur = useDesign.getState().source;
  if (cur !== l.lastPushed) {
    l.userEdited = true;
    patchRun((r) => ({ ...r, note: "You edited the design during the run, so the live preview paused. Your edits are kept when the agents' work is merged." }));
    return;
  }
  const src = composeSections({ ...l.doc, tail: l.previewTail ? l.doc.tail : "" });
  if (src !== cur) setSource(src);
  l.lastPushed = src;
  refreshPartIds(src);
}

function refreshPartIds(src: string) {
  const split = splitSections(src);
  const model = useDesign.getState().model;
  if (!split.ok || !model) return;
  patchRun((r) => ({
    ...r,
    branches: r.branches.map((b) => {
      const s = split.doc.sections.find((x) => x.id === b.id);
      const ids = s ? model.parts.filter((p) => p.span.start >= s.bodyStart && p.span.start < s.bodyEnd).map((p) => p.id) : [];
      return ids.join() === b.partIds.join() ? b : { ...b, partIds: ids };
    }),
  }));
}

// ---------- merge, commit and report ----------

async function integrate(l: Live): Promise<ToolOutcome> {
  patchRun((r) => ({ ...r, status: "integrating" }));
  const tree0 = getAgentRun()!;
  const stopped = l.runAbort.signal.aborted;
  const sameProject = useProject.getState().current?.id === l.projectId;

  let doc = l.doc;
  const kept: string[] = [];
  let mergeFailed = false;
  const now = useDesign.getState().source;
  if (sameProject && now !== l.lastPushed) {
    const base = splitSections(l.lastPushed);
    const merged = base.ok ? mergeByRegion(base.doc, l.doc, now) : null;
    if (merged) {
      doc = merged.doc;
      kept.push(...merged.kept);
    } else mergeFailed = true;
  }
  const final = mergeFailed ? now : composeSections(doc);
  const done = tree0.branches.filter((b) => b.status === "done");
  const changed = sameProject && final !== l.startSource;
  if (changed) {
    const names = done.map((b) => b.title).join(", ");
    const asked = tree0.branches[0].notes[0]?.text;
    const msg = tree0.mode === "revise" ? `${tree0.branches[0].title}: ${firstLine(asked ?? tree0.branches[0].summary ?? "revised")}` : `${stopped ? "Parallel build stopped" : "Parallel build"}: ${names || "no subassemblies finished"}`;
    commitSource(final, "claude", msg.slice(0, 200), { undoBase: l.startSource });
    // the viewer framed the first preview, which held only the first finished parts
    if (!l.startParts) requestCamera("fit");
  }

  let report = useDesign.getState().report;
  if (changed && !stopped) {
    const s = await whenChecked(180_000);
    report = s.report;
  }
  const issues = changed ? classify(final, report?.items ?? []) : [];
  refreshPartIds(final);
  const counts = report && changed ? { pass: report.counts.pass, fail: report.counts.fail, warn: report.counts.warn } : undefined;
  const failed = tree0.branches.filter((b) => b.include && b.status === "failed").length;
  const status: AgentRunTree["status"] = stopped || l.fatal ? "stopped" : failed && !done.length ? "failed" : "done";
  const note = [
    getAgentRun()?.note && !getAgentRun()!.note!.startsWith("You edited") ? getAgentRun()!.note : "",
    kept.length ? `Kept your edits to ${kept.map((k) => (k === LAYOUT ? "the layout" : k === INTEGRATION ? "the integration requirements" : titleOf(k))).join(", ")}.` : "",
    mergeFailed ? "Your edits during the run changed the section markers, so the agents' work could not be merged automatically. Your version of the design is kept." : "",
    !sameProject ? "The project was closed during the run, so nothing was applied." : "",
    l.fatal ? `Stopped: ${l.fatal}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  patchRun((r) => ({ ...r, status, issues, integratedChecks: counts, endedAt: Date.now(), note: note || undefined }));
  persist();

  const tree = getAgentRun()!;
  const secs = (Date.now() - (tree.startedAt ?? tree.createdAt)) / 1000;
  const lines: string[] = [];
  const built = tree.branches.filter((b) => b.include);
  lines.push(
    `${tree.mode === "revise" ? "Revision" : "Parallel build"} ${stopped ? "stopped by the user" : "finished"}: ${done.length} of ${built.length} subassemblies done in ${fmtDuration(secs)}. Agents used ${tree.model}; cost ${fmtUsd(tree.cost)} (estimate was ${fmtUsd(tree.estimate.low)}–${fmtUsd(tree.estimate.high)}, cap ${fmtUsd(tree.budget)}).`,
  );
  if (tree.note) lines.push(`Note: ${tree.note}`);
  lines.push("Subassemblies:");
  for (const b of tree.branches) {
    const c = b.checks ? ` Its own last check: ${b.checks.pass} pass, ${b.checks.fail} fail, ${b.checks.warn} warn.` : "";
    lines.push(`- ${b.id} (${b.title}): ${b.status}.${c} Report: ${(b.summary ?? "").replace(/\s+/g, " ").slice(0, 900)}`);
    for (const n of b.notes) lines.push(`  The user told this agent: "${n.text}"`);
  }
  if (l.requests.length) {
    lines.push("Change requests from the agents (they continued within the current contracts):");
    for (const q of l.requests) lines.push(`- ${q.from} → ${q.target}: ${q.change} (why: ${q.reason})`);
  }
  if (mergeFailed) {
    lines.push("The agents' sections were not merged. Their latest source, for you to apply with edit_design if the user wants:");
    let budget = 20_000;
    for (const s of l.doc.sections) {
      if (!l.planIds.includes(s.id) || budget <= 0) continue;
      const t = s.body.slice(0, budget);
      budget -= t.length;
      lines.push(`<section id="${s.id}">\n${t}\n</section>`);
    }
  }
  if (counts) {
    lines.push(`Integrated design checks: ${counts.pass} pass, ${counts.fail} fail, ${counts.warn} warn.`);
    const cross = issues.filter((i) => i.owners.length > 1);
    const single = issues.filter((i) => i.owners.length <= 1);
    if (cross.length) lines.push(`Problems between subassemblies:\n${cross.map((i) => `- [${i.status}] ${i.title}: ${i.detail} (involves ${i.owners.map(ownerLabel).join(" and ")})`).join("\n")}`);
    if (single.length) lines.push(`Problems inside one region:\n${single.map((i) => `- [${i.status}] ${i.title}: ${i.detail} (in ${ownerLabel(i.owners[0] ?? LAYOUT)})`).join("\n")}`);
  } else if (stopped && changed) lines.push("The partial result was applied; call run_checks to see where it stands.");
  lines.push(
    done.length < built.length || (counts && counts.fail)
      ? "Next: integrate. Fix small cross-subassembly problems with edit_design, re-run only the affected subassemblies with build_subassemblies and a revision brief, or ask the user when a fix changes their goals."
      : "Next: review the integrated design (capture_view helps) and report to the user.",
  );

  const title = stopped ? `Stopped: ${done.length} of ${built.length} subassemblies built` : `Built ${done.length} of ${built.length} subassemblies in parallel`;
  return {
    content: lines.join("\n"),
    isError: !done.length && !changed ? true : undefined,
    card: { title, detail: `${counts ? `${counts.pass} pass · ${counts.fail} fail · ` : ""}${fmtUsd(tree.cost)}`, status: counts?.fail || status !== "done" ? "error" : "done" },
  };
}

function classify(src: string, items: CheckItem[]): CrossIssue[] {
  const split = splitSections(src);
  const model = useDesign.getState().model;
  if (!split.ok || !model) return [];
  const byId = new Map(model.parts.map((p) => [p.id, p]));
  const out: CrossIssue[] = [];
  for (const i of items) {
    if (i.status !== "fail" && i.status !== "warn") continue;
    const owners = new Set<string>();
    for (const pid of i.parts ?? []) {
      const p = byId.get(pid);
      if (p) owners.add(ownerAt(split.doc, p.span.start));
    }
    if (!owners.size && i.span) owners.add(ownerAt(split.doc, i.span.start));
    out.push({ id: i.id, title: i.title, detail: i.detail, status: i.status, owners: [...owners], parts: i.parts ?? [] });
  }
  return out.slice(0, 40);
}

const ownerLabel = (o: string) => (o === LAYOUT ? "the layout" : o === INTEGRATION ? "the integration requirements" : o);

// ---------- helpers ----------

function normalize(subs: SubPlan[]): SubPlan[] {
  return subs.map((s) => ({
    id: s.id.trim(),
    name: s.name.trim().slice(0, 80) || s.id,
    brief: s.brief.trim().slice(0, 4000),
    after: [...new Set((s.after ?? []).map((d) => d.trim()).filter(Boolean))],
    uses: [...new Set((s.uses ?? []).map((d) => d.trim()).filter(Boolean))].slice(0, 30),
  }));
}

/** The working document: existing sections keep their text, planned ones get markers, sorted so dependencies come first. */
function planDoc(doc: Sectioned, subs: SubPlan[], integration?: string): Sectioned {
  const sections = doc.sections.map((s) => {
    const p = subs.find((x) => x.id === s.id);
    return p ? withMeta(s, p) : s;
  });
  for (const p of subs) if (!sections.some((s) => s.id === p.id)) sections.push(newSection(p));
  const deps = new Map(sections.map((s) => [s.id, s.after]));
  const order = sectionOrder(doc.sections.map((s) => s.id), deps);
  const sorted = order.map((id) => sections.find((s) => s.id === id)!).filter(Boolean);
  sorted.forEach((s, i) => (s.gap = i < sorted.length - 1 ? s.gap || "\n" : s.gap));
  const head = doc.sections.length ? doc.head : doc.head.replace(/\s*$/, "\n\n");
  const tailText = integration !== undefined ? integration.replace(/\r\n/g, "\n").trim() : null;
  const tail = tailText === null ? doc.tail : tailText ? `\n// ── Integration: requirements across subassemblies ──\n${tailText}\n` : "";
  return { head, sections: sorted, tail };
}

function branchFor(s: SubPlan, doc: Sectioned): AgentBranch {
  const existing = doc.sections.find((x) => x.id === s.id);
  return {
    id: s.id,
    title: s.name,
    brief: s.brief,
    status: "queued",
    after: s.after,
    uses: s.uses,
    steps: [],
    notes: [],
    requests: [],
    cost: 0,
    tokens: 0,
    partIds: [],
    include: true,
    revising: !!existing?.body.trim(),
  };
}

function estimateFor(tree: AgentRunTree, doc: Sectioned) {
  const sys = roughTokens(subagentSystemPrompt()) + roughTokens(JSON.stringify(SUBAGENT_TOOLS));
  const layout = roughTokens(doc.head) + roughTokens(doc.tail);
  const ctx = tree.branches
    .filter((b) => b.include)
    .map((b) => {
      const sec = doc.sections.find((s) => s.id === b.id);
      return layout + roughTokens(b.brief) + 600 + (sec ? roughTokens(sec.body) : 0) + b.after.length * 2500;
    });
  if (!ctx.length) return { low: 0, high: 0 };
  return estimateRun({ model: tree.model, effort: tree.effort as Effort, systemTokens: sys, contextTokens: ctx });
}

function persist() {
  const r = getAgentRun();
  if (r) saveRuns(r.projectId);
}

function fail(content: string, title: string): ToolOutcome {
  return { isError: true, content, card: { title, detail: content.split("\n")[0], status: "error" } };
}

const firstLine = (s: string) => s.split(/(?<=[.!?])\s|\n/)[0].slice(0, 140);

function fmtDuration(s: number) {
  if (s < 60) return `${Math.round(s)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

// a different project replaces the design: stop the run and show that project's last run
let loadAfterRun: string | null = null;

onProjectOpen((p) => {
  if (live && live.projectId !== p.id) {
    // the stopped run finishes in the background (without applying anything), then this project's runs show
    loadAfterRun = p.id;
    stopRun();
    return;
  }
  if (isLive(getAgentRun()) && getAgentRun()?.projectId === p.id) return;
  loadRuns(p.id);
});
