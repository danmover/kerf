// Composes a drawing sheet: chooses the sheet size and scale, lays out the
// views, and inks geometry, hatching, centre lines, dimensions, cutting
// planes, balloons, the title block, parts list and notes. Pure and
// synchronous: views whose projection has not arrived yet show placeholders.

import { partMass, type EvalPart, type Model } from "../core/model";
import type { Edge2, ViewResult } from "../kernel/drawing";
import { recipeHash, vcross, vdot, vnorm, type V3 } from "../kernel/recipe";
import { MATERIALS, materialDensity } from "../library/standards";
import { FINISHES, resolveFinish } from "../library/materials";
import { buildDims, dimStyle, edgeExtents, inkDim, stackDims, type DatumMark, type DimDef, type DimStyle } from "./dims";
import { datumExtent, fcfHeight, fcfText, fcfWidth, faceName, inkDatum, inkFcf } from "./gdt";
import { processFamily } from "./intent";
import { applyXformsToDir } from "../kernel/recipe";
import { partFeatures } from "./features";
import { bendLabel, bendRows, bendWay, flatShift } from "./flat";
import { arcPoints, clipPolylineToCircle, hatchLines } from "./hatch";
import { gridCell, layoutSheet, type LayoutItem, type LayoutResult } from "./layout";
import { boxOk, emptyBox, fmtNum, growBox, Ink, shapeBox, type BomLine, type Box, type Sheet, type SheetDim, type SheetPart, type SheetView } from "./sheet";
import { scaleText, SHEETS, STANDARD_SCALES, type DrawingSpec, type SheetSize } from "./spec";
import { textWidth } from "./text";
import { frameBox, inkDataTable, inkFrame, inkNotes, inkPartsList, inkTitleBlock, inkToleranceStrip, partsListBoxes, TB_W } from "./titleblock";
import { boxExtents, humanize, toView, viewFrame, worldBox, type BBoxOf, type DrawingPlan, type PlannedView } from "./views";

export interface ComposeInput {
  plan: DrawingPlan;
  model: Model;
  /** projection results by request key: undefined while pending */
  result: (key: string) => ViewResult | Error | undefined;
  bboxOf: BBoxOf;
  /** solid volume in mm³ */
  volumeOf?: (p: EvalPart) => number | undefined;
  /** ISO date for the title block */
  today?: string;
  /** the design evaluated with some parameters changed, so dimensions can find the parameter that drives them */
  reevaluate?: (overrides: Record<string, number>) => Model;
}

const GAP = 8;
const SIZES: SheetSize[] = ["A4", "A3", "A2", "A1", "A0"];

type Ext = [number, number, number, number];

