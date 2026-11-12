// The assistant's tool for apps (app blocks: a live control program for the
// machine): try one on its simulated twin, headless and fast, to see what the
// firmware prints, what the app reads from it and what every panel would
// show, before telling the user it works. It changes nothing.

import { z } from "zod";
import { useDesign, whenChecked } from "../core/engine";
import { appNamed, appsOf, twinOptions } from "../apps/session";
import { bareApp, tryApp } from "../apps/tryApp";
import { telemetryColumns } from "../apps/lines";
import type { AppSpec } from "../apps/spec";
import type { ExprValue } from "../apps/expr";
import { fmtNum } from "../lang/values";
import type { ToolOutcome } from "./tools";

export const APP_TOOL_DEFS = [
  {
    name: "try_app",
    description:
      "Run an app block (a live control program for the machine; see Apps in the language reference) on the machine's simulated twin, headless and faster than real time: its hello lines and any commands you give are typed into the firmware's serial console at their times. Returns what the firmware printed, the signals the app's telemetry formats read from those lines, the twin's own channels (motors, supplies, sensors, world, fw.<variable>) and what every panel would show, flagging panels that would show nothing. With no app in the design (or app: \"none\"), it runs the bare firmware so you can see its lines and channels before writing one. Changes nothing.",
    input_schema: {
      type: "object" as const,
      properties: {
        app: { type: "string", description: 'The app\'s name; default the first app in the design. "none" runs the firmware with no app.' },
        scenario: { type: "string", description: "The scenario whose world the twin runs in (default the app's twin)." },
        seconds: { type: "number", description: "Simulated seconds to run (default 10, at most 120)." },
        send: {
          type: "array",
          maxItems: 20,
          description: "Lines to type into the console, each at a time in seconds: what the app's buttons and console send.",
          items: { type: "object", properties: { at: { type: "number" }, text: { type: "string" } }, required: ["at", "text"], additionalProperties: false },
        },
        show: { type: "string", enum: ["summary", "console"], description: "summary (default): the start and end of the console, signals and panels; console: every line." },
      },
      additionalProperties: false,
    },
  },
];

export const APP_TOOL_TITLES: Record<string, string> = { try_app: "Trying the app on the twin" };

const TryInput = z.object({
  app: z.string().max(200).optional(),
  scenario: z.string().max(200).optional(),
  seconds: z.number().min(0.1).max(120).optional(),
  send: z.array(z.object({ at: z.number().min(0).max(120), text: z.string().max(400) })).max(20).optional(),
  show: z.enum(["summary", "console"]).optional(),
});

const fail = (content: string, title: string): ToolOutcome => ({ isError: true, content, card: { title, status: "error" } });

const show = (v: ExprValue) => (typeof v === "number" ? (Number.isFinite(v) ? fmtNum(v, 3) : "no data") : v === "" ? "no data" : JSON.stringify(v));

