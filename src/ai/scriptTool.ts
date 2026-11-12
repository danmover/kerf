// scripts: Claude works the design through the same kerf API as the user's scripts (src/scripts), for jobs that repeat
// over many values, parts or configurations: a size tried at many values in readings built apart, files for every
// part or configuration, tables, and checks of the user's own. Claude's runs show in the Scripts tab as the user's do,
// and the scripts it saves stay with the design.

import { z } from "zod";
import { deleteScript, projectScripts, saveScript, useProject } from "../app/project";
import { runSaved, runScript, useScripts } from "../scripts/runtime";
import { scriptReference } from "../scripts/reference";
import { MAX_SCRIPT_CHARS, cleanScriptName, newScriptId } from "../scripts/records";
import { ScriptSession, type ScriptOutput } from "../scripts/session";
import type { ScriptRecord } from "../persist/db";
import type { ToolOutcome } from "./tools";

export const SCRIPT_TOOL_DEFS = [
  {
    name: "scripts",
    description: `Run JavaScript on the design through the kerf API, as the user does in the Scripts tab, or keep it as one of the design's scripts. Use it when work repeats over many values, parts or configurations, or when the user asks for a script: try a parameter at many values without changing the design (kerf.variant) and table the results, export files for every part or configuration, make tables and files, or checks of the user's own. For a single change use edit_design.
run: code (or name: one of the design's scripts) runs once in a sandbox. You get what it logged, its tables (the first rows), the files it made (the user downloads them from the Scripts tab), its checks, the value it returned, or the error and its line. A run that calls kerf.set or kerf.setSource changes the design as one version the user can undo.
save: keep code as a script of the design called name (one of that name is replaced). on_change: true runs it after every change and puts its kerf.check results in the Checks tab; such a script may only look. list: the design's scripts. read: a script's code. delete: remove a script, only when the user asks.

${scriptReference()}`,
    input_schema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["run", "save", "list", "read", "delete"] },
        code: { type: "string", maxLength: MAX_SCRIPT_CHARS, description: "run and save: the script, JavaScript using the kerf API." },
        name: { type: "string", maxLength: 60, description: "save: the script's name (short, what it does). run: one of the design's scripts to run (when no code), or what to call this run. read, delete: which script." },
        on_change: { type: "boolean", description: "save: run it after each change, its checks joining the Checks tab (it may only look). Default: as the script was, or off for a new one." },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
];

export const SCRIPT_TOOL_TITLES: Record<string, string> = { scripts: "Running a script" };

const Input = z.object({
  action: z.enum(["run", "save", "list", "read", "delete"]),
  code: z.string().max(MAX_SCRIPT_CHARS).optional(),
  name: z.string().min(1).max(60).optional(),
  on_change: z.boolean().optional(),
});