export function composeSheet(inp: ComposeInput): Sheet {
  const { plan, model } = inp;
  const spec = plan.spec;
  const raw = plan.views.map((v) => (v.synthetic === "gear" ? gearSideView(plan.parts[0], v) : inp.result(v.key)));
  const results = raw.map((r) => (r instanceof Error ? undefined : r));
  const warnings = [...plan.errors];

  // layout extents come from bounding boxes so views do not move as projections arrive
  const lext: Ext[] = plan.views.map((v, i) => {
    if (v.kind === "detail" && v.detail) {
      const [cu, cv] = toView(v.detail.at, v.frame);
      const r = v.detail.r;
      return [cu - r, cv - r, cu + r, cv + r];
    }
    // the box overestimates pictorial views a lot, so those use their projection once it is in
    const exact = v.kind === "iso" ? edgeExtents(results[i]) : null;
    return exact ? pad(exact, 1) : boxExtents(plan.bbox, v.frame);
  });
  const xext: Ext[] = plan.views.map((v, i) => (v.kind === "detail" ? lext[i] : (edgeExtents(results[i]) ?? lext[i])));
  const built = buildDims({ plan, model, spec, ext: xext, results, bboxOf: inp.bboxOf, reevaluate: inp.reevaluate });
  const dims = built.dims;
  warnings.push(...built.warnings);

  // parts list
  const bom = plan.assembly && spec.partsList !== false ? bomLines(plan.parts, inp.bboxOf, inp.volumeOf) : [];
  const itemOf = new Map<string, number>();
  for (const l of bom) for (const id of l.ids) itemOf.set(id, l.item);

  // notes and tables in the bottom-left corner
  const notes = defaultNotes(spec, plan, built);
  const table = dataTable(plan);

  // ---- sheet size and scale
  const portrait = spec.orientation === "portrait";
  type Choice = { size: SheetSize; w: number; h: number; scale: number; iso: number; res: LayoutResult; items: LayoutItem[]; st: DimStyle; fixed: Box[] };
  const minFeature = Math.min(Infinity, ...dims.filter((d) => d.kind === "callout" && d.circle && d.meta.auto).map((d) => 2 * d.circle!.r));
  const principal = plan.views.filter((v) => gridFor(v, plan, spec));
  const maxExtent = Math.max(1, ...principal.map((v) => Math.max(...[0, 1].map((k) => lext[plan.views.indexOf(v)][k + 2] - lext[plan.views.indexOf(v)][k]))));
  const paperOf = (size: SheetSize) => {
    const [a, b] = SHEETS[size];
    return { w: portrait ? Math.min(a, b) : Math.max(a, b), h: portrait ? Math.max(a, b) : Math.min(a, b) };
  };
  /** The first sheet and scale that hold everything; fixed: the first fit, else the readable choice described below. */
  const pick = (sizes: SheetSize[], scales: number[], fixedChoice: boolean): Choice | null => {
    let chosen: Choice | null = null as Choice | null;
    /** the first readable choice, kept while a bigger sheet is tried for small features */
    let roomy: Choice | null = null as Choice | null;
    for (const size of sizes) {
      const { w, h } = paperOf(size);
      const st = dimStyle(w);
      const fixed = fixedRegions(w, h, bom.length, spec.tolerance, notes, st, table);
      const area = inset(frameBox(w, h), 4);
      let found: Choice | null = null as Choice | null;
      search: for (const s of scales) {
        // the pictorial view may drop one scale to make room
        const smaller = STANDARD_SCALES.find((x) => x < s - 1e-9);
        for (const iso of plan.views.some((v) => v.kind === "iso") && smaller ? [s, smaller] : [s]) {
          const sc = { s, iso };
          const margins = plan.views.map((v, i) => viewMargins(v, i, sc, dims, lext, st, plan, spec, bom.length));
          const items = plan.views.map((v, i) => layoutItem(v, sc, lext[i], margins[i], spec, area, w, plan));
          const res = layoutSheet(items, area, fixed, GAP);
          if (res) {
            found = { size, w, h, scale: s, iso, res, items, st, fixed };
            break search;
          }
        }
      }
      if (!found) continue;
      if (fixedChoice) return found;
      const readable = maxExtent * found.scale >= 60 || found.scale >= 2;
      // small holes and bores should come out at least 2 mm across: a sheet up to A2 may be worth it
      const clear = !minFeature || minFeature * found.scale >= 2;
      if (!roomy) {
        chosen = found;
        if (!readable) continue;
        if (clear || ["A2", "A1", "A0"].includes(size)) break;
        roomy = found;
        continue;
      }
      // a bigger sheet only helps when it draws the part bigger
      if (found.scale > chosen!.scale) chosen = found;
      if ((clear && found.scale > roomy.scale) || size === "A2") break;
    }
    return chosen;
  };
  const sizes = spec.sheet ? [spec.sheet] : SIZES;
  let chosen = pick(sizes, spec.scale ? [spec.scale] : STANDARD_SCALES, !!(spec.sheet || spec.scale));
  if (!chosen && spec.scale) {
    // the scale asked for does not fit: the largest standard scale below it that does
    chosen = pick(sizes, STANDARD_SCALES.filter((x) => x < spec.scale! - 1e-9), true);
    if (chosen) warnings.push(`At ${scaleText(spec.scale)} the views do not fit on ${spec.sheet ? `an ${spec.sheet} sheet` : "any sheet up to A0"}, so this sheet is drawn at ${scaleText(chosen.scale)}; change scale: or sheet: to choose`);
  }
  if (!chosen) {
    // nothing fits: the biggest sheet at the smallest scale, the views in rows, overlapping only if they must
    const size = spec.sheet ?? "A0";
    const { w, h } = paperOf(size);
    const st = dimStyle(w);
    const s = STANDARD_SCALES[STANDARD_SCALES.length - 1];
    const sc = { s, iso: s };
    const margins = plan.views.map((v, i) => viewMargins(v, i, sc, dims, lext, st, plan, spec, bom.length));
    const area = inset(frameBox(w, h), 4);
    const items = plan.views.map((v, i) => layoutItem(v, sc, lext[i], margins[i], spec, area, w, plan));
    const res = layoutSheet(items, area, [], GAP) ?? packRows(items, area, GAP);
    chosen = { size, w, h, scale: s, iso: s, res, items, st, fixed: [] };
    warnings.push("The views do not fit on the sheet at any standard scale");
  }
  const { size, w, h, scale, items, st, fixed } = chosen;
  // stacking rows were last assigned while searching; assign them for the chosen scale
  const margins = plan.views.map((v, i) => viewMargins(v, i, { s: scale, iso: chosen!.iso }, dims, lext, st, plan, spec, bom.length));
  const res = centre(chosen.res, inset(frameBox(w, h), 4), fixed);

  // ---- ink
  const ink = new Ink();
  inkFrame(ink, w, h);
  const views: SheetView[] = plan.views.map((v, i) => ({
    kind: v.kind,
    name: v.name,
    label: viewLabel(v, items[i].scale, scale),
    scale: items[i].scale,
    frame: v.frame,
    origin: res.origins[i],
    box: geomBox(lext[i], res.origins[i], items[i].scale),
    state: raw[i] instanceof Error ? "error" : results[i] ? "ready" : "pending",
    error: raw[i] instanceof Error ? (raw[i] as Error).message : undefined,
    hint: viewHint(v),
  }));
  const parts: SheetPart[] = plan.parts.map((p) => ({ id: p.id, name: p.name, label: p.label, item: itemOf.get(p.id) }));

  plan.views.forEach((v, i) => {
    const sv = views[i];
    const r = v.kind === "detail" ? results[v.parent!] : results[i];
    ink.key = `v${i}`;
    if (!r) {
      placeholder(ink, sv, raw[i] instanceof Error);
      return;
    }
    if (v.kind === "detail" && v.detail) inkDetail(ink, i, sv, r, v, views[v.parent!]);
    else inkView(ink, i, sv, r, v, plan);
  });

  // bend lines on a flat pattern
  if (spec.flat) plan.views.forEach((v, i) => results[i] && v.kind === "top" && bendLines(ink, i, views[i], v, plan, st));

  // centre lines for features seen end-on and along their axis
  if (!plan.assembly && !spec.flat) plan.views.forEach((v, i) => results[i] && v.kind !== "detail" && v.kind !== "iso" && centreLines(ink, i, views[i], v, plan, inp.bboxOf));

  // cutting planes, detail circles and view labels
  plan.views.forEach((v, i) => {
    if (v.kind === "section" && v.section && v.parent !== undefined) cuttingLine(ink, v, views[v.parent], lext[v.parent], st);
    if (v.kind === "detail" && v.detail && v.parent !== undefined) detailCircle(ink, v, views[v.parent], st);
    if (views[i].label) {
      ink.key = `v${i}`;
      const b = views[i].box;
      const below = b[3] + margins[i].bottom - st.size * 0.6;
      ink.text((b[0] + b[2]) / 2, below, views[i].label, st.size * 1.2, "middle", { bold: true });
    }
  });

  // dimensions
  const sheetDims: SheetDim[] = [];
  dims.forEach((d) => {
    const v = views[d.view];
    if (!v) return;
    const placed = { origin: v.origin, scale: v.scale, box: v.box };
    // rows were assigned for this scale during layout; recompute so they match the final placement
    ink.key = `d${sheetDims.length}`;
    const box = inkDim(ink, d, placed, st);
    // model points for every dimension, so a drawing edit can write it out as dim() or diameter()
    const f = plan.views[d.view].frame;
    const depth = vdot([(plan.bbox[0][0] + plan.bbox[1][0]) / 2, (plan.bbox[0][1] + plan.bbox[1][1]) / 2, (plan.bbox[0][2] + plan.bbox[1][2]) / 2], f.dir);
    const world = (p: [number, number]): V3 => [0, 1, 2].map((k) => round4(p[0] * f.x[k] + p[1] * f.y[k] + depth * f.dir[k])) as V3;
    const centre = d.circle?.c ?? d.a;
    sheetDims.push({
      ...d.meta,
      view: d.view,
      value: d.value,
      text: dimLabel(d),
      box,
      a: d.meta.a ?? world(d.kind === "callout" ? centre : d.a),
      b: d.meta.b ?? (d.kind === "callout" ? undefined : world(d.b)),
      align: d.kind === "h" || d.kind === "v" || d.kind === "aligned" ? d.kind : undefined,
      frames: d.frames?.length ? d.frames.map(fcfText) : undefined,
      datum: d.datum,
      basic: d.text.boxed || undefined,
    });
  });

  // datum symbols on faces, where they find room
  if (built.marks.length) inkMarks(ink, built.marks, views, st, fixed, frameBox(w, h));

  // balloons
  if (plan.assembly && spec.balloons !== false && bom.length) balloons(ink, plan, views, results, bom, st);

  // furniture
  const tb = inkTitleBlock(ink, w, h, {
    title: spec.title,
    subtitle: subtitle(spec, plan, model),
    material: spec.material ?? (plan.assembly ? "SEE PARTS LIST" : (MATERIALS[plan.parts[0]?.material]?.label ?? plan.parts[0]?.material ?? "")),
    finish: spec.finish ?? finishText(plan.parts),
    tolerance: spec.tolerance,
    mass: massText(plan.parts, inp.volumeOf),
    drawn: spec.author ?? "Kerf",
    checked: spec.checked ?? "",
    date: spec.date ?? inp.today ?? new Date().toISOString().slice(0, 10),
    number: spec.number ?? drawingNumber(spec),
    revision: spec.revision ?? "A",
    scale: scaleText(scale),
    size,
    sheet: "1 / 1",
    projection: spec.projection,
  });
  let top: Box = tb;
  const strip = inkToleranceStrip(ink, top, spec.tolerance);
  if (strip) top = strip;
  const frame = frameBox(w, h);
  if (bom.length) inkPartsList(ink, top, bom, frame);
  let bottom = frame[3] - 4;
  const notesW = tb[0] - frame[0] - 14;
  const nb = inkNotes(ink, frame[0] + 4, bottom, notesW, notes, st.size);
  if (nb) bottom = nb[1] - 4;
  if (table) inkDataTable(ink, frame[0] + 4, bottom, table.title, table.rows, "n");

  // final row assignment was done per view during layout at this scale
  const pending = views.filter((v) => v.state === "pending").length;
  return {
    name: spec.name,
    title: spec.title,
    auto: !!spec.auto,
    size,
    orientation: portrait ? "portrait" : "landscape",
    w,
    h,
    scale,
    shapes: ink.shapes,
    views,
    dims: sheetDims,
    parts,
    bom,
    notes,
    warnings,
    datums: built.datums,
    pending,
    spec,
    titleBox: tb,
  };
}

