// Builds a laid-out board (machine/boards3d/layout.ts) as 3D meshes in the
// board's own frame: the painted top and bottom faces, the laminate edge, and
// every part on it modelled at its real size: chips with their leads and
// markings, headers, screw terminals, USB and HDMI sockets, capacitors,
// inductors, heatsinks, the small surface-mount parts and the solder joints.

import * as THREE from "three";
import type { CatalogPart } from "../../../machine/types";
import type { Frame } from "../../../machine/harness/harness";
import type { V3 } from "../../../kernel/recipe";
import { boardLayout, chipLeads, openingDir, SMD_SIZE, type BoardLayout, type Smd } from "../../../machine/boards3d/layout";
import { headerPins, terminalContacts, type BoardItem } from "../../../machine/boards3d/pins";
import { socketBody } from "../wiring/bodies";
import { MeshBuilder } from "../wiring/builder";
import { markingTexture, paintFace, type FaceMaps } from "./paint";

const EPOXY = "#1b1b1e";
const EPOXY_DARK = "#0e0e10";
const TIN = "#c9ccd1";
const GOLD = "#d9b45a";
const STEEL = "#b9bdc4";
const BLACK = "#141517";
const FR4 = "#b3a678";

export interface BoardModel {
  object: THREE.Group;
  /** every material and texture, to dispose with the model */
  dispose(): void;
}

const F = (o: V3, dx: [number, number] = [1, 0]): Frame => ({ o, x: [dx[0], dx[1], 0], y: [-dx[1], dx[0], 0], z: [0, 0, 1] });

/** A frame whose z points along a direction in the board's plane, for things that open sideways. */
const along = (o: V3, dir: [number, number]): Frame => ({ o, x: [-dir[1], dir[0], 0], y: [0, 0, 1], z: [dir[0], dir[1], 0] });

/** The builders a board's parts go into, one per kind of surface. */
interface Kit {
  plastic: MeshBuilder;
  metal: MeshBuilder;
  satin: MeshBuilder;
  gloss: MeshBuilder;
  decals: { text: string; x: number; y: number; z: number; w: number; d: number; dark: boolean; rot: number }[];
}

/** A bought board, laid out from its catalog entry. */
export function buildBoard(part: CatalogPart): BoardModel {
  return buildLayout(boardLayout(part), part);
}

/** Any laid-out board; `part` is the catalog board its parts belong to (routed boards have none of their own). */
export function buildLayout(L: BoardLayout, part?: CatalogPart): BoardModel {
  const kit: Kit = { plastic: new MeshBuilder(), metal: new MeshBuilder(), satin: new MeshBuilder(), gloss: new MeshBuilder(), decals: [] };
  if (part) for (const it of L.items) item(kit, part, L, it);
  for (const s of L.smd) smd(kit, L, s);
  joints(kit, L);
  edge(kit, L);
  for (const s of L.sockets) {
    // the plug table's frame: x along the contacts, z the way the plug goes in
    const x = s.row;
    const z = s.out;
    const y: V3 = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    socketBody(kit.plastic, kit.metal, { o: s.at, x, y, z }, s.kind, s.ways, s.pitch, false);
  }
  const group = new THREE.Group();
  group.name = `board ${part?.id ?? "routed"}`;
  const disposables: { dispose(): void }[] = [];
  const add = (b: MeshBuilder, mat: THREE.Material) => {
    if (!b.vertexCount) return;
    const g = b.build();
    g.deleteAttribute("span");
    // RGBA vertex colours: the path tracer merges every mesh's colours into one RGBA buffer
    const c3 = g.getAttribute("color") as THREE.BufferAttribute;
    const c4 = new Float32Array(c3.count * 4).fill(1);
    for (let i = 0; i < c3.count; i++) c4.set([c3.getX(i), c3.getY(i), c3.getZ(i)], i * 4);
    g.setAttribute("color", new THREE.BufferAttribute(c4, 4));
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    disposables.push(g, mat);
  };
  add(kit.plastic, new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.55, metalness: 0, clearcoat: 0.15, clearcoatRoughness: 0.5 }));
  add(kit.metal, new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.28, metalness: 0.92 }));
  add(kit.satin, new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.55 }));
  add(kit.gloss, new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.06, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04, transmission: 0 }));
  for (const side of ["top", "bottom"] as const) {
    const maps = paintFace(L, side);
    const mesh = skin(L, side, maps);
    group.add(mesh);
    disposables.push(mesh.geometry, mesh.material as THREE.Material, maps.map, maps.coat, maps.normal);
  }
  for (const d of kit.decals) {
    const tex = markingTexture(d.text, d.w, d.d, d.dark);
    const mat = new THREE.MeshPhysicalMaterial({ map: tex, transparent: true, alphaTest: 0.25, roughness: 0.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const geo = new THREE.PlaneGeometry(d.w, d.d);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(d.x, d.y, d.z);
    m.rotation.z = (d.rot * Math.PI) / 180;
    group.add(m);
    disposables.push(geo, mat, tex);
  }
  return { object: group, dispose: () => disposables.forEach((x) => x.dispose()) };
}

/** A painted face: a plane just off the board's surface, with UVs over the whole board. */
function skin(L: BoardLayout, side: "top" | "bottom", maps: FaceMaps): THREE.Mesh {
  const g = new THREE.PlaneGeometry(L.w, L.d);
  const top = side === "top";
  const z = top ? L.t + 0.012 : -0.012;
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) pos.setZ(i, z);
  if (!top) {
    // face down: flip the winding and the normal, keep the UVs on the board's x and y
    const idx = g.getIndex()!;
    for (let i = 0; i < idx.count; i += 3) {
      const a = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, a);
    }
    const n = g.getAttribute("normal") as THREE.BufferAttribute;
    for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 0, -1);
  }
  const tan = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) tan.set([1, 0, 0, top ? 1 : -1], i * 4);
  g.setAttribute("tangent", new THREE.BufferAttribute(tan, 4));
  const mat = new THREE.MeshPhysicalMaterial({
    map: maps.map,
    roughnessMap: maps.coat,
    metalnessMap: maps.coat,
    clearcoatMap: maps.coat,
    normalMap: maps.normal,
    normalScale: new THREE.Vector2(1, 1),
    roughness: 1,
    metalness: 1,
    clearcoat: 0.55,
    clearcoatRoughness: 0.16,
    alphaTest: 0.5,
  });
  const m = new THREE.Mesh(g, mat);
  m.receiveShadow = true;
  m.castShadow = false;
  m.name = `${side} face`;
  return m;
}

