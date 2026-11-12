// One run of a script: the kerf API's calls answered against the design, with what the script made (output lines,
// tables, files, its own checks) and the limits that keep a run in bounds. The app's side of each call (building a
// reading of the design, exporting, analysing) is a ScriptHost, so the same session runs in the app and in tests.

import { z } from "zod";
import { evaluate } from "../lang/evaluator";
import { applySpanEdits, paramEdits, type SetMap } from "../core/decisions";
import { showConfig } from "../core/configs";
import { partMass, type Model } from "../core/model";
import { materialDensity } from "../library/standards";
import { designStats, type MeshInfo } from "../app/designStats";
import type { CheckReport } from "../core/checks";
import type { MeshData } from "../kernel/build";
import type { ScriptMethod } from "./protocol";

type V3 = [number, number, number];

/** A reading of the design: the open one, or the open one with other values, built and checked apart. */
export interface DesignRead {
  source: string;
  model: Model;
  report: CheckReport | null;
  /** a built solid's volume and box, by geometry hash */
  geom(hash: string): MeshInfo | undefined;
  /** its mesh, for files */
  mesh(hash: string): MeshData | undefined;
  /** why it could not be built or checked */
  error?: string;
}

export interface AnalysisSummary {
  name: string;
  verdict: string;
  /** lowest safety factor, the stress there (MPa), the most it moves (mm) */
  safety?: number;
  stress?: number;
  deflection?: number;
  /** first natural frequency (Hz), hottest temperature (°C), buckling factor */
  frequency?: number;
  temperature?: number;
  buckling?: number;
}

