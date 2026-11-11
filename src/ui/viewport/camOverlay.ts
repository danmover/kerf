// CNC toolpaths in the viewport: one setup's paths drawn round the part where it sits, turned the way the tool
// comes (feeds coloured by operation, rapids dashed), the end mill where it is at the chosen moment, and the
// stock as the cuts so far leave it, cut again move by move as the time moves on. The stock is a height map
// (the same the planner's check uses), so what it shows is what the machine would leave, tabs and all.

import * as THREE from "three";
import type { EvalPart } from "../../core/model";
import { xformMatrix } from "../../kernel/recipe";
import type { CamResult } from "../../cam/compute";
import type { CamMove, CamTool, OpKind } from "../../cam/plan";
import { toolAt, type CamTimeline } from "../../cam/timeline";
import { cutMoves, type HeightMap } from "../../cam/sim";
import { millClass } from "../../mfg/materials";
import type { SceneOverlay } from "./scene";

type V3 = [number, number, number];

export const OP_COLORS: Record<OpKind, string> = { face: "#7dd3fc", rough: "#f5a524", rest: "#f472b6", finish: "#34d399" };
const RAPID = "#ff6b6b";
/** other parts while the toolpaths show */
const OTHERS = 0.1;

/** The colour and sheen of the stock, from its material. */
function stockLook(material: string): { color: number; metalness: number; roughness: number } {
  const m = material.toLowerCase();
  const { cls } = millClass(material);
  if (/brass|bronze/.test(m)) return { color: 0xc9a64a, metalness: 0.75, roughness: 0.35 };
  if (/copper/.test(m)) return { color: 0xc77a4a, metalness: 0.75, roughness: 0.35 };
  if (cls === "light metal") return { color: 0xbcc3cc, metalness: 0.7, roughness: 0.38 };
  if (cls === "steel" || cls === "tough metal") return { color: 0x9aa1a9, metalness: 0.75, roughness: 0.42 };
  if (cls === "wood") return /mdf/.test(m) ? { color: 0xa98563, metalness: 0, roughness: 0.85 } : { color: 0xd2ab73, metalness: 0, roughness: 0.8 };
  return { color: 0xe6e8ea, metalness: 0, roughness: 0.55 };
}

