// The slimmer prompt (Settings → AI → "Slimmer prompt", off by default): the
// language reference without its specialist sections (machines, simulations,
// analyses, drawings, imported STEP files), which are about half of it. Each
// one is left as a short note, and Claude reads the whole section with
// read_reference when the design needs it. Every request rereads the prompt,
// so a design with no electronics, simulations or analyses carries less.
// Whether it does as well is for the bench to say, so it ships switched off.

import { z } from "zod";
import { languageReference } from "./reference";

/** The sections left out, by the start of their heading. */
export const DEFERRED = [
  { id: "machines", heading: "## Machines", when: "a machine, purchasable parts (motors, boards, drivers, batteries, sensors), wiring, power, calculations, firmware or physical tests" },
  { id: "simulations", heading: "## Simulations", when: "a scenario block (a simulated run of the machine and its firmware)" },
  { id: "analysis", heading: "## Analysis blocks", when: "an analysis block (strength, stiffness, heat, vibration, airflow)" },
  { id: "drawings", heading: "## Drawings", when: "a drawing block" },
  { id: "step", heading: "## Imported STEP files", when: "an imported STEP part (step() components, inspect_import)" },
] as const;

export type DeferredId = (typeof DEFERRED)[number]["id"];

/** The reference cut at its "## " headings. */
function sections(): string[] {
  return languageReference().split(/\n(?=## )/);
}

const deferredOf = (sec: string) => DEFERRED.find((d) => sec.startsWith(d.heading));

/** The first sentences of a section, as the note that stands in for it. */
function opening(sec: string): string {
  const body = sec.split("\n").slice(1).find((l) => l.trim() && !l.startsWith("#")) ?? "";
  const cut = body.match(/^(.{0,320}?[.:])(\s|$)/);
  return (cut ? cut[1] : body.slice(0, 320)).replace(/:$/, ".");
}

let cache: { full: string; lean: string } | null = null;

/** The language reference with the specialist sections reduced to a note each. */
export function leanReference(): string {
  const full = languageReference();
  if (cache?.full === full) return cache.lean;
  const kept = sections().map((sec) => {
    const d = deferredOf(sec);
    if (!d) return sec;
    return `${sec.split("\n")[0]}\n${opening(sec)} The syntax is not in this prompt: before you write, change or explain ${d.when}, call read_reference with section "${d.id}" and follow it exactly.\n`;
  });
  cache = { full, lean: kept.join("\n") };
  return cache.lean;
}

export const REFERENCE_TOOL = {
  name: "read_reference",
  description: `Read one section of the Kerf language reference that this prompt leaves out, before you write or change what it covers. ${DEFERRED.map((d) => `${d.id}: ${d.when}`).join("; ")}. Ask once per conversation: the section stays in it.`,
  input_schema: {
    type: "object" as const,
    properties: { section: { type: "string", enum: DEFERRED.map((d) => d.id) } },
    required: ["section"],
    additionalProperties: false,
  },
};

export const ReferenceInput = z.object({ section: z.enum(DEFERRED.map((d) => d.id) as [DeferredId, ...DeferredId[]]) });

/** One left-out section, whole. */
export function referenceText(id: DeferredId): string {
  const d = DEFERRED.find((x) => x.id === id)!;
  return sections().find((s) => s.startsWith(d.heading)) ?? `The reference has no section "${id}".`;
}
