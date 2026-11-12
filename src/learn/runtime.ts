// The lesson open beside the model: which one, which step, and the watching that moves it on. A design made from a
// tutorial or a feature sample starts its lesson when it opens; one left half way resumes when it opens again. Each
// step's check reads a snapshot of the app a moment after anything changes, and a step that comes true moves on.
// Progress is kept in this browser (it is a convenience, not part of the design).

import { create } from "zustand";
import { useDesign } from "../core/engine";
import { useView } from "../app/view";
import { commitSource, createProject, onProjectOpen, openProject, useProject } from "../app/project";
import { useSketch, startPicking } from "../ui/sketch/session";
import { useAnalysis } from "../analysis/runtime";
import { useDrawings } from "../drawing/engine";
import { openScripts, useScripts } from "../scripts/runtime";
import { openCam } from "../cam/job";
import { openSheets } from "../cam/sheetJob";
import type { ProjectRecord } from "../persist/db";
import { lessonById, nextTutorial, SAMPLES, type LearnState, type Lesson, type LessonStep } from "./lessons";

export interface ActiveLesson {
  lesson: string;
  /** the step showing; steps.length once the lesson is finished */
  step: number;
  project: string;
  startedAt: number;
  /** the step's check is true: it moves on in a moment when it came true here, or waits for Next when it was true already */
  passed?: boolean;
}

interface LearnStore {
  active: ActiveLesson | null;
  collapsed: boolean;
  /** lessons finished in this browser */
  finished: string[];
  /** bumped by Show me, so the pointer pulses again */
  pulse: number;
}

// ---------- kept in this browser ----------

const KEY = "kerf.learn.v1";

interface Saved {
  projects: Record<string, { lesson: string; step: number; startedAt: number; closed?: boolean }>;
  finished: string[];
}

function load(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Saved> | null;
    if (v && typeof v === "object") return { projects: v.projects && typeof v.projects === "object" ? v.projects : {}, finished: Array.isArray(v.finished) ? v.finished : [] };
  } catch {
    /* storage blocked or the entry broken: start afresh */
  }
  return { projects: {}, finished: [] };
}

function save(change: (s: Saved) => void) {
  const s = load();
  change(s);
  // the latest lessons are enough to resume
  const ids = Object.keys(s.projects);
  for (const id of ids.slice(0, Math.max(0, ids.length - 60))) delete s.projects[id];
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage blocked: the lesson still runs, it just won't resume */
  }
}

export const useLearn = create<LearnStore>(() => ({ active: null, collapsed: false, finished: load().finished, pulse: 0 }));
const get = useLearn.getState;
const set = useLearn.setState;

const keep = (a: ActiveLesson, closed = false) =>
  save((s) => {
    delete s.projects[a.project];
    s.projects[a.project] = { lesson: a.lesson, step: a.step, startedAt: a.startedAt, ...(closed ? { closed: true } : {}) };
  });

// ---------- what a step can see ----------

/** The app as a lesson step's check sees it. */
export function learnState(startedAt: number): LearnState {
  const d = useDesign.getState();
  const v = useView.getState();
  const sk = useSketch.getState();
  const p = useProject.getState();
  const params: LearnState["params"] = {};
  for (const x of d.model?.params ?? []) params[x.name] = x.value;
  const analyses: Record<string, string> = {};
  for (const [label, run] of useAnalysis.getState().runs) analyses[label] = run.status;
  const scripts = p.current?.scripts ?? [];
  const outputs = useScripts.getState().outputs;
  return {
    source: d.source,
    model: d.model,
    report: d.report,
    params,
    view: { dockTab: v.dockTab, dockOpen: v.dockOpen, leftTab: v.leftTab, selected: v.selected, xray: v.xray, section: v.section.on, explode: v.explode },
    drawings: useDrawings.getState().open,
    sketch: sk.active ?? (sk.picking ? "" : null),
    analyses,
    claudeVersions: p.versions.filter((x) => x.author === "claude" && x.ts >= startedAt).length,
    scripts: { count: scripts.length, onChange: scripts.filter((s) => s.onChange).length, done: Object.keys(outputs).filter((k) => outputs[k].status === "done") },
  };
}

export function activeLesson(): { lesson: Lesson; step: LessonStep | undefined; at: ActiveLesson } | null {
  const a = get().active;
  const lesson = lessonById(a?.lesson);
  return a && lesson ? { lesson, step: lesson.steps[a.step], at: a } : null;
}

// ---------- moving through it ----------

let moveTimer = 0;
let checkTimer = 0;

/** a step whose check is already true when it is reached, or gone back to, shows as done and waits for Next */
const doneAlready = (lesson: Lesson, at: ActiveLesson) => {
  const done = lesson.steps[at.step]?.done;
  try {
    return !!done && done(learnState(at.startedAt));
  } catch {
    return false;
  }
};

function go(step: number) {
  const a = get().active;
  const lesson = lessonById(a?.lesson);
  if (!a || !lesson) return;
  clearTimeout(moveTimer);
  const at: ActiveLesson = { ...a, step: Math.max(0, Math.min(step, lesson.steps.length)), passed: false };
  at.passed = doneAlready(lesson, at);
  set({ active: at, collapsed: false });
  if (at.step >= lesson.steps.length) {
    // finished: it doesn't start again when the design opens, and Find can show it again from the start
    keep(at, true);
    save((s) => void (s.finished = [...new Set([...s.finished, lesson.id])]));
    set({ finished: [...new Set([...get().finished, lesson.id])] });
  } else keep(at);
  schedule();
}