// ---------- layout inputs ----------

const round4 = (n: number) => Math.round(n * 1e4) / 1e4 || 0;

function pad(e: Ext, d: number): Ext {
  return [e[0] - d, e[1] - d, e[2] + d, e[3] + d];
}

function inset(b: Box, d: number): Box {
  return [b[0] + d, b[1] + d, b[2] - d, b[3] - d];
}

function geomBox(e: Ext, o: [number, number], s: number): Box {
  return [o[0] + e[0] * s, o[1] - e[3] * s, o[0] + e[2] * s, o[1] - e[1] * s];
}

type Scales = { s: number; iso: number };

function viewScale(v: PlannedView, sc: Scales): number {
  if (v.kind === "detail" && v.detail) return v.detail.scale;
  return v.scale ?? (v.kind === "iso" ? sc.iso : sc.s);
}

function viewMargins(v: PlannedView, i: number, sc: Scales, dims: DimDef[], lext: Ext[], st: DimStyle, plan: DrawingPlan, spec: DrawingSpec, balloonCount = 0) {
  const scale = viewScale(v, sc);
  const s = sc.s;
  const e = lext[i];
  const box: Box = [e[0] * scale, -e[3] * scale, e[2] * scale, -e[1] * scale];
  const m = stackDims(
    dims.filter((d) => d.view === i),
    { origin: [0, 0], scale, box },
    st,
  );
  const out = { top: m.top + 2, right: m.right + 2, bottom: m.bottom + 2, left: m.left + 2 };
  const label = viewLabel(v, scale, s);
  if (label) {
    out.bottom += st.size * 2.6 + 2;
    // a label wider than its view needs room on both sides
    const over = textWidth(label, st.size * 1.2, true) - (box[2] - box[0]);
    if (over > 0) {
      out.left = Math.max(out.left, over / 2 + 1);
      out.right = Math.max(out.right, over / 2 + 1);
    }
  }
  // cutting-plane lines stick out of the views they are drawn on
  if (plan.views.some((o) => o.kind === "section" && o.parent === i)) for (const k of ["top", "right", "bottom", "left"] as const) out[k] = Math.max(out[k], 10);
  if (plan.assembly && spec.balloons !== false && i === balloonView(plan)) {
    const ring = 16 + balloonRoom(balloonCount, box[2] - box[0] + 18, box[3] - box[1] + 18);
    for (const k of ["top", "right", "bottom", "left"] as const) out[k] += ring;
  }
  return out;
}

const BALLOON_GAP = 10.5;
const BALLOON_STEP = 9.5;

/** How many rings of balloons a view takes, and how far out the first one goes beyond its usual place, for n balloons around a w × h view. */
function balloonRings(n: number, w: number, h: number): { rings: number; grow: number } {
  const per = 2 * (w + h);
  if (n * BALLOON_GAP <= per) return { rings: 1, grow: 0 };
  // a second ring staggered outside the first, then both pushed out until they hold them all
  const rings = 2;
  let grow = 0;
  while (n * BALLOON_GAP > rings * 2 * (w + h + 4 * grow) && grow < 200) grow += 2;
  return { rings, grow };
}

/** The extra margin a view needs around its balloons. */
function balloonRoom(n: number, w: number, h: number): number {
  const r = balloonRings(n, w, h);
  return r.grow + (r.rings - 1) * BALLOON_STEP;
}

function layoutItem(v: PlannedView, sc: Scales, e: Ext, margin: LayoutItem["margin"], spec: DrawingSpec, area: Box, sheetW: number, plan: DrawingPlan): LayoutItem {
  const scale = viewScale(v, sc);
  const grid = gridFor(v, plan, spec);
  const item: LayoutItem = { ext: e, scale, margin, grid, at: v.at };
  if (!grid) {
    // the iso view prefers the top-right, sections and details the space beside their parent
    if (v.kind === "iso") item.prefer = [area[2], area[1]];
    else item.prefer = [Math.min(area[0] + sheetW * 0.55, area[2]), area[1] + (area[3] - area[1]) * 0.6];
  }
  return item;
}

/** Grid cell of a view: principal views by kind, and a section standing in for a missing principal view. */
function gridFor(v: PlannedView, plan: DrawingPlan, spec: DrawingSpec): [number, number] | undefined {
  if (v.kind !== "section") return gridCell(v.kind, spec.projection);
  for (const k of ["front", "top", "right", "left", "back", "bottom"] as const) {
    const f = viewFrame(k);
    if (vdot(f.dir, v.frame.dir) > 0.999 && vdot(f.x, v.frame.x) > 0.999 && !plan.views.some((o) => o.kind === k)) {
      // only the first section that fits the cell takes it
      const first = plan.views.find((o) => o.kind === "section" && vdot(o.frame.dir, f.dir) > 0.999 && vdot(o.frame.x, f.x) > 0.999);
      return first === v ? gridCell(k, spec.projection) : undefined;
    }
  }
  return undefined;
}

/** Fixed regions on the sheet: title block, tolerance strip, parts list, notes. */
function fixedRegions(w: number, h: number, bomRows: number, tolerance: string, notes: string[], st: DimStyle, table: DataTable | null): Box[] {
  const f = frameBox(w, h);
  const tbH = 37 + (/2768/.test(tolerance) ? 9 : 0);
  const tb: Box = [f[2] - TB_W, f[3] - tbH, f[2], f[3]];
  const out: Box[] = [tb, ...(bomRows ? partsListBoxes(bomRows, tb, f).boxes : [])];
  // notes and tables: measure them with a scratch ink
  const scratch = new Ink();
  const notesW = f[2] - TB_W - f[0] - 14;
  let bottom = f[3] - 4;
  const nb = inkNotes(scratch, f[0] + 4, bottom, notesW, notes, st.size);
  if (nb) {
    out.push([nb[0] - 2, nb[1] - 2, nb[2] + 2, f[3]]);
    bottom = nb[1] - 4;
  }
  if (table) {
    const gb = inkDataTable(scratch, f[0] + 4, bottom, table.title, table.rows, "n");
    out.push([gb[0] - 2, gb[1] - 2, gb[2] + 2, f[3]]);
  }
  return out;
}

/** Views side by side in rows across the area, wrapping when a row is full: the last resort when no layout fits. */
function packRows(items: LayoutItem[], area: Box, gap: number): LayoutResult {
  const origins: [number, number][] = [];
  const boxes: Box[] = [];
  let x = area[0];
  let y = area[1];
  let rowH = 0;
  for (const it of items) {
    const left = -it.ext[0] * it.scale + it.margin.left;
    const right = it.ext[2] * it.scale + it.margin.right;
    const top = it.ext[3] * it.scale + it.margin.top;
    const bottom = -it.ext[1] * it.scale + it.margin.bottom;
    if (x > area[0] && x + left + right > area[2]) {
      x = area[0];
      y += rowH + gap;
      rowH = 0;
    }
    origins.push([x + left, y + top]);
    boxes.push([x, y, x + left + right, y + top + bottom]);
    x += left + right + gap;
    rowH = Math.max(rowH, top + bottom);
  }
  return { origins, boxes, group: null };
}

