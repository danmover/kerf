// Assistant tool for mass properties: the mass, centre of mass, inertia
// tensor, principal moments and axes and radii of gyration of a part, a few
// parts or the whole design, as built (see core/massProps).

import { z } from "zod";
import { meshes, useDesign, whenChecked } from "../core/engine";
import { massProperties, massPropsText } from "../core/massProps";
import type { ToolOutcome } from "./tools";

export const MASS_TOOL_DEFS = [
  {
    name: "mass_properties",
    description:
      "Mass properties of the built design, or of the parts named: mass, centre of mass (world mm), the inertia tensor about the centre of mass along the world axes, its principal moments and axes, and radii of gyration (inertia in kg·mm²). Pass about (a world point, such as a joint's axis point or a motor shaft) for the inertia about that point too. Masses come from each part's material and solid, or its mass: (a bought part's catalogue weight, spread through its shape). Use it to size a motor for a turning arm, balance a rotor, place a centre of mass, or check what a mechanism sim will use.",
    input_schema: {
      type: "object" as const,
      properties: {
        parts: { type: "array", items: { type: "string" }, maxItems: 60, description: "Part or component names (or instance ids like screw#2) to sum together. Leave out for the whole design." },
        about: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3, description: "A world point (mm) to give the inertia about as well." },
      },
      additionalProperties: false,
    },
  },
];

export const MASS_TOOL_TITLES: Record<string, string> = { mass_properties: "Working out mass properties" };

const Input = z
  .object({
    parts: z.array(z.string().min(1).max(120)).max(60).optional(),
    about: z.tuple([z.number(), z.number(), z.number()]).optional(),
  })
  .strict();

const err = (content: string, title: string): ToolOutcome => ({ isError: true, content, card: { title, detail: content, status: "error" } });

export async function runMassTool(name: string, input: unknown): Promise<ToolOutcome | null> {
  if (name !== "mass_properties") return null;
  const p = Input.safeParse(input ?? {});
  if (!p.success) return err(p.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "), "Invalid tool input");
  // the sums read the built meshes
  await whenChecked(120_000);
  const model = useDesign.getState().model;
  if (!model) return err("No design is loaded.", "No design");
  const names = p.data.parts ? [...new Set(p.data.parts)] : undefined;
  const of = (n: string, id: string, pn: string) => pn === n || id === n || id.startsWith(n + "#") || id.startsWith(n + ".");
  const missing = (names ?? []).filter((n) => !model.parts.some((q) => of(n, q.id, q.name)));
  if (missing.length) return err(`No part named ${missing.join(", ")}.`, "Part not found");
  const mp = massProperties(
    model,
    (h) => {
      const e = meshes.get(h);
      return e ? { mesh: e.preview ?? e.final, volume: e.volume } : undefined;
    },
    names ? (q) => names.some((n) => of(n, q.id, q.name)) : undefined,
  );
  if (!mp.solids) return err(mp.pending ? "Those parts are still building; try again once the design is built." : "Nothing to weigh: no visible built parts.", "Nothing built");
  const what = names ? names.join(", ") : "the whole design";
  return { content: `Mass properties of ${what}:\n${massPropsText(mp, p.data.about)}`, card: { title: `Mass properties: ${(mp.mass / 1000).toFixed(mp.mass < 1000 ? 3 : 2)} kg`, detail: `centre of mass (${mp.com.map((x) => x.toFixed(1)).join(", ")}) mm`, status: "done" } };
}
