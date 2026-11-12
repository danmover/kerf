// Writing apps back into the design file: the app builder's edits (add,
// change, move, resize and remove a panel) change only the panel's own text,
// so the rest of the block keeps its formatting and comments. Also the
// starter app Kerf writes for a design from its firmware and simulation.

import type { Model } from "../core/model";
import { parse } from "../lang/parser";
import { parseColumns } from "./lines";
import { panelKindInfo, type AppSpec, type ControlSpec, type LampDef, type ModelMove, type PanelKind, type PanelSpec, type SignalItem } from "./spec";

/** Text in quotes for the design language. */
export function q(s: string): string {
  if (s.includes("\n")) return `"""\n${s}\n"""`;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const num = (n: number) => String(Number(n.toPrecision(10)));

function sig(s: SignalItem): string {
  const opts: string[] = [];
  if (s.label !== undefined) opts.push(`label: ${q(s.label)}`);
  if (s.unit !== undefined) opts.push(`unit: ${q(s.unit)}`);
  if (s.digits !== undefined) opts.push(`digits: ${num(s.digits)}`);
  if (s.color !== undefined) opts.push(`color: ${q(s.color)}`);
  if (s.min !== undefined) opts.push(`min: ${num(s.min)}`);
  if (s.max !== undefined) opts.push(`max: ${num(s.max)}`);
  if (s.warn !== undefined) opts.push(`warn: ${q(s.warn)}`);
  if (s.alarm !== undefined) opts.push(`alarm: ${q(s.alarm)}`);
  return opts.length ? `signal(${q(s.expr)}, ${opts.join(", ")})` : q(s.expr);
}

const sigs = (xs: SignalItem[]) => (xs.length === 1 ? sig(xs[0]) : `[${xs.map(sig).join(", ")}]`);

function control(c: ControlSpec): string {
  const key = c.key !== undefined ? `, key: ${q(c.key)}` : "";
  switch (c.kind) {
    case "button":
      return `button(${q(c.label)}, ${q(c.send)}${c.tone !== "plain" ? `, tone: ${q(c.tone ?? "plain")}` : ""}${c.confirm ? `, confirm: ${q(c.confirm)}` : ""}${key})`;
    case "slider": {
      const o = [`min: ${num(c.min)}`, `max: ${num(c.max)}`];
      const autoStep = (c.max - c.min) / 100 >= 1 ? 1 : Number(((c.max - c.min) / 100).toPrecision(1));
      if (c.step !== autoStep) o.push(`step: ${num(c.step)}`);
      if (c.value !== c.min) o.push(`value: ${num(c.value)}`);
      if (c.unit) o.push(`unit: ${q(c.unit)}`);
      if (c.live) o.push("live: true");
      return `slider(${q(c.label)}, ${q(c.send)}, ${o.join(", ")}${key})`;
    }
    case "toggle":
      return `toggle(${q(c.label)}, ${q(c.on)}, ${q(c.off)}${c.state ? `, state: ${q(c.state)}` : ""}${key})`;
    case "field":
      return `field(${q(c.label)}, ${q(c.send)}${c.placeholder ? `, placeholder: ${q(c.placeholder)}` : ""}${key})`;
    case "choice":
      return `choice(${q(c.label)}, [${c.options.map(q).join(", ")}], ${q(c.send)}${key})`;
  }
}

const lamp = (l: LampDef) => `lamp(${q(l.label)}, ${q(l.when)}${l.color ? `, color: ${q(l.color)}` : ""}${l.off ? `, off: ${q(l.off)}` : ""})`;
const v3 = (v: [number, number, number]) => {
  const axes: Record<string, string> = { "1,0,0": "X", "0,1,0": "Y", "0,0,1": "Z", "-1,0,0": "-X", "0,-1,0": "-Y", "0,0,-1": "-Z" };
  return axes[v.map((x) => Math.round(x * 1e6) / 1e6).join(",")] ?? `(${v.map(num).join(", ")})`;
};
const move = (m: ModelMove) => `${m.kind}(${m.part}, ${v3(m.axis)}, ${q(m.expr)}${m.about ? `, about: (${m.about.map(num).join(", ")})` : ""})`;

/** A panel as the design language writes it. */
export function panelSource(p: PanelSpec, indent = "    "): string {
  const info = panelKindInfo(p.kind);
  const size = `${p.w !== info.w ? `, w: ${p.w}` : ""}${p.h !== info.h ? `, h: ${p.h}` : ""}`;
  const t = q(p.title);
  switch (p.kind) {
    case "readout":
      return `readout(${t}, ${sigs(p.signals)}${p.big ? ", big: true" : ""}${size})`;
    case "gauge":
      return `gauge(${t}, ${sig(p.signal)}${p.min !== 0 ? `, min: ${num(p.min)}` : ""}, max: ${num(p.max)}${p.zones.length ? `, zones: [${p.zones.map((z) => `zone(${num(z.from)}, ${num(z.to)}, ${q(z.color)})`).join(", ")}]` : ""}${size})`;
    case "chart":
      return `chart(${t}, ${sigs(p.signals)}${p.window ? `, window: ${num(p.window)}s` : ""}${p.min !== undefined ? `, min: ${num(p.min)}` : ""}${p.max !== undefined ? `, max: ${num(p.max)}` : ""}${p.unit ? `, unit: ${q(p.unit)}` : ""}${size})`;
    case "scope":
      return `scope(${t}, ${sig(p.x)}, ${sig(p.y)}${p.range !== undefined ? `, range: ${num(p.range)}` : ""}${p.trail !== 3 ? `, trail: ${num(p.trail)}s` : ""}${p.unit ? `, unit: ${q(p.unit)}` : ""}${size})`;
    case "bars":
      return `bars(${t}, ${sigs(p.signals)}${p.min !== undefined ? `, min: ${num(p.min)}` : ""}${p.max !== undefined ? `, max: ${num(p.max)}` : ""}${p.unit ? `, unit: ${q(p.unit)}` : ""}${size})`;
    case "lamps":
      return `lamps(${t}, [${p.lamps.map(lamp).join(", ")}]${size})`;
    case "state":
      return `state(${t}${size})`;
    case "controls": {
      const inner = p.controls.map((c) => `${indent}  ${control(c)},`).join("\n");
      return `controls(${t}, [\n${inner}\n${indent}]${size})`;
    }
    case "console":
      return `console(${t}${p.commands.length ? `, commands: [${p.commands.map(q).join(", ")}]` : ""}${size})`;
    case "log":
      return `log(${t}${p.match ? `, match: ${q(p.match)}` : ""}${size})`;
    case "table":
      return `table(${t}, ${sigs(p.signals)}${size})`;
    case "note":
      return `note(${t}, ${q(p.text)}${size})`;
    case "custom": {
      const code = p.code
        .split("\n")
        .map((l) => (l ? `${indent}  ${l}` : l))
        .join("\n");
      return `custom(${t}, code: """\n${code}\n${indent}"""${p.uses.length ? `, uses: [${p.uses.map(q).join(", ")}]` : ""}${size})`;
    }
    case "model":
      return `model(${t}${p.parts.length ? `, parts: [${p.parts.join(", ")}]` : ""}${p.moves.length ? `, moves: [${p.moves.map(move).join(", ")}]` : ""}${p.view !== "iso" ? `, view: ${q(p.view)}` : ""}${size})`;
    case "camera":
      return `camera(${t}${p.overlay.length ? `, overlay: ${sigs(p.overlay).replace(/^(?!\[)(.*)$/, "[$1]")}` : ""}${size})`;
  }
}

/** A new panel of a kind, ready to edit, reading the signals given. */
export function newPanel(kind: PanelKind, signals: string[]): PanelSpec {
  const info = panelKindInfo(kind);
  const s = (n: number) => (signals.length ? signals.slice(0, n) : ["line"]).map((expr) => ({ expr }));
  const base = { title: info.label, w: info.w, h: info.h };
  switch (kind) {
    case "readout":
      return { ...base, kind, signals: s(4), big: false };
    case "gauge":
      return { ...base, kind, signal: s(1)[0], min: 0, max: 100, zones: [] };
    case "chart":
      return { ...base, kind, signals: s(3), window: 0 };
    case "scope":
      return { ...base, kind, x: s(1)[0], y: s(2)[1] ?? s(1)[0], trail: 3 };
    case "bars":
      return { ...base, kind, signals: s(4) };
    case "lamps":
      return { ...base, kind, lamps: [{ label: "Running", when: signals[0] ? `${signals[0]} > 0` : "state != ''", color: "green" }] };
    case "state":
      return { ...base, kind };
    case "controls":
      return { ...base, kind, controls: [{ kind: "button", label: "Start", send: "start", tone: "accent" }] };
    case "console":
      return { ...base, kind, commands: [] };
    case "log":
      return { ...base, kind, match: "fault|error|warn" };
    case "table":
      return { ...base, kind, signals: s(6) };
    case "note":
      return { ...base, kind, text: "What to do first, and what to watch for." };
    case "custom":
      return {
        ...base,
        kind,
        uses: signals.slice(0, 1),
        code: `// g.ctx is a 2D canvas of g.w × g.h; g.v(name) is a signal now, g.history(name, s) its recent past\nfunction draw(g) {\n  const v = g.v(${JSON.stringify(signals[0] ?? "x")});\n  g.ctx.clearRect(0, 0, g.w, g.h);\n  g.ctx.fillStyle = g.theme.accent;\n  const r = Math.min(g.w, g.h) / 3;\n  g.ctx.beginPath();\n  g.ctx.arc(g.w / 2, g.h / 2, r * (0.5 + 0.5 * Math.abs(Math.sin(g.t))), 0, Math.PI * 2);\n  g.ctx.fill();\n  g.ctx.fillStyle = g.theme.text;\n  g.ctx.fillText(isNaN(v) ? "waiting for data" : v.toFixed(2), 10, 20);\n}`,
      };
    case "model":
      return { ...base, kind, parts: [], moves: [], view: "iso" };
    case "camera":
      return { ...base, kind, overlay: s(3) };
  }
}

// ---------- edits ----------

export interface Edit {
  start: number;
  end: number;
  text: string;
}

const apply = (src: string, e: Edit) => src.slice(0, e.start) + e.text + src.slice(e.end);

/** The indentation of the line `at` is on. */
function indentAt(src: string, at: number): string {
  const ls = src.lastIndexOf("\n", at - 1) + 1;
  return /^[ \t]*/.exec(src.slice(ls))![0];
}

export function canEditPanels(app: AppSpec): boolean {
  return app.panels.every((p) => !!p.span);
}

/** Replace panel i with a changed one. */
export function replacePanel(src: string, app: AppSpec, i: number, p: PanelSpec): string {
  const sp = app.panels[i]?.span;
  if (!sp) return src;
  return apply(src, { start: sp.start, end: sp.end, text: panelSource(p, indentAt(src, sp.start)) });
}

export function removePanel(src: string, app: AppSpec, i: number): string {
  const sp = app.panels[i]?.span;
  if (!sp) return src;
  // the panel's whole line when it has one, otherwise the panel and its comma
  const ls = src.lastIndexOf("\n", sp.start - 1) + 1;
  let le = src.indexOf("\n", sp.end);
  if (le < 0) le = src.length;
  if (src.slice(ls, sp.start).trim() === "" && /^\s*,?\s*$/.test(src.slice(sp.end, le))) return src.slice(0, ls) + src.slice(Math.min(src.length, le + 1));
  const trail = /^\s*,\s*/.exec(src.slice(sp.end));
  if (trail) return src.slice(0, sp.start) + src.slice(sp.end + trail[0].length);
  const lead = /,\s*$/.exec(src.slice(0, sp.start));
  if (lead) return src.slice(0, sp.start - lead[0].length) + src.slice(sp.end);
  return src.slice(0, sp.start) + src.slice(sp.end);
}

/** Add a panel at the end of the panels list (or after panel `after`). */
export function addPanel(src: string, app: AppSpec, p: PanelSpec, after?: number): string {
  const last = after !== undefined ? app.panels[after]?.span : app.panels[app.panels.length - 1]?.span;
  if (last) {
    const ind = indentAt(src, last.start);
    // after the panel's comma when it has one (the list keeps its style), or with a new comma
    const m = /^[ \t]*,/.exec(src.slice(last.end));
    if (m) return apply(src, { start: last.end + m[0].length, end: last.end + m[0].length, text: `\n${ind}${panelSource(p, ind)},` });
    return apply(src, { start: last.end, end: last.end, text: `,\n${ind}${panelSource(p, ind)}` });
  }
  // an empty list: panels: [] → panels: [ new ]
  const block = src.slice(app.span.start, app.span.end);
  const m = /panels\s*:\s*\[\s*\]/.exec(block);
  const ind = indentAt(src, app.span.start) + "  ";
  if (m) {
    const at = app.span.start + m.index;
    return apply(src, { start: at, end: at + m[0].length, text: `panels: [\n${ind}  ${panelSource(p, ind + "  ")},\n${ind}]` });
  }
  return src;
}

/** Move panel `from` to where panel `to` is. */
export function movePanel(src: string, app: AppSpec, from: number, to: number): string {
  if (from === to || !canEditPanels(app)) return src;
  const texts = app.panels.map((p) => src.slice(p.span!.start, p.span!.end));
  const order = app.panels.map((_, i) => i);
  const [x] = order.splice(from, 1);
  order.splice(to, 0, x);
  // write each slot's new text from the end, so earlier spans stay valid
  let out = src;
  for (let k = app.panels.length - 1; k >= 0; k--) {
    const sp = app.panels[k].span!;
    out = out.slice(0, sp.start) + texts[order[k]] + out.slice(sp.end);
  }
  return out;
}

export function resizePanel(src: string, app: AppSpec, i: number, w: number, h: number): string {
  const p = app.panels[i];
  if (!p) return src;
  return replacePanel(src, app, i, { ...p, w, h });
}

/**
 * Set top-level properties of an app block, keeping its formatting. Values
 * are source text (`"Maglev"`, `4`); null removes the property.
 */
export function setAppProps(src: string, app: AppSpec, props: Record<string, string | null>): string {
  const { program } = parse(src);
  const stmt = program.stmts.find((s) => s.k === "app" && s.label === app.name);
  if (!stmt || stmt.k !== "app") return src;
  const edits: Edit[] = [];
  const missing: [string, string][] = [];
  for (const [name, value] of Object.entries(props)) {
    const it = stmt.items.find((i) => i.k === "prop" && i.name === name);
    if (it && it.k === "prop") {
      if (value !== null) edits.push({ start: it.value.span.start, end: it.value.span.end, text: value });
      else {
        const ls = src.lastIndexOf("\n", it.span.start - 1) + 1;
        let le = src.indexOf("\n", it.span.end);
        if (le < 0) le = src.length;
        if (src.slice(ls, it.span.start).trim() === "" && /^\s*,?\s*$/.test(src.slice(it.span.end, le))) edits.push({ start: ls, end: Math.min(src.length, le + 1), text: "" });
        else edits.push({ start: it.span.start, end: it.span.end, text: "" });
      }
    } else if (value !== null) missing.push([name, value]);
  }
  if (missing.length) {
    // new properties go before panels:, so the list stays last
    const panels = stmt.items.find((i) => i.k === "prop" && i.name === "panels");
    const first = stmt.items[0];
    const anchor = panels ?? null;
    const ind = first ? indentAt(src, first.span.start) : indentAt(src, stmt.span.start) + "  ";
    if (anchor) {
      const ls = src.lastIndexOf("\n", anchor.span.start - 1) + 1;
      edits.push({ start: ls, end: ls, text: missing.map(([n, v]) => `${ind}${n}: ${v}\n`).join("") });
    } else {
      const open = src.indexOf("{", stmt.labelSpan.end);
      edits.push({ start: open + 1, end: open + 1, text: missing.map(([n, v]) => `\n${ind}${n}: ${v}`).join("") });
    }
  }
  edits.sort((a, b) => b.start - a.start);
  let out = src;
  for (const e of edits) out = apply(out, e);
  return out;
}

/** Give an app a new name. */
export function renameApp(src: string, app: AppSpec, name: string): string {
  return apply(src, { start: app.labelSpan.start, end: app.labelSpan.end, text: q(name.replace(/\n/g, " ")) });
}

/** Remove a whole app block. */
export function removeApp(src: string, app: AppSpec): string {
  let end = app.span.end;
  while (src[end] === "\n" && src[end + 1] === "\n") end++;
  let start = app.span.start;
  // its heading comment goes with it
  const before = src.slice(0, start);
  const m = /(\n\/\/ ── [^\n]*──\n)$/.exec(before);
  if (m) start -= m[1].length - 1;
  return src.slice(0, start) + src.slice(end).replace(/^\n/, "");
}

// ---------- a starter app ----------

/** Text signals and sim channel names worth showing for a design, best first. */
function interesting(names: string[]): string[] {
  const score = (n: string) => (/^fw\./.test(n) ? 3 : /\.(rpm|amps|speed|angle|force|temp|pos|thrust|soc)$/.test(n) ? 2 : /\.(volts|torque)$/.test(n) ? 1 : 0);
  return [...names].sort((a, b) => score(b) - score(a));
}

/**
 * A first app for the design, written from what Kerf knows without asking
 * Claude: the twin's scenario, the firmware's state line and console, the
 * motors, supplies and sensors the simulation records, and a csv telemetry
 * line when the firmware's own read-me documents one.
 */
export function starterApp(model: Model, name: string, channels: string[] = []): string {
  const twin = model.scenarios?.find((s) => s.spec.world.kind !== "printer" && !s.spec.physicsOnly)?.label;
  const comps = model.machine?.components ?? [];
  const motors = comps.filter((c) => /motor|servo|fan|esc|pump/i.test(`${c.kind ?? ""} ${c.catalogId ?? ""}`)).map((c) => c.name);
  const supplies = comps.filter((c) => /battery|psu|supply/i.test(`${c.kind ?? ""} ${c.catalogId ?? ""}`)).map((c) => c.name);
  const ch = interesting(channels);
  const pickCh = (re: RegExp, n: number) => ch.filter((c) => re.test(c)).slice(0, n);
  const motorCh = channels.length ? pickCh(/\.(rpm|speed|angle)$/, 4) : motors.slice(0, 4).map((m) => `${m}.rpm`);
  const ampCh = channels.length ? pickCh(/\.amps$/, 5) : motors.slice(0, 5).map((m) => `${m}.amps`);
  const powerCh = channels.length ? pickCh(/^(bat|psu|bench_supply|usb|supply|[\w]+)\.(volts|soc)$/, 3) : supplies.slice(0, 2).map((s) => `${s}.volts`);
  const fwCh = pickCh(/^fw\./, 6);
  const ind = "    ";
  const panels: PanelSpec[] = [];
  panels.push({ kind: "state", title: "State", w: 2, h: 1 });
  if (fwCh.length) panels.push({ kind: "readout", title: "Firmware", signals: fwCh.map((expr) => ({ expr })), big: false, w: 3, h: 2 });
  if (motorCh.length) panels.push({ kind: "chart", title: "Motion", signals: motorCh.map((expr) => ({ expr })), window: 0, w: 3, h: 2 });
  if (ampCh.length) panels.push({ kind: "bars", title: "Currents", signals: ampCh.map((expr) => ({ expr })), unit: "A", w: 2, h: 2 });
  if (powerCh.length) panels.push({ kind: "readout", title: "Power", signals: powerCh.map((expr) => ({ expr })), big: true, w: 2, h: 2 });
  panels.push({ kind: "console", title: "Console", commands: [], w: 4, h: 3 });
  panels.push({ kind: "model", title: "Design", parts: [], moves: [], view: "iso", w: 2, h: 3 });
  const lines = [
    `app ${q(name)} {`,
    `  about: "Live view of ${model.name.replace(/"/g, "")}: on its simulated twin, or the real machine over USB"`,
    twin ? `  twin: ${q(twin)}` : `  twin: "none"`,
    `  panels: [`,
    ...panels.map((p) => `${ind}${panelSource(p, ind)},`),
    `  ]`,
    `}`,
  ];
  return lines.join("\n");
}

/** Add an app block at the end of the design, under a heading. */
export function appendApp(src: string, block: string): string {
  const sep = src.endsWith("\n\n") ? "" : src.endsWith("\n") ? "\n" : "\n\n";
  return `${src}${sep}// ── App: a live view for the machine, on its simulated twin or the real one over USB ──\n${block}\n`;
}

/** A name for a new app that no app in the design has yet. */
export function freshAppName(model: Model, base = "Control room"): string {
  const taken = new Set((model.apps ?? []).map((a) => a.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
}

export { parseColumns };
