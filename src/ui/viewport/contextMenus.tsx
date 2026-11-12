// What a right-click offers: on a part in the view (ask Claude about the spot, select, zoom, look square at the
// face, section through it, hide or show only it, sketch on the face, the modelling tools at that spot, material,
// lock, its code), on empty space (fit, home, the view switches, a new sketch), and on a row of the parts list.

import type { EvalPart } from "../../core/model";
import { useDesign } from "../../core/engine";
import { commitSource } from "../../app/project";
import { setBlockLocked } from "../../core/sourceEdit";
import { openSpot, type SpotRef } from "../../app/spot";
import { requestCamera, revealSpan, select, useView } from "../../app/view";
import { viewport, type Vec3 } from "../../app/viewportApi";
import { toast } from "../../app/ui";
import { runQuickCommand } from "../../app/quickRun";
import { Icon } from "../icons";
import { T } from "../sketch/glyphs";
import { createSketch, startPicking } from "../sketch/session";
import { planeForFace } from "../sketch/SketchPanels";
import { openModelTool } from "../ModelTools";
import { askMaterialPicker } from "../MaterialPicker";
import { toggleMarkup } from "../Markup";
import { toggleMeasure } from "./MeasureTool";
import { openCam } from "../../cam/job";
import { openSheets } from "../../cam/sheetJob";
import { openContextMenu, type CtxEntry } from "../ContextMenu";

export interface MenuHit {
  id: string;
  local: Vec3;
  point: Vec3;
  normal: Vec3;
  localNormal: Vec3;
}

const partOf = (id: string) => useDesign.getState().model?.parts.find((p) => p.id === id);

/** The parts a right-click acts on: the selection when the clicked part is in it, else the clicked part alone. */
function targetsFor(id: string): string[] {
  const sel = useView.getState().selected;
  return sel.includes(id) ? sel : [id];
}

const hide = (ids: string[]) => useView.setState((s) => ({ hiddenIds: [...new Set([...s.hiddenIds, ...ids])], selected: s.selected.filter((x) => !ids.includes(x)) }));
const showOnly = (ids: string[]) => useView.setState({ selected: ids, isolate: true });
const showAll = () => useView.setState({ hiddenIds: [], isolate: false, soloGroups: [] });
const anyHidden = () => {
  const v = useView.getState();
  return v.hiddenIds.length > 0 || v.isolate || v.soloGroups.length > 0;
};

function lockItem(part: EvalPart): CtxEntry {
  return {
    label: part.locked ? "Unlock" : "Lock (Claude keeps it as it is)",
    icon: part.locked ? <Icon.Unlock size={14} /> : <Icon.Lock size={14} />,
    run: () => {
      const { source } = useDesign.getState();
      const next = setBlockLocked(source, part.name, !part.locked);
      if (next !== source) commitSource(next, "you", `${part.locked ? "Unlocked" : "Locked"} ${part.label}`);
    },
  };
}

/** Run a quick command on the clicked spot, saying why when it can't. */
function quick(cmd: Parameters<typeof runQuickCommand>[0], spot: SpotRef | null) {
  const r = runQuickCommand(cmd, spot);
  if (!r.ok) toast({ kind: "warn", title: r.why });
}