/** The laminate's cut edge round the board, slightly proud of the solid's sides. */
function edge(k: Kit, L: BoardLayout) {
  const f = F([0, 0, 0]);
  const e = 0.02;
  const r = L.corner;
  const edgeCol = `#${new THREE.Color(L.style.mask).lerp(new THREE.Color(FR4), 0.55).getHexString()}`;
  k.plastic.box(f, -L.w / 2 + r, L.w / 2 - r, L.d / 2 - 0.05, L.d / 2 + e, 0.02, L.t - 0.02, edgeCol);
  k.plastic.box(f, -L.w / 2 + r, L.w / 2 - r, -L.d / 2 - e, -L.d / 2 + 0.05, 0.02, L.t - 0.02, edgeCol);
  k.plastic.box(f, L.w / 2 - 0.05, L.w / 2 + e, -L.d / 2 + r, L.d / 2 - r, 0.02, L.t - 0.02, edgeCol);
  k.plastic.box(f, -L.w / 2 - e, -L.w / 2 + 0.05, -L.d / 2 + r, L.d / 2 - r, 0.02, L.t - 0.02, edgeCol);
}

/** Solder joints on the through-hole pins, both faces. */
function joints(k: Kit, L: BoardLayout) {
  const up = F([0, 0, 0]);
  for (const [x, y, r] of L.top.joints) k.metal.blob(up, x, y, L.t + 0.05, r, 0.55, TIN);
  for (const [x, y, r] of L.bottom.joints) {
    k.metal.blob(up, x, y, -0.05, r, -0.6, TIN);
    k.metal.cyl(up, x, y, -1.6, -0.2, 0.22, TIN, 6);
  }
}

/** Gull-wing leads from a package edge out to the feet. */
function gullWings(k: Kit, it: BoardItem, t: number, body: [number, number], h: number) {
  const { feet } = chipLeads(it);
  for (const [fx, fy] of feet) {
    const dx = fx - it.x;
    const dy = fy - it.y;
    const alongX = Math.abs(dx) / body[0] > Math.abs(dy) / body[1];
    const dir: [number, number] = alongX ? [Math.sign(dx), 0] : [0, Math.sign(dy)];
    const edge = alongX ? body[0] / 2 : body[1] / 2;
    const reach = alongX ? Math.abs(dx) : Math.abs(dy);
    const f = F([it.x + dir[0] * edge, it.y + dir[1] * edge, t], dir);
    // lateral position along the edge
    const lat = alongX ? (fy - it.y) * dir[0] : -(fx - it.x) * dir[1];
    const run = reach - edge;
    const hw = 0.12;
    const mid = Math.min(h * 0.45, 0.6);
    k.metal.box(f, 0, run * 0.45, lat - hw, lat + hw, mid, mid + 0.15, TIN);
    k.metal.box(f, run * 0.4, run * 0.55, lat - hw, lat + hw, 0.02, mid + 0.15, TIN);
    k.metal.box(f, run * 0.5, run + 0.2, lat - hw, lat + hw, 0.02, 0.17, TIN);
  }
}

