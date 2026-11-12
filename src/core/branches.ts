// Branches of a design and merging them, as in Onshape or git: a branch is a line of work made from another
// branch's design, kept apart while you try something, and merged back when it works. A merge is three-way
// and line by line: the changes each branch made since the two last met go in together, and a place both changed
// differently is a conflict for the user to settle. Pure functions; src/app/project.ts keeps the branches.

import type { BranchRecord, VersionRecord } from "../persist/db";

export const MAIN = "main";

// ---------- matching lines ----------

/** Pairs [i, j] of equal lines of a and b, in order, as many as there can be (a longest common subsequence). */
export function matchLines(a: readonly string[], b: readonly string[]): [number, number][] {
  const out: [number, number][] = [];
  let h = 0;
  while (h < a.length && h < b.length && a[h] === b[h]) {
    out.push([h, h]);
    h++;
  }
  let t = 0;
  while (t < a.length - h && t < b.length - h && a[a.length - 1 - t] === b[b.length - 1 - t]) t++;
  const n = a.length - h - t;
  const m = b.length - h - t;
  if (n > 0 && m > 0) for (const [i, j] of middle(a, b, h, n, m)) out.push([i + h, j + h]);
  for (let k = 0; k < t; k++) out.push([a.length - t + k, b.length - t + k]);
  return out;
}

/** Myers' diff of a[h, h + n) and b[h, h + m): quick when they differ in a few places, however long they are. */
function middle(a: readonly string[], b: readonly string[], h: number, n: number, m: number): [number, number][] {
  const max = n + m;
  // past this many edits, the table below would grow too big: a plain longest common subsequence, or nothing
  const LIMIT = 1500;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let end = -1;
  search: for (let d = 0; d <= Math.min(max, LIMIT); d++) {
    // the furthest each diagonal reached with d - 1 edits, for the way back
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[h + x] === b[h + y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        end = d;
        break search;
      }
    }
  }
  if (end < 0) return n * m <= 4_000_000 ? lcs(a, b, h, n, m) : [];
  const out: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = end; d >= 0; d--) {
    const V = trace[d];
    const at = (k: number) => V[k + d + 1];
    const k = x - y;
    const pk = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = at(pk);
    const py = px - pk;
    while (x > px && y > py) {
      x--;
      y--;
      out.push([x, y]);
    }
    x = px;
    y = py;
  }
  return out.reverse();
}

function lcs(a: readonly string[], b: readonly string[], h: number, n: number, m: number): [number, number][] {
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[h + i] === b[h + j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[h + i] === b[h + j]) out.push([i++, j++]);
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return out;
}

// ---------- three-way merge ----------

/** A stretch of the three texts: lines all three share, or a place one or both sides changed. */
interface Chunk {
  stable: boolean;
  o: [number, number];
  a: [number, number];
  b: [number, number];
}

/** The base split into what both sides kept and the places either changed (diff3). */
function chunks(O: readonly string[], A: readonly string[], B: readonly string[]): Chunk[] {
  const inA = new Int32Array(O.length).fill(-1);
  const inB = new Int32Array(O.length).fill(-1);
  for (const [i, j] of matchLines(O, A)) inA[i] = j;
  for (const [i, j] of matchLines(O, B)) inB[i] = j;
  const out: Chunk[] = [];
  let o = 0;
  let a = 0;
  let b = 0;
  for (;;) {
    const o0 = o;
    while (o < O.length && inA[o] === a && inB[o] === b) {
      o++;
      a++;
      b++;
    }
    if (o > o0) out.push({ stable: true, o: [o0, o], a: [a - (o - o0), a], b: [b - (o - o0), b] });
    if (o >= O.length && a >= A.length && b >= B.length) return out;
    // the next base line both sides still have, where the texts meet again
    let o2 = o;
    while (o2 < O.length && (inA[o2] < 0 || inB[o2] < 0)) o2++;
    const a2 = o2 < O.length ? inA[o2] : A.length;
    const b2 = o2 < O.length ? inB[o2] : B.length;
    out.push({ stable: false, o: [o, o2], a: [a, a2], b: [b, b2] });
    o = o2;
    a = a2;
    b = b2;
  }
}

const same = (x: readonly string[], [x0, x1]: [number, number], y: readonly string[], [y0, y1]: [number, number]) => {
  if (x1 - x0 !== y1 - y0) return false;
  for (let i = 0; i < x1 - x0; i++) if (x[x0 + i] !== y[y0 + i]) return false;
  return true;
};

/** A place both branches changed differently since they last met. */
export interface MergeConflict {
  /** the lines as they were, as the branch merged into has them (ours), and as the incoming branch has them (theirs) */
  base: string[];
  ours: string[];
  theirs: string[];
  /** the line in the merged design where it starts (from 1) */
  line: number;
  /** the block it is in, such as `part arm`, when there is one */
  where?: string;
}

