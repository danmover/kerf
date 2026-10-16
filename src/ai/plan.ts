// The live plan: a to-do tree of the assistant's work that the user watches
// and steers while Claude works.
//
// Claude writes the plan with the update_plan tool. The user can rename,
// annotate, skip, reorder, add and pause on steps at any time; each change
// shows in the tree at once and queues as steering. Steering reaches Claude
// at its next tool boundary as a <plan-changes> note (or at once, when the
// user interrupts), so the assistant picks it up as it goes.
//
// Sub-agents (one per subassembly, a review pass) report into the same tree
// as branches with openBranch(). Each branch owns its own steps; the main
// loop's update_plan never replaces them, and the user's changes on a branch
// go to that branch's agent while it is open.

import { create } from "zustand";

export const MAIN = "main";

export type StepStatus = "todo" | "doing" | "done" | "skipped" | "blocked";
export const STEP_STATUSES = ["todo", "doing", "done", "skipped", "blocked"] as const;

/** A step as Claude (or a branch agent) reports it. Ids are local to the reporter. */
export interface StepInput {
  id: string;
  title: string;
  status: StepStatus;
  /** one line: what was found, decided or is in the way */
  detail?: string;
  /** part or component names this step works on, highlighted on hover */
  parts?: string[];
  /** id of the parent step; leave out for a top-level step */
  parent?: string;
}

export interface PlanNote {
  id: string;
  text: string;
  at: number;
}

export interface PlanActivity {
  id: string;
  title: string;
  status: "running" | "done" | "error";
  at: number;
  /** the chat tool item this mirrors, when the main loop ran it */
  itemId?: string;
}

export interface PlanStep {
  /** global id: main steps keep Claude's ids, branch steps are "<branch>/<local id>" */
  id: string;
  parent?: string;
  title: string;
  status: StepStatus;
  detail?: string;
  parts?: string[];
  /** who drives this step: MAIN (the chat loop) or a branch id */
  owner: string;
  /** "agent" and "review" mark the root of a branch */
  kind: "step" | "agent" | "review";
  /** short label on a branch root, e.g. the subassembly */
  agent?: string;
  /** one short line a branch reports on its root, e.g. cost */
  meta?: string;
  by: "claude" | "you";
  notes: PlanNote[];
  activity: PlanActivity[];
  /** stop the loop for the user's review once this step is done */
  pauseAfter?: boolean;
  /** Claude's title, when the user renamed the step */
  renamedFrom?: string;
  startedAt?: number;
  endedAt?: number;
}

export type SteerKind = "rename" | "note" | "add" | "skip" | "restore" | "next" | "pause" | "unpause" | "remove" | "design";

/** One change the user made, waiting to reach the agent that owns the step. */
export interface Steer {
  id: string;
  kind: SteerKind;
  stepId?: string;
  /** the new title, the note, the added step's title, or what changed in the design */
  text: string;
  /** the title before a rename, or the title of a removed step */
  prev?: string;
  /** where an added step went */
  after?: string;
  parent?: string;
  /** a note's id, so an undelivered note can be withdrawn */
  noteId?: string;
  at: number;
  /** when it reached the agent */
  delivered?: number;
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
  steering: Steer[];
  /** a step marked pause-after has just been finished; the loop stops at the next tool boundary */
  pauseHit: string | null;
  /** the title of the step the loop last stopped after for the user's review */
  pausedAfter?: string;
  updatedAt: number;
}

export const emptyPlan = (): Plan => ({ goal: "", steps: [], steering: [], pauseHit: null, updatedAt: 0 });

