// Branches in a project, as the History tab drives them: a branch keeps its own versions and design, switching shows
// each branch's latest with its own undo, merging back brings each side's changes in (again after more work, and
// again after main undid a merge), and a project file keeps the branches.

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/app/ui", async (orig) => ({ ...(await orig<typeof import("../src/app/ui")>()), toast: () => 0 }));

import { applyMerge, createBranch, createProject, deleteBranch, findBranch, openBranch, openProject, planMerge, projectBranches, renameBranch, switchBranch, commitSource, undo, useProject, flushPending } from "../src/app/project";
import { useDesign } from "../src/core/engine";
import { MAIN, branchLine, branchOf, mergedText } from "../src/core/branches";
import { projectFile, readImportFile } from "../src/persist/files";
import * as db from "../src/persist/db";
import { runBranchTool } from "../src/ai/branchTool";

const SRC = ['design "Bracket"', "param width = 40", "", "part arm {", "  body box(width, 10, 4)", "}", "", "part base {", "  body box(60, 60, 5)", "}"].join("\n");
const src = () => useDesign.getState().source;
const edit = (from: string, to: string) => commitSource(src().replace(from, to), "you");

describe("branches in a project", () => {
  beforeAll(async () => {
    const p = await createProject("blank", "Bracket", SRC);
    await openProject(p.id);
  });

  it("keeps a branch's edits off main until it is merged, and each branch's undo apart", async () => {
    edit("param width = 40", "param width = 42");
    expect(await createBranch("longer arm")).toBeNull();
    const arm = findBranch("Longer Arm")!;
    expect(openBranch()).toBe(arm.id);
    edit("box(width, 10, 4)", "box(width, 12, 4)");
    edit("param width = 42", "param width = 50");
    expect(useProject.getState().versions.at(-1)!.branch).toBe(arm.id);

    expect(await switchBranch(MAIN)).toBeNull();
    expect(src()).toContain("box(width, 10, 4)");
    expect(src()).toContain("width = 42");
    // main's undo is main's: back to before the width change
    expect(undo()).toBe(true);
    expect(src()).toContain("width = 40");
    commitSource(src().replace("param width = 40", "param width = 45"), "you");

    expect(await switchBranch(arm.id)).toBeNull();
    expect(src()).toContain("box(width, 12, 4)");
    expect(src()).toContain("width = 50");
    // the branch's line: main's versions up to the fork, then its own
    const line = branchLine(useProject.getState().versions, projectBranches(), arm.id);
    expect(line.versions.map((v) => v.message)).toContain("Branched from main");
    expect(line.versions.some((v) => v.source.includes("width = 45"))).toBe(false);
  });

  it("merges the branch into main, then again after more work, and again after main undid a merge", async () => {
    const arm = findBranch("longer arm")!;
    let plan = planMerge(arm.id, MAIN);
    if (typeof plan === "string") throw new Error(plan);
    // main moved the width to 45 and the branch to 50: both changed that line, and main's is kept
    expect(plan.result.conflicts.length).toBe(1);
    expect(plan.result.conflicts[0]).toMatchObject({ ours: ["param width = 45"], theirs: ["param width = 50"], base: ["param width = 42"] });
    expect(await applyMerge(plan, mergedText(plan.result, () => "ours"))).toBeNull();
    expect(openBranch()).toBe(MAIN);
    expect(src()).toContain("width = 45");
    expect(src()).toContain("box(width, 12, 4)");
    expect(useProject.getState().versions.at(-1)!.message).toBe("Merged “longer arm” into main");

    // more work on the branch, merged again without the width coming up again
    await switchBranch(arm.id);
    edit("box(width, 12, 4)", "box(width, 14, 4)");
    plan = planMerge(arm.id, MAIN);
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.result.conflicts).toEqual([]);
    expect(await applyMerge(plan, mergedText(plan.result, () => "ours"))).toBeNull();
    expect(src()).toContain("box(width, 14, 4)");
    expect(src()).toContain("width = 45");

    // main takes the second merge back: merging again brings the 14 back
    undo();
    expect(src()).toContain("box(width, 12, 4)");
    plan = planMerge(arm.id, MAIN);
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.upToDate).toBe(false);
    expect(plan.result.conflicts).toEqual([]);
    expect(mergedText(plan.result, () => "ours")).toContain("box(width, 14, 4)");
  });

  it("takes main's changes into the branch", async () => {
    const arm = findBranch("longer arm")!;
    commitSource(src().replace("box(60, 60, 5)", "box(60, 60, 6)"), "you");
    await switchBranch(arm.id);
    const plan = planMerge(MAIN, arm.id);
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.result.conflicts).toEqual([]);
    expect(await applyMerge(plan, mergedText(plan.result, () => "ours"))).toBeNull();
    expect(openBranch()).toBe(arm.id);
    expect(src()).toContain("box(60, 60, 6)");
    expect(src()).toContain("box(width, 14, 4)");
    // the width main settled on comes too
    expect(src()).toContain("width = 45");
    expect(projectBranches().find((b) => b.id === arm.id)!.meets!.at(-1)!.kind).toBe("took");
  });

  it("lets Claude list, compare and merge branches", async () => {
    const arm = findBranch("longer arm")!;
    const list = await runBranchTool("branches", { action: "list" });
    expect(String(list!.content)).toContain("“longer arm” (open): made from main");
    const cmp = await runBranchTool("branches", { action: "compare" });
    expect(String(cmp!.content)).toMatch(/Lines: \+\d+ −\d+/);
    const merged = await runBranchTool("branches", { action: "merge" });
    expect(merged!.isError).toBeFalsy();
    expect(openBranch()).toBe(MAIN);
    expect(src()).toContain("box(width, 14, 4)");
    expect(String((await runBranchTool("branches", { action: "merge", name: arm.name }))!.content)).toContain("already has everything");
  });

  it("keeps branches in a project file", async () => {
    await flushPending();
    const cur = useProject.getState().current!;
    const versions = (await db.versionsFor(cur.id)).map((v) => ({ ts: v.ts, author: v.author, message: v.message, source: v.source, ...(v.branch ? { branch: v.branch } : {}) }));
    const text = projectFile(cur.name, cur.source, cur.template, cur.createdAt, versions, { branches: projectBranches(), branch: cur.branch });
    const back = await readImportFile(new File([text], "Bracket.kerfproj"));
    const p = back.projects[0];
    expect(p.branches!.map((b) => b.name)).toEqual(["main", "longer arm"]);
    expect(p.versions.filter((v) => branchOf(v) !== MAIN).length).toBe(versions.filter((v) => v.branch).length);
    // a damaged file: a branch made from one that isn't there is left out, and its versions show on main
    const json = JSON.parse(text);
    json.branches[1].from = "brn_missing1";
    const bad = (await readImportFile(new File([JSON.stringify(json)], "x.kerfproj"))).projects[0];
    expect(bad.branches).toBeUndefined();
    expect(bad.versions.every((v) => !v.branch)).toBe(true);
  });

  it("renames and deletes a branch, going back to main", async () => {
    const arm = findBranch("longer arm")!;
    expect(renameBranch(arm.id, "main")).toMatch(/main/);
    expect(renameBranch(arm.id, "arm 14")).toBeNull();
    expect(findBranch("arm 14")!.id).toBe(arm.id);
    await switchBranch(arm.id);
    expect(await deleteBranch(arm.id)).toBeNull();
    expect(openBranch()).toBe(MAIN);
    expect(useProject.getState().current!.branches).toBeUndefined();
    expect(useProject.getState().versions.some((v) => v.branch === arm.id)).toBe(false);
    expect((await db.versionsFor(useProject.getState().current!.id)).some((v) => v.branch === arm.id)).toBe(false);
  });
});