/** The menu for a right-click on a part, at a spot on it. */
export function partMenuEntries(hit: MenuHit): CtxEntry[] {
  const part = partOf(hit.id);
  if (!part) return [];
  const spot: SpotRef = { partId: hit.id, label: part.label, local: hit.local, point: hit.point, normal: hit.normal, localNormal: hit.localNormal };
  const ids = targetsFor(hit.id);
  const many = ids.length > 1;
  const them = many ? `the ${ids.length} selected` : "it";
  const sel = useView.getState().selected;
  const imported = !!part.imported;
  const own = part.kind === "part" && !imported;
  const face = planeForFace(hit.point, hit.normal);
  return [
    { heading: many ? `${ids.length} parts selected` : part.label },
    { label: "Ask Claude about this spot", icon: <Icon.Chat size={14} />, hint: "type", run: () => openSpot(spot) },
    "sep",
    sel.includes(hit.id) ? { label: "Deselect", icon: <Icon.X size={14} />, run: () => select(sel.filter((x) => x !== hit.id)) } : { label: "Add to the selection", icon: <Icon.Plus size={14} />, hint: "Shift+click", run: () => select([...sel, hit.id]) },
    { label: many ? "Zoom to the selection" : "Zoom to it", icon: <Icon.Target size={14} />, hint: "double-click", run: () => viewport()?.focus(ids) },
    { label: "Look straight at this face", icon: <Icon.Cube size={14} />, run: () => requestCamera("fit", hit.normal) },
    {
      label: "Section here",
      icon: <Icon.Scissors size={14} />,
      run: () => {
        const s = viewport()?.sectionThrough(hit.point, hit.normal);
        if (s) useView.setState({ section: { on: true, ...s } });
      },
    },
    "sep",
    { label: many ? "Hide the selection" : "Hide", icon: <Icon.EyeOff size={14} />, run: () => hide(ids) },
    { label: many ? "Show only the selection" : "Show only this", icon: <Icon.Eye size={14} />, hint: "I", run: () => showOnly(ids) },
    ...(anyHidden() ? [{ label: "Show everything", icon: <Icon.Eye size={14} />, run: showAll }] : []),
    "sep",
    { label: "Sketch on this face", icon: <T.Sketch size={14} />, run: () => createSketch(face.plane, face.offset) },
    ...(own
      ? ([
          { label: "Hole here…", icon: <Icon.Hole size={14} />, run: () => openModelTool("hole", spot) },
          { label: "Fillet the edge here…", icon: <Icon.Fillet size={14} />, run: () => openModelTool("fillet", spot) },
          { label: "Chamfer the edge here…", icon: <Icon.Chamfer size={14} />, run: () => openModelTool("chamfer", spot) },
          { label: "Shell it, open at this face…", icon: <Icon.Shell size={14} />, run: () => openModelTool("shell", spot) },
        ] as CtxEntry[])
      : []),
    { label: `Move ${them}…`, icon: <Icon.Move size={14} />, run: () => (select(ids), openModelTool("move")) },
    { label: `Copy ${them}…`, icon: <Icon.Copy size={14} />, run: () => (select(ids), openModelTool("copy")) },
    ...(own ? [{ label: "Mirror it…", icon: <Icon.Mirror size={14} />, run: () => (select([hit.id]), openModelTool("mirror")) }] : []),
    { label: `Pattern ${them}…`, icon: <Icon.Pattern size={14} />, run: () => (select(ids), openModelTool("pattern")) },
    "sep",
    { label: "Material…", icon: <Icon.Material size={14} />, run: () => (select(ids), askMaterialPicker()) },
    ...(part.kind === "part" ? [{ label: "CNC toolpaths…", icon: <Icon.EndMill size={14} />, run: () => openCam(part.id) }] : []),
    ...(part.kind === "part" && (part.sheet || part.process?.id === "laser_cut") ? [{ label: "Cut from sheet…", icon: <Icon.LaserCut size={14} />, run: () => void openSheets(part.id) }] : []),
    lockItem(part),
    { label: "Show its code", icon: <Icon.Code size={14} />, run: () => revealSpan(part.span) },
    { label: "Copy its name", icon: <Icon.Copy size={14} />, run: () => void navigator.clipboard?.writeText(part.name).catch(() => undefined) },
    "sep",
    { label: many ? `Delete the ${ids.length} selected` : "Delete", icon: <Icon.Trash size={14} />, danger: true, run: () => (select(ids), quick({ k: "delete" }, many ? null : spot)) },
  ];
}

