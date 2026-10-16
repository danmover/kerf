// Importing STEP files into the open project: read and analyse the file,
// store it, and place it in the design as a step() component that can be
// undone like any other edit.

import { useDesign, meshes } from "../core/engine";
import { analyseFile, forgetBytes, importBytes, importUsers, primeBytes, useImports } from "../core/imports";
import type { Model } from "../core/model";
import { MAX_STEP_BYTES, mountingHoles, type ImportMeta, type ProjectImport } from "../kernel/imports";
import { applyXforms, type V3 } from "../kernel/recipe";
import { cleanName } from "../kernel/stepText";
import { fmtNum } from "../lang/values";
import { getBlob, putBlob, sha256Hex } from "../persist/blobs";
import { download, safeFileName } from "../persist/files";
import { useChatDraft } from "../ui/chatDraft";
import { commitSource, setProjectImports, useProject } from "./project";
import { confirmDialog, dismissToast, errorText, toast } from "./ui";

export const STEP_EXTENSIONS = /\.(step|stp|p21)$/i;
export const isStepFile = (f: File) => STEP_EXTENSIONS.test(f.name);

const stem = (file: string) => file.replace(STEP_EXTENSIONS, "") || file;

/** A short, unique name for step("…"): the file name without its extension. */
function uniqueName(file: string, taken: string[]): string {
  const base = cleanName(stem(file), 48).replace(/["\\]/g, "") || "Imported part";
  let name = base;
  for (let n = 2; taken.includes(name); n++) name = `${base} ${n}`;
  return name;
}

const RESERVED = new Set(["design", "param", "let", "part", "component", "interface", "require", "note", "for", "in", "if", "else", "true", "false", "lib", "step", "body", "add", "cut", "intersect", "range", "min", "max", "PI", "X", "Y", "Z", "ORIGIN"]);

/** An identifier for the component that places the file: lower case words joined by underscores. */
function componentName(name: string, model: Model | null): string {
  let id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 28)
    .replace(/_+$/, "");
  if (!id || /^[0-9]/.test(id)) id = `part_${id}`.replace(/_+$/, "");
  const taken = new Set(model?.blocks.map((b) => b.name) ?? []);
  let out = RESERVED.has(id) ? `${id}_part` : id;
  for (let n = 2; taken.has(out); n++) out = `${id}_${n}`;
  return out;
}

/** World box of what the design shows now, from the built meshes. */
function designBox(model: Model | null): [V3, V3] | null {
  if (!model) return null;
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of model.parts) {
    if (p.hidden) continue;
    const m = meshes.get(p.hash);
    if (!m) continue;
    for (let i = 0; i < 8; i++) {
      const c = applyXforms([i & 1 ? m.bbox[1][0] : m.bbox[0][0], i & 2 ? m.bbox[1][1] : m.bbox[0][1], i & 4 ? m.bbox[1][2] : m.bbox[0][2]], p.xf);
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], c[k]);
        hi[k] = Math.max(hi[k], c[k]);
      }
    }
  }
  return Number.isFinite(lo[0]) ? [lo, hi] : null;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** The statement that places an import: beside the existing design, sitting on the ground plane. */
function placement(meta: ImportMeta, model: Model | null): V3 {
  const box = designBox(model);
  if (!box) return [0, 0, 0];
  const w = meta.bbox[1][0] - meta.bbox[0][0];
  return [r1(box[1][0] + 20 + w / 2), r1((box[0][1] + box[1][1]) / 2), 0];
}

export function importStatement(ident: string, name: string, at: V3): string {
  const q = JSON.stringify(name);
  return `\n// Imported from a STEP file: measure it, align to its holes and keep clear of it.\ncomponent ${ident} = step(${q}) {\n  at: (${at.map((v) => fmtNum(v, 1)).join(", ")})\n}\n`;
}

/** Add a statement placing the import, as one undoable change. Returns the component's name. */
export function placeImport(name: string): string | null {
  const imp = useImports.getState().list.find((i) => i.name === name);
  if (!imp?.meta) return null;
  const { source, model } = useDesign.getState();
  const ident = componentName(name, model);
  const next = source.replace(/\s*$/, "\n") + importStatement(ident, name, placement(imp.meta, model));
  commitSource(next, "you", `Placed ${name}`);
  return ident;
}

function summary(meta: ImportMeta): string {
  const bits = [`${meta.bodies.length} bod${meta.bodies.length === 1 ? "y" : "ies"}`];
  const s = meta.bbox[1].map((v, k) => fmtNum(v - meta.bbox[0][k], 1));
  bits.push(`${s.join(" × ")} mm`);
  const holes = mountingHoles(meta).length;
  if (holes) bits.push(`${holes} mounting hole${holes === 1 ? "" : "s"}`);
  return bits.join(", ");
}

/** Read a STEP file and check it before anything is stored. */
async function readFileBytes(file: File): Promise<Uint8Array> {
  if (file.size > MAX_STEP_BYTES) throw new Error(`${file.name} is ${(file.size / 1e6).toFixed(1)} MB. Kerf imports STEP files up to ${MAX_STEP_BYTES / 1024 / 1024} MB.`);
  if (!file.size) throw new Error(`${file.name} is empty.`);
  return new Uint8Array(await file.arrayBuffer());
}

let busy = 0;
export const importBusy = () => busy > 0;

/**
 * Import STEP files into the open project. Each file is read by the kernel,
 * stored with the project, and (unless `place` is false) placed beside the design.
 */
