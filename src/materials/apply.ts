// Writing a material choice into the design: the part's material, finish and
// colour, and its process when the one it has cannot make the new material.
// One source edit, so it is one undoable change like every other.

import type { Model } from "../core/model";
import { setBlockProps } from "../core/sourceEdit";
import { setPartProcess } from "../mfg/edit";
import { resolveFinish } from "../library/materials";
import type { ProcessId } from "../mfg/types";
import { processLabel } from "./advise";

export interface MaterialChoice {
  material: string;
  finish: string;
  color: string;
  /** set only when the material needs a different process from the part's */
  process?: ProcessId;
}

/** The main solid of a part block (not a component's extra solids). */
export const blockPart = (model: Model, block: string) => model.parts.find((p) => p.name === block && !p.id.startsWith(`${block}.`));

/**
 * The source with one block switched to a material. `src` must be the source
 * `model` was built from: the process edit uses the model's spans.
 */
export function withMaterial(src: string, model: Model, block: string, choice: MaterialChoice): { src: string; changes: string[] } {
  const part = blockPart(model, block);
  if (!part) return { src, changes: [] };
  const changes: string[] = [];
  let out = src;
  // the process first, while the model's spans still match the text; parts marked process: false keep that
  if (choice.process && part.kind === "part" && !part.processNone && choice.process !== part.process?.id) {
    out = setPartProcess(out, part, { id: choice.process, settings: {} });
    changes.push(`made by ${processLabel(choice.process)}${part.process ? ` instead of ${processLabel(part.process.id)}` : ""}`);
  }
  const props: Record<string, string | null> = {};
  const finishBefore = resolveFinish(part.material, part.finish);
  if (part.material !== choice.material) {
    props.material = JSON.stringify(choice.material);
    changes.unshift(`${part.material} → ${choice.material}`);
  }
  if (part.material !== choice.material || finishBefore !== choice.finish) {
    props.finish = JSON.stringify(choice.finish);
    if (finishBefore !== choice.finish) changes.push(`${choice.finish} finish`);
  }
  if (part.color.toLowerCase() !== choice.color.toLowerCase()) {
    props.color = choice.color.toLowerCase();
    changes.push(`colour ${choice.color.toLowerCase()}`);
  }
  if (Object.keys(props).length) out = setBlockProps(out, block, props);
  return { src: out, changes };
}
