// The designer's review_design tool. Kept apart from the stage so the tool
// list can import it without pulling in the review pipeline.

import { z } from "zod";

// no generated code: the page CSP forbids eval
z.config({ jitless: true });

export const REVIEW_TOOL = {
  name: "review_design",
  description:
    "Get an independent review before you report back. Kerf renders the model from 7 angles, measures every custom part (sharp edges, bare hole rims, sharp internal corners, wall thickness, print support, unnamed dimensions), and a separate reviewer who sees only the brief, the renders, the measurements, the checks and the source returns findings with fixes. Call it once a new design or a substantial revision builds and its checks are sorted, before your final reply. After fixing findings, call it again with a response for each one you touched. Takes a minute or so.",
  input_schema: {
    type: "object" as const,
    properties: {
      responses: {
        type: "array",
        maxItems: 40,
        description: "Your answer to earlier findings: fixed (say what changed), declined (say why it should stay), or needs_user (you asked the user).",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Finding id, e.g. R2." },
            status: { type: "string", enum: ["fixed", "declined", "needs_user"] },
            note: { type: "string", description: "What you changed, or why you kept it." },
          },
          required: ["id", "status", "note"],
          additionalProperties: false,
        },
      },
      focus: { type: "string", description: "Optional: anything you want the reviewer to look at especially." },
    },
    additionalProperties: false,
  },
};

export const ReviewInput = z.object({
  responses: z.array(z.object({ id: z.string().max(10), status: z.enum(["fixed", "declined", "needs_user"]), note: z.string().max(1000) })).max(40).optional(),
  focus: z.string().max(500).optional(),
});
