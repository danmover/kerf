// Part inspection for Claude and the UI: named features, sharp edges, what a
// selector picks, and what lies under a clicked point.

import * as R from "replicad";
import type { Shape3D } from "replicad";
import { bboxOf } from "./build";
import type { InspectEdge, InspectFace, InspectRequest, InspectResult, OutlineEdge } from "./protocol";
import type { V3 } from "./recipe";
import { Topo, type FeatureTools } from "./topology";

const r2 = (n: number) => Math.round(n * 100) / 100;
const p3 = (p: V3): V3 => [r2(p[0]), r2(p[1]), r2(p[2])];

export function inspectShape(shape: Shape3D, features: Map<string, FeatureTools>, req: InspectRequest, volume: number): InspectResult {
  const t0 = performance.now();
  const topo = new Topo(shape, features);
  try {
    const limit = Math.max(1, Math.min(req.limit ?? 30, 200));
    const edgeFeatures = (i: number) => [...new Set(topo.edge(i).faces.flatMap((f) => topo.featuresOfFace(f)))];
    const edgeOut = (i: number): InspectEdge => {
      const e = topo.edge(i);
      return { kind: e.kind.toLowerCase(), length: r2(e.length), mid: p3(e.m), radius: e.radius ? r2(e.radius) : undefined, convexity: e.convexity, features: edgeFeatures(i) };
    };
    const faceOut = (i: number): InspectFace => {
      const s = topo.face(i);
      return { kind: s.kind.toLowerCase(), center: p3(s.pts[0]), normal: s.kind === "PLANE" ? p3(s.normals[0]) : undefined, features: topo.featuresOfFace(i) };
    };

    const stats = { convex: 0, concave: 0, smooth: 0 };
    topo.edges.forEach((_, i) => {
      const c = topo.edge(i).convexity;
      if (c === "convex") stats.convex++;
      else if (c === "concave") stats.concave++;
      else if (c === "smooth") stats.smooth++;
    });

    const feats = [...features.values()].map((f) => {
      let faces = 0;
      let root = 0;
      let tip = 0;
      try {
        faces = topo.featureFaceSet(f.name).size;
        root = topo.selectEdges({ s: "feat", f: f.name, part: "root" }).size;
        tip = topo.selectEdges({ s: "feat", f: f.name, part: "tip" }).size;
      } catch {
        /* feature with no surviving faces */
      }
      return { name: f.name, kind: f.kind, faces, root, tip };
    });

    const result: InspectResult = {
      bbox: bboxOf(shape).map(p3) as [V3, V3],
      volume: Math.round(volume),
      faces: topo.faces.length,
      edges: topo.edges.length,
      features: feats,
      edgeStats: stats,
      ms: 0,
    };

    if (req.sel !== undefined) {
      const kind = req.selKind ?? "edges";
      if (kind === "edges") {
        const idx = [...topo.selectEdges(req.sel)];
        result.selection = { kind, count: idx.length, edges: idx.slice(0, limit).map(edgeOut) };
      } else {
        const idx = [...topo.selectFaces(req.sel)];
        result.selection = { kind, count: idx.length, faces: idx.slice(0, limit).map(faceOut) };
      }
    }

    if (req.at) {
      const at = req.at;
      const dist = new R.DistanceTool();
      const v = R.makeVertex(at);
      let bestE = -1;
      let bestEd = Infinity;
      topo.edges.forEach((e, i) => {
        if (topo.edge(i).convexity === "seam") return;
        const d = dist.distanceBetween(v, e);
        if (d < bestEd) {
          bestEd = d;
          bestE = i;
        }
      });
      let bestF = -1;
      let bestFd = Infinity;
      topo.faces.forEach((f, i) => {
        const d = dist.distanceBetween(v, f);
        if (d < bestFd) {
          bestFd = d;
          bestF = i;
        }
      });
      v.delete();
      dist.delete();
      const selectors: string[] = [];
      const pick: NonNullable<InspectResult["pick"]> = { selectors };
      if (bestE >= 0) {
        pick.edge = { ...edgeOut(bestE), distance: r2(bestEd) };
        // the most specific name that picks this edge
        for (const f of features.keys()) {
          for (const part of ["root", "tip"] as const) {
            if (topo.selectEdges({ s: "feat", f, part }).has(bestE)) selectors.push(`${f}.${part}`);
          }
        }
        const m = topo.edge(bestE).m;
        selectors.push(`near((${p3(m).join(", ")}), ${r2(Math.max(0.2, Math.min(1, topo.edge(bestE).length / 4)))})`);
      }
      if (bestF >= 0) {
        pick.face = { ...faceOut(bestF), distance: r2(bestFd) };
        for (const f of topo.featuresOfFace(bestF)) selectors.push(`${f}.faces`);
        if (req.outline) pick.outline = outlineOf(topo.faces[bestF]);
      }
      result.pick = pick;
    }
    result.ms = Math.round(performance.now() - t0);
    return result;
  } finally {
    topo.dispose();
  }
}

/** The edges round a face, sampled: two points for a line, five along a circle or arc, seventeen along anything else. */
function outlineOf(face: R.Face): OutlineEdge[] {
  const out: OutlineEdge[] = [];
  for (const e of face.edges) {
    const kind = String(e.geomType);
    const at = (t: number): V3 => {
      const v = e.pointAt(t);
      const p: V3 = [v.x, v.y, v.z];
      v.delete();
      return p;
    };
    if (kind === "LINE") out.push({ kind: "line", pts: [at(0), at(1)] });
    else if (kind === "CIRCLE") out.push({ kind: "circle", pts: [0, 0.25, 0.5, 0.75, 1].map(at) });
    else out.push({ kind: "other", pts: Array.from({ length: 17 }, (_, k) => at(k / 16)) });
    e.delete();
  }
  return out;
}