function chip(k: Kit, it: BoardItem, t: number, kind: "qfp" | "soic" | "qfn" | "dip" | "can" | "power") {
  const f = F([it.x, it.y, t]);
  if (kind === "qfp") {
    const b: [number, number] = [it.w - 2, it.d - 2];
    k.plastic.box(f, -b[0] / 2, b[0] / 2, -b[1] / 2, b[1] / 2, 0.12, 1.45, EPOXY);
    k.plastic.cyl(f, -b[0] / 2 + 0.9, b[1] / 2 - 0.9, 1.45, 1.46, 0.45, EPOXY_DARK, 14);
    gullWings(k, it, t, b, 1.45);
    mark(k, it, t + 1.47, b[0] * 0.8, b[1] * 0.6, false);
  } else if (kind === "soic") {
    const alongX = it.w >= it.d;
    const b: [number, number] = alongX ? [it.w, it.d] : [it.w, it.d];
    const h = Math.max(1, Math.min(1.75, it.h));
    k.plastic.box(f, -b[0] / 2, b[0] / 2, -b[1] / 2, b[1] / 2, 0.1, h, EPOXY);
    k.plastic.cyl(f, alongX ? -b[0] / 2 + 0.8 : -b[0] / 2 + 0.6, alongX ? -b[1] / 2 + 0.6 : b[1] / 2 - 0.8, h, h + 0.01, 0.3, EPOXY_DARK, 12);
    gullWings(k, it, t, b, h);
    mark(k, it, t + h + 0.02, b[0] * 0.8, b[1] * 0.6, false);
  } else if (kind === "qfn") {
    k.plastic.box(f, -it.w / 2, it.w / 2, -it.d / 2, it.d / 2, 0.02, it.h, EPOXY);
    const { feet } = chipLeads(it);
    for (const [fx, fy] of feet) {
      const dx = fx - it.x;
      const dy = fy - it.y;
      const alongX = Math.abs(dx) > Math.abs(dy);
      const g = F([fx, fy, t]);
      if (alongX) k.metal.box(g, -0.2, 0.06, -0.12, 0.12, 0.02, 0.22, TIN);
      else k.metal.box(g, -0.12, 0.12, -0.2, 0.06, 0.02, 0.22, TIN);
    }
    k.plastic.cyl(f, -it.w / 2 + 0.5, it.d / 2 - 0.5, it.h, it.h + 0.01, 0.22, EPOXY_DARK, 10);
    mark(k, it, t + it.h + 0.02, it.w * 0.85, it.d * 0.65, false);
  } else if (kind === "dip") {
    const alongX = it.w >= it.d;
    const bw = alongX ? it.w : it.w - 1.2;
    const bd = alongX ? it.d - 1.2 : it.d;
    k.plastic.box(f, -bw / 2, bw / 2, -bd / 2, bd / 2, 0.7, it.h, EPOXY);
    k.plastic.cyl(f, alongX ? -bw / 2 : 0, alongX ? 0 : bd / 2, it.h - 0.01, it.h + 0.01, 1, EPOXY_DARK, 14);
    const { feet } = chipLeads(it);
    for (const [fx, fy] of feet) {
      const g = F([fx, fy, t]);
      k.metal.box(g, -0.25, 0.25, -0.13, 0.13, -1.8, 1.2, TIN);
      const out = alongX ? Math.sign(fy - it.y) : Math.sign(fx - it.x);
      if (alongX) k.metal.box(g, -0.25, 0.25, out > 0 ? -0.75 : 0, out > 0 ? 0 : 0.75, 1, 1.25, TIN);
      else k.metal.box(g, out > 0 ? -0.75 : 0, out > 0 ? 0 : 0.75, -0.25, 0.25, 1, 1.25, TIN);
    }
    mark(k, it, t + it.h + 0.02, bw * 0.6, bd * 0.6, false, alongX ? 0 : 90);
  } else if (kind === "can") {
    k.metal.box(f, -it.w / 2, it.w / 2, -it.d / 2, it.d / 2, 0.02, it.h, "#c3c6cc");
    mark(k, it, t + it.h + 0.02, it.w * 0.8, it.d * 0.55, true);
  } else {
    // a D2PAK-style power package: body, the tab soldered behind it, three legs in front
    const alongX = it.w >= it.d;
    const f2 = F([it.x, it.y, t], alongX ? [1, 0] : [0, 1]);
    const L = alongX ? it.w : it.d;
    const W = alongX ? it.d : it.w;
    k.metal.box(f2, -L / 2, -L / 2 + L * 0.3, -W / 2, W / 2, 0.02, 0.4, TIN);
    k.plastic.box(f2, -L / 2 + L * 0.2, L / 2 - L * 0.2, -W / 2 + 0.3, W / 2 - 0.3, 0.02, Math.min(it.h, 4.5), EPOXY);
    for (const s of [-1, 0, 1]) k.metal.box(f2, L / 2 - L * 0.2, L / 2, s * W * 0.3 - 0.4, s * W * 0.3 + 0.4, 0.02, 0.5, TIN);
    mark(k, it, t + Math.min(it.h, 4.5) + 0.02, (alongX ? L * 0.55 : W * 0.8), (alongX ? W * 0.8 : L * 0.55), false);
  }
}

function mark(k: Kit, it: BoardItem, z: number, w: number, d: number, dark: boolean, rot = 0) {
  if (!it.mark) return;
  k.decals.push({ text: it.mark, x: it.x, y: it.y, z, w, d, dark, rot });
}

