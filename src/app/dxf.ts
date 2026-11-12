// Bringing DXF drawings in as sketches: a dropped or picked .dxf becomes a
// sketch on the XY plane, named after the file, holding the drawing's lines,
// arcs, circles and curves fixed where they were drawn, and opens in the
// sketch editor ready to make solid. In the sketch editor, Insert DXF adds a
// drawing to the open sketch instead. Each is one undoable change.

import { useDesign } from "../core/engine";
import type { Model } from "../core/model";
import { cleanName } from "../kernel/stepText";
import { fmtNum } from "../lang/values";
import { DxfError, readDxf, type DxfDrawing } from "../sketch/dxfRead";
import { dxfCountsText, dxfStatements, type DxfStatements } from "../sketch/dxfSketch";
import { addSketch, addStatements, sketchText, takenNames } from "../sketch/edits";
import { SKETCH_RESERVED } from "../sketch/evaluate";
import { activeSketch, editSketch, enterSketch, faceAgain, flash, useSketch } from "../ui/sketch/session";
import { commitSource } from "./project";
import { errorText, toast } from "./ui";

export const DXF_FILE = /\.dxf$/i;
export const isDxfFile = (f: File) => DXF_FILE.test(f.name);
export const DXF_ACCEPT = ".dxf";
/** Bigger than this is a whole site plan, not an outline. */
export const MAX_DXF_BYTES = 40 * 1024 * 1024;

async function readText(file: File): Promise<string> {
  if (file.size > MAX_DXF_BYTES) throw new DxfError(`${file.name} is ${(file.size / 1e6).toFixed(1)} MB. Kerf reads DXF drawings up to ${MAX_DXF_BYTES / 1024 / 1024} MB.`);
  if (!file.size) throw new DxfError(`${file.name} is empty.`);
  // DXF from AutoCAD 2007 on is UTF-8; older files use a code page, which only matters for text Kerf leaves out
  return new TextDecoder("utf-8").decode(await file.arrayBuffer());
}

const RESERVED = new Set(["design", "param", "let", "part", "component", "interface", "require", "note", "brief", "decision", "sketch", "analysis", "for", "in", "if", "else", "true", "false", "lib", "step", "body", "add", "cut", "intersect", "range", "min", "max", "PI", "X", "Y", "Z", "XY", "XZ", "YZ", "ORIGIN"]);

