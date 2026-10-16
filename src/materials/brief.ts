// The brief as the material advisor reads it, from a built model's brief or
// from the brief being edited.

import type { BriefData } from "../core/brief";
import type { ProcessSpec } from "../mfg/types";
import { processFromText } from "../mfg/spec";
import type { BriefFacts } from "./advise";

export function briefFacts(b: (BriefData & { processSpec?: ProcessSpec }) | null | undefined): BriefFacts | null {
  if (!b) return null;
  return {
    temp: b.temp,
    outdoor: b.outdoor,
    exposure: b.exposure,
    priorities: b.priorities,
    quantity: b.quantity,
    look: b.look,
    maxMass: b.maxMass,
    material: b.material,
    process: b.processSpec?.id ?? (b.process ? (processFromText(b.process) ?? undefined) : undefined),
    processAssumed: b.assumed.includes("process"),
  };
}