/** Moves the views toward the middle of the free space when that keeps them clear of everything. */
function centre(res: LayoutResult, area: Box, fixed: Box[]): LayoutResult {
  const used = emptyBox();
  for (const b of res.boxes) {
    growBox(used, b[0], b[1]);
    growBox(used, b[2], b[3]);
  }
  if (!boxOk(used)) return res;
  const sx = area[2] - used[2];
  const sy = area[3] - used[3];
  const tries: [number, number][] = [];
  for (const f of [0.5, 0.4, 0.3, 0.2, 0.1]) tries.push([sx * f, sy * f], [sx * f, 0], [0, sy * f]);
  for (const [dx, dy] of tries) {
    const moved = res.boxes.map((b) => [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy] as Box);
    if (moved.some((b) => fixed.some((f) => b[0] < f[2] && f[0] < b[2] && b[1] < f[3] && f[1] < b[3]))) continue;
    return { origins: res.origins.map((o) => [o[0] + dx, o[1] + dy]), boxes: moved, group: res.group };
  }
  return res;
}

function viewLabel(v: PlannedView, scale: number, sheetScale: number): string {
  const sc = Math.abs(scale - sheetScale) > 1e-9 ? ` (${scaleText(scale)})` : "";
  if (v.kind === "section") return `SECTION ${v.name}-${v.name}${sc}`;
  if (v.kind === "detail") return `DETAIL ${v.name}${sc}`;
  if (v.kind === "iso") return v.label ? v.label.toUpperCase() + sc : sc ? `ISOMETRIC${sc}` : "";
  if (v.label) return v.label.toUpperCase() + sc;
  return sc ? `VIEW ${v.name.toUpperCase()}${sc}` : "";
}

function viewHint(v: PlannedView): string {
  if (v.kind === "section") return `Section ${v.name}-${v.name}`;
  if (v.kind === "detail") return `Detail ${v.name}`;
  if (v.kind === "iso") return "Isometric view";
  return `${v.kind[0].toUpperCase()}${v.kind.slice(1)} view`;
}

// ---------- views ----------

function placeholder(ink: Ink, v: SheetView, failed: boolean) {
  const [x0, y0, x1, y1] = v.box;
  ink.poly([x0, y0, x1, y0, x1, y1, x0, y1], "phantom", true);
  ink.text((x0 + x1) / 2, (y0 + y1) / 2 + 1, failed ? "Could not project this view" : "Projecting…", 2.5, "middle");
}

const HATCH_ANGLES = [45, 135, 45, 135, 30, 60, 120, 150];

function inkEdges(ink: Ink, edges: Edge2[], view: number, tf: (u: number, v: number) => [number, number], scale: number) {
  for (const e of edges) {
    ink.key = `v${view}:p${e.part}`;
    const pen = e.vis ? "visible" : "hidden";
    const g = e.g;
    if (g.t === "L") {
      const [x1, y1] = tf(g.p[0], g.p[1]);
      const [x2, y2] = tf(g.p[2], g.p[3]);
      ink.line(x1, y1, x2, y2, pen);
    } else if (g.t === "A") {
      const [cx, cy] = tf(g.c[0], g.c[1]);
      ink.arc(cx, cy, g.r * scale, g.a0, g.a1, pen);
    } else {
      const p: number[] = [];
      for (let k = 0; k < g.p.length; k += 2) p.push(...tf(g.p[k], g.p[k + 1]));
      ink.poly(p, pen);
    }
  }
}

function inkView(ink: Ink, i: number, sv: SheetView, r: ViewResult, v: PlannedView, plan: DrawingPlan) {
  const s = sv.scale;
  const [ox, oy] = sv.origin;
  const tf = (u: number, w: number): [number, number] => [ox + u * s, oy - w * s];
  // hatching under the outlines
  if (v.kind === "section") {
    r.hatch.forEach((hh) => {
      ink.key = `v${i}:p${hh.part}`;
      const loops = hh.loops.map((l) => {
        const out: number[] = [];
        for (let k = 0; k < l.length; k += 2) out.push(...tf(l[k], l[k + 1]));
        return out;
      });
      const angle = plan.assembly ? HATCH_ANGLES[hh.part % HATCH_ANGLES.length] : 45;
      const spacing = plan.assembly ? 1.8 + (hh.part % 3) * 0.6 : 2.2;
      for (const [a, b, c, d] of hatchLines(loops, angle, spacing)) ink.line(a, b, c, d, "hatch");
    });
  }
  inkEdges(ink, r.edges, i, tf, s);
}

function inkDetail(ink: Ink, i: number, sv: SheetView, r: ViewResult, v: PlannedView, parent: SheetView) {
  const d = v.detail!;
  const s = sv.scale;
  const [ox, oy] = sv.origin;
  const tf = (u: number, w: number): [number, number] => [ox + u * s, oy - w * s];
  const [cu, cv] = toView(d.at, v.frame);
  const [cx, cy] = tf(cu, cv);
  const R = d.r * s;
  for (const e of r.edges) {
    ink.key = `v${i}:p${e.part}`;
    const pen = e.vis ? "visible" : "hidden";
    let pts: number[];
    if (e.g.t === "L") pts = [...tf(e.g.p[0], e.g.p[1]), ...tf(e.g.p[2], e.g.p[3])];
    else if (e.g.t === "A") {
      const [ax, ay] = tf(e.g.c[0], e.g.c[1]);
      pts = arcPoints(ax, ay, e.g.r * s, e.g.a0, e.g.a1, 0.3);
    } else {
      pts = [];
      for (let k = 0; k < e.g.p.length; k += 2) pts.push(...tf(e.g.p[k], e.g.p[k + 1]));
    }
    for (const piece of clipPolylineToCircle(pts, cx, cy, R)) ink.poly(piece, pen);
  }
  if (parent.kind === "section") {
    r.hatch.forEach((hh) => {
      ink.key = `v${i}:p${hh.part}`;
      const loops = hh.loops.map((l) => {
        const out: number[] = [];
        for (let k = 0; k < l.length; k += 2) out.push(...tf(l[k], l[k + 1]));
        return out;
      });
      for (const [a, b, c, dd] of hatchLines(loops, 45, 2.2)) for (const piece of clipPolylineToCircle([a, b, c, dd], cx, cy, R)) ink.poly(piece, "hatch");
    });
  }
  ink.key = `v${i}`;
  ink.circle(cx, cy, R, "thin");
}