export const EXPORT_FORMATS = ["stl", "step", "csv", "kerf"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportOptions {
  /** part names to put in; default every made part (STL) or every part (STEP) */
  parts?: string[];
  /** STL: one file per part to make, named with how many */
  each?: boolean;
  /** the file's name (an extension is added) */
  name?: string;
}

export interface ScriptFile {
  name: string;
  data: Uint8Array | string;
  mime: string;
  bytes: number;
}

/** What the app does for a script. */
export interface ScriptHost {
  /** the open design's source as it is now */
  source(): string;
  /** the open design, once it is built and checked */
  current(): Promise<DesignRead>;
  /** this source built and checked apart from the open design */
  measure(source: string): Promise<DesignRead>;
  /** show this source as the open design (not a version yet), once built and checked */
  show(source: string): Promise<DesignRead>;
  /** keep what the run changed: the open design becomes one version, undone back to `before` */
  keep(before: string, message: string): void;
  analyse(read: DesignRead, name: string | null): Promise<AnalysisSummary>;
  exportFiles(read: DesignRead, format: ExportFormat, opts: ExportOptions): Promise<{ name: string; data: Uint8Array | string; mime: string }[]>;
  projects(): { name: string; updated: number }[];
}

/** run: by hand or by Claude, may change the design; check: after each change, may only look */
export type ScriptMode = "run" | "check";

export interface ScriptLine {
  level: "log" | "warn" | "error";
  text: string;
}
export type Cell = string | number | boolean | null;
export interface ScriptTable {
  title?: string;
  columns: string[];
  rows: Cell[][];
}
export interface ScriptCheck {
  name: string;
  status: "pass" | "fail" | "warn";
  detail?: string;
}

export interface ScriptOutput {
  status: "running" | "done" | "error" | "stopped";
  lines: ScriptLine[];
  tables: ScriptTable[];
  files: ScriptFile[];
  checks: ScriptCheck[];
  progress?: { done: number; total: number; label?: string };
  /** what the script returned, as text */
  value?: string;
  error?: string;
  /** the script's line the error came from */
  line?: number;
  /** the design was changed and kept as a version */
  changed?: boolean;
  calls: number;
  /** designs built apart (variants and analyses of them) */
  builds: number;
  startedAt: number;
  ms: number;
}

export const LIMITS = {
  calls: 5000,
  builds: { run: 300, check: 20 },
  lines: 2000,
  lineChars: 4000,
  tables: 50,
  rows: 5000,
  columns: 50,
  cellChars: 500,
  files: 200,
  fileBytes: 50 * 1024 * 1024,
  allBytes: 250 * 1024 * 1024,
  checks: 100,
  source: 2_000_000,
  /** a run stops after this long */
  ms: 30 * 60_000,
};

/** A summary of a reading of the design, as the API gives it. */
export interface DesignSummary {
  name: string;
  /** the configuration it is read as, and all of them (a configs block) */
  config?: string;
  configs: string[];
  params: Record<string, number | string | boolean>;
  parts: PartSummary[];
  /** grams of everything built, and the overall size (mm) */
  mass: number;
  size: V3 | null;
  /** parts still building or that failed to build (their mass and size are missing) */
  missing: number;
  errors: string[];
  warnings: string[];
  checks: { pass: number; fail: number; warn: number; failing: string[]; warnings: string[] };
  requirements: { name: string; status: string; margin?: number }[];
}

export interface PartSummary {
  name: string;
  label: string;
  made: boolean;
  material: string;
  process?: string;
  /** grams, and the size of its box (mm), when built */
  mass: number | null;
  size: V3 | null;
}

const round = (x: number, d = 3) => {
  const f = 10 ** d;
  return Math.round(x * f) / f;
};

export function summarise(read: DesignRead): DesignSummary {
  const m = read.model;
  const stats = designStats(m, (h) => read.geom(h));
  const parts: PartSummary[] = [];
  const seen = new Map<string, PartSummary>();
  for (const p of m.parts) {
    if (p.hidden) continue;
    const key = p.kind === "component" ? p.id.split(".")[0] : p.id;
    const g = read.geom(p.hash);
    const mass = g ? (partMass(p, g.volume, materialDensity(p.material)) ?? null) : null;
    const have = seen.get(key);
    if (have) {
      have.mass = have.mass !== null && mass !== null ? round(have.mass + mass) : null;
      continue;
    }
    const s: PartSummary = { name: p.kind === "component" ? key : p.name, label: p.label, made: p.kind === "part", material: p.material, ...(p.process ? { process: p.process.id } : {}), mass: mass === null ? null : round(mass), size: g ? sizeOf(g.bbox) : null };
    seen.set(key, s);
    parts.push(s);
  }
  const items = read.report?.items ?? [];
  const diags = (sev: string) => m.diagnostics.filter((d) => d.severity === sev).map((d) => d.message);
  return {
    name: m.name,
    ...(m.configs?.active ? { config: m.configs.active } : {}),
    configs: m.configs?.rows.map((r) => r.label) ?? [],
    params: Object.fromEntries(m.params.map((p) => [p.name, typeof p.value === "number" ? round(p.value, 6) : p.value])),
    parts,
    mass: round(stats.mass),
    size: stats.size ? (stats.size.map((x) => round(x)) as V3) : null,
    missing: stats.pending,
    errors: read.error ? [read.error, ...diags("error")] : diags("error"),
    warnings: diags("warning"),
    checks: {
      pass: items.filter((i) => i.status === "pass").length,
      fail: items.filter((i) => i.status === "fail").length,
      warn: items.filter((i) => i.status === "warn").length,
      failing: items.filter((i) => i.status === "fail").map((i) => i.title),
      warnings: items.filter((i) => i.status === "warn").map((i) => i.title),
    },
    requirements: m.requirements.map((r) => ({ name: r.label, status: r.status, ...(r.margin !== undefined ? { margin: round(r.margin, 4) } : {}) })),
  };
}

const sizeOf = ([a, b]: [V3, V3]): V3 => [round(b[0] - a[0]), round(b[1] - a[1]), round(b[2] - a[2])];

// ---------- inputs ----------

const Value = z.union([z.number().finite(), z.string().max(2000), z.boolean()]);
const Values = z.record(z.string().min(1).max(80), Value).refine((v) => Object.keys(v).length <= 200, "Too many values at once (200 at most).");
const VariantOptions = z.object({ config: z.string().min(1).max(80).optional() }).strict();
const ExportOpts = z
  .object({
    parts: z.array(z.string().min(1).max(120)).max(500).optional(),
    each: z.boolean().optional(),
    name: z.string().min(1).max(120).optional(),
    values: Values.optional(),
    config: z.string().min(1).max(80).optional(),
  })
  .strict();

/** A short reason from a zod error, naming the argument. */
function why(e: z.ZodError, what: string): string {
  const i = e.issues[0];
  const at = i?.path.length ? `${what}.${i.path.join(".")}` : what;
  return `${at}: ${i?.message ?? "not valid"}`;
}

function parse<T>(schema: z.ZodType<T>, v: unknown, what: string): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new Error(why(r.error, what));
  return r.data;
}

const MIME: Record<string, string> = { csv: "text/csv", json: "application/json", txt: "text/plain", md: "text/markdown", svg: "image/svg+xml", html: "text/html", kerf: "text/plain", xml: "application/xml", gcode: "text/plain", nc: "text/plain", dxf: "application/dxf" };