function item(k: Kit, part: CatalogPart, L: BoardLayout, it: BoardItem) {
  const t = L.t;
  const f = F([it.x, it.y, t]);
  const open = openingDir(part, it);
  switch (it.look) {
    case "qfp":
    case "soic":
    case "qfn":
    case "dip":
    case "can":
    case "power":
      return chip(k, it, t, it.look);
    case "mosfets": {
      // four SO-8 power MOSFETs in a square
      for (const [sx, sy] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ])
        chip(k, { look: "soic", x: it.x + (sx * it.w) / 4, y: it.y + (sy * it.d) / 4, w: 5, d: 4, h: 1.6, mark: "4468" }, t, "soic");
      return;
    }
    case "header_m":
    case "header_f":
    case "header_down":
      return header(k, it, t);
    case "box_header": {
      k.plastic.box(f, -it.w / 2, it.w / 2, -it.d / 2, it.d / 2, 0, 1.2, BLACK);
      k.plastic.box(f, -it.w / 2, it.w / 2, it.d / 2 - 0.9, it.d / 2, 1.2, it.h, BLACK);
      k.plastic.box(f, -it.w / 2, it.w / 2, -it.d / 2, -it.d / 2 + 0.9, 1.2, it.h, BLACK);
      k.plastic.box(f, -it.w / 2, -it.w / 2 + 0.9, -it.d / 2, it.d / 2, 1.2, it.h, BLACK);
      k.plastic.box(f, it.w / 2 - 0.9, it.w / 2, -it.d / 2, it.d / 2, 1.2, it.h, BLACK);
      const n = Math.max(2, Math.round((it.w - 5) / 2.54));
      for (let i = 0; i < n; i++) for (const r of [-1.27, 1.27]) k.metal.box(f, (i - (n - 1) / 2) * 2.54 - 0.32, (i - (n - 1) / 2) * 2.54 + 0.32, r - 0.32, r + 0.32, 0, it.h - 2.2, GOLD);
      return;
    }
    case "fpc": {
      const alongX = it.w >= it.d;
      const g = F([it.x, it.y, t], alongX ? [1, 0] : [0, 1]);
      const Lh = (alongX ? it.w : it.d) / 2;
      const Wh = (alongX ? it.d : it.w) / 2;
      k.plastic.box(g, -Lh, Lh, -Wh, Wh * 0.2, 0, it.h, "#ece6d6");
      k.plastic.box(g, -Lh + 0.5, Lh - 0.5, Wh * 0.2, Wh, 0, it.h * 0.7, "#5a3a20");
      return;
    }
    case "terminal":
      return terminal(k, part, L, it);
    case "usb_c":
    case "usb_micro":
    case "usb_mini":
    case "usb_b":
    case "usb_a":
    case "hdmi_mini":
      return socket(k, it, t, open, it.look);
    case "barrel": {
      const g = F([it.x, it.y, t], open);
      const [a, b] = extents(it, open);
      k.plastic.box(g, -a, a, -b, b, 0, it.h, BLACK);
      // the opening in the front face, with the centre pin in it
      const mouth = along([it.x + open[0] * a, it.y + open[1] * a, t + it.h / 2], open);
      k.gloss.cyl(mouth, 0, 0, -0.01, 0.02, it.h * 0.32, "#050505", 20);
      k.metal.cyl(mouth, 0, 0, -3, 0.01, 1.0, TIN, 12);
      return;
    }
    case "jack35": {
      const g = F([it.x, it.y, t], open);
      const [a, b] = extents(it, open);
      k.plastic.box(g, -a, a - 2.5, -b, b, 0, it.h * 0.75, BLACK);
      const nose = along([it.x + open[0] * (a - 2.5), it.y + open[1] * (a - 2.5), t + it.h * 0.4], open);
      k.plastic.cyl(nose, 0, 0, 0, 2.5, 3, BLACK, 20);
      k.gloss.cyl(nose, 0, 0, 2.49, 2.52, 1.8, "#040404", 20);
      return;
    }
    case "jst_sh": {
      // a side-entry JST SH socket: a cream shroud open towards the board's edge, four contacts inside, two tin hold-downs
      const g = F([it.x, it.y, t], open);
      const [a, b] = extents(it, open);
      const c = L.style.socket ?? "#e6dfcb";
      k.plastic.box(g, -a, a, -b, b, 0, 0.5, c);
      k.plastic.box(g, -a, a, -b, b, it.h - 0.5, it.h, c);
      k.plastic.box(g, -a, a, -b, -b + 0.6, 0.5, it.h - 0.5, c);
      k.plastic.box(g, -a, a, b - 0.6, b, 0.5, it.h - 0.5, c);
      k.plastic.box(g, -a, -a + 1, -b + 0.6, b - 0.6, 0.5, it.h - 0.5, c);
      for (let i = 0; i < 4; i++) k.metal.box(g, -a + 1, a - 0.5, i - 1.5 - 0.15, i - 1.5 + 0.15, 1.0, 1.3, GOLD);
      for (let i = 0; i < 4; i++) k.metal.box(g, -a - 0.7, -a, i - 1.5 - 0.15, i - 1.5 + 0.15, 0.02, 0.2, TIN);
      k.metal.box(g, a - 1.9, a - 0.5, -b - 0.6, -b, 0.02, 0.35, TIN);
      k.metal.box(g, a - 1.9, a - 0.5, b, b + 0.6, 0.02, 0.35, TIN);
      return;
    }
    case "shunt": {
      // a current-sense resistor: a black body between two tinned ends, its value printed on top
      const alongX = it.w >= it.d;
      const g = F([it.x, it.y, t], alongX ? [1, 0] : [0, 1]);
      const lh = (alongX ? it.w : it.d) / 2;
      const wh = (alongX ? it.d : it.w) / 2;
      const h = Math.max(0.55, it.h);
      k.plastic.box(g, -lh + 0.7, lh - 0.7, -wh, wh, 0.04, h, "#17181b");
      k.metal.box(g, -lh, -lh + 0.75, -wh, wh, 0, h + 0.02, TIN);
      k.metal.box(g, lh - 0.75, lh, -wh, wh, 0, h + 0.02, TIN);
      mark(k, it, t + h + 0.03, it.w * 0.5, it.d * 0.55, false);
      return;
    }
    case "sdcard": {
      const g = F([it.x, it.y, t], open);
      const [a, b] = extents(it, open);
      k.metal.box(g, -a, a, -b, b, 0, Math.max(1.4, it.h), STEEL);
      // the card in its slot
      k.plastic.box(g, a - 2, a + 1.5, -b + 1.2, b - 1.2, 0.25, Math.max(1.4, it.h) - 0.35, "#1a1c22");
      return;
    }
    case "heatsink":
      return heatsink(k, it, t, L.style.heatsink ?? "#1d1f22");
    case "elcap":
      return elcap(k, it, t);
    case "inductor": {
      k.plastic.box(f, -it.w / 2, it.w / 2, -it.d / 2, it.d / 2, 0, it.h, "#16171a");
      k.plastic.box(f, -it.w / 2 + 0.6, it.w / 2 - 0.6, -it.d / 2 + 0.6, it.d / 2 - 0.6, it.h, it.h + 0.04, "#2a2c30");
      mark(k, it, t + it.h + 0.06, it.w * 0.6, it.d * 0.4, false);
      return;
    }
    case "drum": {
      const r = Math.min(it.w, it.d) / 2;
      k.plastic.cyl(f, 0, 0, 0, 0.9, r, "#151516", 28);
      k.metal.cyl(f, 0, 0, 0.9, it.h - 1.2, r * 0.82, "#b8682a", 28);
      k.plastic.cyl(f, 0, 0, it.h - 1.2, it.h, r, "#151516", 28);
      return;
    }
    case "trimpot": {
      k.plastic.box(f, -it.w / 2, it.w / 2, -it.d / 2, it.d / 2, 0, it.h, "#2a5bd0");
      const big = it.h > 5;
      const g = big ? { o: [it.x - it.w / 2, it.y, t + it.h - 1.6] as V3, x: [0, 1, 0] as V3, y: [0, 0, 1] as V3, z: [-1, 0, 0] as V3 } : F([it.x, it.y, t + it.h]);
      k.metal.cyl(g, 0, 0, 0, 0.6, big ? 1.2 : 1.1, GOLD, 16);
      k.plastic.box(g, -0.9, 0.9, -0.15, 0.15, 0.58, 0.64, "#5a4a20");
      return;
    }
    case "button": {
      const s = Math.min(it.w, it.d);
      k.plastic.box(f, -it.w / 2, it.w / 2, -it.d / 2, it.d / 2, 0, it.h * 0.45, BLACK);
      k.metal.box(f, -it.w / 2 + 0.2, it.w / 2 - 0.2, -it.d / 2 + 0.2, it.d / 2 - 0.2, it.h * 0.45, it.h * 0.6, STEEL);
      k.plastic.cyl(f, 0, 0, it.h * 0.6, it.h, s * 0.28, "#2a2b2e", 20);
      return;
    }
    case "crystal": {
      if (it.h >= 3) {
        const alongX = it.w >= it.d;
        const g = F([it.x, it.y, t], alongX ? [1, 0] : [0, 1]);
        const Lh = (alongX ? it.w : it.d) / 2;
        const r = (alongX ? it.d : it.w) / 2;
        k.metal.box(g, -Lh + r, Lh - r, -r, r, 0, it.h, "#d3d6db");
        k.metal.cyl(g, -Lh + r, 0, 0, it.h, r, "#d3d6db", 18);
        k.metal.cyl(g, Lh - r, 0, 0, it.h, r, "#d3d6db", 18);
      } else {
        k.plastic.box(f, -it.w / 2, it.w / 2, -it.d / 2, it.d / 2, 0, 0.35, "#d8cdb0");
        k.metal.box(f, -it.w / 2 + 0.2, it.w / 2 - 0.2, -it.d / 2 + 0.2, it.d / 2 - 0.2, 0.35, it.h, "#c9ccd2");
      }
      return;
    }
    case "wroom": {
      // module board, shield can over the chip, and the antenna's copper meander at the far end
      const g = F([it.x, it.y, t], open);
      const [a, b] = extents(it, open);
      k.plastic.box(g, -a, a, -b, b, 0, 0.8, "#24282f");
      const ant = Math.min(6, a * 0.45);
      k.metal.box(g, -a + 0.6, a - ant - 0.4, -b + 0.6, b - 0.6, 0.8, it.h, "#c6c9cf");
      for (let i = 0; i < 6; i++) {
        const y0 = -b + 1.2 + ((2 * b - 2.4) / 6) * i;
        k.metal.box(g, a - ant + 0.4, a - 0.6, y0, y0 + 0.35, 0.8, 0.84, GOLD);
        k.metal.box(g, i % 2 ? a - ant + 0.4 : a - 0.95, i % 2 ? a - ant + 0.75 : a - 0.6, y0, y0 + (2 * b - 2.4) / 6 + 0.35, 0.8, 0.84, GOLD);
      }
      k.decals.push({ text: it.mark ?? "ESP32-WROOM-32E", x: it.x - open[0] * ant * 0.5, y: it.y - open[1] * ant * 0.5, z: t + it.h + 0.02, w: (Math.abs(open[0]) ? 2 * a - ant - 2 : 2 * b - 2) * 0.85, d: (Math.abs(open[0]) ? 2 * b - 2 : 2 * a - ant - 2) * 0.4, dark: true, rot: 0 });
      return;
    }
    case "transducer": {
      const r = Math.min(it.w, it.d) / 2;
      k.metal.cyl(f, 0, 0, 0, it.h, r, "#c8ccd2", 32);
      k.plastic.cyl(f, 0, 0, it.h, it.h + 0.05, r * 0.82, "#2a2c30", 32);
      k.plastic.cyl(f, 0, 0, it.h + 0.05, it.h + 0.08, r * 0.3, "#3a3d42", 20);
      return;
    }
    case "lens": {
      // the holder is a third of the height, the barrel screws into it, and the glass sits just inside the barrel's rim
      const r = Math.min(it.w, it.d) / 2;
      const base = Math.min(it.h * 0.36, r * 1.1);
      k.plastic.box(f, -it.w / 2, it.w / 2, -it.d / 2, it.d / 2, 0, base, "#131416");
      k.plastic.cyl(f, 0, 0, base, it.h, r * 0.86, "#18191c", 36);
      k.plastic.cyl(f, 0, 0, it.h - 1.6, it.h + 0.02, r * 0.93, "#101113", 36);
      k.plastic.cyl(f, 0, 0, it.h + 0.02, it.h + 0.05, r * 0.62, "#1a2340", 32);
      k.plastic.cyl(f, 0, 0, it.h + 0.05, it.h + 0.08, r * 0.3, "#3b4f8f", 24);
      return;
    }
    case "microswitch": {
      k.plastic.box(f, -it.w / 2, it.w / 2, -it.d / 2, it.d / 2, 0.3, it.h * 0.8, BLACK);
      k.plastic.box(f, -0.8, 0.8, -0.8, 0.8, it.h * 0.8, it.h * 0.88, "#c43a2e");
      // the lever, hinged at one end and resting on the plunger
      const hinge: V3 = [it.x - it.w / 2 + 0.6, it.y, t + it.h * 0.8];
      const ang = (8 * Math.PI) / 180;
      const lever: Frame = { o: hinge, x: [Math.cos(ang), 0, Math.sin(ang)], y: [0, 1, 0], z: [-Math.sin(ang), 0, Math.cos(ang)] };
      k.metal.box(lever, 0, it.w * 1.15, -it.d / 2 + 0.6, it.d / 2 - 0.6, 0.05, 0.3, STEEL);
      for (const s of [-1, 0, 1]) k.metal.box(f, s * it.w * 0.38 - 0.3, s * it.w * 0.38 + 0.3, -0.25, 0.25, -t - 1.2, 0.3, TIN);
      return;
    }
    case "oled": {
      k.gloss.box(f, -it.w / 2, it.w / 2, -it.d / 2, it.d / 2, 0, it.h, "#06080c");
      k.gloss.box(f, -it.w / 2 + 1.2, it.w / 2 - 1.2, -it.d / 2 + 2.4, it.d / 2 - 1.2, it.h, it.h + 0.02, "#0b1220");
      k.plastic.box(f, -it.w * 0.3, it.w * 0.3, -it.d / 2 - 1.2, -it.d / 2, -0.05, it.h * 0.6, "#c98a2b");
      return;
    }
    case "drivers":
      return;
  }
}

