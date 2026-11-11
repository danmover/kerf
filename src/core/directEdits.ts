// Direct edits from the 3D view: push or pull, delete or move the faces the
// user picked. Each part gets one new line at the end of its block, because a
// direct edit works on the solid as it is at that step and the picks were made
// on the finished part. An imported file becomes a part first, so its faces can
// change: component x = step("f") { at: … } turns into part x { at: … body step("f") }.

import type { Stmt } from "../lang/ast";
import { parse } from "../lang/parser";
import { fmtNum } from "../lang/values";
import type { Model } from "./model";
import { insertItem } from "./quickCommands";

export type DirectAsk = { k: "push_pull"; by: number } | { k: "delete_faces" } | { k: "move_faces"; by: [number, number, number]; copy: boolean };

export interface DirectGroup {
  /** the part block */
  block: string;
  /** the picked faces as a selector, in the part's own coordinates */
  faces: string;
  count: number;
}

export type DirectResult = { ok: true; src: string; title: string; targets: string[] } | { ok: false; why: string };

type PartStmt = Extract<Stmt, { k: "part" }>;
type CompStmt = Extract<Stmt, { k: "component" }>;

const num = (n: number) => fmtNum(Math.abs(n) < 1e-9 ? 0 : n, 3);
const faceWord = (n: number) => (n === 1 ? "a face" : `${n} faces`);

function blockOf(src: string, name: string): PartStmt | CompStmt | undefined {
  return parse(src).program.stmts.find((s): s is PartStmt | CompStmt => (s.k === "part" || s.k === "component") && s.name === name);
}

/** The modifier line for an edit. */
export function directLine(ask: DirectAsk, faces: string): string {
  if (ask.k === "push_pull") return `push_pull(${num(ask.by)}, faces: ${faces})`;
  if (ask.k === "delete_faces") return `delete_faces(faces: ${faces})`;
  return `move_faces(faces: ${faces}, by: (${ask.by.map(num).join(", ")})${ask.copy ? ", copy: true" : ""})`;
}

function titleOf(ask: DirectAsk, count: number, label: string): string {
  if (ask.k === "push_pull") return ask.by > 0 ? `Pushed ${faceWord(count)} of ${label} out ${num(ask.by)} mm` : `Pulled ${faceWord(count)} of ${label} in ${num(-ask.by)} mm`;
  if (ask.k === "delete_faces") return `Took ${faceWord(count)} off ${label} and closed it up`;
  return `${ask.copy ? "Copied" : "Moved"} ${faceWord(count)} of ${label} by (${ask.by.map(num).join(", ")})`;
}

/**
 * An imported file's component written as a part with the file as its body, placed as before (a part's rotate: and
 * at: work as the component's did). Returns why not when it can't be.
 */
export function importAsPart(src: string, stmt: CompStmt): string | { why: string } {
  const callee = stmt.call.callee;
  if (callee.k !== "ident" || callee.name !== "step") return { why: `${stmt.name} is not an imported file` };
  const lineStart = src.lastIndexOf("\n", stmt.span.start - 1) + 1;
  const indent = /^[ \t]*/.exec(src.slice(lineStart))![0];
  const inner = `${indent}  `;
  const lines: string[] = [];
  for (const it of stmt.items) {
    if (it.k === "prop" || it.k === "flag") lines.push(src.slice(it.span.start, it.span.end).trim().replace(/,$/, ""));
    else return { why: `${stmt.name} has more than placement and colour in its block` };
  }
  const at = stmt.items.find((i) => i.k === "prop" && i.name === "at");
  if (at && at.k === "prop" && at.value.k === "list") return { why: `${stmt.name} is placed several times (a list of points)` };
  const call = src.slice(stmt.call.span.start, stmt.call.span.end);
  const body = [...lines, `body ${call}`].map((l) => `${inner}${l}`).join("\n");
  return `${src.slice(0, stmt.span.start)}part ${stmt.name} {\n${body}\n${indent}}${src.slice(stmt.span.end)}`;
}

/**
 * Adds the edit to each part's block, as one change to the source. Picked faces on an imported file make it a part
 * first. The caller checks the result still evaluates and commits it.
 */
export function directEdit(src: string, model: Model, ask: DirectAsk, groups: DirectGroup[]): DirectResult {
  const fail = (why: string): DirectResult => ({ ok: false, why });
  if (!groups.length || groups.every((g) => !g.count)) return fail("Pick the faces to change first (the selection filter, Q, set to faces).");
  if (ask.k === "push_pull" && !(Math.abs(ask.by) > 0)) return fail("Give the push or pull a distance in mm: positive goes out, negative in.");
  if (ask.k === "move_faces" && !ask.by.some((v) => Math.abs(v) > 0)) return fail("Give the move a distance: x, y and z in mm.");
  let out = src;
  const titles: string[] = [];
  const targets: string[] = [];
  for (const g of groups) {
    if (!g.count) continue;
    const parts = model.parts.filter((p) => p.name === g.block);
    const part = parts[0];
    if (!part) return fail(`There is no part called ${g.block}.`);
    if (part.locked) return fail(`${part.label} is locked. Unlock it in the parts list first.`);
    if (part.frame) return fail(`${part.label} is a member of frame ${part.frame}: change the frame's profile or lines instead.`);
    if (part.sheet) return fail(`${part.label} is sheet metal: change its flanges, bends and cut-outs instead, so its flat pattern stays right.`);
    let stmt = blockOf(out, g.block);
    if (!stmt) return fail(`There is no part called ${g.block}.`);
    let title = "";
    if (stmt.k === "component") {
      if (!part.imported) return fail(`${part.label} is a library part, so its faces can't be changed. Only parts made in this design and imported files can be.`);
      if (parts.length > 1) return fail(`${part.label} has ${parts.length} bodies or copies, and only a single body can be made a part here: ask Claude to make the body you want a part (part x { body step("${part.imported.file}", body: 2) }).`);
      const made = importAsPart(out, stmt);
      if (typeof made !== "string") return fail(`${part.label} can't be made a part here: ${made.why}. Ask Claude to do it.`);
      out = made;
      stmt = blockOf(out, g.block);
      if (!stmt || stmt.k !== "part") return fail(`${part.label} can't be made a part here. Ask Claude to do it.`);
      title = `Made ${part.label} a part. `;
    }
    out = insertItem(out, stmt, directLine(ask, g.faces), null);
    titles.push(title + titleOf(ask, g.count, part.label));
    targets.push(g.block);
  }
  const title = titles.length > 2 ? `${titles[0]}, and ${titles.length - 1} more` : titles.join("; ");
  return { ok: true, src: out, title, targets };
}