function centreLines(ink: Ink, i: number, sv: SheetView, v: PlannedView, plan: DrawingPlan, bboxOf: BBoxOf) {
  ink.key = `v${i}`;
  const s = sv.scale;
  const [ox, oy] = sv.origin;
  const tf = (p: V3): [number, number] => {
    const [u, w] = toView(p, v.frame);
    return [ox + u * s, oy - w * s];
  };
  const done = new Set<string>();
  const mark = (c: V3, r: number, axis: V3, length: number) => {
    const along = Math.abs(vdot(vnorm(axis), v.frame.dir));
    if (along > 0.999) {
      const [x, y] = tf(c);
      const k = `${x.toFixed(2)},${y.toFixed(2)}`;
      if (done.has(k)) return;
      done.add(k);
      const R = r * s + 2;
      ink.line(x - R, y, x + R, y, "center");
      ink.line(x, y - R, x, y + R, "center");
    } else if (along < 1e-3 && length > 0) {
      const a = vnorm(axis);
      const [x1, y1] = tf(c);
      const [x2, y2] = tf([c[0] + a[0] * length, c[1] + a[1] * length, c[2] + a[2] * length]);
      const L = Math.hypot(x2 - x1, y2 - y1) || 1;
      const ux = (x2 - x1) / L;
      const uy = (y2 - y1) / L;
      const k = `${Math.min(x1, x2).toFixed(1)},${Math.min(y1, y2).toFixed(1)},${ux.toFixed(2)}`;
      if (done.has(k)) return;
      done.add(k);
      ink.line(x1 - ux * 2, y1 - uy * 2, x2 + ux * 2, y2 + uy * 2, "center");
    }
  };
  for (const p of plan.parts) {
    const local = bboxOf(p);
    const world = local ? worldBox(p, local) : null;
    for (const f of partFeatures(p)) {
      if (f.t === "hole") {
        let depth = f.depth;
        if (world && depth >= 1000) {
          // through holes: run the centre line across the part
          const ext = boxExtents(world, { dir: f.dir, x: f.dir, y: f.dir });
          depth = Math.min(depth, ext[2] - vdot(f.at, f.dir) + 0.01);
        }
        mark(f.at, f.d / 2, f.dir, depth);
      } else if (f.t === "cyl") mark(f.at, f.d / 2, f.dir, f.h);
      else if (f.t === "turned") {
        const zs = f.pts.map((q) => q[1]);
        const z0 = Math.min(...zs);
        const z1 = Math.max(...zs);
        const a = vnorm(f.dir);
        mark([f.at[0] + a[0] * z0, f.at[1] + a[1] * z0, f.at[2] + a[2] * z0], Math.max(...f.pts.map((q) => q[0])), f.dir, z1 - z0);
      }
    }
    if (p.gear) {
      const b = p.recipe.base;
      const w = b?.t === "gear" ? b.w : p.gear.width;
      mark(p.gear.center, (p.gear.m * (p.gear.z + 2)) / 2, p.gear.axis, w);
      const a = vnorm(p.gear.axis);
      const pr = (p.gear.m * p.gear.z) / 2;
      if (Math.abs(vdot(a, v.frame.dir)) > 0.999) {
        // pitch circle in the end view
        const [x, y] = tf(p.gear.center);
        ink.circle(x, y, pr * s, "center");
      } else if (Math.abs(vdot(a, v.frame.dir)) < 1e-6) {
        // pitch lines in the side view
        const perp = vnorm(vcross(a, v.frame.dir));
        for (const sg of [-1, 1]) {
          const q0: V3 = [p.gear.center[0] + perp[0] * pr * sg, p.gear.center[1] + perp[1] * pr * sg, p.gear.center[2] + perp[2] * pr * sg];
          const q1: V3 = [q0[0] + a[0] * w, q0[1] + a[1] * w, q0[2] + a[2] * w];
          const [x1, y1] = tf(q0);
          const [x2, y2] = tf(q1);
          const L = Math.hypot(x2 - x1, y2 - y1) || 1;
          ink.line(x1 - ((x2 - x1) / L) * 2, y1 - ((y2 - y1) / L) * 2, x2 + ((x2 - x1) / L) * 2, y2 + ((y2 - y1) / L) * 2, "center");
        }
      }
    }
  }
}

function cuttingLine(ink: Ink, v: PlannedView, parent: SheetView, pe: Ext, st: DimStyle) {
  const sec = v.section!;
  const n = vnorm(sec.normal);
  const f = parent.frame;
  const n2: [number, number] = [vdot(n, f.x), vdot(n, f.y)];
  const L = Math.hypot(n2[0], n2[1]);
  if (L < 1e-6) return;
  n2[0] /= L;
  n2[1] /= L;
  const t: [number, number] = [-n2[1], n2[0]];
  const c = toView(sec.at, f);
  // span the line across the parent view's extents
  const corners: [number, number][] = [
    [pe[0], pe[1]],
    [pe[2], pe[1]],
    [pe[2], pe[3]],
    [pe[0], pe[3]],
  ];
  const along = corners.map(([u, w]) => (u - c[0]) * t[0] + (w - c[1]) * t[1]);
  const lo = Math.min(...along) - 4 / parent.scale;
  const hi = Math.max(...along) + 4 / parent.scale;
  const s = parent.scale;
  const [ox, oy] = parent.origin;
  const P = (k: number): [number, number] => [ox + (c[0] + t[0] * k) * s, oy - (c[1] + t[1] * k) * s];
  const [x1, y1] = P(lo);
  const [x2, y2] = P(hi);
  ink.key = `sec:${v.name}`;
  ink.line(x1, y1, x2, y2, "cutting");
  // thick ends, arrows pointing the way the section looks (against the normal)
  const dx = (x2 - x1) / Math.hypot(x2 - x1, y2 - y1);
  const dy = (y2 - y1) / Math.hypot(x2 - x1, y2 - y1);
  const ax = -n2[0];
  const ay = n2[1];
  for (const [ex, ey, sgn] of [
    [x1, y1, 1],
    [x2, y2, -1],
  ] as const) {
    ink.line(ex, ey, ex + dx * sgn * 6, ey + dy * sgn * 6, "visible");
    const bx = ex + dx * sgn * 1.5;
    const by = ey + dy * sgn * 1.5;
    ink.line(bx, by, bx + ax * 6, by + ay * 6, "thin");
    ink.arrow(bx + ax * 6, by + ay * 6, ax, ay, st.arrow * 1.2);
    ink.text(bx + ax * 8.5 - dx * sgn * 1.5, by + ay * 8.5 + st.size * 0.6 - dy * sgn * 1.5, v.name, st.size * 1.3, "middle", { bold: true });
  }
}

function detailCircle(ink: Ink, v: PlannedView, parent: SheetView, st: DimStyle) {
  const d = v.detail!;
  const [u, w] = toView(d.at, parent.frame);
  const x = parent.origin[0] + u * parent.scale;
  const y = parent.origin[1] - w * parent.scale;
  const R = d.r * parent.scale;
  ink.key = `det:${v.name}`;
  ink.circle(x, y, R, "thin");
  ink.text(x + R * 0.8 + 1.5, y - R * 0.8 - 1, v.name, st.size * 1.3, "start", { bold: true });
}

/** ISO 2203 side view of a spur gear: tip outline, hubs and a hidden bore. */
function gearSideView(p: EvalPart, v: PlannedView): ViewResult {
  const g = p.gear!;
  const base = p.recipe.base;
  const a = vnorm(g.axis);
  const w = base?.t === "gear" ? base.w : g.width;
  const tip = g.m * (g.z + 2);
  const horiz = Math.abs(vdot(v.frame.x, a)) > 0.999;
  const c0 = toView(g.center, v.frame);
  const ta = horiz ? Math.sign(vdot(v.frame.x, a)) : Math.sign(vdot(v.frame.y, a));
  const P = (t: number, s: number): [number, number] => (horiz ? [c0[0] + ta * t, c0[1] + s] : [c0[0] + s, c0[1] + ta * t]);
  const edges: Edge2[] = [];
  const line = (t1: number, s1: number, t2: number, s2: number, vis = true) => {
    const p1 = P(t1, s1);
    const p2 = P(t2, s2);
    edges.push({ part: 0, vis, g: { t: "L", p: [p1[0], p1[1], p2[0], p2[1]] } });
  };
  line(0, -tip / 2, w, -tip / 2);
  line(0, tip / 2, w, tip / 2);
  line(0, -tip / 2, 0, tip / 2);
  line(w, -tip / 2, w, tip / 2);
  let t0 = 0;
  let t1 = w;
  let bore = 0;
  for (const f of partFeatures(p)) {
    if (f.t !== "cyl") continue;
    const s0 = vdot([f.at[0] - g.center[0], f.at[1] - g.center[1], f.at[2] - g.center[2]], a);
    const s1 = s0 + f.h * Math.sign(vdot(f.dir, a));
    const lo = Math.min(s0, s1);
    const hi = Math.max(s0, s1);
    if (f.op === "cut") {
      bore = Math.max(bore, f.d);
      continue;
    }
    // a hub: the part outside the gear body
    for (const [x0, x1] of [
      [lo, Math.min(hi, 0)],
      [Math.max(lo, w), hi],
    ]) {
      if (x1 - x0 < 1e-6) continue;
      line(x0, -f.d / 2, x1, -f.d / 2);
      line(x0, f.d / 2, x1, f.d / 2);
      const end = x0 < 0 ? x0 : x1;
      line(end, -f.d / 2, end, f.d / 2);
      t0 = Math.min(t0, x0);
      t1 = Math.max(t1, x1);
    }
  }
  if (bore > 0) {
    line(t0, -bore / 2, t1, -bore / 2, false);
    line(t0, bore / 2, t1, bore / 2, false);
  }
  return { edges, hatch: [], ms: 0 };
}