/** A file name a script asked for, kept to plain characters, with an extension. */
export function scriptFileName(name: string, ext?: string): string {
  const parts = name.split(/[\\/]/).map((s) => s.replace(/[^A-Za-z0-9 _.()+-]+/g, "").trim().replace(/^\.+/, "")).filter(Boolean);
  let base = parts.join("/").slice(0, 120) || "file";
  if (ext && !base.toLowerCase().endsWith(`.${ext}`)) base = `${base.replace(/\.[A-Za-z0-9]{1,6}$/, "")}.${ext}`;
  return base;
}

// ---------- the session ----------

export class ScriptSession {
  readonly out: ScriptOutput;
  private start: string;
  private changed = false;
  private notes: string[] = [];
  private allBytes = 0;
  private reads: { source: string; read: DesignRead }[] = [];
  private stopped = false;

  constructor(
    private host: ScriptHost,
    readonly opts: { name: string; mode: ScriptMode; onUpdate?: () => void },
  ) {
    this.start = host.source();
    this.out = { status: "running", lines: [], tables: [], files: [], checks: [], calls: 0, builds: 0, startedAt: Date.now(), ms: 0 };
  }

  private touch() {
    this.out.ms = Date.now() - this.out.startedAt;
    this.opts.onUpdate?.();
  }

  log(level: ScriptLine["level"], text: string) {
    if (this.out.lines.length > LIMITS.lines) return;
    if (this.out.lines.length === LIMITS.lines) this.out.lines.push({ level: "warn", text: `More output was left out (${LIMITS.lines} lines at most).` });
    else this.out.lines.push({ level, text: text.length > LIMITS.lineChars ? `${text.slice(0, LIMITS.lineChars)} …` : text });
    this.touch();
  }

  progress(done: number, total: number, label?: string) {
    this.out.progress = { done: Math.max(0, done), total: Math.max(0, total), ...(label ? { label: label.slice(0, 120) } : {}) };
    this.touch();
  }

  /** Answer one call on the kerf API. A thrown error goes back to the script as a rejected promise. */
  async call(method: string, args: unknown[]): Promise<unknown> {
    if (this.stopped) throw new Error("The run was stopped.");
    if (++this.out.calls > LIMITS.calls) throw new Error(`A run makes ${LIMITS.calls} calls at most.`);
    const a = args;
    switch (method as ScriptMethod) {
      case "design":
        return summarise(await this.host.current());
      case "params":
        return Object.fromEntries(evaluate(this.host.source(), { skipGeometry: true }).params.map((p) => [p.name, p.value]));
      case "variant": {
        const values = parse(Values, a[0] ?? {}, "values");
        const o = parse(VariantOptions, a[1] ?? {}, "options");
        return summarise(await this.variant(values, o.config));
      }
      case "set": {
        this.mayChange("set");
        const values = parse(Values, a[0] ?? {}, "values");
        const base = this.host.source();
        const next = this.withValues(base, values);
        if (next === base) return summarise(await this.host.current());
        this.changed = true;
        return summarise(await this.host.show(next));
      }
      case "source":
        return this.host.source();
      case "setSource": {
        this.mayChange("setSource");
        const src = parse(z.string().max(LIMITS.source), a[0], "source");
        const note = a[1] === undefined || a[1] === null ? undefined : parse(z.string().max(200), a[1], "note");
        if (note) this.notes.push(note);
        if (src === this.host.source()) return summarise(await this.host.current());
        this.changed = true;
        return summarise(await this.host.show(src));
      }
      case "checks": {
        const read = await this.host.current();
        const items = read.report?.items ?? [];
        return items.filter((i) => i.status !== "info").map((i) => ({ status: i.status, title: i.title, detail: i.detail, category: i.category, ...(i.parts?.length ? { parts: i.parts } : {}), ...(i.margin !== undefined ? { margin: round(i.margin, 4) } : {}) }));
      }
      case "analyse": {
        const name = a[0] === null || a[0] === undefined ? null : parse(z.string().min(1).max(120), a[0], "name");
        const values = parse(Values, a[1] ?? {}, "values");
        const read = Object.keys(values).length ? await this.variant(values) : await this.host.current();
        this.build();
        return this.host.analyse(read, name);
      }
      case "export":
        return this.export(a[0], a[1]);
      case "file": {
        const name = parse(z.string().min(1).max(160), a[0], "name");
        const content = parse(z.string().max(LIMITS.fileBytes), a[1], "content");
        const ext = /\.([A-Za-z0-9]{1,6})$/.exec(name)?.[1]?.toLowerCase() ?? "txt";
        return this.addFile(scriptFileName(name, ext), content, MIME[ext] ?? "text/plain").name;
      }
      case "table":
        return this.table(a[0], a[1]);
      case "check": {
        const name = parse(z.string().min(1).max(160), a[0], "name");
        const ok = parse(z.union([z.boolean(), z.literal("warn")]), a[1], "ok");
        const detail = a[2] === null || a[2] === undefined ? undefined : parse(z.string().max(2000), a[2], "detail");
        if (this.out.checks.length >= LIMITS.checks) throw new Error(`A script reports ${LIMITS.checks} checks at most.`);
        const c: ScriptCheck = { name, status: ok === "warn" ? "warn" : ok ? "pass" : "fail", ...(detail ? { detail } : {}) };
        const at = this.out.checks.findIndex((x) => x.name === name);
        if (at >= 0) this.out.checks[at] = c;
        else this.out.checks.push(c);
        this.touch();
        return c.status;
      }
      case "projects":
        return this.host.projects();
      default:
        throw new Error(`kerf.${method} is not part of the API.`);
    }
  }

