// The files kerf.export makes from a reading of the design: STL (all in one, or one per part to make), STEP, the parts
// list and the design source. The meshes and the STEP writer come from the caller, so this runs in the app and in tests.

import { bomCsv, safeFileName, writeStl } from "../persist/files";
import type { EvalPart } from "../core/model";
import type { MeshData } from "../kernel/build";
import type { Xform } from "../kernel/recipe";
import type { DesignRead, ExportFormat, ExportOptions } from "./session";

export interface ExportDeps {
  /** the file name to start from (the project's name) */
  name: string;
  /** STEP of placed parts, built from their recipes where need be */
  step(items: { hash: string; xf: Xform[]; name: string; color: string; recipe: EvalPart["recipe"] }[]): Promise<ArrayBuffer>;
  /** fine meshes for these parts of the reading */
  meshes(parts: EvalPart[]): Promise<(p: EvalPart) => MeshData | undefined>;
}

export interface MadeFile {
  name: string;
  data: Uint8Array | string;
  mime: string;
}

const made = (p: EvalPart) => p.kind === "part" && !p.imported;

/** The parts an export takes: those named (parts or components), else every visible one `only` lets through. */
function chosen(read: DesignRead, names: string[] | undefined, only: (p: EvalPart) => boolean): EvalPart[] {
  return read.model.parts.filter((p) => !p.hidden && (names ? names.includes(p.name) || names.includes(p.id.split(".")[0]) : only(p)));
}

export async function exportFilesOf(read: DesignRead, format: ExportFormat, opts: ExportOptions, deps: ExportDeps): Promise<MadeFile[]> {
  const name = opts.name ?? deps.name;
  switch (format) {
    case "kerf":
      return [{ name: safeFileName(name, "kerf"), data: read.source, mime: "text/plain" }];
    case "csv":
      return [{ name: safeFileName(`${name} parts list`, "csv"), data: bomCsv(read.model), mime: "text/csv" }];
    case "step": {
      const parts = chosen(read, opts.parts, () => true);
      if (!parts.length) throw new Error("There are no parts to export.");
      const data = await deps.step(parts.map((p) => ({ hash: p.hash, xf: p.xf, name: p.id, color: p.color, recipe: p.recipe })));
      return [{ name: safeFileName(name, "step"), data: new Uint8Array(data), mime: "application/step" }];
    }
    case "stl": {
      const parts = chosen(read, opts.parts, made);
      if (!parts.length) throw new Error(opts.parts ? "None of those parts has a solid to export." : "The design has no parts to make.");
      const meshOf = await deps.meshes(parts);
      const placed = parts.flatMap((part) => {
        const mesh = meshOf(part);
        return mesh ? [{ part, mesh }] : [];
      });
      if (!placed.length) throw new Error("The parts did not build, so there is nothing to export.");
      if (!opts.each) return [{ name: safeFileName(name, "stl"), data: new Uint8Array(writeStl(placed.map((x) => ({ mesh: x.mesh, xf: x.part.xf })), `Kerf: ${name}`)), mime: "model/stl" }];
      // one of each part, in its own coordinates, named with how many the design uses
      const byHash = new Map<string, { part: EvalPart; mesh: MeshData; qty: number }>();
      for (const x of placed) {
        const hit = byHash.get(x.part.hash);
        if (hit) hit.qty++;
        else byHash.set(x.part.hash, { ...x, qty: 1 });
      }
      return [...byHash.values()].map((u) => ({
        name: `${safeFileName(u.part.name, "x").replace(/\.x$/, "")}${u.qty > 1 ? ` x${u.qty}` : ""}.stl`,
        data: new Uint8Array(writeStl([{ mesh: u.mesh, xf: [] }], `Kerf: ${u.part.label}`)),
        mime: "model/stl",
      }));
    }
  }
}
