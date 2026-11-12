// A design's apps: control rooms and live views for the machine, declared in
// the design file with an `app "Name" { ... }` block and run inside Kerf (on
// the design's simulated twin or the real machine over USB) or exported as
// software of their own. Everything here is plain data, so the same spec
// drives the app in Kerf, in a saved page and in a desktop app.
//
// Signals are named numbers (or text) that change over time: columns of the
// firmware's telemetry lines, values the app works out from them, and on the
// simulated twin every number the simulation records (`tunnel.drag`,
// `lift.amps`, `fw.dragMn`). Panels read them through small expressions
// such as "drag / 100" or "hypot(x, y)".

/** How one kind of line the firmware prints becomes signals. */
export type TelemetryFormat =
  /** `T,1234,2,-31,...`: a word first, then values in a fixed order */
  | { kind: "csv"; prefix: string; columns: ColumnDef[]; sep: string }
  /** `x=1.2 y=3.4` or `speed: 12.5, rpm: 3000`, optionally after a first word; spaced also reads `dist 120 mm  yaw 1.5` */
  | { kind: "keys"; prefix: string; spaced?: boolean }
  /** `{"x": 1.2, "y": 3.4}`, optionally after a first word */
  | { kind: "json"; prefix: string };

export interface ColumnDef {
  name: string;
  unit?: string;
}

/** A signal the app works out from others: `derive("air", "speed / 100", unit: "m/s")`. */
export interface DeriveDef {
  name: string;
  expr: string;
  unit?: string;
  label?: string;
  digits?: number;
}

/** One signal shown in a panel: an expression and how to show it. */
export interface SignalItem {
  expr: string;
  label?: string;
  unit?: string;
  digits?: number;
  color?: string;
  /** a bar under the number, full at this value */
  max?: number;
  min?: number;
  /** the number turns amber while this is true */
  warn?: string;
  /** and red while this is */
  alarm?: string;
}

export type ControlSpec =
  | { kind: "button"; label: string; send: string; confirm?: string; tone?: "accent" | "danger" | "plain"; key?: string }
  | { kind: "slider"; label: string; send: string; min: number; max: number; step: number; value: number; unit?: string; live: boolean; key?: string }
  | { kind: "toggle"; label: string; on: string; off: string; state?: string; key?: string }
  | { kind: "field"; label: string; send: string; placeholder?: string; key?: string }
  | { kind: "choice"; label: string; options: string[]; send: string; key?: string };

export interface LampDef {
  label: string;
  when: string;
  color?: string;
  /** the label while it is off, when that reads better ("landed" for "floating") */
  off?: string;
}

/** Where a part sits while the app runs: moved or turned by a signal. */
export interface ModelMove {
  part: string;
  kind: "slide" | "turn" | "spin";
  /** slide: the direction; turn and spin: the axis */
  axis: [number, number, number];
  /** turn and spin: a point on the axis, mm */
  about?: [number, number, number];
  /** mm for slide, degrees for turn, rpm for spin */
  expr: string;
}

interface PanelBase {
  title: string;
  /** width and height on the app's grid */
  w: number;
  h: number;
  /** source span of the panel's call, for the builder's edits */
  span?: { start: number; end: number };
}

export type PanelSpec = PanelBase &
  (
    | { kind: "readout"; signals: SignalItem[]; big: boolean }
    | { kind: "gauge"; signal: SignalItem; min: number; max: number; zones: { from: number; to: number; color: string }[] }
    | { kind: "chart"; signals: SignalItem[]; window: number; min?: number; max?: number; unit?: string }
    | { kind: "scope"; x: SignalItem; y: SignalItem; range?: number; trail: number; unit?: string }
    | { kind: "bars"; signals: SignalItem[]; min?: number; max?: number; unit?: string }
    | { kind: "lamps"; lamps: LampDef[] }
    | { kind: "state" }
    | { kind: "controls"; controls: ControlSpec[] }
    | { kind: "console"; commands: string[] }
    | { kind: "log"; match?: string }
    | { kind: "table"; signals: SignalItem[] }
    | { kind: "note"; text: string }
    | { kind: "custom"; uses: string[]; code: string }
    | { kind: "model"; parts: string[]; moves: ModelMove[]; view: "iso" | "front" | "side" | "top" }
    | { kind: "camera"; overlay: SignalItem[] }
  );

export type PanelKind = PanelSpec["kind"];