  private mayChange(what: string) {
    if (this.opts.mode === "check") throw new Error(`kerf.${what} can't be used in a script that runs after each change: it may only look at the design. Run it by hand to change the design.`);
  }

  private build() {
    if (++this.out.builds > LIMITS.builds[this.opts.mode]) throw new Error(`A ${this.opts.mode === "check" ? "script run after each change" : "run"} builds ${LIMITS.builds[this.opts.mode]} other readings of the design at most.`);
  }

  /** The source with these parameter values written in (where the Parameters tab would put them). */
  private withValues(src: string, values: SetMap): string {
    if (!Object.keys(values).length) return src;
    const model = evaluate(src, { skipGeometry: true });
    const { edits, missing } = paramEdits(model, values);
    if (missing.length) throw new Error(`The design has no parameter called ${missing.map((n) => `"${n}"`).join(", ")}. Its parameters: ${model.params.map((p) => p.name).join(", ") || "none"}.`);
    return applySpanEdits(src, edits);
  }

  /** The open design read with other values (and configuration), built and checked apart; the last few are kept. */
  private async variant(values: SetMap, config?: string): Promise<DesignRead> {
    let src = this.host.source();
    if (config) {
      const model = evaluate(src, { skipGeometry: true });
      const rows = model.configs?.rows ?? [];
      if (!rows.some((r) => r.label === config)) throw new Error(rows.length ? `The design has no configuration called "${config}". Its configurations: ${rows.map((r) => r.label).join(", ")}.` : "The design has no configurations (a configs block).");
      src = showConfig(src, model, config);
    }
    src = this.withValues(src, values);
    if (src === this.host.source()) return this.host.current();
    const hit = this.reads.find((r) => r.source === src);
    if (hit) return hit.read;
    this.build();
    const read = await this.host.measure(src);
    this.reads.push({ source: src, read });
    if (this.reads.length > 3) this.reads.shift();
    return read;
  }

  private async export(format: unknown, options: unknown): Promise<string[]> {
    const f = parse(z.enum(EXPORT_FORMATS), typeof format === "string" ? format.toLowerCase() : format, "format");
    const o = parse(ExportOpts, options ?? {}, "options");
    const read = o.values || o.config ? await this.variant(o.values ?? {}, o.config) : await this.host.current();
    if (read.model.diagnostics.some((d) => d.severity === "error") && f !== "kerf") throw new Error(`That reading of the design has errors, so it was not exported: ${read.model.diagnostics.find((d) => d.severity === "error")!.message}`);
    if (o.parts) {
      const names = new Set(read.model.parts.flatMap((p) => [p.name, p.id.split(".")[0]]));
      const unknown = o.parts.filter((n) => !names.has(n));
      if (unknown.length) throw new Error(`No part called ${unknown.map((n) => `"${n}"`).join(", ")}.`);
    }
    const made = await this.host.exportFiles(read, f, { ...(o.parts ? { parts: o.parts } : {}), ...(o.each ? { each: true } : {}), ...(o.name ? { name: o.name } : {}) });
    return made.map((x) => this.addFile(x.name, x.data, x.mime).name);
  }