// ---------- balloons ----------

function balloonView(plan: DrawingPlan): number {
  const iso = plan.views.findIndex((v) => v.kind === "iso");
  return iso >= 0 ? iso : 0;
}

function balloons(ink: Ink, plan: DrawingPlan, views: SheetView[], results: (ViewResult | undefined)[], bom: BomLine[], st: DimStyle) {
  const vi = balloonView(plan);
  const r = results[vi];
  const sv = views[vi];
  if (!r || !sv) return;
  const s = sv.scale;
  const tf = (u: number, w: number): [number, number] => [sv.origin[0] + u * s, sv.origin[1] - w * s];
  const idIndex = new Map(plan.parts.map((p, k) => [p.id, k]));
  const cx = (sv.box[0] + sv.box[2]) / 2;
  const cy = (sv.box[1] + sv.box[3]) / 2;
  const anchors: { item: number; ax: number; ay: number; t: number }[] = [];
  for (const line of bom) {
    // an anchor on the visible outline of one of the line's parts
    const parts = new Set(line.ids.map((id) => idIndex.get(id)));
    const pts: [number, number][] = [];
    for (const e of r.edges) {
      if (!e.vis || !parts.has(e.part)) continue;
      if (e.g.t === "L") pts.push(tf((e.g.p[0] + e.g.p[2]) / 2, (e.g.p[1] + e.g.p[3]) / 2));
      else if (e.g.t === "A") {
        const a = (e.g.a0 + e.g.a1) / 2;
        pts.push(tf(e.g.c[0] + e.g.r * Math.cos(a), e.g.c[1] + e.g.r * Math.sin(a)));
      } else {
        const k = Math.floor(e.g.p.length / 4) * 2;
        pts.push(tf(e.g.p[k], e.g.p[k + 1]));
      }
    }
    if (!pts.length) continue;
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    let best = pts[0];
    for (const p of pts) if (Math.hypot(p[0] - mx, p[1] - my) < Math.hypot(best[0] - mx, best[1] - my)) best = p;
    anchors.push({ item: line.item, ax: best[0], ay: best[1], t: 0 });
  }
  if (!anchors.length) return;
  // balloons sit on a rectangle around the view, ordered by angle so leaders do not cross;
  // many of them take a second ring, every other balloon staggered out
  const { rings, grow } = balloonRings(anchors.length, sv.box[2] - sv.box[0] + 18, sv.box[3] - sv.box[1] + 18);
  const g = 9 + grow;
  const R: Box = [sv.box[0] - g, sv.box[1] - g, sv.box[2] + g, sv.box[3] + g];
  const W = R[2] - R[0];
  const H = R[3] - R[1];
  const per = 2 * (W + H);
  const toT = (x: number, y: number) => {
    const dx = x - cx;
    const dy = y - cy;
    // ray from the centre through the anchor, to the rectangle
    const k = Math.min(dx > 0 ? (R[2] - cx) / dx : dx < 0 ? (R[0] - cx) / dx : Infinity, dy > 0 ? (R[3] - cy) / dy : dy < 0 ? (R[1] - cy) / dy : Infinity);
    const px = cx + dx * k;
    const py = cy + dy * k;
    if (Math.abs(py - R[1]) < 1e-6) return px - R[0];
    if (Math.abs(px - R[2]) < 1e-6) return W + (py - R[1]);
    if (Math.abs(py - R[3]) < 1e-6) return W + H + (R[2] - px);
    return 2 * W + H + (R[3] - py);
  };
  const atT = (t: number): [number, number] => {
    t = ((t % per) + per) % per;
    if (t < W) return [R[0] + t, R[1]];
    if (t < W + H) return [R[2], R[1] + (t - W)];
    if (t < 2 * W + H) return [R[2] - (t - W - H), R[3]];
    return [R[0], R[3] - (t - 2 * W - H)];
  };
  for (const a of anchors) a.t = toT(a.ax, a.ay);
  anchors.sort((a, b) => a.t - b.t);
  // the gap between neighbours on the rectangle; with two rings, neighbours alternate in and out
  const minGap = BALLOON_GAP / rings;
  // spread evenly where they crowd
  for (let pass = 0; pass < 40; pass++) {
    let moved = false;
    for (let k = 0; k < anchors.length; k++) {
      const a = anchors[k];
      const b = anchors[(k + 1) % anchors.length];
      if (anchors.length < 2) break;
      let d = b.t - a.t;
      if (k === anchors.length - 1) d += per;
      if (d < minGap) {
        const push = (minGap - d) / 2;
        a.t -= push;
        b.t += push;
        moved = true;
      }
    }
    if (!moved) break;
  }
  const rb = 4;
  anchors.forEach((a, k) => {
    ink.key = `b${a.item}`;
    let [bx, by] = atT(a.t);
    if (rings > 1 && k % 2 === 1) {
      // out from the rectangle's side it sits on
      const side = Math.abs(by - R[1]) < 1e-6 ? [0, -1] : Math.abs(bx - R[2]) < 1e-6 ? [1, 0] : Math.abs(by - R[3]) < 1e-6 ? [0, 1] : [-1, 0];
      bx += side[0] * BALLOON_STEP;
      by += side[1] * BALLOON_STEP;
    }
    const dx = a.ax - bx;
    const dy = a.ay - by;
    const L = Math.hypot(dx, dy) || 1;
    ink.line(bx + (dx / L) * rb, by + (dy / L) * rb, a.ax, a.ay, "thin");
    ink.dot(a.ax, a.ay, 0.6);
    ink.circle(bx, by, rb, "frame");
    ink.text(bx, by + st.size * 0.42, String(a.item), Math.min(3.5, st.size * 1.2), "middle", { bold: true });
  });
}

// ---------- tables and fields ----------

const LIB_NAMES: Record<string, string> = {
  usb_c: "USB-C receptacle",
  pcb: "Circuit board",
  nema17: "NEMA 17 motor",
  spur_gear: "Spur gear",
  screw: "Screw",
  nut: "Nut",
  insert: "Threaded insert",
  dowel: "Dowel pin",
  bearing: "Ball bearing",
  connector: "Connector",
};

/**
 * What a made part looks like wherever it sits: its recipe's structure, its
 * volume and size, and its features measured from its own corner. Parts
 * modelled in place (a loop of pins each with its own at:) come out the
 * same when they are the same part.
 */
function shapeKey(p: EvalPart, bboxOf?: BBoxOf, volumeOf?: (p: EvalPart) => number | undefined): string {
  const local = bboxOf?.(p);
  const vol = volumeOf?.(p);
  if (!local || vol === undefined) return p.hash;
  const [lo, hi] = worldBox(p, local);
  const r = (n: number) => Math.round(n * 100) / 100;
  const structure = JSON.stringify(p.recipe, (_k, v) => (typeof v === "number" ? 0 : v));
  const feats = partFeatures(p).map((f) => JSON.stringify({ ...f, part: undefined, at: "at" in f ? (f.at as V3).map((c, k) => r(c - lo[k])) : undefined }, (_k, v) => (typeof v === "number" ? r(v) : v)));
  return recipeHash({ structure, vol: Number(vol.toPrecision(7)), size: hi.map((h, k) => r(h - lo[k])), feats: feats.sort() });
}