export interface AppSpec {
  /** the name in the block's header: app "Maglev control room" { ... } */
  name: string;
  /** the scenario whose world the simulated twin runs; null when the app has no twin */
  twin: string | null;
  /** twin: was written (otherwise the first scenario is the twin) */
  twinGiven: boolean;
  twinSpan?: { start: number; end: number };
  /** which firmware block the app talks to, when the design has more than one */
  firmware?: string;
  firmwareSpan?: { start: number; end: number };
  baud: number;
  telemetry: TelemetryFormat[];
  derive: DeriveDef[];
  /** text sent when the app connects (to start the firmware's data stream) */
  hello: string[];
  /** commands the console suggests */
  commands: string[];
  /** columns of the panel grid on a wide screen */
  columns: number;
  /** the window a chart shows when it does not give its own, s */
  window: number;
  accent?: string;
  /** a line of text under the app's name */
  about?: string;
  panels: PanelSpec[];
  span: { start: number; end: number };
  labelSpan: { start: number; end: number };
}

/** What each kind of panel is, for the builder's add menu and the docs. */
export const PANEL_KINDS: { kind: PanelKind; label: string; detail: string; w: number; h: number }[] = [
  { kind: "readout", label: "Numbers", detail: "Live values, big or small, with a bar and warning colours", w: 2, h: 2 },
  { kind: "gauge", label: "Gauge", detail: "A dial for one value, with coloured zones", w: 1, h: 2 },
  { kind: "chart", label: "Chart", detail: "Values over the last seconds, scrolling", w: 3, h: 2 },
  { kind: "scope", label: "XY scope", detail: "One value against another with a fading trail: a position seen from above", w: 2, h: 3 },
  { kind: "bars", label: "Bars", detail: "Several values side by side as bars: currents, loads, levels", w: 2, h: 2 },
  { kind: "lamps", label: "Lamps", detail: "Status lights that come on when a condition is true", w: 2, h: 1 },
  { kind: "state", label: "State", detail: "What the firmware says it is doing, its faults and recent events", w: 2, h: 1 },
  { kind: "controls", label: "Controls", detail: "Buttons, sliders, switches and fields that send commands", w: 2, h: 2 },
  { kind: "console", label: "Console", detail: "The serial console: everything the firmware prints, and a line to type commands", w: 3, h: 3 },
  { kind: "log", label: "Log", detail: "The lines that match a pattern: faults, results, sweep points", w: 2, h: 2 },
  { kind: "table", label: "Table", detail: "Values with their lowest, highest and average since the start", w: 2, h: 2 },
  { kind: "model", label: "3D model", detail: "The design in 3D, its parts moved and turned by live values", w: 3, h: 4 },
  { kind: "camera", label: "Camera", detail: "A USB camera's picture with live values over it", w: 3, h: 3 },
  { kind: "note", label: "Note", detail: "Text for whoever uses the app: what to do first, what to watch", w: 2, h: 1 },
  { kind: "custom", label: "Custom drawing", detail: "Your own drawing code for anything the others do not show", w: 3, h: 3 },
];

export const panelKindInfo = (k: PanelKind) => PANEL_KINDS.find((p) => p.kind === k)!;

/** The signals a panel reads, as expressions. */
export function panelExprs(p: PanelSpec): string[] {
  const items = (xs: SignalItem[]) => xs.flatMap((s) => [s.expr, s.warn, s.alarm].filter((x): x is string => !!x));
  switch (p.kind) {
    case "readout":
    case "chart":
    case "bars":
    case "table":
      return items(p.signals);
    case "camera":
      return items(p.overlay);
    case "gauge":
      return items([p.signal]);
    case "scope":
      return items([p.x, p.y]);
    case "lamps":
      return p.lamps.map((l) => l.when);
    case "controls":
      return p.controls.flatMap((c) => (c.kind === "toggle" && c.state ? [c.state] : []));
    case "model":
      return p.moves.map((m) => m.expr);
    default:
      return [];
  }
}

/** The commands an app's controls can send, with `{}` where the value goes. */
export function controlSends(app: AppSpec): string[] {
  const out: string[] = [];
  for (const p of app.panels) {
    if (p.kind !== "controls") continue;
    for (const c of p.controls) {
      if (c.kind === "toggle") out.push(c.on, c.off);
      else out.push(c.send);
    }
  }
  return out;
}

/** "fan {}" with 40 → "fan 40"; a template without {} gets the value after a space. */
export function fillSend(template: string, value: string | number): string {
  const v = typeof value === "number" ? String(Number(value.toPrecision(6))) : value;
  return template.includes("{}") ? template.split("{}").join(v) : `${template} ${v}`.trim();
}