export const nextStep = () => go((get().active?.step ?? 0) + 1);
export const backStep = () => go((get().active?.step ?? 0) - 1);

/** Close the lesson; it can be shown again from Find. */
export function closeLesson() {
  const a = get().active;
  clearTimeout(moveTimer);
  if (a) keep(a, true);
  set({ active: null });
}

export const setCollapsed = (collapsed: boolean) => set({ collapsed });

/** The lesson this design was made from, closed or finished: Find offers it again. */
export function lessonToResume(): Lesson | null {
  const p = useProject.getState().current;
  if (!p || get().active?.project === p.id) return null;
  return lessonById(load().projects[p.id]?.lesson ?? p.template) ?? null;
}

/** Show the open design's lesson again, where it was left (or from the start once finished). */
export function resumeLesson() {
  const p = useProject.getState().current;
  const lesson = lessonById(load().projects[p?.id ?? ""]?.lesson ?? p?.template);
  if (!p || !lesson) return;
  const was = load().projects[p.id];
  begin(lesson, p.id, was && was.step < lesson.steps.length ? was.step : 0, was?.startedAt);
}

/** Start a lesson in a new design of its own. */
export async function startLesson(id: string) {
  const p = await createProject(id);
  await openProject(p.id);
}

/** The lesson after this one: the next tutorial, or the next sample. */
export function lessonAfter(lesson: Lesson): Lesson | undefined {
  if (lesson.kind === "tutorial") return nextTutorial(lesson.id);
  const at = SAMPLES.findIndex((s) => s.id === lesson.id);
  return at >= 0 ? SAMPLES[(at + 1) % SAMPLES.length] : undefined;
}

function begin(lesson: Lesson, project: string, step = 0, startedAt = Date.now()) {
  clearTimeout(moveTimer);
  const at: ActiveLesson = { lesson: lesson.id, step, project, startedAt };
  at.passed = doneAlready(lesson, at);
  set({ active: at, collapsed: false });
  keep(at);
  schedule();
}

function onOpen(p: ProjectRecord | null) {
  clearTimeout(moveTimer);
  if (!p) return set({ active: null });
  const was = load().projects[p.id];
  const lesson = lessonById(was?.lesson ?? p.template);
  if (!lesson) return set({ active: null });
  if (was) {
    if (was.closed) return set({ active: null });
    return begin(lesson, p.id, Math.min(was.step, lesson.steps.length - 1), was.startedAt);
  }
  // a design just made from a lesson starts it; one made before, or changed since, waits to be asked from Find
  if (p.template !== lesson.id || p.source !== lesson.source) return set({ active: null });
  begin(lesson, p.id);
}

// ---------- doing it for you ----------

const DOCK = (tab: string) => () => useView.setState({ dockTab: tab, dockOpen: true });
const LEFT = (tab: string) => () => useView.setState({ leftTab: tab });

const SHOW: Record<string, () => void> = {
  params: LEFT("params"),
  history: LEFT("history"),
  features: LEFT("features"),
  code: DOCK("code"),
  checks: DOCK("checks"),
  analysis: DOCK("analysis"),
  bom: DOCK("bom"),
  make: DOCK("make"),
  scripts: () => openScripts(),
  sketch: () => {
    if (!useSketch.getState().active) startPicking();
  },
  cam: () => void openCam(),
  sheets: () => void openSheets(),
};

/** Show me: open what the step is about and point at it again. */
export function showStep() {
  const s = activeLesson()?.step;
  if (!s) return;
  if (s.show) SHOW[s.show]?.();
  set({ pulse: get().pulse + 1 });
}

/** Write it for me: the step's change, made as one version the user can undo. */
export function applyStep() {
  const s = activeLesson()?.step;
  if (!s?.apply) return;
  const src = useDesign.getState().source;
  const next = s.apply(src);
  if (next !== src) commitSource(next, "you", `Tutorial: ${s.title.toLowerCase()}`);
  useView.setState({ dockTab: "code", dockOpen: true });
}

// ---------- watching ----------

function schedule() {
  if (!get().active || checkTimer) return;
  checkTimer = window.setTimeout(() => {
    checkTimer = 0;
    check();
  }, 250);
}

function check() {
  const found = activeLesson();
  if (!found?.step?.done) return;
  const { step, at } = found;
  if (at.passed || useProject.getState().current?.id !== at.project) return;
  let ok = false;
  try {
    ok = step.done!(learnState(at.startedAt));
  } catch {
    ok = false;
  }
  if (!ok) return;
  set({ active: { ...at, passed: true } });
  moveTimer = window.setTimeout(() => {
    const now = get().active;
    if (now && now.lesson === at.lesson && now.step === at.step && now.project === at.project) go(at.step + 1);
  }, 1100);
}

let started = false;

/** Watch for designs made from lessons, and for what the user does in them. */
export function startLearn() {
  if (started) return;
  started = true;
  // once the design is loaded, so a step's check never reads the one before
  onProjectOpen(onOpen);
  useProject.subscribe((s) => {
    if (!s.current && get().active) onOpen(null);
  });
  for (const store of [useDesign, useView, useSketch, useAnalysis, useDrawings, useScripts, useProject] as { subscribe(f: () => void): () => void }[]) store.subscribe(schedule);
}