function bomLines(parts: EvalPart[], bboxOf?: BBoxOf, volumeOf?: (p: EvalPart) => number | undefined): BomLine[] {
  const rows = new Map<string, BomLine & { kind: string; names: Set<string> }>();
  const seen = new Set<string>();
  for (const p of parts) {
    const inst = p.id.split(".")[0];
    if (p.kind === "component" && seen.has(inst)) continue;
    seen.add(inst);
    const description = p.bom?.description ?? (p.kind === "part" ? `Custom part` : p.label);
    const kind = p.kind === "part" ? "Make" : "Buy";
    const name = p.kind === "part" ? humanize(p.label) : (LIB_NAMES[p.libKind ?? ""] ?? humanize(p.libKind ?? p.name));
    // made parts of the same shape, material and hand are one line, whatever they are called
    const hand = (p.worldXf ?? p.xf).filter((x) => x.op === "mirror").length % 2;
    const key = p.kind === "part" ? `${kind}|${shapeKey(p, bboxOf, volumeOf)}|${hand}|${p.material}|${description}` : `${kind}|${description}|${p.material}`;
    const row = rows.get(key);
    const ids = parts.filter((q) => q.id.split(".")[0] === inst).map((q) => q.id);
    if (row) {
      row.qty++;
      row.ids.push(...ids);
      row.names.add(name);
    } else rows.set(key, { item: 0, qty: 1, name, names: new Set([name]), description: p.bom?.standard ? `${description} (${p.bom.standard})` : description, material: MATERIALS[p.material]?.label ?? p.material, ids, kind });
  }
  for (const r of rows.values()) if (r.names.size > 1) r.name = sharedName([...r.names]);
  const list = [...rows.values()].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === "Make" ? -1 : 1));
  return list.map((r, i) => ({ item: i + 1, qty: r.qty, name: r.name, description: r.description, material: r.material, ids: r.ids }));
}

/** One name for parts made alike: the words their names share ("Cup a1", "Cup b2" → "Cup"; "Left side", "Right side" → "Side"), else the first name and how many more. */
function sharedName(names: string[]): string {
  const words = names.map((n) => n.split(/[\s_]+/).filter(Boolean));
  const common = (pick: (w: string[], i: number) => string | undefined) => {
    const out: string[] = [];
    for (let i = 0; ; i++) {
      const w = pick(words[0], i);
      if (w === undefined || !words.every((ws) => pick(ws, i)?.toLowerCase() === w.toLowerCase())) return out;
      out.push(w);
    }
  };
  const head = common((w, i) => w[i]);
  if (head.length) return humanize(head.join(" "));
  const tail = common((w, i) => w[w.length - 1 - i]).reverse();
  if (tail.length) return humanize(tail.join(" "));
  return `${names[0]} (+${names.length - 1})`;
}

function defaultNotes(spec: DrawingSpec, plan: DrawingPlan, built: { datums: unknown[]; notes: string[] }): string[] {
  const out = ["ALL DIMENSIONS IN MILLIMETRES."];
  if (/2768|8062/.test(spec.tolerance)) out.push(`UNLESS OTHERWISE STATED, TOLERANCES TO ${spec.tolerance.toUpperCase()}.`);
  else if (spec.tolerance) out.push(`GENERAL TOLERANCES: ${spec.tolerance.toUpperCase()}.`);
  if (built.datums.length) out.push(spec.projection === "third" ? "INTERPRET DIMENSIONS AND TOLERANCES PER ASME Y14.5-2018. BOXED DIMENSIONS ARE BASIC." : "GEOMETRICAL TOLERANCES TO ISO 1101, DATUMS TO ISO 5459. BOXED DIMENSIONS ARE THEORETICALLY EXACT.");
  const part = !plan.assembly ? plan.parts.find((p) => p.kind === "part") : undefined;
  if (part) out.push(...processNotes(part));
  if (spec.flat) out.push("FLAT PATTERN SEEN FROM ABOVE: UP BENDS RISE TOWARD THE VIEWER. BEND LINES CHAIN-DOTTED, WITH ANGLES AND INSIDE RADII IN THE BEND TABLE.");
  return [...out, ...built.notes, ...spec.notes.map((n) => n.toUpperCase())];
}

/** What the maker needs to know for the way the part is made. */
function processNotes(p: EvalPart): string[] {
  const family = processFamily(p);
  const set = p.process?.settings ?? {};
  if (family === "subtractive") return ["BREAK SHARP EDGES 0.2 × 45° MAX AND REMOVE BURRS.", "SURFACE TEXTURE Ra 3.2 µm UNLESS STATED."];
  if (family === "additive") {
    const out = ["REMOVE SUPPORT MATERIAL AND BREAK SHARP EDGES."];
    const b = set.build;
    if (Array.isArray(b) && b.length === 3 && typeof b[0] === "number") {
      const up = vnorm(applyXformsToDir(b as V3, p.xf));
      const axis = up.map(Math.abs).indexOf(Math.max(...up.map(Math.abs)));
      if (Math.abs(up[axis]) > 0.999) {
        const layer = typeof set.layer === "number" ? `, ${fmtNum(set.layer)} MM LAYERS` : "";
        const name = `${up[axis] > 0 ? "+" : "−"}${"XYZ"[axis]}`;
        out.push(`PRINT ON THE ${faceName([-up[0], -up[1], -up[2]]).toUpperCase()} FACE, BUILDING TOWARD ${name}${layer}.`);
      }
    }
    return out;
  }
  if (family === "formative") return ["REMOVE FLASH AND GATE MARKS FLUSH; BREAK SHARP EDGES."];
  return ["REMOVE BURRS AND BREAK SHARP EDGES."];
}

/**
 * Datum symbols on faces seen edge-on: each goes to the first spot along its
 * edge where the letter (and its frame) clears everything already on the
 * sheet, trying longer stems further out.
 */