export type MergeChoice = "ours" | "theirs" | "both";

export interface MergeResult {
  /** the merged lines and the conflicts between them, in order */
  pieces: (string[] | MergeConflict)[];
  conflicts: MergeConflict[];
  /** how many places took a change from each side without a conflict */
  fromOurs: number;
  fromTheirs: number;
}

/** A top-level statement: its keyword and name (`part arm {`, `param width = 40`). */
const HEAD = /^(?:export\s+)?([a-z_]+)\s+([A-Za-z_]\w*)/;

/**
 * Merge `theirs` into `ours`, both made from `base`: each side's changes go in, and a place both changed differently
 * (or both added lines at the same spot, differently) is a conflict.
 */
export function merge3(base: string, ours: string, theirs: string): MergeResult {
  const O = base.split("\n");
  const A = ours.split("\n");
  const B = theirs.split("\n");
  const pieces: (string[] | MergeConflict)[] = [];
  const conflicts: MergeConflict[] = [];
  let fromOurs = 0;
  let fromTheirs = 0;
  let line = 1;
  // the top-level block the merged text has reached the inside of, to say where a conflict is
  let block: string | undefined;
  const scan = (lines: readonly string[]) => {
    for (const l of lines) {
      if (/^\}/.test(l)) block = undefined;
      else if (l && !/^\s/.test(l)) {
        const m = HEAD.exec(l);
        block = m && /\{\s*(\/\/.*)?$/.test(l) ? `${m[1]} ${m[2]}` : undefined;
      }
    }
  };
  const take = (lines: string[]) => {
    scan(lines);
    pieces.push(lines);
    line += lines.length;
  };
  for (const c of chunks(O, A, B)) {
    const a = A.slice(c.a[0], c.a[1]);
    const b = B.slice(c.b[0], c.b[1]);
    if (c.stable || same(A, c.a, B, c.b)) {
      if (!c.stable) (fromOurs++, fromTheirs++);
      take(a);
    } else if (same(A, c.a, O, c.o)) {
      fromTheirs++;
      take(b);
    } else if (same(B, c.b, O, c.o)) {
      fromOurs++;
      take(a);
    } else {
      const head = [...O.slice(c.o[0], c.o[1]), ...a, ...b].map((l) => (/^\s/.test(l) ? null : HEAD.exec(l))).find((m) => m);
      const where = block ?? (head ? `${head[1]} ${head[2]}` : undefined);
      const x: MergeConflict = { base: O.slice(c.o[0], c.o[1]), ours: a, theirs: b, line, ...(where ? { where } : {}) };
      conflicts.push(x);
      pieces.push(x);
      scan(a);
      line += Math.max(a.length, b.length);
    }
  }
  return { pieces, conflicts, fromOurs, fromTheirs };
}

/** The merged design, each conflict settled as `choose` says (both: ours, then theirs). */
export function mergedText(r: MergeResult, choose: (c: MergeConflict, i: number) => MergeChoice): string {
  const out: string[] = [];
  let i = 0;
  for (const p of r.pieces) {
    if (Array.isArray(p)) out.push(...p);
    else {
      const k = choose(p, i++);
      if (k !== "theirs") out.push(...p.ours);
      if (k !== "ours") out.push(...p.theirs);
    }
  }
  return out.join("\n");
}

/** The choice a conflict starts on: both, when each side only added lines (two new parts, say), else none. */
export const firstChoice = (c: MergeConflict): MergeChoice | undefined => (c.base.length === 0 ? "both" : undefined);

/**
 * Whether `side` has the changes `point` made to `ref`, or has changed those lines again since: so it was made from
 * `point`, or took it in, and has not been taken back past it.
 */
export function hasChanges(ref: string, point: string, side: string): boolean {
  if (point === ref || side === point) return true;
  const O = ref.split("\n");
  const P = point.split("\n");
  const S = side.split("\n");
  return !chunks(O, P, S).some((c) => !c.stable && !same(P, c.a, O, c.o) && same(S, c.b, O, c.o));
}

/**
 * Where a branch and its parent last met, for merging one into the other: the parent's design it last took, or its
 * own design the parent last took in, when the side that took it still has what that merge brought (an undo can take
 * a merge back), else the design it was made from.
 */
export function mergeBase(b: BranchRecord, parentHead: string, branchHead: string): string {
  const meets = b.meets ?? [];
  for (let i = meets.length - 1; i >= 0; i--) {
    const p = meets[i];
    if (hasChanges(p.base, p.source, p.kind === "merged" ? parentHead : branchHead)) return p.source;
  }
  return b.base;
}