/** Half sizes of an item along its opening direction and across it. */
function extents(it: BoardItem, dir: [number, number]): [number, number] {
  return Math.abs(dir[0]) > 0.5 ? [it.w / 2, it.d / 2] : [it.d / 2, it.w / 2];
}

function header(k: Kit, it: BoardItem, t: number) {
  const pins = headerPins(it);
  const alongX = it.w >= it.d;
  const f = F([it.x, it.y, t]);
  const P = 0.32;
  if (it.look === "header_down") {
    // plastic spacer under the board, pins down through it, short stubs on top
    const g = F([it.x, it.y, 0]);
    k.plastic.box(g, -it.w / 2, it.w / 2, -it.d / 2, it.d / 2, -2.5, 0, BLACK);
    for (const [x, y] of pins) k.metal.box(F([x, y, 0]), -P, P, -P, P, -8.5, t + 1.1, GOLD);
    return;
  }
  if (it.look === "header_f") {
    k.plastic.box(f, -it.w / 2, it.w / 2, -it.d / 2, it.d / 2, 0, it.h, BLACK);
    for (const [x, y] of pins) {
      const g = F([x, y, t]);
      k.plastic.box(g, -0.5, 0.5, -0.5, 0.5, it.h - 0.02, it.h + 0.01, "#050506");
      k.metal.box(g, -0.32, 0.32, -0.12, 0.12, it.h - 1.4, it.h - 0.9, GOLD);
      k.metal.box(F([x, y, 0]), -0.25, 0.25, -0.12, 0.12, -3, 0, TIN);
    }
    return;
  }
  // male: plastic base with the pins through it
  const n = pins.length / (Math.min(it.w, it.d) >= 4.5 ? 2 : 1);
  for (let i = 0; i < n; i++) {
    const a = (i - (n - 1) / 2) * 2.54;
    // each pin position has its own little block, with a groove between
    if (alongX) k.plastic.box(f, a - 1.22, a + 1.22, -it.d / 2, it.d / 2, 0, 2.5, BLACK);
    else k.plastic.box(f, -it.w / 2, it.w / 2, a - 1.22, a + 1.22, 0, 2.5, BLACK);
  }
  for (const [x, y] of pins) {
    const g = F([x, y, t]);
    k.metal.box(g, -P, P, -P, P, -t - 2.8, it.h - 0.3, GOLD);
    k.metal.box(g, -P * 0.6, P * 0.6, -P * 0.6, P * 0.6, it.h - 0.3, it.h, GOLD);
  }
}