  private addFile(name: string, data: Uint8Array | string, mime: string): ScriptFile {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data).length : data.byteLength;
    if (this.out.files.length >= LIMITS.files) throw new Error(`A run makes ${LIMITS.files} files at most.`);
    if (bytes > LIMITS.fileBytes) throw new Error(`${name} is ${Math.round(bytes / 1e6)} MB; a file can be ${LIMITS.fileBytes / 1024 / 1024} MB at most.`);
    if (this.allBytes + bytes > LIMITS.allBytes) throw new Error(`A run's files can come to ${LIMITS.allBytes / 1024 / 1024} MB at most.`);
    // the same name again gets a number, as a downloads folder does
    let unique = name;
    for (let n = 2; this.out.files.some((x) => x.name === unique); n++) unique = name.replace(/(\.[A-Za-z0-9]{1,6})?$/, (ext) => ` (${n})${ext}`);
    const file: ScriptFile = { name: unique, data, mime, bytes };
    this.allBytes += bytes;
    this.out.files.push(file);
    this.touch();
    return file;
  }

  private table(rows: unknown, title: unknown): number {
    if (this.out.tables.length >= LIMITS.tables) throw new Error(`A run shows ${LIMITS.tables} tables at most.`);
    if (!Array.isArray(rows)) throw new Error("kerf.table takes a list of rows: objects ({ width: 40, mass: 12.3 }) or lists of values.");
    const t = title === null || title === undefined ? undefined : parse(z.string().max(160), title, "title");
    const cell = (v: unknown): Cell => {
      if (v === null || v === undefined) return null;
      if (typeof v === "number") return Number.isFinite(v) ? round(v, 6) : String(v);
      if (typeof v === "boolean") return v;
      const s = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
      return s.length > LIMITS.cellChars ? `${s.slice(0, LIMITS.cellChars)} …` : s;
    };
    const columns: string[] = [];
    const objects = rows.every((r) => r && typeof r === "object" && !Array.isArray(r));
    if (objects) {
      for (const r of rows as Record<string, unknown>[]) for (const k of Object.keys(r)) if (!columns.includes(k) && columns.length < LIMITS.columns) columns.push(k);
    } else {
      const n = Math.min(LIMITS.columns, rows.reduce((most: number, r) => Math.max(most, Array.isArray(r) ? r.length : 1), 0));
      for (let i = 0; i < n; i++) columns.push(String(i + 1));
    }
    const out: Cell[][] = rows.slice(0, LIMITS.rows).map((r) => (objects ? columns.map((k) => cell((r as Record<string, unknown>)[k])) : Array.isArray(r) ? columns.map((_, i) => cell(r[i])) : [cell(r)]));
    this.out.tables.push({ ...(t ? { title: t } : {}), columns, rows: out });
    if (rows.length > LIMITS.rows) this.log("warn", `The table${t ? ` "${t}"` : ""} shows the first ${LIMITS.rows} of ${rows.length} rows.`);
    this.touch();
    return out.length;
  }

  /** CSV of a table, for the output's download. */
  static csv(t: ScriptTable): string {
    const q = (c: Cell) => {
      const s = c === null ? "" : String(c);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [t.columns.map(q).join(","), ...t.rows.map((r) => r.map(q).join(","))].join("\n") + "\n";
  }

  /** The run is over: keep what it changed as one version and settle the output. */
  finish(end: { ok: boolean; value?: string; error?: string; line?: number } | "stopped") {
    if (this.out.status !== "running") return this.out;
    this.stopped = true;
    if (end === "stopped") {
      this.out.status = "stopped";
    } else if (end.ok) {
      this.out.status = "done";
      if (end.value !== undefined) this.out.value = end.value.slice(0, 20000);
    } else {
      this.out.status = "error";
      this.out.error = (end.error ?? "The script stopped with an error.").slice(0, 4000);
      if (end.line) this.out.line = end.line;
    }
    // the design it changed may have been closed: then there is nothing to keep
    let now: string | null = null;
    try {
      now = this.host.source();
    } catch {
      now = null;
    }
    if (this.changed && now !== null && now !== this.start) {
      const note = this.notes.length ? `: ${this.notes[this.notes.length - 1]}` : "";
      this.host.keep(this.start, `Script “${this.opts.name}”${note}${this.out.status === "done" ? "" : " (stopped part way)"}`);
      this.out.changed = true;
    }
    this.reads = [];
    this.touch();
    return this.out;
  }
}
