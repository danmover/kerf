// Kerf's own worked examples, which Claude can open while it designs: the
// templates on the home screen, each a whole design that passes its checks. A
// part of one shows how Kerf builds that kind of thing (a gearbox's bearing
// seats, a ride's slip ring, a printer's wiring), so Claude copies a pattern
// that works instead of inventing one.

import { z } from "zod";
import { TEMPLATES } from "../demos/templates";
import { parse } from "../lang/parser";

// the tutorials start from the examples (or from nothing), so they would only repeat them
const EXAMPLES = TEMPLATES.filter((t) => t.id !== "blank" && t.category !== "learn");

/** The most source one call returns, so a big example does not crowd out the design. */
export const EXAMPLE_MAX_CHARS = 24_000;

export const EXAMPLE_TOOL = {
  name: "get_example",
  description: `Read one of Kerf's worked examples: a whole design that builds and passes its checks. Open the closest one before building something like it, and copy how it is done (layout, interfaces, hardware, wiring, analyses), not its sizes. Give part to read just one part, component or analysis and what it uses. The examples: ${EXAMPLES.map((t) => `${t.id} (${t.name}: ${(t.shows ?? []).join(", ") || t.stats})`).join("; ")}.`,
  input_schema: {
    type: "object" as const,
    properties: {
      id: { type: "string", enum: EXAMPLES.map((t) => t.id) },
      part: { type: "string", description: "Only this part, component, interface, analysis or let, with the params and lets it reads." },
    },
    required: ["id"],
    additionalProperties: false,
  },
};

export const ExampleInput = z.object({ id: z.string(), part: z.string().trim().min(1).max(80).optional() });

/** An example's source, or one statement of it with the top-level names it reads. */
export function exampleText(id: string, part?: string): { text: string; title: string } | { error: string } {
  const t = EXAMPLES.find((x) => x.id === id);
  if (!t) return { error: `There is no example "${id}". The examples: ${EXAMPLES.map((x) => x.id).join(", ")}.` };
  const head = `${t.name}: ${t.tagline}`;
  if (!part) {
    const cut = t.source.length > EXAMPLE_MAX_CHARS;
    const body = cut ? t.source.slice(0, t.source.lastIndexOf("\n", EXAMPLE_MAX_CHARS)) : t.source;
    return { title: t.name, text: `${head}\n\n<example id="${id}">\n${body}\n</example>${cut ? `\n\nThe example is longer than this; ask for one part of it with part: to see the rest.` : ""}` };
  }
  const stmts = parse(t.source).program.stmts as { k: string; name?: string; label?: string; span: { start: number; end: number } }[];
  const named = (s: (typeof stmts)[number]) => s.name ?? s.label;
  const hit = stmts.find((s) => named(s) === part);
  if (!hit) {
    const names = stmts.map(named).filter((n): n is string => !!n);
    return { error: `${t.name} has no part, component or analysis named "${part}". It has: ${names.slice(0, 80).join(", ")}.` };
  }
  const own = t.source.slice(hit.span.start, hit.span.end);
  // the params and lets it reads, so the snippet makes sense on its own
  const reads = stmts.filter((s) => (s.k === "param" || s.k === "let") && s !== hit && s.name && new RegExp(`\\b${s.name}\\b`).test(own));
  const context = reads.map((s) => t.source.slice(s.span.start, s.span.end)).join("\n");
  return { title: `${t.name}: ${part}`, text: `${head}\n\n<example id="${id}" part="${part}">\n${context ? `${context}\n\n` : ""}${own}\n</example>` };
}
