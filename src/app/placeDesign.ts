// Placing another of your designs in the open one, from the find palette: writes
// component motor_mount = design("Motor mount") { at: (0, 0, 0) } at the end of the
// design (named after the project), so it shows as one subassembly to move and mate.

import { KEYWORDS } from "../lang/lexer";
import { commitSource, realSource, useProject } from "./project";
import { toast } from "./ui";

/** The component name for a project: its name as a word (motor_mount), not one the design already uses. */
export function placedName(project: string, src: string): string {
  const base =
    project
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^(\d)/, "d$1") || "design";
  const used = (n: string) => KEYWORDS.has(n) || new RegExp(`\\b${n}\\b`).test(src);
  if (!used(base)) return base;
  for (let i = 2; ; i++) if (!used(`${base}_${i}`)) return `${base}_${i}`;
}

/** The source with the project placed in it at the origin. */
export function withPlaced(src: string, project: string): { src: string; name: string } {
  const name = placedName(project, src);
  const line = `component ${name} = design(${JSON.stringify(project)}) { at: (0, 0, 0) }`;
  return { src: `${src.replace(/\s*$/, "")}${src.trim() ? "\n\n" : ""}${line}\n`, name };
}

export function placeDesignHere(projectId: string) {
  const { projects, current } = useProject.getState();
  const p = projects.find((x) => x.id === projectId);
  if (!p || !current || p.id === current.id) return;
  const made = withPlaced(realSource(), p.name);
  commitSource(made.src, "you", `Placed ${p.name}`);
  toast({ kind: "success", title: `Placed ${p.name} as ${made.name}`, detail: "Move it into place, or give it its sizes in design(...): it updates when you change that design." }, 6000);
}
