// The design's dependency graph: parameters flow into layout values, parts
// and requirements. Hover a node to see what it drives and what drives it.

import { motion } from "framer-motion";
import { useMemo, useState } from "react";
import { useDesign } from "../core/engine";
import { revealSpan, select } from "../app/view";
import type { DepNode, Model } from "../core/model";

const KIND_COLOR: Record<DepNode["kind"], string> = {
  param: "#ffcb6b",
  let: "#7cc4ff",
  interface: "#4fd1c5",
  component: "#c792ff",
  part: "#6d8bff",
  require: "#3ddc97",
};
const W = 168;
const H = 30;
const GX = 74;
const GY = 12;

interface Laid {
  node: DepNode;
  x: number;
  y: number;
}

function layout(m: Model) {
  const parents = new Map<string, string[]>();
  const ids = new Set(m.graph.nodes.map((n) => n.id));
  const edges = m.graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  for (const e of edges) parents.set(e.to, [...(parents.get(e.to) ?? []), e.from]);
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const d = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const ps = parents.get(id) ?? [];
    const v = ps.length ? Math.max(...ps.map(d)) + 1 : 0;
    visiting.delete(id);
    depth.set(id, v);
    return v;
  };
  for (const n of m.graph.nodes) d(n.id);
  // requirements always in the last column
  const maxD = Math.max(0, ...[...depth.values()]);
  for (const n of m.graph.nodes) if (n.kind === "require") depth.set(n.id, maxD + 1);
  const cols = new Map<number, DepNode[]>();
  for (const n of m.graph.nodes) cols.set(depth.get(n.id)!, [...(cols.get(depth.get(n.id)!) ?? []), n]);
  const order: DepNode["kind"][] = ["param", "interface", "let", "component", "part", "require"];
  const laid = new Map<string, Laid>();
  let maxRows = 0;
  for (const [c, list] of [...cols.entries()].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.label.localeCompare(b.label));
    list.forEach((n, i) => laid.set(n.id, { node: n, x: 16 + c * (W + GX), y: 16 + i * (H + GY) }));
    maxRows = Math.max(maxRows, list.length);
  }
  const width = 32 + (Math.max(...cols.keys(), 0) + 1) * (W + GX) - GX;
  const height = 32 + maxRows * (H + GY);
  return { laid, edges, width, height, parents };
}

export function GraphView() {
  const model = useDesign((s) => s.model);
  const [hot, setHot] = useState<string | null>(null);
  const g = useMemo(() => (model ? layout(model) : null), [model]);
  const related = useMemo(() => {
    if (!g || !hot) return null;
    const up = new Set<string>([hot]);
    const down = new Set<string>([hot]);
    const children = new Map<string, string[]>();
    for (const e of g.edges) children.set(e.from, [...(children.get(e.from) ?? []), e.to]);
    const walk = (start: string, next: Map<string, string[]>, acc: Set<string>) => {
      const st = [start];
      while (st.length) {
        const c = st.pop()!;
        for (const n of next.get(c) ?? []) if (!acc.has(n)) (acc.add(n), st.push(n));
      }
    };
    walk(hot, g.parents, up);
    walk(hot, children, down);
    return new Set([...up, ...down]);
  }, [g, hot]);

  if (!model || !g) return null;
  if (!model.graph.nodes.length)
    return (
      <div className="empty-state" style={{ margin: 16 }}>
        The graph appears once the design defines parameters, parts or requirements.
      </div>
    );

  const open = (n: DepNode) => {
    const name = n.kind === "require" ? null : n.id;
    const block = model.blocks.find((b) => b.name === name);
    const req = model.requirements.find((r) => `require:${r.label}` === n.id);
    const span = block?.span ?? req?.span;
    if (span) revealSpan(span);
    if (n.kind === "part" || n.kind === "component") select(model.parts.filter((p) => p.name === n.id).map((p) => p.id));
  };

  return (
    <div className="graph-wrap">
      <svg width={g.width} height={g.height} style={{ display: "block" }}>
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M0 0 10 5 0 10z" fill="#39445c" />
          </marker>
        </defs>
        {g.edges.map((e, i) => {
          const a = g.laid.get(e.from);
          const b = g.laid.get(e.to);
          if (!a || !b) return null;
          const x1 = a.x + W;
          const y1 = a.y + H / 2;
          const x2 = b.x;
          const y2 = b.y + H / 2;
          const mx = (x1 + x2) / 2;
          const isHot = related && related.has(e.from) && related.has(e.to);
          return <path key={i} d={`M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`} className={`graph-edge ${isHot ? "hot" : related ? "dim" : ""}`} markerEnd="url(#arrow)" />;
        })}
        {[...g.laid.values()].map(({ node, x, y }, i) => {
          const color = KIND_COLOR[node.kind];
          const req = node.kind === "require" ? model.requirements.find((r) => `require:${r.label}` === node.id) : null;
          const status = req ? (req.status === "pass" ? "#3ddc97" : req.status === "fail" ? "#ff5d6c" : "#6d8bff") : null;
          const dim = related && !related.has(node.id);
          return (
            <motion.g
              key={node.id}
              className="graph-node"
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: dim ? 0.25 : 1, x: 0 }}
              transition={{ delay: Math.min(i * 0.008, 0.4), duration: 0.25 }}
              onMouseEnter={() => setHot(node.id)}
              onMouseLeave={() => setHot(null)}
              onClick={() => open(node)}
              style={{ cursor: "pointer" }}
            >
              <rect x={x} y={y} width={W} height={H} rx={7} fill="#121722" stroke={hot === node.id ? color : "#2a3245"} />
              <rect x={x} y={y + 7} width={3} height={H - 14} rx={1.5} fill={status ?? color} />
              <text x={x + 12} y={y + 12.5} fill="#6c7791" fontSize={8.5} fontFamily="IBM Plex Mono" letterSpacing="0.08em">
                {node.kind.toUpperCase()}
              </text>
              <text x={x + 12} y={y + 24} fill="#dfe5f2" fontSize={11} fontFamily="IBM Plex Mono">
                {truncate(node.kind === "require" ? node.label : node.id, 22)}
              </text>
            </motion.g>
          );
        })}
      </svg>
    </div>
  );
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
