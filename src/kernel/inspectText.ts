// Plain-text form of a part inspection, for Claude. Kept apart from
// inspect.ts so the UI can use it without loading OpenCASCADE.

import type { InspectResult } from "./protocol";

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Plain-text summary of an inspection, for Claude. */
export function inspectText(name: string, r: InspectResult, selText?: string): string {
  const [lo, hi] = r.bbox;
  const size = [0, 1, 2].map((k) => r2(hi[k] - lo[k]));
  const lines = [
    `Part "${name}" in its own coordinates: size ${size.join(" × ")} mm (x ${lo[0]}..${hi[0]}, y ${lo[1]}..${hi[1]}, z ${lo[2]}..${hi[2]}), volume ${r.volume} mm³, ${r.faces} faces, ${r.edges} edges.`,
    `Edges: ${r.edgeStats.convex} sharp outside (convex), ${r.edgeStats.concave} sharp inside (concave), ${r.edgeStats.smooth} smooth.`,
  ];
  if (r.features.length) {
    lines.push("Named features: " + r.features.map((f) => `${f.name} (${f.kind}: ${f.faces} faces, ${f.root} root edges, ${f.tip} tip edges)`).join("; "));
  } else lines.push("No named features. Name one with `add ... as name` to pick its edges.");
  if (r.selection) {
    const s = r.selection;
    lines.push(`Selection ${selText ?? ""} picks ${s.count} ${s.kind}${s.count === 0 ? ". Nothing matched." : ":"}`);
    for (const e of s.edges ?? []) lines.push(`  - ${e.kind}${e.radius ? ` r${e.radius}` : ""}, ${e.length} mm long, ${e.convexity}, at (${e.mid.join(", ")})${e.features.length ? `, on ${e.features.join(" + ")}` : ""}`);
    for (const f of s.faces ?? []) lines.push(`  - ${f.kind} face at (${f.center.join(", ")})${f.normal ? ` facing (${f.normal.join(", ")})` : ""}${f.features.length ? `, part of ${f.features.join(" + ")}` : ""}`);
    const shown = (s.edges ?? s.faces ?? []).length;
    if (s.count > shown) lines.push(`  … and ${s.count - shown} more.`);
  }
  if (r.pick) {
    const p = r.pick;
    if (p.edge) lines.push(`Nearest edge (${p.edge.distance} mm away): ${p.edge.kind}, ${p.edge.length} mm, ${p.edge.convexity}, at (${p.edge.mid.join(", ")}).`);
    if (p.face) lines.push(`Nearest face (${p.face.distance} mm away): ${p.face.kind}${p.face.features.length ? `, part of ${p.face.features.join(" + ")}` : ""}.`);
    if (p.selectors.length) lines.push("Selectors for it: " + p.selectors.join(", "));
  }
  return lines.join("\n");
}
