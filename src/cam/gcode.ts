// G-code from a plan, for the controllers hobby and shop mills run: GRBL (no tool changer, so one file per tool,
// the tool touched off again between them), LinuxCNC and Mach3 (one file per setup with T M6 tool changes and
// tool length offsets). Work zero is the stock's top front-left corner, which is how most people zero a router.

import type { CamMove, CamOp, CamPlan } from "./plan";

export type Post = "grbl" | "linuxcnc" | "mach3";

export const POSTS: { id: Post; label: string; note: string }[] = [
  { id: "grbl", label: "GRBL", note: "Shapeoko, X-Carve, Onefinity, LongMill, 3018 and most hobby routers: a file per tool" },
  { id: "linuxcnc", label: "LinuxCNC", note: "Mills and routers on LinuxCNC: tool changes with T M6 and length offsets" },
  { id: "mach3", label: "Mach3 / Mach4", note: "Mills and routers on Mach: tool changes with T M6 and length offsets" },
];

export interface GcodeFile {
  name: string;
  text: string;
  /** the tools it uses, in order */
  tools: number[];
  seconds: number;
}

const f3 = (x: number) => {
  const v = Math.abs(x) < 0.0005 ? 0 : x;
  return v.toFixed(3).replace(/\.?0+$/, "") || "0";
};

const toolLabel = (op: CamOp) => `${f3(op.d)} mm flat end mill, ${op.cut.flutes} flutes`;

/** Comment text a controller accepts: no brackets or semicolons inside. */
const say = (s: string) => `(${s.replace(/[()]/g, "").replace(/;/g, ",")})`;

class Writer {
  lines: string[] = [];
  private x = NaN;
  private y = NaN;
  private z = NaN;
  private f = NaN;
  private g = -1;
  constructor(
    readonly ox: number,
    readonly oy: number,
    readonly oz: number,
  ) {}
  reset() {
    this.x = this.y = this.z = this.f = NaN;
    this.g = -1;
  }
  move(m: CamMove, feed: number) {
    const x = m.p[0] - this.ox,
      y = m.p[1] - this.oy,
      z = m.p[2] - this.oz;
    const g = m.k === "rapid" ? 0 : 1;
    const words: string[] = [];
    if (g !== this.g) words.push(`G${g}`);
    if (!(Math.abs(x - this.x) < 0.0005)) words.push(`X${f3(x)}`);
    if (!(Math.abs(y - this.y) < 0.0005)) words.push(`Y${f3(y)}`);
    if (!(Math.abs(z - this.z) < 0.0005)) words.push(`Z${f3(z)}`);
    if (words.length === (g !== this.g ? 1 : 0)) return;
    if (g === 1 && feed !== this.f) {
      words.push(`F${Math.round(feed)}`);
      this.f = feed;
    }
    this.lines.push(words.join(" "));
    this.g = g;
    this.x = x;
    this.y = y;
    this.z = z;
  }
}

const feedOf = (m: CamMove, op: CamOp) => (m.k === "plunge" ? op.cut.plunge : m.k === "ramp" ? op.cut.ramp : op.cut.feed);

/**
 * The plan as G-code files. title names the part; setup says which way up it is ("setup 1 of 2: top up").
 */
export function writeGcode(plan: CamPlan, post: Post, title: string, setup: string): GcodeFile[] {
  const st = plan.stock;
  const ox = st.lo[0],
    oy = st.lo[1],
    oz = st.top;
  const safe = plan.safeZ - oz;
  const size = `${f3(st.hi[0] - st.lo[0])} x ${f3(st.hi[1] - st.lo[1])} x ${f3(st.top - st.bottom)} mm`;
  // runs of operations with one tool
  const runs: CamOp[][] = [];
  for (const op of plan.ops) {
    const last = runs[runs.length - 1];
    if (last && last[0].tool === op.tool) last.push(op);
    else runs.push([op]);
  }
  const head = (w: Writer, ops: CamOp[]) => {
    w.lines.push(say(`Kerf: ${title}, ${setup}`));
    w.lines.push(say(`Stock ${size}. Zero: X0 Y0 at its front left corner, Z0 on its top`));
    for (const t of [...new Map(ops.map((o) => [o.tool, o])).values()]) w.lines.push(say(`T${t.tool + 1}: ${toolLabel(t)}`));
    const s = ops.reduce((a, o) => a + o.seconds, 0);
    w.lines.push(say(`About ${Math.max(1, Math.round(s / 60))} min of cutting`));
    w.lines.push("G21 G90 G17 G94");
    if (post === "linuxcnc") w.lines.push("G64 P0.01");
    if (post === "mach3") w.lines.push("G40 G49 G80");
    w.lines.push("G54");
    w.lines.push(`G0 Z${f3(safe)}`);
  };
  const body = (w: Writer, ops: CamOp[], changer: boolean) => {
    let tool = -1;
    for (const op of ops) {
      if (op.tool !== tool) {
        if (tool >= 0) {
          w.lines.push("M5");
          w.lines.push(`G0 Z${f3(safe)}`);
        }
        if (changer) {
          w.lines.push(say(`Tool ${op.tool + 1}: ${toolLabel(op)}`));
          w.lines.push(`T${op.tool + 1} M6`);
          w.lines.push(`G43 H${op.tool + 1}`);
        }
        w.lines.push(`S${op.cut.rpm} M3`);
        w.lines.push("G4 P3");
        w.reset();
        tool = op.tool;
      }
      w.lines.push(say(op.label));
      for (const m of op.moves) w.move(m, feedOf(m, op));
    }
    w.lines.push("M5");
    w.lines.push(`G0 Z${f3(safe)}`);
    w.lines.push("M30");
  };
  const stem = `${title} ${setup.split(":")[0]}`.trim();
  if (post === "grbl") {
    // GRBL has no tool changer: a file per tool, re-zeroed in Z after each change
    return runs.map((ops, i) => {
      const w = new Writer(ox, oy, oz);
      head(w, ops);
      if (i > 0) w.lines.splice(4, 0, say(`Fit the ${f3(ops[0].d)} mm tool and zero Z on the stock top again before running this`));
      body(w, ops, false);
      return { name: `${stem} - ${i + 1} T${ops[0].tool + 1} ${f3(ops[0].d)}mm.nc`, text: w.lines.join("\n") + "\n", tools: [ops[0].tool], seconds: ops.reduce((a, o) => a + o.seconds, 0) };
    });
  }
  const w = new Writer(ox, oy, oz);
  head(w, plan.ops);
  body(w, plan.ops, true);
  return [{ name: `${stem}.${post === "linuxcnc" ? "ngc" : "tap"}`, text: w.lines.join("\n") + "\n", tools: [...new Set(plan.ops.map((o) => o.tool))], seconds: plan.seconds }];
}