export async function runAppTool(name: string, input: unknown): Promise<ToolOutcome | null> {
  if (name !== "try_app") return null;
  const p = TryInput.safeParse(input ?? {});
  if (!p.success) return fail(`Invalid input: ${p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "Could not try the app");
  await whenChecked(60_000);
  const model = useDesign.getState().model;
  if (!model) return fail("The design has not built yet.", "Could not try the app");
  const apps = appsOf(model);
  let app: AppSpec;
  if (p.data.app === "none" || (!p.data.app && !apps.length)) {
    const def = model.scenarios?.find((s) => (p.data.scenario ? s.label === p.data.scenario : s.spec.world.kind !== "printer" && !s.spec.physicsOnly));
    if (!def) return fail(p.data.scenario ? `There is no scenario “${p.data.scenario}”.` : "The design has no scenario with firmware for a twin to run in: add one (see Simulations), then try again.", "No twin to run");
    app = bareApp(def.label);
  } else {
    const found = p.data.app ? appNamed(model, p.data.app) : apps[0];
    if (!found) return fail(`There is no app “${p.data.app}”. The design's apps: ${apps.map((a) => a.name).join(", ") || "none"}.`, "No such app");
    app = p.data.scenario ? { ...found, twin: p.data.scenario } : found;
  }
  const o = twinOptions(app, model);
  if ("error" in o) return fail(`The twin cannot run: ${o.error}.`, "The twin cannot run");
  const seconds = p.data.seconds ?? 10;
  let r;
  try {
    r = tryApp(app, o, { seconds, send: p.data.send, budgetMs: 15000 });
  } catch (e) {
    return fail(`The twin failed to start: ${e instanceof Error ? e.message : String(e)}`, "The twin failed");
  }

  const out: string[] = [];
  out.push(`${app.panels.length ? `App “${app.name}”` : "The firmware with no app"} on the simulated twin: ${r.firmware || "the firmware"} on a virtual ${r.board}, in “${app.twin}”, ${fmtNum(Number(r.ran.toFixed(2)))} s simulated${r.cut ? " (cut short: it ran out of time)" : ""}.`);
  if (r.stopped) out.push(`The twin stopped: ${r.stopped}${r.error ? ` (${r.error})` : ""}.`);
  const L = r.lines;
  const line = (l: { t: number; text: string }) => `${l.t.toFixed(2).padStart(7)}  ${l.text}`;
  if (p.data.show === "console") out.push(`\nConsole (${L.length} lines):\n${L.slice(0, 400).map(line).join("\n")}${L.length > 400 ? `\n… ${L.length - 400} more` : ""}`);
  else if (L.length <= 50) out.push(`\nConsole:\n${L.map(line).join("\n") || "(nothing printed)"}`);
  else out.push(`\nConsole (${L.length} lines; the first 30 and last 20):\n${L.slice(0, 30).map(line).join("\n")}\n…\n${L.slice(-20).map(line).join("\n")}`);

  const parsed = Object.entries(r.parsed);
  const cols = telemetryColumns(app.telemetry).map((c) => c.name);
  out.push(`\nRead from the lines by the app's telemetry (${app.telemetry.length ? app.telemetry.map((f) => f.kind + (f.prefix ? ` "${f.prefix}"` : "")).join(", ") : "default: name=value pairs"}): ${parsed.length ? parsed.map(([k, v]) => `${k} = ${show(v)}`).join(", ") : "nothing"}.`);
  const unseen = cols.filter((c) => !(c in r.parsed));
  if (unseen.length) out.push(`Telemetry columns never read (no line matched): ${unseen.join(", ")}.`);
  const chNames = Object.keys(r.channels);
  const byPrefix = new Map<string, string[]>();
  for (const n of chNames) {
    const k = n.includes(".") ? n.slice(0, n.indexOf(".")) : n;
    byPrefix.set(k, [...(byPrefix.get(k) ?? []), n]);
  }
  out.push(
    `\nTwin channels (${chNames.length}; these exist only on the twin, not on the real machine): ${[...byPrefix.values()]
      .map((ns) => ns.slice(0, 12).map((n) => `${n} = ${show(r.channels[n])}`).join(", ") + (ns.length > 12 ? `, … ${ns.length - 12} more` : ""))
      .join("; ")}.`,
  );
  if (app.panels.length) {
    out.push("\nPanels:");
    let blank = 0;
    for (const pl of r.panels) {
      const vals = pl.values.map((v) => `${v.expr} → ${show(v.value)}${v.shows ? "" : " ✗"}`);
      if (pl.values.some((v) => !v.shows)) blank++;
      out.push(`- ${pl.title || pl.kind} (${pl.kind})${vals.length ? `: ${vals.join("; ")}` : ""}`);
    }
    if (blank) out.push(`${blank} panel${blank === 1 ? "" : "s"} would show “no data” for a signal (✗): fix the name, add the telemetry the firmware prints, or make the firmware print it.`);
    const simOnly = r.panels.flatMap((pl) => pl.values.filter((v) => v.shows && /^[\w.]+$/.test(v.expr) && v.expr in r.channels && !(v.expr in r.parsed)).map((v) => v.expr));
    if (simOnly.length) out.push(`Shown from twin-only channels (blank on the real machine unless its firmware prints them): ${[...new Set(simOnly)].join(", ")}.`);
  }
  return { content: out.join("\n"), card: { title: `Tried ${app.panels.length ? app.name : "the firmware"} on the twin`, detail: `${fmtNum(Number(r.ran.toFixed(1)))} s, ${L.length} lines`, status: "done" } };
}
