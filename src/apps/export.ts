// Saving an app as a program of its own: the app, its runtime, the
// simulated twin (scenario, machine and firmware, ready to run) and copies of
// the design's meshes for its 3D panels, in one HTML file; or a desktop
// project around that file.

import { meshes, useDesign } from "../core/engine";
import { toast } from "../app/ui";
import { download } from "../persist/files";
import { zip } from "../machine/zip";
import { appNamed, appsOf, twinOptions, useApps } from "./session";
import type { AppSpec } from "./spec";
import { desktopProject, standaloneHtml, tokenCss, type AppRuntime } from "./exportDoc";
import { fileStemOf } from "./names";
import { packMesh, type AppBundle, type WireModel, type WirePart } from "./wire";
import appCss from "../styles/app.css?raw";
import themeCss from "../styles/theme.css?raw";
import appsCss from "../styles/apps.css?raw";

/** Triangles a saved app carries at most at full detail; past it, the coarser preview meshes. */
const FINE_TRIANGLES = 600_000;

function pickApp(app?: AppSpec): AppSpec {
  const model = useDesign.getState().model;
  const a = app ?? appNamed(model, useApps.getState().open) ?? appsOf(model)[0];
  if (!a) throw new Error("The design has no app to save yet: make one in the apps tab first");
  return a;
}

/** The parts and meshes the app's 3D panels show. */
function modelFor(app: AppSpec): WireModel | undefined {
  const model = useDesign.getState().model;
  const panels = app.panels.filter((p) => p.kind === "model");
  if (!model || !panels.length) return undefined;
  const all = panels.some((p) => p.kind === "model" && !p.parts.length);
  const wanted = new Set(panels.flatMap((p) => (p.kind === "model" ? p.parts : [])));
  const parts = model.parts.filter((p) => !p.hidden && (all || wanted.has(p.name)));
  const hashes = [...new Set(parts.map((p) => p.hash))].filter((h) => meshes.get(h));
  const fineTris = hashes.reduce((n, h) => n + ((meshes.get(h)!.final ?? meshes.get(h)!.preview)?.indices.length ?? 0) / 3, 0);
  const fine = fineTris <= FINE_TRIANGLES;
  const out: WireModel = { parts: [], meshes: [] };
  for (const h of hashes) {
    const e = meshes.get(h)!;
    const data = (fine ? (e.final ?? e.preview) : (e.preview ?? e.final))!;
    out.meshes.push(packMesh(h, e, data));
  }
  for (const p of parts) {
    if (!meshes.get(p.hash)) continue;
    const w: WirePart = { id: p.id, name: p.name, hash: p.hash, xf: p.xf, color: p.color, material: p.material, kind: p.kind, motion: p.motion, hidden: false };
    if (p.bom?.catalogId) w.bom = { catalogId: p.bom.catalogId };
    out.parts.push(w);
  }
  return out;
}

async function runtime(): Promise<AppRuntime> {
  const rt = await import("virtual:kerf-app-runtime");
  return { main: rt.main, worker: rt.worker };
}

/** Everything a saved app carries, and what it could not. */
export async function bundleApp(app?: AppSpec): Promise<{ bundle: AppBundle; html: string; notes: string[] }> {
  const a = pickApp(app);
  const model = useDesign.getState().model!;
  const notes: string[] = [];
  const bundle: AppBundle = {
    v: 1,
    app: a,
    design: { name: model.name, kerf: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev", saved: new Date().toISOString() },
  };
  if (a.twin) {
    const o = twinOptions(a, model);
    if ("error" in o) {
      bundle.twinWhy = o.error;
      notes.push(`no simulated twin (${o.error})`);
    } else bundle.twin = o;
  } else bundle.twinWhy = "the app has no twin";
  bundle.model = modelFor(a);
  const css = tokenCss(appCss, themeCss) + appsCss;
  const html = standaloneHtml(bundle, await runtime(), css);
  return { bundle, html, notes };
}

export async function exportStandaloneApp(app?: AppSpec) {
  const { bundle, html, notes } = await bundleApp(app);
  download(html, `${fileStemOf(bundle.app.name)}.html`, "text/html");
  toast({
    kind: notes.length ? "warn" : "success",
    title: `${bundle.app.name} saved as a program`,
    detail: `${(html.length / 1e6).toFixed(1)} MB. Open it in Chrome or Edge: ${bundle.twin ? "Twin runs the simulated machine, USB the real one" : "USB talks to the machine"}.${notes.length ? ` It has ${notes.join("; ")}.` : ""}`,
  }, 9000);
}

export async function exportDesktopApp(app?: AppSpec) {
  const { bundle, html, notes } = await bundleApp(app);
  download(zip(desktopProject(bundle, html)), `${fileStemOf(bundle.app.name)}-desktop.zip`, "application/zip");
  toast({
    kind: notes.length ? "warn" : "success",
    title: `${bundle.app.name} saved as a desktop project`,
    detail: `Unzip it, then npm install and npm start to run it, or npm run dist for an installer (the read-me says more).${notes.length ? ` It has ${notes.join("; ")}.` : ""}`,
  }, 9000);
}