function inkMarks(ink: Ink, marks: DatumMark[], views: SheetView[], st: DimStyle, fixed: Box[], frame: Box) {
  // what is already on the sheet, polylines as their segments so an outline's box doesn't fill its inside
  const taken: Box[] = [];
  for (const sh of ink.shapes) {
    if (sh.key === "border") continue;
    if (sh.t === "poly") {
      const p = sh.p;
      const n = p.length / 2;
      for (let i = 0; i + 1 < n + (sh.closed ? 1 : 0); i++) {
        const j = (i + 1) % n;
        taken.push([Math.min(p[2 * i], p[2 * j]), Math.min(p[2 * i + 1], p[2 * j + 1]), Math.max(p[2 * i], p[2 * j]), Math.max(p[2 * i + 1], p[2 * j + 1])]);
      }
    } else taken.push(shapeBox(sh));
  }
  const area = inset(frame, 2);
  const hit = (b: Box) => b[0] < area[0] || b[1] < area[1] || b[2] > area[2] || b[3] > area[3] || fixed.some((f) => f[0] < b[2] && b[0] < f[2] && f[1] < b[3] && b[1] < f[3]) || taken.some((t) => t[0] < b[2] + 0.5 && b[0] < t[2] + 0.5 && t[1] < b[3] + 0.5 && b[1] < t[3] + 0.5);
  for (const m of marks) {
    const sv = views[m.view];
    if (!sv || sv.state !== "ready") continue;
    const P = (p: [number, number]): [number, number] => [sv.origin[0] + p[0] * sv.scale, sv.origin[1] - p[1] * sv.scale];
    const A = P(m.a);
    const B = P(m.b);
    const ux = m.out[0];
    const uy = -m.out[1];
    const fw = m.frame ? fcfWidth(m.frame, st.size) : 0;
    const fh = fcfHeight(st.size);
    /** the box of the letter and its frame, beyond the triangle and stem */
    const region = (x: number, y: number, stem: number): { box: Box; fx: number; fy: number } => {
      const e = datumExtent(x, y, ux, uy, st.size, stem);
      // the letter box is the far end of the extent
      const b = st.size * 1.75;
      const bx = ux > 0 ? e[2] - b : ux < 0 ? e[0] : (e[0] + e[2]) / 2 - b / 2;
      const by = uy > 0 ? e[3] - b : uy < 0 ? e[1] : (e[1] + e[3]) / 2 - b / 2;
      // the frame carries on outward from a side letter, and to the right of a letter above or below
      const fx = ux < 0 ? bx - 1 - fw : bx + b + 1;
      const fy = by + b / 2 - fh / 2;
      const box: Box = [Math.min(bx, fw ? fx : bx), Math.min(by, fy), Math.max(bx + b, fw ? fx + fw : bx + b), Math.max(by + b, fy + fh)];
      return { box, fx, fy };
    };
    let pick: { x: number; y: number; stem: number } | null = null;
    search: for (const stem of [1.5, 5, 10, 16]) {
      for (const t of [m.t, 0.5, 0.2, 0.8, 0.35, 0.65, 0.1, 0.9]) {
        const x = A[0] + (B[0] - A[0]) * t;
        const y = A[1] + (B[1] - A[1]) * t;
        if (!hit(region(x, y, stem).box)) {
          pick = { x, y, stem };
          break search;
        }
      }
    }
    pick ??= { x: A[0] + (B[0] - A[0]) * m.t, y: A[1] + (B[1] - A[1]) * m.t, stem: 1.5 };
    ink.key = `v${m.view}`;
    const box = inkDatum(ink, pick.x, pick.y, ux, uy, m.letter, st.size, pick.stem);
    const r = region(pick.x, pick.y, pick.stem);
    if (m.frame) inkFcf(ink, r.fx, r.fy, m.frame, st.size);
    taken.push(box, r.box);
  }
}

type DataTable = { title: string; rows: [string, string][] };

/** The table in the bottom-left corner: a gear's data, or a flat pattern's bends. */
function dataTable(plan: DrawingPlan): DataTable | null {
  if (plan.spec.flat) {
    const rows = bendRows(plan.parts);
    return rows ? { title: "BEND TABLE", rows } : null;
  }
  const rows = !plan.assembly ? gearTable(plan.parts[0]) : null;
  return rows ? { title: "GEAR DATA", rows } : null;
}

/** Each bend's centre line across the flat, chain-dotted and tagged with its bend-table label. */
function bendLines(ink: Ink, i: number, sv: SheetView, v: PlannedView, plan: DrawingPlan, st: DimStyle) {
  const s = sv.scale;
  const [ox, oy] = sv.origin;
  for (const p of plan.parts) {
    if (!p.sheet) continue;
    ink.key = `v${i}:p${plan.parts.indexOf(p)}`;
    const dx = flatShift(p);
    p.sheet.bends.forEach((b, k) => {
      const [a, c] = b.line.map(([x, y]) => toView([x + dx, y, 0], v.frame)).map(([u, w]) => [ox + u * s, oy - w * s] as [number, number]);
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (len < 1e-6) return;
      // a little past the blank's edges, as bend lines are drawn
      const ext = Math.min(3, len * 0.1);
      const e: [number, number] = [(c[0] - a[0]) / len, (c[1] - a[1]) / len];
      ink.line(a[0] - e[0] * ext, a[1] - e[1] * ext, c[0] + e[0] * ext, c[1] + e[1] * ext, "phantom");
      // the tag reads along the line at its middle, on the side its letters stand up from
      let rot = (Math.atan2(-e[1], e[0]) * 180) / Math.PI;
      if (rot > 90) rot -= 180;
      if (rot <= -90) rot += 180;
      const r = (rot * Math.PI) / 180;
      const off = st.size * 0.4;
      const mid: [number, number] = [(a[0] + c[0]) / 2 - Math.sin(r) * off, (a[1] + c[1]) / 2 - Math.cos(r) * off];
      ink.text(mid[0], mid[1], `${bendLabel(k)} ${bendWay(b.angle)} ${fmtNum(Math.abs(b.angle))}°`, st.size * 0.85, "middle", { rot });
    });
  }
}

function gearTable(p: EvalPart | undefined): [string, string][] | null {
  if (!p?.gear) return null;
  const g = p.gear;
  return [
    ["MODULE", fmtNum(g.m)],
    ["NUMBER OF TEETH", String(g.z)],
    ["PRESSURE ANGLE", `${fmtNum(g.pa)}°`],
    ["PITCH DIAMETER", `Ø${fmtNum(g.m * g.z)}`],
    ["TIP DIAMETER", `Ø${fmtNum(g.m * (g.z + 2))}`],
    ["FACE WIDTH", fmtNum(g.width)],
    ["BACKLASH", fmtNum(g.backlash, 3)],
  ];
}

/** The finish the parts actually get (the material's default when none is set), or a dash when they differ. */
function finishText(parts: EvalPart[]): string {
  const custom = parts.filter((p) => p.kind === "part");
  const ids = new Set((custom.length ? custom : parts).map((p) => resolveFinish(p.material, p.finish)));
  if (ids.size !== 1) return "—";
  const id = [...ids][0];
  return FINISHES[id]?.label ?? id;
}

/** The parts' mass as the design's mass report gives it: a stated mass: where there is one (bought parts, hollow parts), else the solid's volume times its material's density. */
function massText(parts: EvalPart[], volumeOf?: (p: EvalPart) => number | undefined): string {
  let g = 0;
  for (const p of parts) {
    const m = partMass(p, volumeOf?.(p), materialDensity(p.material));
    if (m === undefined) return "";
    g += m;
  }
  return g >= 1000 ? `${fmtNum(g / 1000, 2)} kg` : `${fmtNum(g, g < 10 ? 2 : 1)} g`;
}

function subtitle(spec: DrawingSpec, plan: DrawingPlan, model: Model): string {
  if (!model.name || model.name === spec.title) return plan.assembly ? "ASSEMBLY" : "";
  return model.name.toUpperCase() + (plan.assembly ? " · ASSEMBLY" : "");
}

function drawingNumber(spec: DrawingSpec): string {
  const name = spec.name.replace(/^auto:/, "").replace(/_(drawing|dwg)(_\d+)?$/i, "$2");
  const base = name === "assembly" ? "ASM" : name;
  return "KRF-" + base.toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 20);
}

function dimLabel(d: DimDef): string {
  let s = d.text.main;
  if (d.text.suffix) s += " " + d.text.suffix;
  if (d.text.up || d.text.lo) s += ` ${d.text.up ?? ""}/${d.text.lo ?? ""}`;
  if (d.lines?.length) s += " · " + d.lines.join(" · ");
  return s;
}

/** Box around everything inked with a key, for hit-testing in the viewer. */
export function keyBoxes(sheet: Sheet): Map<string, Box> {
  const out = new Map<string, Box>();
  for (const s of sheet.shapes) {
    const b = shapeBox(s);
    const cur = out.get(s.key) ?? emptyBox();
    growBox(cur, b[0], b[1]);
    growBox(cur, b[2], b[3]);
    out.set(s.key, cur);
  }
  return out;
}