const LIMITS = { steps: 80, depth: 4, title: 140, detail: 300, note: 1000, activity: 40 };
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const ended = (s: StepStatus) => s === "done" || s === "skipped";
let idn = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++idn).toString(36)}`;

// ---------- reading the tree ----------

export interface PlanNode {
  step: PlanStep;
  depth: number;
  children: PlanNode[];
}

/**
 * The plan as a tree. Siblings keep their order in the list; under a step,
 * its owner's own children come first, then branches that report into it.
 */
export function planTree(plan: Plan): PlanNode[] {
  const ids = new Set(plan.steps.map((s) => s.id));
  const kids = new Map<string | undefined, PlanStep[]>();
  for (const s of plan.steps) {
    const p = s.parent && ids.has(s.parent) && s.parent !== s.id ? s.parent : undefined;
    const arr = kids.get(p) ?? [];
    arr.push(s);
    kids.set(p, arr);
  }
  const seen = new Set<string>();
  const build = (parent: PlanStep | undefined, depth: number): PlanNode[] => {
    const list = kids.get(parent?.id) ?? [];
    const owner = parent?.owner ?? MAIN;
    const sorted = [...list.filter((s) => s.owner === owner && s.kind === "step"), ...list.filter((s) => !(s.owner === owner && s.kind === "step"))];
    const out: PlanNode[] = [];
    for (const s of sorted) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push({ step: s, depth, children: build(s, depth + 1) });
    }
    return out;
  };
  return build(undefined, 0);
}

export function findStep(plan: Plan, id: string | undefined) {
  return id ? plan.steps.find((s) => s.id === id) : undefined;
}

export function descendants(plan: Plan, id: string): PlanStep[] {
  const out: PlanStep[] = [];
  const walk = (pid: string) => {
    for (const s of plan.steps) if (s.parent === pid && !out.includes(s)) (out.push(s), walk(s.id));
  };
  walk(id);
  return out;
}

/** The step the main loop is on: the deepest main step marked doing. */
export function currentStep(plan: Plan, owner = MAIN): PlanStep | undefined {
  const doing = plan.steps.filter((s) => s.owner === owner && s.kind === "step" && s.status === "doing");
  if (!doing.length) return undefined;
  const depth = (s: PlanStep) => {
    let d = 0;
    let p = findStep(plan, s.parent);
    while (p && d < 10) (d++, (p = findStep(plan, p.parent)));
    return d;
  };
  return doing.reduce((a, b) => (depth(b) >= depth(a) ? b : a));
}

/** Progress over the top-level steps: which one is running, how many are finished. */
export function progress(plan: Plan) {
  const top = planTree(plan).map((n) => n.step);
  const live = top.filter((s) => s.status !== "skipped");
  const done = live.filter((s) => s.status === "done").length;
  const cur = currentStep(plan);
  let topCur = cur;
  while (topCur?.parent && findStep(plan, topCur.parent)) topCur = findStep(plan, topCur.parent);
  const index = topCur ? live.indexOf(topCur) : -1;
  return { total: live.length, done, index, current: cur, top: topCur };
}

export const pendingSteering = (plan: Plan) => plan.steering.filter((s) => !s.delivered);

// ---------- Claude's updates ----------

/** Problems with a reported step list, or null when it is usable. */
export function checkSteps(steps: StepInput[]): string | null {
  if (steps.length > LIMITS.steps) return `A plan can have at most ${LIMITS.steps} steps.`;
  const seen = new Set<string>();
  const depth = new Map<string, number>();
  for (const s of steps) {
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(s.id)) return `Step id "${s.id}" must be 1 to 40 letters, digits, dots, dashes or underscores.`;
    if (seen.has(s.id)) return `Step id "${s.id}" is used twice.`;
    seen.add(s.id);
    if (!s.title.trim()) return `Step "${s.id}" needs a title.`;
    if (s.parent !== undefined) {
      if (!seen.has(s.parent) || s.parent === s.id) return `Step "${s.id}" names parent "${s.parent}", which must be listed before it.`;
      const d = (depth.get(s.parent) ?? 0) + 1;
      if (d >= LIMITS.depth) return `Step "${s.id}" is nested more than ${LIMITS.depth} levels deep.`;
      depth.set(s.id, d);
    } else depth.set(s.id, 0);
  }
  return null;
}

/**
 * Replace the steps an owner reports with a new list, keeping what the user
 * added to them: notes, pause marks, activity, and any change Claude has not
 * seen yet (an undelivered rename, skip or added step wins over the update).
 */
export function applyUpdate(plan: Plan, input: { goal?: string; steps: StepInput[]; newPlan?: boolean }, opts: { owner?: string; root?: string; now?: number; isOpen?: (branch: string) => boolean } = {}): Plan {
  const owner = opts.owner ?? MAIN;
  const now = opts.now ?? Date.now();
  const gid = (id: string) => (owner === MAIN ? id : `${owner}/${id}`);
  const waiting = pendingSteering(plan);
  if (owner === MAIN && input.newPlan) {
    // a plan for a new request: the old steps and finished branches go, open branches and unseen additions stay
    const keep = (s: PlanStep) => (s.owner !== MAIN && !!opts.isOpen?.(s.owner)) || waiting.some((w) => w.kind === "add" && w.stepId === s.id);
    plan = { ...plan, steps: plan.steps.filter(keep), pauseHit: null };
  }
  const prevById = new Map(plan.steps.map((s) => [s.id, s]));
  const has = (kind: SteerKind, id: string) => waiting.some((w) => w.kind === kind && w.stepId === id);
  let pauseHit = plan.pauseHit;

  const fresh: PlanStep[] = [];
  for (const s of input.steps) {
    const id = gid(s.id);
    if (has("remove", id)) continue;
    const prev = prevById.get(id);
    if (prev && prev.owner !== owner) continue; // never take over another owner's step
    let status: StepStatus = has("skip", id) ? "skipped" : s.status;
    if (has("restore", id) && status === "skipped") status = prev && prev.status !== "skipped" ? prev.status : "todo";
    const keepTitle = prev && has("rename", id);
    const title = keepTitle ? prev.title : clip(s.title.trim(), LIMITS.title);
    const parent = s.parent !== undefined ? gid(s.parent) : opts.root;
    if (prev?.pauseAfter && status === "done" && prev.status !== "done") pauseHit = id;
    fresh.push({
      id,
      parent,
      title,
      status,
      detail: s.detail?.trim() ? clip(s.detail.trim(), LIMITS.detail) : undefined,
      parts: s.parts?.length ? s.parts.slice(0, 30) : undefined,
      owner,
      kind: "step",
      by: prev?.by ?? "claude",
      notes: prev?.notes ?? [],
      activity: prev?.activity ?? [],
      pauseAfter: prev?.pauseAfter,
      // the user's rename stays marked while Claude keeps their title
      renamedFrom: keepTitle || (prev?.renamedFrom && prev.title === title) ? prev?.renamedFrom : undefined,
      startedAt: prev?.startedAt ?? (status === "doing" || status === "done" ? now : undefined),
      endedAt: ended(status) ? (prev && prev.status === status && prev.endedAt ? prev.endedAt : now) : undefined,
    });
  }

  // nothing starts after a pause: steps this update began go back to waiting
  if (pauseHit && pauseHit !== plan.pauseHit) {
    for (const f of fresh) {
      const prev = prevById.get(f.id);
      if (f.status === "doing" && prev?.status !== "doing" && !isAncestor(fresh, f.id, pauseHit)) Object.assign(f, { status: "todo", startedAt: prev?.startedAt });
    }
  }

  // steps the user added that Claude has not seen yet stay where they put them
  const freshIds = new Set(fresh.map((s) => s.id));
  const block = fresh.slice();
  for (const s of plan.steps) {
    if (s.owner !== owner || s.kind !== "step" || freshIds.has(s.id) || !has("add", s.id)) continue;
    const add = waiting.find((w) => w.kind === "add" && w.stepId === s.id)!;
    const at = add.after ? block.findIndex((b) => b.id === add.after) : -1;
    if (at >= 0) block.splice(at + 1, 0, s);
    else block.push(s);
  }

  const others = plan.steps.filter((s) => s.owner !== owner || s.kind !== "step");
  const all = [...others, ...block];
  const ids = new Set(all.map((s) => s.id));
  const steps = all.map((s) => (s.parent && !ids.has(s.parent) ? { ...s, parent: s.owner === owner ? opts.root : undefined } : s));
  return { ...plan, goal: input.goal !== undefined && owner === MAIN ? clip(input.goal.trim(), LIMITS.title) : plan.goal, steps, pauseHit, pausedAfter: owner === MAIN ? undefined : plan.pausedAfter, updatedAt: now };
}

function isAncestor(steps: PlanStep[], id: string, of: string): boolean {
  let p = steps.find((s) => s.id === of)?.parent;
  for (let i = 0; p && i < 10; i++) {
    if (p === id) return true;
    p = steps.find((s) => s.id === p)?.parent;
  }
  return false;
}

/** Patch one step (a branch agent's update, or the app marking progress). */
export function patchStep(plan: Plan, id: string, patch: Partial<Pick<PlanStep, "title" | "status" | "detail" | "parts" | "meta" | "agent">>, now = Date.now()): Plan {
  const prev = findStep(plan, id);
  if (!prev) return plan;
  const waiting = pendingSteering(plan);
  const next: PlanStep = { ...prev };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
  if (patch.title !== undefined && waiting.some((w) => w.kind === "rename" && w.stepId === id)) next.title = prev.title;
  if (patch.status && waiting.some((w) => w.kind === "skip" && w.stepId === id)) next.status = "skipped";
  if (next.status !== prev.status) {
    if ((next.status === "doing" || next.status === "done") && !next.startedAt) next.startedAt = now;
    next.endedAt = ended(next.status) ? now : undefined;
  }
  const pauseHit = prev.pauseAfter && next.status === "done" && prev.status !== "done" ? id : plan.pauseHit;
  return { ...plan, steps: plan.steps.map((s) => (s.id === id ? next : s)), pauseHit, updatedAt: now };
}

// ---------- the user's changes ----------

function withSteer(plan: Plan, steer: Omit<Steer, "id" | "at">, now: number): Plan {
  return { ...plan, steering: [...plan.steering, { ...steer, id: uid("st"), at: now }], updatedAt: now };
}
/** Drop an undelivered steer of a kind for a step; true if one was there (the two cancel out). */
function cancel(plan: Plan, kind: SteerKind, stepId: string): Plan | null {
  const i = plan.steering.findIndex((s) => !s.delivered && s.kind === kind && s.stepId === stepId);
  if (i < 0) return null;
  return { ...plan, steering: plan.steering.filter((_, j) => j !== i) };
}
const mapStep = (plan: Plan, id: string, fn: (s: PlanStep) => PlanStep): Plan => ({ ...plan, steps: plan.steps.map((s) => (s.id === id ? fn(s) : s)) });

export function renameStep(plan: Plan, id: string, title: string, now = Date.now()): Plan {
  const s = findStep(plan, id);
  const t = clip(title.trim(), LIMITS.title);
  if (!s || !t || t === s.title) return plan;
  // a step the user added and Claude has not seen: just change what will be sent
  const add = plan.steering.find((w) => !w.delivered && w.kind === "add" && w.stepId === id);
  if (add) return { ...mapStep(plan, id, (x) => ({ ...x, title: t })), steering: plan.steering.map((w) => (w === add ? { ...w, text: t } : w)), updatedAt: now };
  const original = s.renamedFrom ?? s.title;
  const prior = cancel(plan, "rename", id) ?? plan;
  const next = mapStep(prior, id, (x) => ({ ...x, title: t, renamedFrom: t === original ? undefined : original }));
  if (t === original && prior !== plan) return { ...next, updatedAt: now }; // renamed back before Claude saw it
  return withSteer(next, { kind: "rename", stepId: id, text: t, prev: s.title }, now);
}

export function addNote(plan: Plan, id: string, text: string, now = Date.now()): Plan {
  const s = findStep(plan, id);
  const t = clip(text.trim(), LIMITS.note);
  if (!s || !t) return plan;
  const note: PlanNote = { id: uid("n"), text: t, at: now };
  return withSteer(mapStep(plan, id, (x) => ({ ...x, notes: [...x.notes, note] })), { kind: "note", stepId: id, text: t, noteId: note.id }, now);
}

/** Withdraw a note. Only possible before it reaches Claude. */
export function removeNote(plan: Plan, stepId: string, noteId: string, now = Date.now()): Plan {
  const steer = plan.steering.find((w) => w.noteId === noteId);
  if (steer?.delivered) return plan;
  return { ...mapStep(plan, stepId, (x) => ({ ...x, notes: x.notes.filter((n) => n.id !== noteId) })), steering: plan.steering.filter((w) => w !== steer), updatedAt: now };
}

/** Add a step after another (as its sibling) or inside one (as its last child). */
export function addStep(plan: Plan, where: { after?: string; parent?: string }, title: string, now = Date.now()): { plan: Plan; id: string | null } {
  const t = clip(title.trim(), LIMITS.title);
  if (!t) return { plan, id: null };
  const after = findStep(plan, where.after);
  const parentStep = after ? findStep(plan, after.parent) : findStep(plan, where.parent);
  // a step belongs to whoever owns its parent: inside a branch, that branch's agent
  const owner = parentStep?.owner ?? MAIN;
  let n = 1;
  const local = () => `u${n}`;
  const gid = () => (owner === MAIN ? local() : `${owner}/${local()}`);
  while (plan.steps.some((s) => s.id === gid())) n++;
  const id = gid();
  const step: PlanStep = { id, parent: parentStep?.id, title: t, status: "todo", owner, kind: "step", by: "you", notes: [], activity: [] };
  const steps = plan.steps.slice();
  let at = steps.length;
  if (after) {
    // after the anchor's own subtree, so the list stays readable in order
    const sub = new Set([after.id, ...descendants(plan, after.id).map((d) => d.id)]);
    at = steps.findIndex((s) => s.id === after.id);
    while (at + 1 < steps.length && sub.has(steps[at + 1].id)) at++;
    at++;
  }
  steps.splice(at, 0, step);
  return { plan: withSteer({ ...plan, steps }, { kind: "add", stepId: id, text: t, after: after?.id, parent: parentStep?.id }, now), id };
}

export function skipStep(plan: Plan, id: string, now = Date.now()): Plan {
  const s = findStep(plan, id);
  if (!s || s.status === "skipped" || s.status === "done") return plan;
  const subtree = new Set([id, ...descendants(plan, id).filter((d) => !ended(d.status)).map((d) => d.id)]);
  const steps = plan.steps.map((x) => (subtree.has(x.id) ? { ...x, status: "skipped" as const, endedAt: now } : x));
  const undone = cancel(plan, "restore", id);
  if (undone) return { ...undone, steps, updatedAt: now };
  return withSteer({ ...plan, steps }, { kind: "skip", stepId: id, text: s.title }, now);
}

export function restoreStep(plan: Plan, id: string, now = Date.now()): Plan {
  const s = findStep(plan, id);
  if (!s || s.status !== "skipped") return plan;
  const subtree = new Set([id, ...descendants(plan, id).filter((d) => d.status === "skipped").map((d) => d.id)]);
  const steps = plan.steps.map((x) => (subtree.has(x.id) ? { ...x, status: "todo" as const, endedAt: undefined } : x));
  const undone = cancel(plan, "skip", id);
  if (undone) return { ...undone, steps, updatedAt: now };
  return withSteer({ ...plan, steps }, { kind: "restore", stepId: id, text: s.title }, now);
}

/** Move a step ahead of the steps still to do beside it, and ask for it next. */
export function doNext(plan: Plan, id: string, now = Date.now()): Plan {
  const s = findStep(plan, id);
  if (!s || s.status !== "todo") return plan;
  const sibs = plan.steps.filter((x) => x.parent === s.parent && x.owner === s.owner && x.kind === "step");
  const first = sibs.find((x) => x.status === "todo");
  let steps = plan.steps;
  if (first && first.id !== id) {
    steps = steps.filter((x) => x.id !== id);
    steps.splice(steps.findIndex((x) => x.id === first.id), 0, s);
  }
  const prior = cancel(plan, "next", id) ?? plan;
  return withSteer({ ...prior, steps }, { kind: "next", stepId: id, text: s.title }, now);
}

export function togglePause(plan: Plan, id: string, now = Date.now()): Plan {
  const s = findStep(plan, id);
  if (!s) return plan;
  const on = !s.pauseAfter;
  const next = mapStep(plan, id, (x) => ({ ...x, pauseAfter: on || undefined }));
  const undone = cancel(next, on ? "unpause" : "pause", id);
  if (undone) return { ...undone, updatedAt: now };
  return withSteer(next, { kind: on ? "pause" : "unpause", stepId: id, text: s.title }, now);
}

/** Remove a step the user added. Claude's own steps are skipped instead, so their history stays. */
export function removeStep(plan: Plan, id: string, now = Date.now()): Plan {
  const s = findStep(plan, id);
  if (!s || s.by !== "you") return plan;
  const gone = new Set([id, ...descendants(plan, id).map((d) => d.id)]);
  const steps = plan.steps.filter((x) => !gone.has(x.id));
  const unseen = plan.steering.some((w) => !w.delivered && w.kind === "add" && w.stepId === id);
  const steering = plan.steering.filter((w) => !(w.stepId && gone.has(w.stepId) && !w.delivered));
  if (unseen) return { ...plan, steps, steering, updatedAt: now };
  return withSteer({ ...plan, steps, steering }, { kind: "remove", stepId: id, text: s.title, prev: s.title }, now);
}

/** The user changed the design itself while the agent worked. */
export function designEdited(plan: Plan, what: string, now = Date.now()): Plan {
  const prior = plan.steering.find((w) => !w.delivered && w.kind === "design");
  if (prior) return { ...plan, steering: plan.steering.map((w) => (w === prior ? { ...w, text: what, at: now } : w)) };
  return withSteer(plan, { kind: "design", text: what }, now);
}

// ---------- delivering steering ----------

/** Which agent a change is for: its step's owner while that branch is open, else the main loop. */
export function steerScope(plan: Plan, s: Steer, isOpen: (branch: string) => boolean): string {
  const owner = findStep(plan, s.stepId)?.owner ?? MAIN;
  return owner !== MAIN && isOpen(owner) ? owner : MAIN;
}

/**
 * Take the changes waiting for one agent, formatted for its next tool result,
 * and mark them delivered. Returns null text when there is nothing to send.
 */
export function takeSteering(plan: Plan, scope = MAIN, isOpen: (branch: string) => boolean = () => false, now = Date.now()): { plan: Plan; text: string | null } {
  const mine = plan.steering.filter((s) => !s.delivered && steerScope(plan, s, isOpen) === scope);
  if (!mine.length) return { plan, text: null };
  const text = formatSteering(plan, mine, scope);
  const ids = new Set(mine.map((s) => s.id));
  return { plan: { ...plan, steering: plan.steering.map((s) => (ids.has(s.id) ? { ...s, delivered: now } : s)), updatedAt: now }, text };
}

const quote = (s: string) => `“${s.replace(/<\/?plan-changes>/gi, "").replace(/[“”]/g, '"')}”`;

export function formatSteering(plan: Plan, steers: Steer[], scope = MAIN): string {
  const local = (id?: string) => (!id ? "" : scope !== MAIN && id.startsWith(scope + "/") ? id.slice(scope.length + 1) : id);
  const ref = (id?: string) => {
    const s = findStep(plan, id);
    return s ? `step ${local(s.id)} ${quote(s.title)}` : id ? `step ${local(id)}` : "";
  };
  const lines = steers.map((w) => {
    const st = findStep(plan, w.stepId);
    switch (w.kind) {
      case "rename":
        return `- Renamed step ${local(w.stepId)} from ${quote(w.prev ?? "")} to ${quote(w.text)}. Do the step as they now describe it.`;
      case "note":
        return `- Note on ${ref(w.stepId)}: ${quote(w.text)}`;
      case "add": {
        const where = w.after ? ` after ${ref(w.after)}` : w.parent ? ` inside ${ref(w.parent)}` : "";
        return `- Added step ${local(w.stepId)} ${quote(w.text)}${where}. Do it in order and keep id ${local(w.stepId)} in your plan.`;
      }
      case "skip":
        return `- Skip ${ref(w.stepId)}${st && descendants(plan, st.id).length ? " and its sub-steps" : ""}. Do not do it; if you already started it, stop and keep the design consistent.`;
      case "restore":
        return `- Do ${ref(w.stepId)} after all (they had skipped it).`;
      case "next":
        return `- Do ${ref(w.stepId)} next, before the other remaining steps.`;
      case "pause":
        return `- Pause for their review after ${ref(w.stepId)}. Kerf stops you once you mark it done; carry on normally until then.`;
      case "unpause":
        return `- No pause after ${ref(w.stepId)} any more.`;
      case "remove":
        return `- Removed step ${local(w.stepId)} ${quote(w.prev ?? w.text)} that they had added. Leave it out.`;
      case "design":
        return `- Edited the design themselves (${w.text}). Call get_design before your next edit and keep their change.`;
    }
  });
  return [
    "<plan-changes>",
    "While you worked, the user changed your plan in Kerf's to-do tree. These are the user's own instructions and come before your plan: follow them, adjust the work, and call update_plan so the tree shows what you will now do.",
    ...lines,
    "</plan-changes>",
  ].join("\n");
}

/** The waiting changes in a line or two, for the user's own message when they send them. */
export function describeSteering(plan: Plan): string {
  const name = (id?: string) => `“${findStep(plan, id)?.title ?? "a step"}”`;
  const parts = pendingSteering(plan).map((w) => {
    switch (w.kind) {
      case "rename":
        return `renamed “${w.prev}” to “${w.text}”`;
      case "note":
        return `note on ${name(w.stepId)}: ${w.text}`;
      case "add":
        return `added “${w.text}”`;
      case "skip":
        return `skip ${name(w.stepId)}`;
      case "restore":
        return `do ${name(w.stepId)} after all`;
      case "next":
        return `do ${name(w.stepId)} next`;
      case "pause":
        return `pause after ${name(w.stepId)}`;
      case "unpause":
        return `no pause after ${name(w.stepId)}`;
      case "remove":
        return `removed “${w.prev ?? w.text}”`;
      case "design":
        return `edited the design (${w.text})`;
    }
  });
  return parts.length ? `Plan changes: ${parts.join("; ")}.` : "";
}

// ---------- activity ----------

export function addActivity(plan: Plan, stepId: string, a: Omit<PlanActivity, "at">, now = Date.now()): Plan {
  if (!findStep(plan, stepId)) return plan;
  return { ...mapStep(plan, stepId, (s) => ({ ...s, activity: [...s.activity, { ...a, at: now }].slice(-LIMITS.activity) })), updatedAt: now };
}

export function endActivity(plan: Plan, activityId: string, status: "done" | "error", title?: string, now = Date.now()): Plan {
  const s = plan.steps.find((x) => x.activity.some((a) => a.id === activityId));
  if (!s) return plan;
  return { ...mapStep(plan, s.id, (x) => ({ ...x, activity: x.activity.map((a) => (a.id === activityId ? { ...a, status, title: title ?? a.title } : a)) })), updatedAt: now };
}

// ---------- the store ----------

export const usePlan = create<Plan>(() => emptyPlan());
const getPlan = usePlan.getState;
const setPlan = (p: Plan) => usePlan.setState(p, true);
const change = (fn: (p: Plan) => Plan) => setPlan(fn(getPlan()));

/** Branches whose agent is still running; changes on closed branches go to the main loop. */
const openBranches = new Set<string>();
const isOpen = (b: string) => openBranches.has(b);

export function loadPlan(saved: unknown) {
  openBranches.clear();
  const p = saved && typeof saved === "object" && Array.isArray((saved as Plan).steps) ? (saved as Plan) : emptyPlan();
  // anything that was running when the page closed did not finish
  setPlan({
    ...emptyPlan(),
    ...p,
    pauseHit: null,
    steps: p.steps.map((s) => ({
      ...s,
      // no branch agent survives a reload
      ...(s.kind !== "step" && (s.status === "doing" || s.status === "todo") ? { status: "blocked" as const, detail: "Interrupted when the page closed." } : s.owner !== MAIN && s.status === "doing" ? { status: "blocked" as const } : {}),
      notes: s.notes ?? [],
      activity: (s.activity ?? []).map((a) => (a.status === "running" ? { ...a, status: "error" as const, title: `${a.title} (interrupted)` } : a)),
    })),
    steering: p.steering ?? [],
  });
}
export const resetPlan = () => {
  openBranches.clear();
  setPlan(emptyPlan());
};
export const planSnapshot = (): Plan => getPlan();

export const updatePlanFromClaude = (input: { goal?: string; steps: StepInput[]; newPlan?: boolean }) => change((p) => applyUpdate(p, input, { isOpen }));
export const userRename = (id: string, title: string) => change((p) => renameStep(p, id, title));
export const userNote = (id: string, text: string) => change((p) => addNote(p, id, text));
export const userRemoveNote = (stepId: string, noteId: string) => change((p) => removeNote(p, stepId, noteId));
export const userSkip = (id: string) => change((p) => skipStep(p, id));
export const userRestore = (id: string) => change((p) => restoreStep(p, id));
export const userDoNext = (id: string) => change((p) => doNext(p, id));
export const userTogglePause = (id: string) => change((p) => togglePause(p, id));
export const userRemove = (id: string) => change((p) => removeStep(p, id));
export function userAdd(where: { after?: string; parent?: string }, title: string): string | null {
  const r = addStep(getPlan(), where, title);
  setPlan(r.plan);
  return r.id;
}
export const noteDesignEdit = (what: string) => change((p) => designEdited(p, what));

/** For the main loop: the user's changes since the last tool boundary, or null. */
export function takeMainSteering(): string | null {
  const r = takeSteering(getPlan(), MAIN, isOpen);
  if (r.text) setPlan(r.plan);
  return r.text;
}

/** For the main loop: the title of a step the user asked to pause after, once, when it has just been finished. */
export function takePauseHit(): string | null {
  const p = getPlan();
  if (!p.pauseHit) return null;
  const title = findStep(p, p.pauseHit)?.title ?? "that step";
  setPlan({ ...p, pauseHit: null, pausedAfter: title });
  return title;
}

/** Mirror a chat tool call under the step the main loop is on. */
export function mainActivityStart(itemId: string, title: string) {
  const cur = currentStep(getPlan());
  if (cur) change((p) => addActivity(p, cur.id, { id: itemId, title, status: "running", itemId }));
}
export const mainActivityEnd = (itemId: string, status: "done" | "error", title?: string) => change((p) => endActivity(p, itemId, status, title));

/** Close the main loop's turn: anything still running under a step stopped with it. */
export function settleActivity() {
  const p = getPlan();
  if (!p.steps.some((s) => s.activity.some((a) => a.status === "running" && a.itemId))) return;
  setPlan({ ...p, steps: p.steps.map((s) => ({ ...s, activity: s.activity.map((a) => (a.status === "running" && a.itemId ? { ...a, status: "error" as const } : a)) })) });
}

// ---------- branches for sub-agents ----------

export interface PlanBranch {
  readonly id: string;
  /** Replace this branch's own steps (ids are local to the branch; top-level steps hang under the branch root). */
  setSteps(steps: StepInput[]): string | null;
  /** Patch one of this branch's steps by its local id. */
  updateStep(id: string, patch: Partial<Omit<StepInput, "id" | "parent">>): void;
  /** An activity line under a step (or the branch root); returns an id for endLog. */
  log(title: string, stepId?: string): string;
  endLog(logId: string, status: "done" | "error", title?: string): void;
  /** One short line on the branch root, e.g. tokens and cost. */
  setMeta(meta: string): void;
  /** The parts the whole branch works on, lit up when its root is hovered. */
  setParts(parts: string[]): void;
  /** The branch's own state while it is open: todo (queued or waiting on another branch), doing, or blocked. */
  setStatus(status: "todo" | "doing" | "blocked", detail?: string): void;
  /** The user's changes to this branch since the last call, formatted for the agent's next tool result; null if none. */
  takeSteering(): string | null;
  /** True once the user has skipped the whole branch: the agent should stop and report. */
  readonly skipped: boolean;
  /** Close the branch. Later changes on it go to the main loop. */
  finish(status: "done" | "blocked" | "skipped", detail?: string): void;
}

/** Open a branch of the tree for a sub-agent, under a main step (by default the one the main loop is on). */
export function openBranch(opts: { title: string; agent: string; under?: string; parts?: string[]; kind?: "agent" | "review"; id?: string }): PlanBranch {
  const p0 = getPlan();
  // the same id again resumes that branch, keeping its steps
  const id = opts.id && /^[A-Za-z0-9_.-]{1,40}$/.test(opts.id) ? `b.${opts.id}` : uid("b.");
  const prior = findStep(p0, id);
  const under = opts.under !== undefined ? findStep(p0, opts.under)?.id : (prior?.parent ?? currentStep(p0)?.id);
  const root: PlanStep = {
    ...(prior ?? { notes: [], activity: [], by: "claude" as const }),
    id,
    parent: under,
    title: clip(opts.title, LIMITS.title),
    status: "doing",
    parts: opts.parts,
    owner: id,
    kind: opts.kind ?? "agent",
    agent: clip(opts.agent, 40),
    detail: undefined,
    startedAt: prior?.startedAt ?? Date.now(),
    endedAt: undefined,
  };
  setPlan({ ...p0, steps: prior ? p0.steps.map((s) => (s.id === id ? root : s)) : [...p0.steps, root], updatedAt: Date.now() });
  openBranches.add(id);
  const g = (local?: string) => (local ? `${id}/${local}` : id);
  return {
    id,
    setSteps(steps) {
      const problem = checkSteps(steps);
      if (problem) return problem;
      change((p) => applyUpdate(p, { steps }, { owner: id, root: id }));
      return null;
    },
    updateStep(local, patch) {
      change((p) => patchStep(p, g(local), { ...patch, title: patch.title !== undefined ? clip(patch.title, LIMITS.title) : undefined, detail: patch.detail !== undefined ? clip(patch.detail, LIMITS.detail) : undefined }));
    },
    log(title, stepId) {
      const aid = uid("a");
      change((p) => addActivity(p, findStep(p, g(stepId)) ? g(stepId) : id, { id: aid, title: clip(title, LIMITS.title), status: "running" }));
      return aid;
    },
    endLog(aid, status, title) {
      change((p) => endActivity(p, aid, status, title));
    },
    setMeta(meta) {
      change((p) => patchStep(p, id, { meta: clip(meta, 80) }));
    },
    setParts(parts) {
      change((p) => patchStep(p, id, { parts: parts.slice(0, 60) }));
    },
    setStatus(status, detail) {
      change((p) => patchStep(p, id, { status, detail: detail !== undefined ? clip(detail, LIMITS.detail) : undefined }));
    },
    takeSteering() {
      const r = takeSteering(getPlan(), id, isOpen);
      if (r.text) setPlan(r.plan);
      return r.text;
    },
    get skipped() {
      return findStep(getPlan(), id)?.status === "skipped";
    },
    finish(status, detail) {
      change((p) => patchStep(p, id, { status, detail: detail ? clip(detail, LIMITS.detail) : undefined }));
      openBranches.delete(id);
    },
  };
}