/** The menu for a right-click on empty space in the view. */
export function spaceMenuEntries(): CtxEntry[] {
  const v = useView.getState();
  return [
    { label: "Fit the model", icon: <Icon.Fit size={14} />, hint: "F", run: () => requestCamera("fit") },
    { label: "Home view", icon: <Icon.Home size={14} />, hint: "1", run: () => requestCamera("iso") },
    "sep",
    ...(v.selected.length ? [{ label: "Clear the selection", icon: <Icon.X size={14} />, hint: "Esc", run: () => select([]) }] : []),
    ...(anyHidden() ? [{ label: "Show everything", icon: <Icon.Eye size={14} />, run: showAll }] : []),
    "sep",
    { label: "Section view", checked: v.section.on, icon: <Icon.Scissors size={14} />, hint: "S", run: () => useView.setState({ section: { ...v.section, on: !v.section.on } }) },
    { label: "Exploded view", checked: v.explode > 0, icon: <Icon.Explode size={14} />, hint: "E", run: () => useView.setState({ explode: v.explode > 0 ? 0 : 1 }) },
    { label: "X-ray", checked: v.xray, icon: <Icon.Xray size={14} />, hint: "X", run: () => useView.setState({ xray: !v.xray }) },
    { label: "Measure", icon: <Icon.Dimension size={14} />, hint: "R", run: () => toggleMeasure() },
    "sep",
    { label: "New sketch", icon: <T.Sketch size={14} />, run: () => startPicking() },
    { label: "Draw on the view for Claude", icon: <Icon.Edit size={14} />, hint: "M", run: () => toggleMarkup(true) },
  ];
}

/** Open the view's menu for a right-click (or a long press) at a point: on a part, or on empty space. */
export function openViewportMenu(hit: MenuHit | null, x: number, y: number) {
  const part = hit && partOf(hit.id);
  if (!hit || !part) return openContextMenu({ x, y }, spaceMenuEntries());
  // a right-click on a part outside the selection selects it, as a click would
  if (!useView.getState().selected.includes(hit.id)) select([hit.id]);
  const spot: SpotRef = { partId: hit.id, label: part.label, local: hit.local, point: hit.point, normal: hit.normal, localNormal: hit.localNormal };
  openContextMenu({ x, y }, partMenuEntries(hit), { onType: (text) => openSpot({ ...spot, draft: text }), typeHint: "Or start typing to ask Claude about this spot" });
}

/** The menu for a right-click on a row of the parts list (every placed copy of one part or component). */
export function partRowMenuEntries(ids: string[]): CtxEntry[] {
  const part = ids.length ? partOf(ids[0]) : undefined;
  if (!part) return [];
  const v = useView.getState();
  const hidden = ids.every((id) => v.hiddenIds.includes(id));
  const selected = ids.some((id) => v.selected.includes(id));
  return [
    { heading: part.label },
    selected ? { label: "Deselect", icon: <Icon.X size={14} />, run: () => select(v.selected.filter((x) => !ids.includes(x))) } : { label: "Select", icon: <Icon.Check size={14} />, run: () => select(ids) },
    { label: "Zoom to it", icon: <Icon.Target size={14} />, run: () => viewport()?.focus(ids) },
    "sep",
    hidden ? { label: "Show", icon: <Icon.Eye size={14} />, run: () => useView.setState((s) => ({ hiddenIds: s.hiddenIds.filter((x) => !ids.includes(x)) })) } : { label: "Hide", icon: <Icon.EyeOff size={14} />, run: () => hide(ids) },
    { label: "Show only this", icon: <Icon.Eye size={14} />, run: () => showOnly(ids) },
    ...(anyHidden() ? [{ label: "Show everything", icon: <Icon.Eye size={14} />, run: showAll }] : []),
    "sep",
    { label: "Ask Claude about it", icon: <Icon.Chat size={14} />, run: () => (select(ids), openSpot({ partId: ids[0], label: part.label })) },
    { label: "Material…", icon: <Icon.Material size={14} />, run: () => (select(ids), askMaterialPicker()) },
    lockItem(part),
    { label: "Show its code", icon: <Icon.Code size={14} />, hint: "double-click", run: () => revealSpan(part.span) },
    { label: "Copy its name", icon: <Icon.Copy size={14} />, run: () => void navigator.clipboard?.writeText(part.name).catch(() => undefined) },
    "sep",
    { label: "Delete", icon: <Icon.Trash size={14} />, danger: true, run: () => (select(ids), quick({ k: "delete", target: part.name }, { partId: ids[0], label: part.label })) },
  ];
}