/** The new sketch's name: the file name in lower case words joined by underscores, not already used. */
function sketchName(file: string, model: Model | null): string {
  let id = file
    .replace(DXF_FILE, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 28)
    .replace(/_+$/, "");
  if (!id) id = "drawing";
  if (/^[0-9]/.test(id)) id = `dxf_${id}`;
  if (RESERVED.has(id)) id = `${id}_sketch`;
  const taken = new Set(model?.blocks.map((b) => b.name) ?? []);
  let out = id;
  for (let n = 2; taken.has(out); n++) out = `${id}_${n}`;
  return out;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** What came in and what did not, for the message after an import. */
function report(d: DxfDrawing, st: DxfStatements): string {
  const bits = [`${dxfCountsText(st.counts)}, ${fmtNum(st.size[0], 1)} × ${fmtNum(st.size[1], 1)} mm`];
  if (st.counts.guides) bits.push(`${plural(st.counts.guides, "centre or hidden line")} as construction`);
  if (st.joined) bits.push(`${plural(st.joined, "small gap")} closed`);
  if (st.duplicates) bits.push(`${plural(st.duplicates, "curve")} drawn twice left out`);
  const left = Object.entries(d.skipped).map(([k, n]) => plural(n, k));
  if (left.length) bits.push(`left out ${left.join(", ")}`);
  return bits.join("; ") + ".";
}

/** The sketch statements for a drawing, or a message saying why there are none. */
async function statementsFor(file: File, taken: Set<string>, unit?: "mm" | "in") {
  const d = readDxf(await readText(file), { unit });
  return { d, st: dxfStatements(d, taken, { file: cleanName(file.name, 80), recentre: true }) };
}

/**
 * Import DXF drawings as new sketches. With `open` (the default) the last one
 * opens in the sketch editor with Make solid showing. Returns the sketches made.
 */
export async function importDxfFiles(files: File[], opts: { open?: boolean } = {}): Promise<string[]> {
  const made: string[] = [];
  for (const file of files.filter(isDxfFile)) {
    try {
      const { d, st } = await statementsFor(file, new Set(SKETCH_RESERVED));
      const { source, model } = useDesign.getState();
      const name = sketchName(file.name, model);
      const r = addSketch(source, model, { name, plane: "XY", body: [...st.geometry, ...st.constraints] });
      commitSource(r.src, "you", `Imported ${cleanName(file.name, 60)} as sketch ${r.name}`);
      made.push(r.name);
      // a file that does not give its unit can be read the other way at once
      const other = d.unit ? null : d.readAs === "inches" ? "mm" : "in";
      toast(
        {
          kind: "success",
          title: `Imported ${cleanName(file.name, 60)} as sketch ${r.name}`,
          detail: `${report(d, st)} Fixed where it was drawn${d.unit ? "" : `, read in ${d.readAs}`}: Make solid extrudes it, and deleting the fix lines lets you drag and dimension it.${d.warnings.length && d.unit ? ` ${d.warnings.join(" ")}` : ""}`,
          action: other ? { label: other === "in" ? "Read as inches" : "Read as millimetres", run: () => void rereadDxf(r.name, file, other) } : undefined,
        },
        12000,
      );
    } catch (e) {
      toast({ kind: "error", title: `Could not import ${cleanName(file.name, 60)}`, detail: errorText(e) }, 10000);
    }
  }
  const last = made[made.length - 1];
  if (last && opts.open !== false) {
    enterSketch(last);
    const sk = useDesign.getState().model?.sketches.find((s) => s.name === last);
    if (sk?.profile.regions.length) useSketch.setState({ feature: true });
  }
  return made;
}

/** Read a drawing again in another unit, in place of the sketch it made. */
async function rereadDxf(name: string, file: File, unit: "mm" | "in") {
  const { source, model } = useDesign.getState();
  const sk = model?.sketches.find((s) => s.name === name);
  if (!sk) return toast({ kind: "warn", title: `Sketch ${name} is not in the design any more` });
  try {
    const { st } = await statementsFor(file, new Set(SKETCH_RESERVED), unit);
    const text = sketchText(name, { plane: sk.planeText || "XY", body: [...st.geometry, ...st.constraints] }).replace(/\n$/, "");
    commitSource(source.slice(0, sk.span.start) + text + source.slice(sk.span.end), "you", `Read ${cleanName(file.name, 60)} in ${unit === "in" ? "inches" : "millimetres"}`);
    if (useSketch.getState().active === name) faceAgain();
    toast({ kind: "success", title: `Sketch ${name} now reads ${cleanName(file.name, 60)} in ${unit === "in" ? "inches" : "millimetres"}`, detail: `${fmtNum(st.size[0], 1)} × ${fmtNum(st.size[1], 1)} mm.` });
  } catch (e) {
    toast({ kind: "error", title: `Could not read ${cleanName(file.name, 60)} again`, detail: errorText(e) });
  }
}

/** Add a drawing to the sketch open in the editor, fixed where it was drawn. */
export async function insertDxfIntoSketch(file: File) {
  const sk = activeSketch();
  if (!sk) return;
  try {
    const { d, st } = await statementsFor(file, takenNames(sk));
    editSketch((src, cur) => addStatements(src, cur, st), `inserted ${cleanName(file.name, 60)}`);
    faceAgain();
    flash(`Inserted ${dxfCountsText(st.counts)} from ${cleanName(file.name, 40)}${d.unit ? "" : ` (read in ${d.readAs})`}, fixed where they were drawn${st.moved ? ", moved to sit on the origin" : ""}. Delete their fix lines to drag and dimension them.`);
  } catch (e) {
    flash(`Could not insert ${cleanName(file.name, 40)}: ${errorText(e)}`);
  }
}

/** Pick a DXF file, then `then` it. */
export function pickDxf(then: (f: File) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = DXF_ACCEPT;
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) then(f);
  };
  input.click();
}
