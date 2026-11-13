// What changed between two versions of a file, in whole lines, for the firmware editor.

/**
 * The change from a to b in whole lines: lines added above a breakpoint push it down with its code, and one on a
 * changed line stays on it, as when Claude edits the file.
 */
export function lineChange(a: string, b: string): { from: number; to: number; insert: string } {
  const A = a.split("\n");
  const B = b.split("\n");
  const m = Math.min(A.length, B.length);
  let p = 0;
  while (p < m && A[p] === B[p]) p++;
  let s = 0;
  while (s < m - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  const from = p === 0 ? 0 : A.slice(0, p).join("\n").length + 1;
  const midA = A.slice(p, A.length - s);
  const midB = B.slice(p, B.length - s);
  if (midA.length && midB.length) return { from, to: from + midA.join("\n").length, insert: midB.join("\n") };
  if (midB.length) return p < A.length ? { from, to: from, insert: midB.join("\n") + "\n" } : { from: a.length, to: a.length, insert: "\n" + midB.join("\n") };
  // lines removed: from the end of the line above, so a breakpoint on a removed line goes with it
  const len = midA.join("\n").length;
  if (s === 0) return { from: Math.max(0, from - 1), to: a.length, insert: "" };
  return from > 0 ? { from: from - 1, to: from + len, insert: "" } : { from, to: from + len + 1, insert: "" };
}