function terminal(k: Kit, part: CatalogPart, L: BoardLayout, it: BoardItem) {
  const t = L.t;
  const alongX = it.w >= it.d;
  const contacts = terminalContacts(it);
  const [ex, ey] = openingDir(part, it);
  // wires go in on the side facing the nearer edge, across the block's length
  const side: [number, number] = alongX ? [0, ey || 1] : [ex || 1, 0];
  const color = L.style.terminal ?? "#2c6e49";
  const deep = alongX ? it.d : it.w;
  for (const [x, y] of contacts) {
    const g = F([x, y, t], side);
    const hw = 2.45;
    k.plastic.box(g, -deep / 2, deep / 2, -hw, hw, 0, it.h, color);
    // wire entry with the clamp inside
    k.plastic.box(g, deep / 2 - 0.02, deep / 2 + 0.01, -1.6, 1.6, it.h * 0.2, it.h * 0.6, "#0a0b0c");
    k.metal.box(g, deep / 2 - 0.6, deep / 2 - 0.05, -1.4, 1.4, it.h * 0.2, it.h * 0.28, STEEL);
    // the screw on top, set back from the entry
    const s = F([x - side[0] * deep * 0.12, y - side[1] * deep * 0.12, t + it.h], side);
    k.metal.cyl(s, 0, 0, -0.6, 0.01, 1.6, STEEL, 18);
    k.plastic.box(s, -1.3, 1.3, -0.2, 0.2, -0.1, 0.03, "#2b2d31");
    // a line where the blocks meet
    k.plastic.box(g, -deep / 2, deep / 2, hw - 0.06, hw + 0.06, 0, it.h - 0.01, "#183d29");
  }
}