const err = (content: string, title: string): ToolOutcome => ({ isError: true, content, card: { title, detail: content, status: "error" } });
const find = (name: string) => projectScripts().find((s) => s.name.toLowerCase() === cleanScriptName(name).toLowerCase());
const lines = (code: string) => {
  const n = code.split("\n").length;
  return `${n} line${n === 1 ? "" : "s"}`;
};
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} …` : s);

/** What a run made, as text for Claude: the status first, then the checks, tables, files and the log, each cut short. */
export function outputText(name: string, o: ScriptOutput): string {
  const secs = o.ms < 1000 ? `${o.ms} ms` : `${(o.ms / 1000).toFixed(1)} s`;
  const out: string[] = [];
  const head = { done: "done", stopped: "stopped before it finished", error: "stopped with an error", running: "still running" }[o.status];
  out.push(`Ran “${name}” in ${secs}: ${head}.${o.builds ? ` It built ${o.builds} other reading${o.builds === 1 ? "" : "s"} of the design.` : ""}`);
  if (o.changed) out.push("It changed the design, kept as one version the user can undo.");
  if (o.error) out.push(`Error${o.line ? ` at line ${o.line}` : ""}: ${o.error}`);
  if (o.value !== undefined) out.push(`Returned: ${clip(o.value, 3000)}`);
  if (o.checks.length) out.push(`Checks:\n${o.checks.map((c) => `- ${c.status}: ${c.name}${c.detail ? ` (${c.detail})` : ""}`).join("\n")}`);
  for (const [i, t] of o.tables.slice(0, 6).entries()) {
    const shown = { ...t, rows: t.rows.slice(0, 25) };
    out.push(`Table “${t.title || `Table ${i + 1}`}”, ${t.rows.length} row${t.rows.length === 1 ? "" : "s"}${t.rows.length > 25 ? " (the first 25)" : ""}:\n${clip(ScriptSession.csv(shown).trimEnd(), 4000)}`);
  }
  if (o.tables.length > 6) out.push(`And ${o.tables.length - 6} more tables, in the Scripts tab.`);
  if (o.files.length) {
    const list = o.files.slice(0, 40).map((f) => `${f.name} (${f.bytes < 1024 * 1024 ? `${Math.max(1, Math.round(f.bytes / 1024))} kB` : `${(f.bytes / 1024 / 1024).toFixed(1)} MB`})`);
    out.push(`Files, which the user downloads from the Scripts tab (one by one or as a zip): ${list.join(", ")}${o.files.length > 40 ? ` and ${o.files.length - 40} more` : ""}.`);
  }
  if (o.lines.length) {
    const all = o.lines.map((l) => (l.level === "log" ? l.text : `[${l.level}] ${l.text}`));
    const shown = all.length > 80 ? [...all.slice(0, 60), `… ${all.length - 80} lines left out …`, ...all.slice(-20)] : all;
    out.push(`Log (${all.length} line${all.length === 1 ? "" : "s"}):\n${clip(shown.join("\n"), 8000)}`);
  }
  if (o.status === "done" && !o.value && !o.checks.length && !o.tables.length && !o.files.length && !o.lines.length && !o.changed) out.push("It made no output: log with console.log, show rows with kerf.table, or return a value.");
  return out.join("\n\n");
}

function listText(): string {
  const list = projectScripts();
  if (!list.length) return "The design has no scripts yet.";
  const outs = useScripts.getState().outputs;
  return `The design's scripts:\n${list
    .map((s) => {
      const o = outs[`script:${s.id}`];
      const last = o ? `; last run ${o.status === "error" ? `stopped with an error${o.line ? ` at line ${o.line}` : ""}` : o.status}` : "";
      return `- “${s.name}”: ${lines(s.code)}${s.onChange ? ", runs after each change" : ""}${last}`;
    })
    .join("\n")}`;
}

export async function runScriptTool(name: string, input: unknown, ctx: { signal?: AbortSignal } = {}): Promise<ToolOutcome | null> {
  if (name !== "scripts") return null;
  const p = Input.safeParse(input ?? {});
  if (!p.success) return err(p.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "), "Invalid tool input");
  if (!useProject.getState().current) return err("No design is open.", "No design");
  const { action, code, name: called, on_change } = p.data;

  switch (action) {
    case "list":
      return { content: listText(), card: { title: "Scripts" } };

    case "read": {
      if (!called) return err(`Name the script to read. ${listText()}`, "No script named");
      const s = find(called);
      if (!s) return err(`No script called “${called}”. ${listText()}`, "No such script");
      return { content: `“${s.name}”${s.onChange ? " (runs after each change)" : ""}:\n${s.code}`, card: { title: `Read “${s.name}”` } };
    }

    case "save": {
      if (!called) return err("Give the script a name.", "No name");
      if (code === undefined || !code.trim()) return err("Give the script's code.", "No code");
      const was = find(called);
      const rec: ScriptRecord = { id: was?.id ?? newScriptId(), name: was?.name ?? called, code, updatedAt: Date.now(), ...((on_change ?? was?.onChange) ? { onChange: true } : {}) };
      const why = saveScript(rec);
      if (why) return err(why, "Not saved");
      useScripts.setState({ opened: true, selected: `script:${rec.id}` });
      const auto = rec.onChange ? " It runs after each change, once your turn ends, and its checks join the Checks tab; run it now to see them." : "";
      const saved = cleanScriptName(rec.name);
      return { content: `${was ? "Replaced" : "Saved"} “${saved}” (${lines(code)}) in the design's Scripts tab.${auto}`, card: { title: `${was ? "Updated" : "Saved"} the script “${saved}”` } };
    }

    case "delete": {
      if (!called) return err("Name the script to delete.", "No script named");
      const s = find(called);
      if (!s) return err(`No script called “${called}”. ${listText()}`, "No such script");
      deleteScript(s.id);
      return { content: `Deleted the script “${s.name}”.`, card: { title: `Deleted the script “${s.name}”` } };
    }

    case "run": {
      let shown: string;
      let done: Promise<ScriptOutput>;
      if (code !== undefined && code.trim()) {
        shown = called ? cleanScriptName(called) || "Claude's script" : "Claude's script";
        useScripts.setState({ opened: true, selected: "claude", claude: { name: shown, code } });
        done = runScript("claude", shown, code, { author: "claude", signal: ctx.signal });
      } else if (called) {
        const s = find(called);
        if (!s) return err(`No script called “${called}”, and no code to run. ${listText()}`, "No such script");
        shown = s.name;
        useScripts.setState({ opened: true, selected: `script:${s.id}` });
        done = runSaved(s.id, { author: "claude", signal: ctx.signal });
      } else return err("Give code to run, or the name of one of the design's scripts.", "Nothing to run");
      let o: ScriptOutput;
      try {
        o = await done;
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e), "The script didn't run");
      }
      const text = outputText(shown, o);
      const detail = o.status === "error" ? `${o.line ? `Line ${o.line}: ` : ""}${o.error ?? "stopped with an error"}` : [o.tables.length ? `${o.tables.length} table${o.tables.length === 1 ? "" : "s"}` : "", o.files.length ? `${o.files.length} file${o.files.length === 1 ? "" : "s"}` : "", o.checks.length ? `${o.checks.length} check${o.checks.length === 1 ? "" : "s"}` : "", o.changed ? "changed the design" : ""].filter(Boolean).join(", ");
      return {
        content: text,
        ...(o.status === "error" ? { isError: true } : {}),
        card: { title: o.status === "error" ? `The script “${shown}” stopped` : `Ran the script “${shown}”`, ...(detail ? { detail } : {}), ...(o.status === "error" ? { status: "error" as const } : {}) },
      };
    }
  }
}