const LINE_VERT = /* glsl */ `
  attribute float aT;
  attribute float aD;
  attribute float aR;
  attribute vec3 aC;
  varying float vT;
  varying float vD;
  varying float vR;
  varying vec3 vC;
  void main() {
    vT = aT;
    vD = aD;
    vR = aR;
    vC = aC;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

// the operation under way bright up to the tool and faint after it; the ones before and after it fainter still
const LINE_FRAG = /* glsl */ `
  uniform float uT;
  uniform float uOp0;
  uniform float uOp1;
  uniform float uBefore;
  uniform float uAfter;
  varying float vT;
  varying float vD;
  varying float vR;
  varying vec3 vC;
  void main() {
    // rapids dashed
    if (vR > 0.5 && fract(vD / 2.4) > 0.5) discard;
    float a;
    if (vT < uOp0 - 1e-4) a = uBefore;
    else if (vT > uOp1 + 1e-4) a = uAfter;
    else a = vT <= uT + 1e-4 ? 1.0 : 0.3;
    if (vR > 0.5) a *= 0.6;
    if (a <= 0.0) discard;
    gl_FragColor = vec4(vC, a);
    #include <colorspace_fragment>
  }`;

/** The stock's top as a grid of heights (one vertex per cell centre) with walls round its edge; cells cut right through are holes. */
class StockSurface {
  readonly mesh: THREE.Group = new THREE.Group();
  readonly geo = new THREE.BufferGeometry();
  /** the stock's underside, with the same holes */
  readonly under = new THREE.BufferGeometry();
  readonly mat: THREE.MeshStandardMaterial;
  private pos: Float32Array;
  private nrm: Float32Array;
  private keep: Float32Array;
  /** grid index of each wall column, round the edge */
  private ring: Int32Array;
  private wallNormals: Float32Array;
  private n: number;

  constructor(
    private nx: number,
    private ny: number,
    x0: number,
    y0: number,
    private cell: number,
    private bottom: number,
    material: string,
  ) {
    const n = nx * ny;
    this.n = n;
    // the edge cells in order round the grid
    const ring: number[] = [];
    if (nx > 1 && ny > 1) {
      for (let i = 0; i < nx - 1; i++) ring.push(i);
      for (let j = 0; j < ny - 1; j++) ring.push(j * nx + nx - 1);
      for (let i = nx - 1; i > 0; i--) ring.push((ny - 1) * nx + i);
      for (let j = ny - 1; j > 0; j--) ring.push(j * nx);
    }
    this.ring = Int32Array.from(ring);
    const m = ring.length;
    const total = n + 2 * m;
    this.pos = new Float32Array(3 * total);
    this.nrm = new Float32Array(3 * total);
    this.keep = new Float32Array(total).fill(1);
    this.wallNormals = new Float32Array(3 * m);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        this.pos[3 * k] = x0 + (i + 0.5) * cell;
        this.pos[3 * k + 1] = y0 + (j + 0.5) * cell;
      }
    // walls: each edge column twice (top, bottom), facing out
    for (let r = 0; r < m; r++) {
      const k = ring[r];
      const i = k % nx,
        j = Math.floor(k / nx);
      const nxv = i === 0 ? -1 : i === nx - 1 ? 1 : 0;
      const nyv = j === 0 ? -1 : j === ny - 1 ? 1 : 0;
      const l = Math.hypot(nxv, nyv) || 1;
      this.wallNormals[3 * r] = nxv / l;
      this.wallNormals[3 * r + 1] = nyv / l;
      for (const s of [0, 1]) {
        const v = n + 2 * r + s;
        this.pos[3 * v] = this.pos[3 * k];
        this.pos[3 * v + 1] = this.pos[3 * k + 1];
        this.pos[3 * v + 2] = bottom;
        this.nrm[3 * v] = nxv / l;
        this.nrm[3 * v + 1] = nyv / l;
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i,
          b = a + 1,
          c = a + nx,
          d = c + 1;
        idx.push(a, b, d, a, d, c);
      }
    for (let r = 0; r < m; r++) {
      const a = n + 2 * r,
        b = n + 2 * ((r + 1) % m);
      // top a, bottom a, top b, bottom b: outward when seen from outside the stock
      idx.push(a, a + 1, b + 1, a, b + 1, b);
    }
    const Index = total > 65535 ? THREE.Uint32BufferAttribute : THREE.Uint16BufferAttribute;
    this.geo.setIndex(new Index(idx, 1));
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("normal", new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("aKeep", new THREE.BufferAttribute(this.keep, 1).setUsage(THREE.DynamicDrawUsage));
    const look = stockLook(material);
    this.mat = new THREE.MeshStandardMaterial({ ...look, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2 });
    this.mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nattribute float aKeep;\nvarying float vKeep;").replace("#include <begin_vertex>", "#include <begin_vertex>\nvKeep = aKeep;");
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\nvarying float vKeep;").replace("void main() {", "void main() {\nif (vKeep < 0.5) discard;");
    };
    this.mat.customProgramCacheKey = () => "kerf-cam-stock-v1";
    const top = new THREE.Mesh(this.geo, this.mat);
    top.frustumCulled = false;
    // the underside: the grid again at the bottom, facing down
    const upos = new Float32Array(3 * n);
    const unrm = new Float32Array(3 * n);
    for (let k = 0; k < n; k++) {
      upos[3 * k] = this.pos[3 * k];
      upos[3 * k + 1] = this.pos[3 * k + 1];
      upos[3 * k + 2] = bottom;
      unrm[3 * k + 2] = -1;
    }
    const uidx: number[] = [];
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i,
          b = a + 1,
          c = a + nx,
          d = c + 1;
        uidx.push(a, d, b, a, c, d);
      }
    const UIndex = n > 65535 ? THREE.Uint32BufferAttribute : THREE.Uint16BufferAttribute;
    this.under.setIndex(new UIndex(uidx, 1));
    this.under.setAttribute("position", new THREE.BufferAttribute(upos, 3));
    this.under.setAttribute("normal", new THREE.BufferAttribute(unrm, 3));
    this.under.setAttribute("aKeep", new THREE.BufferAttribute(this.keep.subarray(0, n), 1).setUsage(THREE.DynamicDrawUsage));
    this.underMat = new THREE.MeshStandardMaterial({ ...look, side: THREE.FrontSide });
    this.underMat.onBeforeCompile = this.mat.onBeforeCompile;
    this.underMat.customProgramCacheKey = () => "kerf-cam-stock-v1";
    const below = new THREE.Mesh(this.under, this.underMat);
    below.frustumCulled = false;
    this.mesh.add(top, below);
  }

  private underMat: THREE.MeshStandardMaterial;

  /** Show these heights. */
  set(h: Float32Array) {
    const { nx, ny, cell, bottom, n, pos, nrm, keep } = this;
    const through = bottom + 0.005;
    for (let k = 0; k < n; k++) {
      const z = h[k];
      const cut = !(z > through);
      pos[3 * k + 2] = cut ? bottom : z;
      keep[k] = cut ? 0 : 1;
    }
    // normals from the neighbours' heights
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const zl = pos[3 * (i > 0 ? k - 1 : k) + 2],
          zr = pos[3 * (i < nx - 1 ? k + 1 : k) + 2];
        const zd = pos[3 * (j > 0 ? k - nx : k) + 2],
          zu = pos[3 * (j < ny - 1 ? k + nx : k) + 2];
        const sx = (i > 0 ? 1 : 0) + (i < nx - 1 ? 1 : 0) || 1,
          sy = (j > 0 ? 1 : 0) + (j < ny - 1 ? 1 : 0) || 1;
        const gx = (zr - zl) / (sx * cell),
          gy = (zu - zd) / (sy * cell);
        const l = Math.hypot(gx, gy, 1);
        nrm[3 * k] = -gx / l;
        nrm[3 * k + 1] = -gy / l;
        nrm[3 * k + 2] = 1 / l;
      }
    const ring = this.ring;
    for (let r = 0; r < ring.length; r++) {
      const k = ring[r];
      const v = n + 2 * r;
      pos[3 * v + 2] = pos[3 * k + 2];
      keep[v] = keep[v + 1] = keep[k];
    }
    const g = this.geo;
    (g.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute("normal") as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute("aKeep") as THREE.BufferAttribute).needsUpdate = true;
    (this.under.getAttribute("aKeep") as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose() {
    this.geo.dispose();
    this.under.dispose();
    this.mat.dispose();
    this.underMat.dispose();
  }
}

/** A flat end mill with its shank and the collet nut above, its tip at the origin, pointing down -Z. */
function endMill(d: number, reach: number): { group: THREE.Group; dispose(): void } {
  const r = d / 2;
  const flute = Math.max(2 * d, Math.min(reach, 4 * d + 6, 40));
  const shankR = Math.max(r, 1.5);
  const shank = 22;
  const group = new THREE.Group();
  // lit only by the overlay's lights (no reflections to show), so a light grey reads as bright steel
  const steel = new THREE.MeshStandardMaterial({ color: 0xe4e9ef, metalness: 0.3, roughness: 0.32 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x4a525c, metalness: 0.3, roughness: 0.45 });
  const glow = new THREE.LineBasicMaterial({ color: 0x5a6570 });
  const cyl = (rad: number, h: number, z0: number, mat: THREE.Material) => {
    const g = new THREE.CylinderGeometry(rad, rad, h, 28, 1);
    g.rotateX(Math.PI / 2);
    g.translate(0, 0, z0 + h / 2);
    const m = new THREE.Mesh(g, mat);
    group.add(m);
    return g;
  };
  const geos = [cyl(r, flute, 0, steel), cyl(shankR, shank, flute, steel), cyl(shankR * 1.6 + 4, 12, flute + shank, dark)];
  // two flutes' helices on the cutting length
  const pts: THREE.Vector3[][] = [[], []];
  const turns = flute / (Math.PI * d * 0.58);
  for (let s = 0; s <= 96; s++) {
    const f = s / 96;
    for (const h of [0, 1]) {
      const a = f * turns * 2 * Math.PI + h * Math.PI;
      pts[h].push(new THREE.Vector3(Math.cos(a) * r * 1.01, Math.sin(a) * r * 1.01, f * flute));
    }
  }
  const lines = pts.map((p) => new THREE.BufferGeometry().setFromPoints(p));
  for (const l of lines) group.add(new THREE.Line(l, glow));
  return {
    group,
    dispose() {
      for (const g of [...geos, ...lines]) g.dispose();
      steel.dispose();
      dark.dispose();
      glow.dispose();
    },
  };
}

export class CamOverlay implements SceneOverlay {
  readonly object = new THREE.Group();
  readonly replaces = new Set<string>();
  readonly ghosts = new Map<string, number>();
  private paths: THREE.LineSegments;
  private pathMat: THREE.ShaderMaterial;
  private stock: StockSurface;
  private hm: HeightMap;
  private toolHolder = new THREE.Group();
  private tools = new Map<number, { group: THREE.Group; dispose(): void }>();
  private disposables: { dispose(): void }[] = [];
  /** the op whose moves are being cut into hm, and how many of them are in fully */
  private cutOp = -1;
  private cutDone = 0;
  private cutTime = -1;
  private shown = { paths: true, stock: true };
  private s = 0;

  constructor(
    private part: EvalPart,
    others: string[],
    private r: CamResult,
    private tl: CamTimeline,
    private toolList: CamTool[],
    material: string,
  ) {
    for (const id of others) if (id !== part.id) this.ghosts.set(id, OTHERS);
    // the setup's frame to the world: the part's placement after the setup's turn undone
    const R = r.rot;
    const toPart = new THREE.Matrix4().set(R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, 0, 0, 0, 1);
    this.object.matrixAutoUpdate = false;
    this.object.matrix.copy(new THREE.Matrix4().fromArray(xformMatrix(part.xf)).multiply(toPart));
    this.object.matrixWorldNeedsUpdate = true;

    // the paths, every move a segment carrying its times
    const n = tl.t.length;
    const segs = Math.max(0, n - 1);
    const pos = new Float32Array(segs * 6);
    const col = new Float32Array(segs * 6);
    const aT = new Float32Array(segs * 2);
    const aD = new Float32Array(segs * 2);
    const aR = new Float32Array(segs * 2);
    const c = new THREE.Color();
    const opCol = r.plan.ops.map((o) => new THREE.Color(OP_COLORS[o.kind]).convertSRGBToLinear());
    const rapidCol = new THREE.Color(RAPID).convertSRGBToLinear();
    for (let i = 1; i < n; i++) {
      const s = i - 1;
      pos.set(tl.p.subarray(3 * (i - 1), 3 * i), 6 * s);
      pos.set(tl.p.subarray(3 * i, 3 * i + 3), 6 * s + 3);
      const rapid = tl.kind[i] === 0;
      c.copy(rapid ? rapidCol : opCol[tl.op[i]]);
      col.set([c.r, c.g, c.b, c.r, c.g, c.b], 6 * s);
      aT[2 * s] = tl.t[i - 1];
      aT[2 * s + 1] = tl.t[i];
      aD[2 * s + 1] = Math.hypot(pos[6 * s + 3] - pos[6 * s], pos[6 * s + 4] - pos[6 * s + 1], pos[6 * s + 5] - pos[6 * s + 2]);
      aR[2 * s] = aR[2 * s + 1] = rapid ? 1 : 0;
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    pg.setAttribute("aC", new THREE.BufferAttribute(col, 3));
    pg.setAttribute("aT", new THREE.BufferAttribute(aT, 1));
    pg.setAttribute("aD", new THREE.BufferAttribute(aD, 1));
    pg.setAttribute("aR", new THREE.BufferAttribute(aR, 1));
    this.pathMat = new THREE.ShaderMaterial({
      uniforms: { uT: { value: 0 }, uOp0: { value: 0 }, uOp1: { value: 0 }, uBefore: { value: 0.15 }, uAfter: { value: 0 } },
      vertexShader: LINE_VERT,
      fragmentShader: LINE_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.paths = new THREE.LineSegments(pg, this.pathMat);
    this.paths.frustumCulled = false;
    this.paths.renderOrder = 3;
    this.disposables.push(pg, this.pathMat);

    // the stock, cut as far as the time shown
    const st = r.plan.stock;
    const mp = r.maps;
    this.hm = { x0: mp.x0, y0: mp.y0, cell: mp.cell, nx: mp.nx, ny: mp.ny, h: new Float32Array(mp.nx * mp.ny).fill(st.top) };
    this.stock = new StockSurface(mp.nx, mp.ny, mp.x0, mp.y0, mp.cell, st.bottom, material);
    this.disposables.push(this.stock);

    // the uncut stock's outline, and work zero on its top front-left corner
    const box = new THREE.BufferGeometry();
    const [x0, y0] = st.lo,
      [x1, y1] = st.hi;
    const b = st.bottom,
      t = st.top;
    const corners = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
    const edge: number[] = [];
    for (let k = 0; k < 4; k++) {
      const [ax, ay] = corners[k],
        [bx, by] = corners[(k + 1) % 4];
      edge.push(ax, ay, t, bx, by, t, ax, ay, b, bx, by, b, ax, ay, b, ax, ay, t);
    }
    box.setAttribute("position", new THREE.Float32BufferAttribute(edge, 3));
    const boxMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false });
    const outline = new THREE.LineSegments(box, boxMat);
    this.disposables.push(box, boxMat);
    const zero = new THREE.Group();
    const L = Math.max(6, Math.min(25, 0.15 * Math.max(x1 - x0, y1 - y0)));
    ([
      [[L, 0, 0], 0xff5d6c],
      [[0, L, 0], 0x4ade80],
      [[0, 0, L], 0x6d8bff],
    ] as [V3, number][]).forEach(([d, colr]) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(...d)]);
      const m = new THREE.LineBasicMaterial({ color: colr, depthTest: false, transparent: true });
      const line = new THREE.Line(g, m);
      line.renderOrder = 5;
      zero.add(line);
      this.disposables.push(g, m);
    });
    zero.position.set(x0, y0, t);

    // the scene lights the model from above: a setup from the side or below gets a light of its own from the tool's side
    const up = new THREE.Vector3(0, 0, 1).transformDirection(this.object.matrix);
    const extra = Math.min(1, 1 - up.z) * 1.8;
    if (extra > 0.05) {
      const sun = new THREE.DirectionalLight(0xffffff, extra);
      sun.position.set(0.4, -0.6, 1).multiplyScalar(500);
      const aim = new THREE.Object3D();
      sun.target = aim;
      this.object.add(sun, aim);
    }
    this.object.add(this.stock.mesh, this.paths, outline, zero, this.toolHolder);
    this.setShow(this.shown);
    this.setTime(tl.total);
  }

  /** Paths and stock on or off; the part shows when the stock does not. */
  setShow(show: { paths: boolean; stock: boolean }) {
    this.shown = { ...show };
    this.paths.visible = show.paths;
    // over the stock the earlier cuts' paths would hide what they cut: fainter there
    this.pathMat.uniforms.uBefore.value = show.stock ? 0.12 : 0.45;
    this.pathMat.uniforms.uAfter.value = show.stock ? 0 : 0.14;
    this.stock.mesh.visible = show.stock;
    this.replaces.clear();
    if (show.stock) {
      this.replaces.add(this.part.id);
      this.stock.set(this.hm.h);
    }
  }

  get total() {
    return this.tl.total;
  }

  /** Show the cutting s seconds in: the tool there, the paths up to it bright, the stock cut that far. */
  setTime(s: number) {
    const tl = this.tl;
    s = Math.max(0, Math.min(tl.total, s));
    this.s = s;
    this.pathMat.uniforms.uT.value = s;
    const ops = this.r.plan.ops;
    if (!ops.length || !tl.t.length) {
      this.stock.set(this.hm.h);
      this.toolHolder.visible = false;
      return;
    }
    const at = toolAt(tl, s);
    const k = at.op;
    const kEnd = k + 1 < ops.length ? tl.start[k + 1] - 1 : tl.t.length - 1;
    // an op's paths start where the move into it starts
    this.pathMat.uniforms.uOp0.value = tl.start[k] > 0 ? tl.t[tl.start[k] - 1] : 0;
    this.pathMat.uniforms.uOp1.value = tl.t[kEnd];
    // the tool
    const op = ops[k];
    let tool = this.tools.get(op.tool);
    if (!tool) {
      tool = endMill(op.d, this.toolList[op.tool]?.reach ?? 4 * op.d);
      this.tools.set(op.tool, tool);
      this.disposables.push(tool);
    }
    if (this.toolHolder.children[0] !== tool.group) {
      this.toolHolder.clear();
      this.toolHolder.add(tool.group);
    }
    this.toolHolder.visible = s < tl.total - 1e-6;
    this.toolHolder.position.set(at.p[0], at.p[1], at.p[2]);
    // the stock
    if (s >= tl.total - 1e-6) {
      this.hm.h.set(this.r.maps.after[ops.length - 1]);
      this.cutOp = ops.length;
      this.cutDone = 0;
    } else {
      if (k !== this.cutOp || s < this.cutTime) {
        // start the op afresh from how the ones before left the stock
        if (k === 0) this.hm.h.fill(this.r.plan.stock.top);
        else this.hm.h.set(this.r.maps.after[k - 1]);
        this.cutOp = k;
        this.cutDone = 0;
      }
      const first = tl.start[k];
      const upto = at.i - first; // the move under way, within the op
      const startOf = (j: number): V3 | undefined => {
        const g = first + j - 1;
        return g >= 0 ? [tl.p[3 * g], tl.p[3 * g + 1], tl.p[3 * g + 2]] : undefined;
      };
      if (upto > this.cutDone) cutMoves(this.hm, op.moves.slice(this.cutDone, upto), op.d, startOf(this.cutDone));
      this.cutDone = Math.max(this.cutDone, upto);
      const mv = op.moves[upto];
      if (mv && mv.k !== "rapid") {
        const part: CamMove = { k: mv.k, p: at.p };
        cutMoves(this.hm, [part], op.d, startOf(upto));
      }
    }
    this.cutTime = s;
    if (this.shown.stock) this.stock.set(this.hm.h);
  }

  get time() {
    return this.s;
  }

  /** The stock's box in the world, to frame the view on. */
  frameBox(): THREE.Box3 {
    const st = this.r.plan.stock;
    const b = new THREE.Box3(new THREE.Vector3(st.lo[0], st.lo[1], st.bottom), new THREE.Vector3(st.hi[0], st.hi[1], this.r.plan.safeZ));
    this.object.updateMatrixWorld(true);
    b.applyMatrix4(this.object.matrix);
    // room round it for the panel and the timeline over the view
    const size = b.getSize(new THREE.Vector3()).length();
    return b.expandByScalar(size * 0.12);
  }

  /** A view from the side the tool comes from, in front and to the right as the machine sees it. */
  viewDir(): THREE.Vector3 {
    return new THREE.Vector3(0.5, -0.8, 0.95).normalize().transformDirection(this.object.matrix);
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
}