export async function importStepFiles(files: File[], opts: { place?: boolean } = {}) {
  const cur = useProject.getState().current;
  if (!cur) return;
  const steps = files.filter(isStepFile);
  if (!steps.length) {
    toast({ kind: "warn", title: "Not a STEP file", detail: "Kerf imports parts as STEP files (.step or .stp). Most CAD tools and part suppliers offer them." });
    return;
  }
  for (const file of steps) {
    const progress = toast({ kind: "info", title: `Reading ${cleanName(file.name, 60)}…`, detail: "OpenCASCADE is loading the solids and looking for holes." }, 0);
    busy++;
    let hash = "";
    try {
      const data = await readFileBytes(file);
      hash = await sha256Hex(data);
      const list = useImports.getState().list;
      const same = list.find((i) => i.hash === hash);
      if (same) {
        toast({ kind: "info", title: `${same.name} is already imported`, detail: "Use Place in Imported files to add another copy to the design." });
        continue;
      }
      primeBytes(hash, data);
      const meta = await analyseFile(hash, cleanName(file.name, 200), data);
      await putBlob(hash, data);
      const name = uniqueName(file.name, list.map((i) => i.name));
      const entry: ProjectImport = { name, hash, file: cleanName(file.name, 200), size: data.byteLength, addedAt: Date.now(), meta };
      await setProjectImports([...useImports.getState().list, entry]);
      const ident = opts.place === false ? null : placeImport(name);
      toast(
        {
          kind: "success",
          title: `Imported ${name}`,
          detail: summary(meta) + (meta.warnings.length ? `. ${meta.warnings[0]}` : ""),
          action: ident ? { label: "Ask Claude", run: () => useChatDraft.getState().set(`I imported ${name} as \`${ident}\`. Design around it: `) } : undefined,
        },
        9000,
      );
    } catch (e) {
      if (hash) forgetBytes(hash);
      toast({ kind: "error", title: `Could not import ${cleanName(file.name, 60)}`, detail: errorText(e) }, 10000);
    } finally {
      busy--;
      dismissToast(progress);
    }
  }
}

/** Swap in a new version of a file: designs keep their step("name") and pick up the new geometry. */
export async function replaceImport(name: string, file: File) {
  const list = useImports.getState().list;
  const old = list.find((i) => i.name === name);
  if (!old) return;
  if (!isStepFile(file)) return toast({ kind: "warn", title: "Not a STEP file", detail: "Choose a .step or .stp file." });
  const progress = toast({ kind: "info", title: `Reading ${cleanName(file.name, 60)}…` }, 0);
  busy++;
  let hash = "";
  try {
    const data = await readFileBytes(file);
    hash = await sha256Hex(data);
    primeBytes(hash, data);
    const meta = await analyseFile(hash, cleanName(file.name, 200), data);
    await putBlob(hash, data);
    const next = list.map((i) => (i.name === name ? { ...i, hash, file: cleanName(file.name, 200), size: data.byteLength, addedAt: Date.now(), meta } : i));
    await setProjectImports(next);
    const before = old.meta ? summary(old.meta) : "";
    toast({ kind: "success", title: `Replaced ${name}`, detail: `Now ${summary(meta)}${before ? ` (was ${before})` : ""}. Checks run again on the new geometry.` }, 9000);
  } catch (e) {
    if (hash) forgetBytes(hash);
    toast({ kind: "error", title: `Could not replace ${name}`, detail: errorText(e) }, 10000);
  } finally {
    busy--;
    dismissToast(progress);
  }
}

/** Remove an import, and the components that place it, after asking. */
export async function removeImport(name: string) {
  const { source, model } = useDesign.getState();
  const users = importUsers(model).get(name) ?? [];
  const ok = await confirmDialog({
    title: `Remove ${name}?`,
    body: users.length ? `The design places it as ${users.map((u) => `“${u}”`).join(", ")}. Those components are removed from the design too.` : "The file is removed from this project.",
    confirm: "Remove",
    danger: true,
  });
  if (!ok) return;
  if (users.length && model) {
    const spans = model.blocks.filter((b) => b.kind === "component" && users.includes(b.name)).map((b) => b.span);
    let next = source;
    for (const sp of [...spans].sort((a, b) => b.start - a.start)) {
      // take the comment line written above an imported component with it
      const before = next.slice(0, sp.start);
      const comment = /\n\n?\/\/ Imported from a STEP file[^\n]*\n$/.exec(before);
      const from = comment ? sp.start - comment[0].length + (comment[0].startsWith("\n") ? 1 : 0) : sp.start;
      const to = next[sp.end] === "\n" ? sp.end + 1 : sp.end;
      next = next.slice(0, from) + next.slice(to);
    }
    commitSource(next, "you", `Removed ${name}`);
  }
  await setProjectImports(useImports.getState().list.filter((i) => i.name !== name));
  toast({ kind: "success", title: `Removed ${name}` });
}

/** Download the original file. */
export async function downloadImport(name: string) {
  const imp = useImports.getState().list.find((i) => i.name === name);
  if (!imp) return;
  const data = importBytes(imp.hash) ?? (await getBlob(imp.hash));
  if (!data) return toast({ kind: "error", title: "This browser does not have the file", detail: "Use Replace to import it again." });
  download(data as BlobPart, safeFileName(stem(imp.file), "step"), "model/step");
}
