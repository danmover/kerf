// Export actions shared by the top bar menu and keyboard shortcuts.

import * as THREE from "three";
import { detailKernel, kernel } from "../kernel/client";
import { meshes, useDesign, whenChecked, whenRefined } from "../core/engine";
import { detailImportsLoaded, recipeUsesImport } from "../core/imports";
import { bomCsv, download, safeFileName, writeStl } from "../persist/files";
import { buildDirection, buildPack, orientForPrint } from "../machine/pack";
import { boardSpecs } from "../machine/boards";
import { boardProblems, gerberZip, routeBoards } from "../machine/boardPack";
import { safeName } from "../machine/pcb/gerber";
import { routeFor } from "../machine/pcb/runtime";
import { zip } from "../machine/zip";
import { exportProject, useProject } from "./project";
import { useView } from "./view";
import { viewport } from "./viewportApi";
import { toast, errorText, dismissToast } from "./ui";
import { bomRows } from "../persist/files";
import type { ViewPreset } from "./view";
import type { EvalPart } from "../core/model";
import type { MeshData } from "../kernel/build";
import { xformMatrix } from "../kernel/recipe";
// as zipFiles, so it can sit beside the build pack's own zip() from machine/zip
import { zip as zipFiles } from "../persist/zip";
import { layoutPlate, meshBounds, threeMfFiles, translation, writeObj, type PlacedMesh } from "../persist/meshFormats";
import { briefData, processInfo } from "../core/brief";
import { appearanceFor } from "../ui/viewport/render/appearance";
import { markSvg } from "../ui/logoGeometry";
import { briefSummary, designStats, massText, sizeText } from "./designStats";
import { designReportHtml } from "./report";

function visibleParts(selectionOnly: boolean) {
  const { model } = useDesign.getState();
  if (!model) return [];
  const { hiddenIds, selected } = useView.getState();
  return model.parts.filter((p) => !p.hidden && !hiddenIds.includes(p.id) && (!selectionOnly || selected.includes(p.id)));
}

const baseName = () => useProject.getState().current?.name ?? useDesign.getState().model?.name ?? "design";

/** Exact STEP of placed parts, with their full detail; the STEP export and the build pack share it. */
async function stepOf(parts: ReturnType<typeof visibleParts>) {
  await whenRefined();
  const items = parts.filter((p) => meshes.has(p.hash)).map((p) => ({ hash: p.hash, xf: p.xf, name: p.id, color: p.color, recipe: p.recipe }));
  // the detail worker holds the real threads and cosmetic detail; the main one builds them if it has to
  if (detailKernel.status !== "error") detailKernel.start();
  // imported STEP bodies are exported from the detail worker too, so it needs the files
  if (detailKernel.status !== "error" && parts.some((p) => p.imported || recipeUsesImport(p.recipe))) await detailImportsLoaded();
  return { data: await (detailKernel.status === "error" ? kernel : detailKernel).exportStep(items), count: items.length };
}

export async function exportStep(selectionOnly = false) {
  const parts = visibleParts(selectionOnly);
  if (!parts.length) return toast({ kind: "warn", title: "Nothing to export", detail: selectionOnly ? "Select one or more parts first." : "The design has no visible parts." });
  const t = toast({ kind: "info", title: "Preparing STEP…", detail: "Exporting exact B-rep solids from the kernel." }, 0);
  try {
    const { data, count } = await stepOf(parts);
    download(data, safeFileName(baseName() + (selectionOnly ? " selection" : ""), "step"), "application/step");
    toast({ kind: "success", title: "STEP exported", detail: `${count} solids in millimetres, ready for other CAD tools.` });
  } catch (e) {
    toast({ kind: "error", title: "STEP export failed", detail: errorText(e) }, 9000);
  } finally {
    dismissToast(t);
  }
}