/** Whether a branch has changes its parent lacks (ahead) and the parent has changes it lacks (behind). */
export function mergeState(b: BranchRecord, parentHead: string, branchHead: string): { ahead: boolean; behind: boolean } {
  if (parentHead === branchHead) return { ahead: false, behind: false };
  const base = mergeBase(b, parentHead, branchHead);
  const into = (ours: string, theirs: string) => {
    const r = merge3(base, ours, theirs);
    return r.conflicts.length > 0 || mergedText(r, () => "ours") !== ours;
  };
  return { ahead: into(parentHead, branchHead), behind: into(branchHead, parentHead) };
}

// ---------- names and lines ----------

/** The id of the branch a version (or a project, for the branch open now) is on. */
export const branchOf = (v: { branch?: string } | null | undefined) => v?.branch || MAIN;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** A branch name as kept: no control characters, spaces collapsed, at most 40 characters. */
export const cleanBranchName = (s: string) =>
  s
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);

/** Why a name can't be a branch's (other than the branch `except`, by id), or null when it can. */
export function branchNameProblem(name: string, branches: readonly { id?: string; name: string }[], except?: string): string | null {
  const n = cleanBranchName(name);
  if (!n) return "Give the branch a name.";
  if (!/[\p{L}\p{N}]/u.test(n)) return "A branch name needs a letter or a number.";
  if (norm(n) === MAIN && except !== MAIN) return "main is the design's own line; pick another name.";
  if (branches.some((b) => norm(b.name) === norm(n) && (except === undefined || b.id !== except))) return `There is already a branch called “${n}”.`;
  return null;
}

/** A free name like "idea 2". */
export function nextBranchName(branches: readonly { name: string }[], stem = "idea"): string {
  for (let i = 1; ; i++) {
    const n = `${stem} ${i}`;
    if (!branchNameProblem(n, branches)) return n;
  }
}

/** The branches of a project, with main first (main alone when it has none). */
export function branchList(p: { branches?: BranchRecord[]; source: string; createdAt: number; updatedAt: number }): BranchRecord[] {
  const list = p.branches?.length ? p.branches : [];
  if (list.some((b) => b.id === MAIN)) return list;
  return [{ id: MAIN, name: MAIN, from: "", base: "", head: p.source, createdAt: p.createdAt, updatedAt: p.updatedAt }, ...list];
}

/**
 * A project's branches with those another device made that this one lacks (by id; a name taken here gets a number),
 * or null when there are none to add.
 */
export function joinBranches(p: { branches?: BranchRecord[]; source: string; createdAt: number; updatedAt: number }, theirs: readonly BranchRecord[]): BranchRecord[] | null {
  const list = branchList(p);
  const ids = new Set(list.map((b) => b.id));
  const added = theirs.filter((b) => !ids.has(b.id) && b.id !== MAIN);
  if (!added.length) return null;
  const out = [...list];
  for (const b of added) {
    let name = cleanBranchName(b.name) || "branch";
    for (let i = 2; branchNameProblem(name, out); i++) name = `${cleanBranchName(b.name).slice(0, 36) || "branch"} ${i}`;
    out.push({ ...b, name, from: ids.has(b.from) || added.some((x) => x.id === b.from) ? b.from : MAIN });
  }
  return out;
}

/** The design a project's main branch has now (what other designs place). */
export function mainSource(p: { branch?: string; branches?: BranchRecord[]; source: string }): string {
  if (!p.branch || p.branch === MAIN) return p.source;
  return p.branches?.find((b) => b.id === MAIN)?.head ?? p.source;
}

/** The ids of the branches made from `id`, and from those, and so on. */
export function descendants(branches: readonly BranchRecord[], id: string): string[] {
  const out: string[] = [];
  const walk = (n: string) => {
    for (const b of branches) if (b.from === n && !out.includes(b.id)) (out.push(b.id), walk(b.id));
  };
  walk(id);
  return out;
}

export interface BranchLine {
  /** oldest first: the branch's own versions after those of the branches it was made from, up to when it was */
  versions: VersionRecord[];
  /** where the line crosses into the branch it was made from (ids), newest fork first */
  forks: { branch: string; from: string; at: number }[];
}

/** The history a branch (by id) shows: what it was made from, then its own versions. */
export function branchLine(versions: readonly VersionRecord[], branches: readonly BranchRecord[], id: string): BranchLine {
  const byId = new Map(branches.map((b) => [b.id, b]));
  const forks: BranchLine["forks"] = [];
  const parts: VersionRecord[][] = [];
  const seen = new Set<string>();
  let n = id;
  let until = Infinity;
  while (!seen.has(n)) {
    seen.add(n);
    const b = byId.get(n);
    const own = versions.filter((v) => branchOf(v) === n && v.ts <= until);
    parts.unshift(own);
    if (!b || !b.from || n === MAIN) break;
    forks.push({ branch: n, from: b.from, at: b.createdAt });
    until = Math.min(until, b.createdAt);
    n = b.from;
  }
  return { versions: parts.flat(), forks };
}
