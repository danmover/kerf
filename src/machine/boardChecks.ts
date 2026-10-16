// Circuit board checks for the report: every part placed on the board without
// overlaps (instant, every report), and the routed copper (from the board
// runtime, which routes in a worker and caches by the board's copper hash).

import type { CheckItem } from "../core/checks";
import { fmtNum } from "../lang/values";
import { boardSpecs } from "./boards";
import { checkPlacement, type BoardSpec, type DrcItem, type RoutedBoard } from "./pcb";
import type { BoardDef, MachineData, MachineComponent } from "./types";

/** Board components named by their reference designators (R3 → r_gnd). */
function compsByRef(m: MachineData, board: string): Map<string, MachineComponent> {
  return new Map(m.components.filter((c) => c.pcb?.board === board && c.ref).map((c) => [c.ref!, c]));
}

const SHOWN = 6;

function issueItems(def: BoardDef, m: MachineData, issues: DrcItem[], id: string, title: string): CheckItem[] {
  const refs = compsByRef(m, def.name);
  const parts = (d: DrcItem) => (d.refs ?? []).map((r) => refs.get(r)?.name).filter((n): n is string => !!n);
  const out: CheckItem[] = issues.slice(0, SHOWN).map((d, i) => ({
    id: `board:${def.name}:${id}:${i}`,
    category: "electrical",
    status: "fail",
    title: `${title}: ${d.kind === "unrouted" ? "not connected" : d.kind}`,
    detail: `${d.message} (at ${fmtNum(d.x, 1)}, ${fmtNum(d.y, 1)} mm from the board's corner)`,
    parts: parts(d).length ? parts(d) : [def.name],
    span: parts(d).length === 1 ? m.components.find((c) => c.name === parts(d)[0])?.span : def.span,
    basis: "geometry",
  }));
  if (issues.length > SHOWN) out.push({ id: `board:${def.name}:${id}:more`, category: "electrical", status: "fail", title: `${title}: ${issues.length - SHOWN} more problems`, detail: "Open the Board view in the Build tab to see every one.", parts: [def.name], span: def.span, basis: "geometry" });
  return out;
}

/** Parts on the board, inside its outline and clear of each other and the mounting holes. */
export function placementItems(m: MachineData): CheckItem[] {
  const out: CheckItem[] = [];
  for (const { def, spec } of boardSpecs(m)) {
    if (!spec.parts.length) continue;
    const issues = checkPlacement(spec);
    if (issues.length) out.push(...issueItems(def, m, issues, "place", `${def.title} board`));
    else out.push({ id: `board:${def.name}:place`, category: "electrical", status: "pass", title: `${def.title} board: parts placed`, detail: `${spec.parts.length} parts on a ${fmtNum(def.w)} × ${fmtNum(def.d)} mm board, none overlapping each other, the edge or the mounting holes.`, parts: [def.name], span: def.span, basis: "geometry" });
  }
  return out;
}

export type RouteState = { status: "routing"; board?: RoutedBoard } | { status: "done"; board: RoutedBoard } | { status: "error"; error: string };

/** The routed copper of one board: every connection made, and clear of the design rules. */
export function routeItems(m: MachineData, def: BoardDef, spec: BoardSpec, st: RouteState): CheckItem[] {
  const base = { category: "electrical" as const, parts: [def.name], span: def.span, basis: "geometry" as const };
  const id = `board:${def.name}:route`;
  if (st.status === "routing") return [{ ...base, id, status: "pending", title: `${def.title} board: routing`, detail: st.board ? "Re-routing the copper for the latest change…" : "Routing the copper tracks…" }];
  if (st.status === "error") return [{ ...base, id, status: "fail", title: `${def.title} board: routing failed`, detail: st.error }];
  const b = st.board;
  const out: CheckItem[] = [];
  if (b.unrouted.length) {
    const nets = [...new Set(b.unrouted.map((u) => u.net))];
    out.push({ ...base, id: `${id}:unrouted`, status: "fail", title: `${def.title} board: ${b.unrouted.length} connection${b.unrouted.length === 1 ? "" : "s"} not routed`, detail: `The router found no path for ${nets.slice(0, 8).join(", ")}${nets.length > 8 ? " and more" : ""}. Move parts on those nets closer together or make the board bigger.` });
  }
  if (b.drc.length) out.push(...issueItems(def, m, b.drc, "drc", `${def.title} board`));
  if (!out.length) {
    const pour = spec.nets.find((n) => n.pour)?.name;
    out.push({ ...base, id, status: "pass", title: `${def.title} board routed`, detail: `All ${b.stats.connections} connections routed on 2 layers with ${b.stats.vias} vias and ${fmtNum(b.stats.trackLength / 1000, 2)} m of track${pour ? `, ${pour} poured on both sides` : ""}. The design rule check is clean.` });
  }
  return out;
}