function socket(k: Kit, it: BoardItem, t: number, open: [number, number], look: string) {
  const g = F([it.x, it.y, t], open);
  const [a, b] = extents(it, open);
  const h = it.h;
  const shell = look === "usb_b" || look === "usb_a" ? STEEL : "#c5c8ce";
  if (look === "usb_c") {
    const r = Math.min(h, 2 * b) / 2;
    k.metal.box(g, -a, a, -b + r, b - r, 0, h, shell);
    k.metal.cyl({ o: [g.o[0] + g.y[0] * (-b + r), g.o[1] + g.y[1] * (-b + r), t + h / 2], x: g.y, y: [0, 0, 1], z: g.x }, 0, 0, -a, a, r, shell, 16);
    k.metal.cyl({ o: [g.o[0] + g.y[0] * (b - r), g.o[1] + g.y[1] * (b - r), t + h / 2], x: g.y, y: [0, 0, 1], z: g.x }, 0, 0, -a, a, r, shell, 16);
    k.plastic.box(g, a - 0.05, a + 0.01, -b + r * 0.6, b - r * 0.6, h * 0.2, h * 0.8, "#060607");
    k.plastic.box(g, a - 1.5, a - 0.02, -b * 0.55, b * 0.55, h * 0.42, h * 0.58, "#2a2b2f");
    return;
  }
  k.metal.box(g, -a, a, -b, b, 0, h, shell);
  const inset = look === "usb_b" ? 0.25 : 0.15;
  k.plastic.box(g, a - 0.05, a + 0.01, -b + b * inset * 2, b - b * inset * 2, h * inset, h * (1 - inset), "#060607");
  if (look === "usb_b") k.plastic.box(g, a - 2, a - 0.02, -b * 0.35, b * 0.35, h * 0.35, h * 0.65, "#e9e7e2");
  else if (look === "usb_a") k.plastic.box(g, a - 3, a - 0.02, -b * 0.75, b * 0.75, h * 0.25, h * 0.45, "#1e5fcf");
  else k.plastic.box(g, a - 1.2, a - 0.02, -b * 0.5, b * 0.5, h * 0.4, h * 0.6, "#1a1b1e");
  // the shell's tabs soldered through the board
  for (const s of [-1, 1]) k.metal.box(g, -a * 0.4, -a * 0.1, s * b - 0.15, s * b + 0.15, -t - 0.8, 0.2, shell);
}

