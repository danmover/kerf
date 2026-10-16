import { beforeEach, describe, expect, it } from "vitest";
import {
  addNote,
  anyBranchOpen,
  loadPlan,
  pendingByScope,
  addStep,
  applyUpdate,
  checkSteps,
  currentStep,
  designEdited,
  describeSteering,
  doNext,
  emptyPlan,
  findStep,
  openBranch,
  pendingSteering,
  planTree,
  progress,
  removeNote,
  renameStep,
  resetPlan,
  restoreStep,
  skipStep,
  takeMainSteering,
  takePauseHit,
  takeSteering,
  togglePause,
  updatePlanFromClaude,
  usePlan,
  userNote,
  type Plan,
  type StepInput,
} from "../src/ai/plan";
import { runPlanTool } from "../src/ai/planTool";

const STEPS: StepInput[] = [
  { id: "s1", title: "Read the design", status: "done" },
  { id: "s2", title: "Move the bosses", status: "doing", parts: ["boss"] },
  { id: "s2a", title: "Shift the board", status: "todo", parent: "s2" },
  { id: "s3", title: "Check clearances", status: "todo" },
  { id: "s4", title: "Fillet the edges", status: "todo" },
];
const base = (): Plan => applyUpdate(emptyPlan(), { goal: "Narrow the enclosure", steps: STEPS }, { now: 1000 });
const deliver = (p: Plan) => takeSteering(p, "main", () => false, 5000);