export async function exportStl(selectionOnly = false) {
  const parts = visibleParts(selectionOnly);
  if (!parts.length) return toast({ kind: "warn", title: "Nothing to export", detail: selectionOnly ? "Select one or more parts first." : "The design has no visible parts." });
  await whenRefined();
  const items = parts.map((p) => ({ mesh: meshes.get(p.hash)?.final ?? meshes.get(p.hash)?.preview, xf: p.xf })).filter((x): x is { mesh: NonNullable<typeof x.mesh>; xf: typeof x.xf } => !!x.mesh);
  if (!items.length) return toast({ kind: "warn", title: "The geometry is still building", detail: "Try again in a moment." });
  download(writeStl(items, `Kerf: ${baseName()}`), safeFileName(baseName() + (selectionOnly ? " selection" : ""), "stl"), "model/stl");
  toast({ kind: "success", title: "STL exported", detail: `${items.length} solids, fine tessellation, millimetres.` });
}

/** The build pack name keeps spaces, unlike other exports, so it reads well in a downloads folder. */
const packName = (s: string) => s.replace(/[^A-Za-z0-9 _.()-]+/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "design";

let packBusy: Promise<void> | null = null;

/** Everything needed to order, make, wire, program and test the machine, as one zip. */
export function exportBuildPack(): Promise<void> {
  packBusy ??= makeBuildPack().finally(() => (packBusy = null));
  return packBusy;
}

async function makeBuildPack() {
  if (!useDesign.getState().model?.machine) {
    toast({ kind: "warn", title: "No build pack for this design", detail: "Build packs are for machines: designs with catalog parts, wiring or firmware." });
    return;
  }
  const t = toast({ kind: "info", title: "Preparing the build pack…", detail: "Waiting for the final geometry and checks, then writing every file." }, 0);
  try {
    await whenRefined();
    await whenChecked();
    const { model, report } = useDesign.getState();
    if (!model?.machine) throw new Error("The design changed and no longer has machine data.");
    const parts = visibleParts(false).filter((p) => meshes.has(p.hash));
    let step: ArrayBuffer | undefined;
    let stepNote = "";
    if (parts.length) {
      try {
        step = (await stepOf(parts)).data;
      } catch (e) {
        stepNote = ` The STEP file was left out: ${errorText(e)}`;
      }
    }
    const name = baseName();
    // the board runtime's finished routes; a board still routing is routed by the pack itself (about a second)
    const boards = boardSpecs(model.machine).flatMap(({ spec }) => {
      const r = routeFor(spec);
      return r.status === "done" ? [r.board] : [];
    });
    const files = buildPack(model, report, { name, step, boards, meshFor: (p) => meshes.get(p.hash)?.final ?? meshes.get(p.hash)?.preview });
    const folder = `${packName(name)} build pack`;
    const data = zip(files.map((f) => ({ path: `${folder}/${f.path}`, data: f.data })));
    download(data, `${folder}.zip`, "application/zip");
    const stl = files.filter((f) => f.path.endsWith(".stl")).length;
    toast({ kind: "success", title: "Build pack downloaded", detail: `${files.length} files${stl ? `, ${stl} to print or make` : ""}. Start with README.md.${stepNote}` }, stepNote ? 9000 : undefined);
  } catch (e) {
    toast({ kind: "error", title: "Could not make the build pack", detail: errorText(e) }, 9000);
  } finally {
    dismissToast(t);
  }
}

/** Every circuit board's Gerber and drill files, zipped for a board house: the Board view's download, for all boards at once. */
export async function exportGerbers() {
  const m = useDesign.getState().model?.machine;
  if (!m?.boards.length) {
    toast({ kind: "warn", title: "No circuit board in this design", detail: "Gerbers come from a board block's routed copper." });
    return;
  }
  // the board runtime's finished routes; a board still routing is routed here, as the build pack does
  const done = boardSpecs(m).flatMap(({ spec }) => {
    const r = routeFor(spec);
    return r.status === "done" ? [r.board] : [];
  });
  const built = routeBoards(m, done);
  const ok = built.flatMap((b) => (b.routed ? [{ spec: b.spec, routed: b.routed }] : []));
  if (!ok.length) throw new Error(built[0]?.error ?? "No board could be routed.");
  const files = ok.map((b) => ({ path: `${safeName(b.spec.name)}-gerbers.zip`, data: gerberZip(b.routed) }));
  if (files.length === 1) download(files[0].data, files[0].path, "application/zip");
  else download(zip(files), safeFileName(baseName() + " gerbers", "zip"), "application/zip");
  const problems = ok.reduce((n, b) => n + boardProblems(b.spec, b.routed).length, 0);
  const failed = built.length - ok.length;
  if (problems || failed)
    toast({ kind: "warn", title: "Gerbers downloaded, with problems", detail: `${problems ? `${problems} board problem${problems === 1 ? "" : "s"} to fix before ordering (the Board view lists them).` : ""}${failed ? ` ${failed} board${failed === 1 ? "" : "s"} could not be routed and ${failed === 1 ? "was" : "were"} left out.` : ""}`.trim() }, 9000);
  else toast({ kind: "success", title: "Gerbers downloaded", detail: "Upload each board's zip as it is to JLCPCB, PCBWay or another board house. The README inside lists the options to pick." }, 7000);
}

export function exportSource() {
  const { source } = useDesign.getState();
  download(source, safeFileName(baseName(), "kerf"), "text/plain");
}

export function exportBom() {
  const { model } = useDesign.getState();
  if (model) download(bomCsv(model), safeFileName(baseName() + " BOM", "csv"), "text/csv");
}

export async function exportPng() {
  const vp = viewport();
  if (!vp) return;
  const url = await vp.capture({ view: "current", width: 1920, height: 1200, mime: "image/png", samples: 64 });
  const bin = atob(url.split(",")[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  download(bytes, safeFileName(baseName(), "png"), "image/png");
}

export async function exportProjectFile() {
  const id = useProject.getState().current?.id;
  if (id) await exportProject(id);
}

// ---------- more formats: print files, meshes for other tools, images, report ----------

type Placed = { part: EvalPart; mesh: MeshData };

/** The fine meshes of the parts being exported (visible ones, or just the selection). */
async function placedMeshes(selectionOnly: boolean, only?: (p: EvalPart) => boolean): Promise<Placed[] | null> {
  const parts = visibleParts(selectionOnly).filter((p) => !only || only(p));
  if (!parts.length) {
    toast({ kind: "warn", title: "Nothing to export", detail: selectionOnly ? "Select one or more parts first." : only ? "The design has no parts to make." : "The design has no visible parts." });
    return null;
  }
  await whenRefined();
  const out = parts.map((part) => ({ part, mesh: meshes.get(part.hash)?.final ?? meshes.get(part.hash)?.preview })).filter((x): x is Placed => !!x.mesh);
  if (!out.length) {
    toast({ kind: "warn", title: "The geometry is still building", detail: "Try again in a moment." });
    return null;
  }
  return out;
}

/** Parts you make (not bought hardware or imported boards). */
const madePart = (p: EvalPart) => p.kind === "part" && !p.imported;

const suffix = (selectionOnly: boolean) => (selectionOnly ? " selection" : "");

/** One of each made part, with how many the design uses. */
function uniqueMade(items: Placed[]) {
  const byHash = new Map<string, Placed & { qty: number }>();
  for (const it of items) {
    const hit = byHash.get(it.part.hash);
    if (hit) hit.qty++;
    else byHash.set(it.part.hash, { ...it, qty: 1 });
  }
  return [...byHash.values()];
}

/** Every made part on one print plate, turned the way it prints and repeated as many times as the design uses it. */
export async function export3mfPlate(selectionOnly = false) {
  const items = await placedMeshes(selectionOnly, madePart);
  if (!items) return;
  const unique = uniqueMade(items);
  const brief = briefData(useDesign.getState().model?.brief);
  const bed = brief?.buildVolume ?? processInfo(brief?.process)?.volume ?? [220, 220, 250];
  // each part turned the way the build pack prints it: onto its largest flat face, or along its process's build direction
  const copies = unique.flatMap((u) => {
    const o = orientForPrint(u.mesh, buildDirection(u.part));
    const mesh: MeshData = { positions: o.positions, indices: o.indices, normals: new Float32Array(0), edges: new Float32Array(0) };
    const box = meshBounds(mesh);
    return Array.from({ length: u.qty }, () => ({ ...u, mesh, box }));
  });
  const spots = layoutPlate(
    copies.map((c) => ({ w: c.box.max[0] - c.box.min[0], d: c.box.max[1] - c.box.min[1] })),
    bed[0],
  );
  // centre the layout on the bed
  const extentX = Math.max(...copies.map((c, i) => spots[i].x + c.box.max[0] - c.box.min[0]));
  const extentY = Math.max(...copies.map((c, i) => spots[i].y + c.box.max[1] - c.box.min[1]));
  const ox = Math.max(0, (bed[0] - extentX) / 2);
  const oy = Math.max(0, (bed[1] - extentY) / 2);
  const placed: PlacedMesh[] = copies.map((c, i) => ({
    name: c.part.name,
    color: c.part.color,
    material: c.part.material,
    mesh: c.mesh,
    matrix: translation(ox + spots[i].x - c.box.min[0], oy + spots[i].y - c.box.min[1], -c.box.min[2]),
  }));
  const data = await zipFiles(threeMfFiles(placed, baseName()));
  download(data, safeFileName(baseName() + " print plate" + suffix(selectionOnly), "3mf"), "model/3mf");
  const tooBig = extentX > bed[0] + 0.5 || extentY > bed[1] + 0.5;
  toast(
    tooBig
      ? { kind: "warn", title: "Print plate exported, but it is bigger than the bed", detail: `${copies.length} parts need ${Math.round(extentX)} × ${Math.round(extentY)} mm. Split them across plates in your slicer.` }
      : { kind: "success", title: "Print plate exported", detail: `${copies.length} part${copies.length === 1 ? "" : "s"}, each turned to print on a flat face, on a ${bed[0]} × ${bed[1]} mm bed in their colours. Opens in PrusaSlicer, Bambu Studio, Cura and Orca.` },
  );
}

/** One STL per made part, in the part's own coordinates, named with how many to print. */
export async function exportStlParts(selectionOnly = false) {
  const items = await placedMeshes(selectionOnly, madePart);
  if (!items) return;
  const unique = uniqueMade(items);
  const files = unique.map((u) => ({ name: `${u.part.name}${u.qty > 1 ? ` x${u.qty}` : ""}.stl`, data: new Uint8Array(writeStl([{ mesh: u.mesh, xf: [] }], `Kerf: ${u.part.label}`)) }));
  download(await zipFiles(files), safeFileName(baseName() + " parts" + suffix(selectionOnly), "zip"), "application/zip");
  toast({ kind: "success", title: "Parts exported", detail: `${files.length} STL file${files.length === 1 ? "" : "s"}, one per part to make, in millimetres.` });
}

const placedFor = (items: Placed[]): PlacedMesh[] => items.map(({ part, mesh }) => ({ name: part.id, color: part.color, material: part.material, mesh, matrix: xformMatrix(part.xf) }));

/** OBJ with a material library, for renderers and modelling tools. */
export async function exportObj(selectionOnly = false) {
  const items = await placedMeshes(selectionOnly);
  if (!items) return;
  const base = safeFileName(baseName() + suffix(selectionOnly), "obj").replace(/\.obj$/, "");
  const { obj, mtl } = writeObj(placedFor(items), `${base}.mtl`, baseName());
  download(await zipFiles([{ name: `${base}.obj`, data: obj }, { name: `${base}.mtl`, data: mtl }]), `${base}.zip`, "application/zip");
  toast({ kind: "success", title: "OBJ exported", detail: `${items.length} solids with their colours, in millimetres, Z up.` });
}

/** A three.js scene of the parts with their real materials, in metres and Y up as glTF and USD expect. */
async function sceneOf(items: Placed[]) {
  const root = new THREE.Group();
  root.name = baseName();
  root.rotation.x = -Math.PI / 2;
  root.scale.setScalar(0.001);
  const geos = new Map<MeshData, THREE.BufferGeometry>();
  const mats = new Map<string, THREE.MeshPhysicalMaterial>();
  for (const { part, mesh } of items) {
    let g = geos.get(mesh);
    if (!g) {
      g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
      if (mesh.colors) g.setAttribute("color", new THREE.BufferAttribute(mesh.colors, 3, true));
      g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      geos.set(mesh, g);
    }
    const look = appearanceFor(part.material, part.finish, part.color);
    const key = look.key + (mesh.colors ? "|vc" : "");
    let m = mats.get(key);
    if (!m) {
      m = new THREE.MeshPhysicalMaterial({
        name: look.label,
        color: mesh.colors ? 0xffffff : look.color,
        vertexColors: !!mesh.colors,
        metalness: look.metalness,
        roughness: look.roughness,
        clearcoat: look.clearcoat,
        clearcoatRoughness: look.clearcoatRoughness,
        transmission: look.transmission,
        thickness: look.thickness,
        ior: look.ior,
        sheen: look.sheen,
        sheenRoughness: look.sheenRoughness,
        specularIntensity: look.specularIntensity,
      });
      mats.set(key, m);
    }
    const obj = new THREE.Mesh(g, m);
    obj.name = part.id;
    obj.matrixAutoUpdate = false;
    obj.matrix.fromArray(xformMatrix(part.xf));
    root.add(obj);
  }
  const scene = new THREE.Scene();
  scene.add(root);
  scene.updateMatrixWorld(true);
  return { scene, dispose: () => [...geos.values(), ...mats.values()].forEach((x) => x.dispose()) };
}

/** Binary glTF with physically based materials: for the web, Blender, game engines and AR viewers. */
export async function exportGlb(selectionOnly = false) {
  const items = await placedMeshes(selectionOnly);
  if (!items) return;
  const { scene, dispose } = await sceneOf(items);
  try {
    const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
    const data = (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
    download(data, safeFileName(baseName() + suffix(selectionOnly), "glb"), "model/gltf-binary");
    toast({ kind: "success", title: "glTF exported", detail: `${items.length} solids with their materials. Drop it into Blender, a web page or an AR viewer.` });
  } finally {
    dispose();
  }
}

/** USDZ for AR Quick Look: open it on an iPhone or iPad to place the design on your desk. */
export async function exportUsdz(selectionOnly = false) {
  const items = await placedMeshes(selectionOnly);
  if (!items) return;
  const { scene, dispose } = await sceneOf(items);
  try {
    const { USDZExporter } = await import("three/examples/jsm/exporters/USDZExporter.js");
    const data = await new USDZExporter().parseAsync(scene, { quickLookCompatible: true });
    download(data as BlobPart, safeFileName(baseName() + suffix(selectionOnly), "usdz"), "model/vnd.usdz+zip");
    toast({ kind: "success", title: "USDZ exported", detail: "Open it on an iPhone or iPad to see the design at full size in AR." });
  } finally {
    dispose();
  }
}

function dataUrlBytes(url: string): Uint8Array<ArrayBuffer> {
  const bin = atob(url.split(",")[1] ?? "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** A high-resolution picture of the current view. */
export async function exportPngSized(width: number, height: number, label: string) {
  const vp = viewport();
  if (!vp) return;
  const url = await vp.capture({ view: "current", width, height, mime: "image/png", samples: 64 });
  download(dataUrlBytes(url), safeFileName(`${baseName()} ${label}`, "png"), "image/png");
  toast({ kind: "success", title: "Image exported", detail: `${width} × ${height} pixels of the current view.` }, 3500);
}

/** Copy the current view to the clipboard, ready to paste into a chat, a doc or an email. */
export async function copyViewImage() {
  const vp = viewport();
  if (!vp) return;
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    toast({ kind: "warn", title: "This browser can't copy images", detail: "Export the image as a PNG instead." });
    return;
  }
  // the clipboard must be asked while the click still counts, so the picture is handed over as a promise
  const blob = vp.capture({ view: "current", width: 1600, height: 1000, mime: "image/png", samples: 32 }).then((url) => new Blob([dataUrlBytes(url) as BlobPart], { type: "image/png" }));
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast({ kind: "success", title: "View copied", detail: "Paste it anywhere." }, 3000);
  } catch (e) {
    toast({ kind: "error", title: "Couldn't copy the image", detail: errorText(e) }, 6000);
  }
}

const SHEET_VIEWS: { view: ViewPreset; label: string }[] = [
  { view: "iso", label: "ISOMETRIC" },
  { view: "front", label: "FRONT" },
  { view: "top", label: "TOP" },
  { view: "right", label: "RIGHT" },
];

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not draw a view"));
    img.src = src;
  });
}

/** Four standard views on one presentation sheet with the design's name and key numbers. */
export async function exportViewSheet() {
  const vp = viewport();
  const { model, report } = useDesign.getState();
  if (!vp || !model?.parts.length) return toast({ kind: "warn", title: "Nothing to show", detail: "The design has no parts yet." });
  const t = toast({ kind: "info", title: "Drawing the view sheet…", detail: "Rendering four views." }, 0);
  try {
    await whenRefined();
    const W = 960;
    const H = 640;
    const shots: string[] = [];
    for (const v of SHEET_VIEWS) shots.push(await vp.capture({ view: v.view, width: W, height: H, mime: "image/png", samples: 32 }));
    const pad = 40;
    const gap = 20;
    const head = 128;
    const foot = 56;
    const cw = pad * 2 + W * 2 + gap;
    const ch = head + H * 2 + gap + foot + pad;
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const g = canvas.getContext("2d")!;
    await document.fonts?.ready;
    const bg = g.createLinearGradient(0, 0, 0, ch);
    bg.addColorStop(0, "#0d1118");
    bg.addColorStop(1, "#07090d");
    g.fillStyle = bg;
    g.fillRect(0, 0, cw, ch);
    g.strokeStyle = "rgba(143,168,255,0.05)";
    g.lineWidth = 1;
    for (let x = 0.5; x < cw; x += 24) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, ch);
      g.stroke();
    }
    for (let y = 0.5; y < ch; y += 24) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(cw, y);
      g.stroke();
    }
    const mark = await loadImage("data:image/svg+xml;charset=utf-8," + encodeURIComponent(markSvg(56, 0.07, "sheet")));
    g.drawImage(mark, pad, 36, 56, 56);
    g.fillStyle = "#eef1fb";
    g.font = "600 34px 'IBM Plex Sans', sans-serif";
    g.textBaseline = "alphabetic";
    g.fillText(model.name || baseName(), pad + 74, 66);
    const stats = designStats(model, (h) => meshes.get(h));
    g.font = "400 15px 'IBM Plex Mono', monospace";
    g.fillStyle = "#8d98b3";
    const sub = [`${sizeText(stats.size)} mm`, massText(stats.mass), `${stats.make} to make · ${stats.buy} to buy`, new Date().toISOString().slice(0, 10)].join("   ·   ");
    g.fillText(sub, pad + 74, 94);
    const fails = report?.counts.fail ?? 0;
    const verdict = report ? (fails ? `${fails} check${fails > 1 ? "s" : ""} failing` : `all ${report.counts.pass} checks pass`) : "checks not run";
    g.font = "500 14px 'IBM Plex Mono', monospace";
    const vw = g.measureText(verdict).width;
    const vx = cw - pad - vw - 28;
    g.fillStyle = fails ? "rgba(255,93,108,0.14)" : "rgba(61,220,151,0.12)";
    roundRect(g, vx, 52, vw + 28, 30, 15);
    g.fill();
    g.fillStyle = fails ? "#ff5d6c" : "#3ddc97";
    g.beginPath();
    g.arc(vx + 14, 67, 4, 0, Math.PI * 2);
    g.fill();
    g.fillText(verdict, vx + 24, 72);
    for (let i = 0; i < shots.length; i++) {
      const x = pad + (i % 2) * (W + gap);
      const y = head + Math.floor(i / 2) * (H + gap);
      g.save();
      roundRect(g, x, y, W, H, 14);
      g.clip();
      g.drawImage(await loadImage(shots[i]), x, y, W, H);
      g.restore();
      g.strokeStyle = "rgba(143,168,255,0.18)";
      roundRect(g, x + 0.5, y + 0.5, W - 1, H - 1, 14);
      g.stroke();
      g.font = "500 12px 'IBM Plex Mono', monospace";
      const lw = g.measureText(SHEET_VIEWS[i].label).width;
      g.fillStyle = "rgba(7,9,13,0.72)";
      roundRect(g, x + 14, y + 14, lw + 20, 24, 6);
      g.fill();
      g.fillStyle = "#c9d2ea";
      g.fillText(SHEET_VIEWS[i].label, x + 24, y + 30.5);
    }
    g.font = "400 12px 'IBM Plex Mono', monospace";
    g.fillStyle = "#56607a";
    g.fillText(`Made with Kerf ${__APP_VERSION__}. Millimetres, Z up. Strength checks are estimates: test before you rely on a part.`, pad, ch - pad + 4);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    if (!blob) throw new Error("The browser could not encode the sheet");
    download(blob, safeFileName(baseName() + " views", "png"), "image/png");
    toast({ kind: "success", title: "View sheet exported", detail: "Four views on one image." }, 3500);
  } catch (e) {
    toast({ kind: "error", title: "View sheet failed", detail: errorText(e) }, 8000);
  } finally {
    dismissToast(t);
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** A self-contained design report (brief, views, checks, values, parts list) that prints to PDF. */
export async function exportReport() {
  const vp = viewport();
  const { model, report } = useDesign.getState();
  if (!model) return;
  const t = toast({ kind: "info", title: "Writing the design report…", detail: "Rendering views and gathering the checks." }, 0);
  try {
    await whenChecked();
    await whenRefined();
    const latest = useDesign.getState();
    const views: { label: string; url: string }[] = [];
    let hero: string | undefined;
    if (vp && latest.model?.parts.length) {
      hero = await vp.capture({ view: "iso", width: 1600, height: 1000, mime: "image/jpeg", quality: 0.9, samples: 48 });
      for (const v of SHEET_VIEWS.slice(1)) views.push({ label: v.label.toLowerCase(), url: await vp.capture({ view: v.view, width: 900, height: 620, mime: "image/jpeg", quality: 0.88, samples: 24 }) });
    }
    const html = designReportHtml({
      model: latest.model ?? model,
      report: latest.report ?? report,
      stats: designStats(latest.model ?? model, (h) => meshes.get(h)),
      brief: briefSummary(latest.model ?? model, latest.report ?? report),
      bom: bomRows(latest.model ?? model),
      versions: useProject.getState().versions.length,
      appVersion: __APP_VERSION__,
      date: new Date(),
      hero,
      views,
    });
    download(html, safeFileName(baseName() + " report", "html"), "text/html");
    toast({ kind: "success", title: "Report exported", detail: "Open it in a browser to read, share or print to PDF." });
  } catch (e) {
    toast({ kind: "error", title: "Report failed", detail: errorText(e) }, 8000);
  } finally {
    dismissToast(t);
  }
}