function heatsink(k: Kit, it: BoardItem, t: number, color: string) {
  const alongX = it.w >= it.d;
  const g = F([it.x, it.y, t], alongX ? [1, 0] : [0, 1]);
  const Lh = (alongX ? it.w : it.d) / 2;
  const Wh = (alongX ? it.d : it.w) / 2;
  const base = Math.min(2.5, it.h * 0.18);
  k.satin.box(g, -Lh, Lh, -Wh, Wh, 0, base, color);
  const n = Math.max(3, Math.round((2 * Wh) / 2.4));
  const fin = Math.min(1.1, (2 * Wh) / n * 0.45);
  for (let i = 0; i < n; i++) {
    const y = -Wh + fin / 2 + ((2 * Wh - fin) * i) / Math.max(1, n - 1);
    k.satin.box(g, -Lh, Lh, y - fin / 2, y + fin / 2, base, it.h, color);
  }
}

function elcap(k: Kit, it: BoardItem, t: number) {
  const r = Math.min(it.w, it.d) / 2 - 0.15;
  const f = F([it.x, it.y, t]);
  const h = it.h;
  k.plastic.cyl(f, 0, 0, 0, 0.5, r * 0.92, "#18191b", 28);
  k.plastic.cyl(f, 0, 0, 0.5, h - 0.35, r, "#1d2b57", 32);
  // rolled-in groove near the top, and the aluminium top with its vent
  k.plastic.cyl(f, 0, 0, h - 1.4, h - 1.1, r * 0.96, "#14203f", 32);
  k.metal.cyl(f, 0, 0, h - 0.35, h - 0.25, r * 0.93, "#c9ccd2", 32);
  k.plastic.box(f, -r * 0.6, r * 0.6, -0.12, 0.12, h - 0.26, h - 0.24, "#7c8088");
  k.plastic.box(f, -0.12, 0.12, -r * 0.6, r * 0.6, h - 0.26, h - 0.24, "#7c8088");
  // the negative stripe down one side
  const ang = Math.PI;
  for (let i = -2; i <= 2; i++) {
    const a = ang + i * 0.16;
    const s: Frame = { o: [it.x + Math.cos(a) * (r + 0.01), it.y + Math.sin(a) * (r + 0.01), t], x: [-Math.sin(a), Math.cos(a), 0], y: [Math.cos(a), Math.sin(a), 0], z: [0, 0, 1] };
    k.plastic.box(s, -r * 0.09, r * 0.09, -0.02, 0.02, 0.6, h - 1.5, "#a9b4cf");
  }
}

function smd(k: Kit, L: BoardLayout, s: Smd) {
  const [Ls, W, H] = SMD_SIZE[s.kind];
  const f = F([s.x, s.y, L.t], s.rot ? [0, 1] : [1, 0]);
  const e = Math.min(0.3, Ls * 0.2);
  switch (s.kind) {
    case "sot23": {
      k.plastic.box(f, -Ls / 2 + 0.2, Ls / 2 - 0.2, -W / 2, W / 2, 0.1, H, EPOXY);
      for (const [x, y] of [
        [-0.95, -1],
        [0.95, -1],
        [0, 1],
      ])
        k.metal.box(f, x - 0.2, x + 0.2, y > 0 ? W / 2 - 0.05 : y - 0.25, y > 0 ? y + 0.25 : -W / 2 + 0.05, 0.02, 0.15, TIN);
      return;
    }
    case "led": {
      k.plastic.box(f, -Ls / 2 + e, Ls / 2 - e, -W / 2, W / 2, 0, H * 0.5, "#f1efe6");
      k.gloss.box(f, -Ls / 2 + e, Ls / 2 - e, -W / 2, W / 2, H * 0.5, H, s.tone ?? "#3fd46a");
      break;
    }
    case "sma": {
      k.plastic.box(f, -Ls / 2 + 0.6, Ls / 2 - 0.6, -W / 2, W / 2, 0.05, H, EPOXY);
      k.plastic.box(f, -Ls / 2 + 0.9, -Ls / 2 + 1.4, -W / 2, W / 2, H, H + 0.01, "#9a9ea6");
      k.metal.box(f, -Ls / 2, -Ls / 2 + 0.7, -0.7, 0.7, 0.02, 0.25, TIN);
      k.metal.box(f, Ls / 2 - 0.7, Ls / 2, -0.7, 0.7, 0.02, 0.25, TIN);
      return;
    }
    default: {
      const resistor = s.kind[0] === "r";
      k.plastic.box(f, -Ls / 2 + e, Ls / 2 - e, -W / 2, W / 2, 0.02, H, resistor ? "#e9e6dc" : (s.tone ?? "#a98e66"));
      if (resistor) k.plastic.box(f, -Ls / 2 + e, Ls / 2 - e, -W / 2 + 0.02, W / 2 - 0.02, H, H + 0.03, "#121214");
    }
  }
  k.metal.box(f, -Ls / 2, -Ls / 2 + e, -W / 2, W / 2, 0.02, H + 0.01, TIN);
  k.metal.box(f, Ls / 2 - e, Ls / 2, -W / 2, W / 2, 0.02, H + 0.01, TIN);
}