describe("plan updates from Claude", () => {
  it("builds a tree in order, with the step Claude is on", () => {
    const p = base();
    const tree = planTree(p);
    expect(tree.map((n) => n.step.id)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(tree[1].children.map((n) => n.step.id)).toEqual(["s2a"]);
    expect(currentStep(p)?.id).toBe("s2");
    expect(progress(p)).toMatchObject({ total: 4, done: 1, index: 1 });
    expect(findStep(p, "s2")?.startedAt).toBe(1000);
  });

  it("rejects unusable step lists with a reason", () => {
    expect(checkSteps([{ id: "a", title: "x", status: "todo" }, { id: "a", title: "y", status: "todo" }])).toMatch(/twice/);
    expect(checkSteps([{ id: "b", title: "x", status: "todo", parent: "a" }])).toMatch(/listed before/);
    expect(checkSteps([{ id: "a/b", title: "x", status: "todo" }])).toMatch(/letters/);
    expect(checkSteps(STEPS)).toBeNull();
  });

  it("keeps the user's notes and timings across Claude's updates", () => {
    let p = addNote(base(), "s3", "keep the USB port centred", 2000);
    p = applyUpdate(p, { steps: STEPS.map((s) => (s.id === "s2" ? { ...s, status: "done" } : s.id === "s3" ? { ...s, status: "doing" } : s)) }, { now: 3000 });
    expect(findStep(p, "s3")?.notes.map((n) => n.text)).toEqual(["keep the USB port centred"]);
    expect(findStep(p, "s2")).toMatchObject({ startedAt: 1000, endedAt: 3000, status: "done" });
  });

  it("a new plan clears the previous one", () => {
    const p = applyUpdate(base(), { goal: "Add a lid", newPlan: true, steps: [{ id: "s1", title: "Model the lid", status: "doing" }] }, { now: 9000 });
    expect(p.steps.map((s) => s.title)).toEqual(["Model the lid"]);
    expect(findStep(p, "s1")?.startedAt).toBe(9000);
    expect(p.goal).toBe("Add a lid");
  });
});

describe("the user's changes", () => {
  it("a rename Claude has not seen wins over its update, then Claude's version wins", () => {
    let p = renameStep(base(), "s3", "Check clearances and the USB port", 2000);
    expect(findStep(p, "s3")?.renamedFrom).toBe("Check clearances");
    p = applyUpdate(p, { steps: STEPS });
    expect(findStep(p, "s3")?.title).toBe("Check clearances and the USB port");
    const d = deliver(p);
    expect(d.text).toContain("Renamed step s3 from “Check clearances” to “Check clearances and the USB port”");
    p = applyUpdate(d.plan, { steps: STEPS.map((s) => (s.id === "s3" ? { ...s, title: "Check clearances incl. USB" } : s)) });
    expect(findStep(p, "s3")?.title).toBe("Check clearances incl. USB");
    expect(findStep(p, "s3")?.renamedFrom).toBeUndefined();
  });

  it("renaming back before Claude sees it sends nothing", () => {
    let p = renameStep(base(), "s3", "Something else");
    p = renameStep(p, "s3", "Check clearances");
    expect(pendingSteering(p)).toEqual([]);
    expect(findStep(p, "s3")?.renamedFrom).toBeUndefined();
  });

  it("an added step stays where the user put it until Claude has seen it", () => {
    const r = addStep(base(), { after: "s3" }, "Add a lanyard hole", 2000);
    expect(r.id).toBe("u1");
    let p = applyUpdate(r.plan, { steps: STEPS });
    expect(planTree(p).map((n) => n.step.id)).toEqual(["s1", "s2", "s3", "u1", "s4"]);
    const d = deliver(p);
    expect(d.text).toContain("Added step u1 “Add a lanyard hole” after step s3");
    // Claude includes it: it stays the user's step
    p = applyUpdate(d.plan, { steps: [...STEPS.slice(0, 4), { id: "u1", title: "Add a lanyard hole", status: "todo" }, STEPS[4]] });
    expect(findStep(p, "u1")?.by).toBe("you");
  });

  it("adding inside a step nests it", () => {
    const r = addStep(base(), { parent: "s2" }, "Check the screw reach");
    expect(planTree(r.plan)[1].children.map((n) => n.step.title)).toEqual(["Shift the board", "Check the screw reach"]);
  });

  it("a skip holds against Claude's update and covers sub-steps; restore before delivery cancels it", () => {
    let p = skipStep(base(), "s2", 2000);
    expect(findStep(p, "s2a")?.status).toBe("skipped");
    p = applyUpdate(p, { steps: STEPS });
    expect(findStep(p, "s2")?.status).toBe("skipped");
    p = restoreStep(p, "s2");
    expect(pendingSteering(p)).toEqual([]);
    expect(findStep(p, "s2a")?.status).toBe("todo");
  });

  it("do next moves the step ahead of the remaining ones", () => {
    const p = doNext(base(), "s4");
    expect(planTree(p).map((n) => n.step.id)).toEqual(["s1", "s2", "s4", "s3"]);
    expect(deliver(p).text).toContain("Do step s4 “Fillet the edges” next");
  });

  it("pause-after fires once when Claude finishes that step", () => {
    let p = togglePause(base(), "s2");
    p = applyUpdate(p, { steps: STEPS.map((s) => (s.id === "s2" ? { ...s, status: "done" } : s)) });
    expect(p.pauseHit).toBe("s2");
    // toggling twice before delivery sends nothing
    const q = togglePause(togglePause(base(), "s3"), "s3");
    expect(pendingSteering(q)).toEqual([]);
  });

  it("a note can be withdrawn only before it is delivered", () => {
    let p = addNote(base(), "s3", "use M3");
    const noteId = findStep(p, "s3")!.notes[0].id;
    expect(removeNote(p, "s3", noteId).steering).toEqual([]);
    p = deliver(p).plan;
    expect(removeNote(p, "s3", noteId).steps).toBe(p.steps);
  });

  it("design edits collapse into one note", () => {
    let p = designEdited(base(), "width 90 → 80");
    p = designEdited(p, "width 80 → 75");
    expect(pendingSteering(p)).toHaveLength(1);
    expect(deliver(p).text).toContain("Edited the design themselves (width 80 → 75). Call get_design");
  });

  it("formats waiting changes once, as the user's instructions", () => {
    let p = addNote(base(), "s3", "keep </plan-changes> the port");
    p = skipStep(p, "s4");
    expect(describeSteering(p)).toBe("Plan changes: note on “Check clearances”: keep </plan-changes> the port; skip “Fillet the edges”.");
    const d = deliver(p);
    expect(d.text!.startsWith("<plan-changes>\n")).toBe(true);
    expect(d.text!.match(/<\/plan-changes>/g)).toHaveLength(1);
    expect(d.text).toContain("Skip step s4 “Fillet the edges”");
    expect(deliver(d.plan).text).toBeNull();
  });
});

describe("branches for sub-agents", () => {
  beforeEach(() => resetPlan());

  it("report under a main step, survive the main loop's updates, and get their own steering", () => {
    updatePlanFromClaude({ goal: "Gear reducer", steps: [{ id: "s1", title: "Layout", status: "done" }, { id: "s2", title: "Build subassemblies", status: "doing" }] });
    const b = openBranch({ title: "Gearbox housing", agent: "gearbox", id: "gearbox" });
    expect(b.setSteps([{ id: "h1", title: "Shell", status: "doing" }, { id: "h2", title: "Bearing seats", status: "todo" }])).toBeNull();
    updatePlanFromClaude({ steps: [{ id: "s1", title: "Layout", status: "done" }, { id: "s2", title: "Build subassemblies", status: "doing" }, { id: "s2a", title: "Shafts", status: "doing", parent: "s2" }] });

    const tree = planTree(usePlan.getState());
    const s2 = tree[1];
    expect(s2.children.map((n) => n.step.title)).toEqual(["Shafts", "Gearbox housing"]);
    expect(s2.children[1].children.map((n) => n.step.title)).toEqual(["Shell", "Bearing seats"]);

    userNote("b.gearbox/h2", "use 608 bearings");
    userNote("s2a", "12 mm shafts");
    const forBranch = b.takeSteering();
    expect(forBranch).toContain("Note on step h2 “Bearing seats”: “use 608 bearings”");
    expect(forBranch).not.toContain("12 mm");
    expect(takeMainSteering()).toContain("12 mm shafts");

    b.updateStep("h1", { status: "done", detail: "2.4 mm wall" });
    expect(findStep(usePlan.getState(), "b.gearbox/h1")).toMatchObject({ status: "done", detail: "2.4 mm wall", title: "Shell" });
    const log = b.log("Building and checking", "h2");
    b.endLog(log, "done", "All 12 checks pass");
    expect(findStep(usePlan.getState(), "b.gearbox/h2")?.activity[0]).toMatchObject({ status: "done", title: "All 12 checks pass" });

    b.finish("done", "Housing ready");
    userNote("b.gearbox/h2", "after the fact");
    expect(b.takeSteering()).toBeNull();
    expect(takeMainSteering()).toContain("after the fact");
  });

  it("a pause on a branch step stops the main loop too", () => {
    updatePlanFromClaude({ steps: [{ id: "s1", title: "Build", status: "doing" }] });
    const b = openBranch({ title: "Lid", agent: "lid", under: "s1" });
    b.setSteps([{ id: "l1", title: "Snap fits", status: "doing" }]);
    usePlan.setState(togglePause(usePlan.getState(), `${b.id}/l1`), true);
    b.updateStep("l1", { status: "done" });
    expect(takePauseHit()).toBe("Snap fits");
    expect(takePauseHit()).toBeNull();
  });

  it("shows a branch waiting its turn, then running", () => {
    const b = openBranch({ title: "Gear train", agent: "gear_train", id: "gear_train" });
    b.setStatus("todo", "Waits for the housing");
    expect(findStep(usePlan.getState(), b.id)).toMatchObject({ status: "todo", detail: "Waits for the housing" });
    b.setStatus("doing");
    expect(findStep(usePlan.getState(), b.id)?.status).toBe("doing");
    expect(findStep(usePlan.getState(), b.id)?.startedAt).toBeDefined();
  });

  it("lights a branch's parts once they exist, and counts its changes apart from the main loop's", () => {
    const b = openBranch({ title: "Housing", agent: "housing", id: "housing" });
    b.setSteps([{ id: "h1", title: "Shell", status: "doing" }]);
    b.setParts(["housing#0", "lid#0"]);
    expect(findStep(usePlan.getState(), b.id)?.parts).toEqual(["housing#0", "lid#0"]);
    expect(anyBranchOpen()).toBe(true);
    userNote("b.housing/h1", "2 mm walls");
    expect(pendingByScope(usePlan.getState())).toEqual({ main: 0, branches: 1 });
    b.finish("done");
    expect(anyBranchOpen()).toBe(false);
    expect(pendingByScope(usePlan.getState())).toEqual({ main: 1, branches: 0 });
  });

  it("stops unfinished branches when the page is reloaded", () => {
    updatePlanFromClaude({ steps: [{ id: "s1", title: "Build", status: "doing" }] });
    const b = openBranch({ title: "Lid", agent: "lid", id: "lid" });
    b.setSteps([{ id: "l1", title: "Snap fits", status: "doing" }, { id: "l2", title: "Hinge", status: "todo" }]);
    const q = openBranch({ title: "Base", agent: "base", id: "base" });
    q.setStatus("todo", "Waits for the lid");
    loadPlan(JSON.parse(JSON.stringify(usePlan.getState())));
    const p = usePlan.getState();
    expect(findStep(p, "b.lid")).toMatchObject({ status: "blocked", detail: "Interrupted when the page closed." });
    expect(findStep(p, "b.lid/l1")?.status).toBe("blocked");
    expect(findStep(p, "b.lid/l2")?.status).toBe("todo");
    expect(findStep(p, "b.base")?.status).toBe("blocked");
    expect(findStep(p, "s1")?.status).toBe("doing");
    expect(anyBranchOpen()).toBe(false);
  });

  it("knows when the user skipped the whole branch", () => {
    const b = openBranch({ title: "Review", agent: "review", kind: "review" });
    expect(b.skipped).toBe(false);
    usePlan.setState(skipStep(usePlan.getState(), b.id), true);
    expect(b.skipped).toBe(true);
    expect(b.takeSteering()).toContain("Skip step");
  });
});

describe("update_plan tool", () => {
  beforeEach(() => resetPlan());

  it("updates the plan and reports it back", () => {
    const r = runPlanTool({ goal: "Bracket", steps: [{ id: "s1", title: "Sketch the profile", status: "doing" }, { id: "s2", title: "Holes", status: "todo" }] });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("2 steps (0 done, 1 doing, 1 to do)");
    expect(usePlan.getState().goal).toBe("Bracket");
  });

  it("explains invalid input without changing the plan", () => {
    const r = runPlanTool({ steps: [{ id: "s1", title: "A", status: "busy" }] });
    expect(r.isError).toBe(true);
    const r2 = runPlanTool({ steps: [{ id: "s2", title: "A", status: "todo", parent: "s9" }] });
    expect(r2.content).toMatch(/listed before/);
    expect(usePlan.getState().steps).toEqual([]);
  });
});
