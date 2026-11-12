// The checks report's view of parts made in pieces (split:): how each was
// cut, what joins the pieces and how big each one is, and what stopped a
// joint taking its pins.

import type { CheckItem } from "./checks";
import type { Model, SplitRecord } from "./model";

const fmt = (n: number, d = 1) => String(+n.toFixed(d));
const list = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

function cutWords(r: SplitRecord): string {
  return list(r.cuts.filter((c) => c.at.length).map((c) => `across ${c.axis} at ${list(c.at.map((t) => `${c.axis} = ${fmt(t)}`))}`));
}

function joinWords(r: SplitRecord): string {
  const perJoint = r.joints.length ? Math.max(...r.joints.map((j) => j.pins)) : 0;
  if (r.join === "glue") return "The pieces are glued face to face (epoxy or, for PLA and PETG, a gel superglue); clamp them square while it sets.";
  if (r.join === "none") return "The cut faces are left plain: join the pieces yourself (bolts through flanges, a strap, a bracket).";
  if (!r.pin) return "There was no room for pins in any joint, so the pieces are glued face to face.";
  const pins = r.join === "dowel" ? `${r.pin.count} steel dowel pins Ø${fmt(r.pin.d)} × ${fmt(r.pin.length, 0)} mm (ISO 8734)` : `${r.pin.count} printed pins Ø${fmt(r.pin.d)} × ${fmt(r.pin.length - 0.4)} mm (${r.pin.name})`;
  return `${pins}, ${perJoint > 1 ? `up to ${perJoint} in each joint` : "one in each joint"}, in Ø${fmt(r.pin.hole, 2)} mm holes ${fmt(r.pin.length / 2 + 0.5)} mm deep in both pieces: they line the pieces up, and glue on the faces holds them.`;
}

export function splitItems(model: Model): CheckItem[] {
  const out: CheckItem[] = [];
  for (const r of model.splits ?? []) {
    const base = { category: "process" as const, span: r.span, basis: "geometry" as const };
    if (r.status === "waiting") continue;
    if (r.status === "error") {
      out.push({ ...base, id: `split:${r.name}`, status: "fail", parts: r.pieces, title: `${r.label} could not be cut into pieces`, detail: `split: ${r.asked}: ${r.error ?? "the cuts could not be worked out"}.`, fix: "Say where to cut it with pieces(X, at: [..]), or check the part builds." });
      continue;
    }
    if (r.status === "whole") {
      out.push({ ...base, id: `split:${r.name}`, status: "info", parts: r.pieces, title: `${r.label} is made in one piece`, detail: `${r.bed ? `It fits the ${r.bed.what} (${r.bed.size.map((x) => fmt(x, 0)).join(" × ")} mm) whole` : "No cut crosses it"}, so split: ${r.asked} leaves it whole.` });
      continue;
    }
    const sizes = r.sizes.map((s) => s.map((x) => fmt(x, 0)).join(" × ")).join("; ");
    const thin = r.warnings.filter((w) => /joint/.test(w));
    const other = r.warnings.filter((w) => !/joint/.test(w));
    out.push({
      ...base,
      id: `split:${r.name}`,
      status: other.some((w) => /too big/.test(w)) ? "fail" : "pass",
      parts: [...r.pieces, ...(r.pin ? [r.pin.name] : [])],
      title: `${r.label} is made in ${r.pieces.length} pieces`,
      detail: `Cut ${cutWords(r)}${r.bed ? `, the fewest pieces that fit the ${r.bed.what} (${r.bed.size.map((x) => fmt(x, 0)).join(" × ")} mm)` : ""}. Pieces ${list(r.pieces)}: ${sizes} mm. ${joinWords(r)}${other.length ? ` ${other.join(" ")}` : ""}`,
      ...(other.some((w) => /too big/.test(w)) ? { fix: "Cut it in more places, or across a second direction too: split: [X, Y]." } : {}),
    });
    for (const w of thin)
      out.push({
        ...base,
        id: `split:${r.name}:joint:${w.slice(0, 40)}`,
        status: "warn",
        parts: r.pieces,
        title: `${r.label}: a joint without all its pins`,
        detail: w,
        fix: "Move the cut to where the part is solid (pieces(X, at: [..])), thicken the walls where it is cut, use a smaller pin:, or glue that joint.",
      });
  }
  return out;
}
