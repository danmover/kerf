// The Scripts tab: JavaScript that works the design through the kerf API (sweeps of a size, batch exports, reports
// and checks of your own) with examples to start from, what each run made, and the API beside the editor.

import { useEffect, useState } from "react";
import { deleteScript, projectScripts, saveScript, useProject } from "../../app/project";
import { confirmDialog, errorText, toast } from "../../app/ui";
import { useChat } from "../../ai/chat";
import { addScript, runSaved, runScript, stopScript, useScripts } from "../../scripts/runtime";
import { SCRIPT_EXAMPLES, type ScriptExample } from "../../scripts/examples";
import { SCRIPT_API } from "../../scripts/reference";
import { ScriptSession, type ScriptOutput, type ScriptTable } from "../../scripts/session";
import type { ScriptRecord } from "../../persist/db";
import { download, safeFileName } from "../../persist/files";
import { zip } from "../../persist/zip";
import { Toggle, useTick } from "../common";
import { Icon } from "../icons";
import { askClaude } from "../chatDraft";
import { ScriptEditor } from "./ScriptEditor";
import "../../styles/scripts.css";

export function ScriptGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="1.5" y="2" width="13" height="12" rx="2" />
      <path d="M4.5 6.5 6.5 8.5 4.5 10.5" />
      <path d="M8.5 10.5h3" />
    </svg>
  );
}

export const SCRIPT_ASK = "Write a script for this design in the Scripts tab that ";

type Shown = { key: string; name: string; code: string } & ({ kind: "script"; script: ScriptRecord } | { kind: "example"; example: ScriptExample } | { kind: "claude" });

function shownOf(selected: string | null, scripts: ScriptRecord[], claude: { name: string; code: string } | null): Shown {
  const own = (s: ScriptRecord): Shown => ({ kind: "script", key: `script:${s.id}`, name: s.name, code: s.code, script: s });
  const ex = (e: ScriptExample): Shown => ({ kind: "example", key: `example:${e.id}`, name: e.name, code: e.code, example: e });
  const s = scripts.find((x) => `script:${x.id}` === selected);
  if (s) return own(s);
  const e = SCRIPT_EXAMPLES.find((x) => `example:${x.id}` === selected);
  if (e) return ex(e);
  if (selected === "claude" && claude) return { kind: "claude", key: "claude", ...claude };
  return scripts.length ? own(scripts[0]) : ex(SCRIPT_EXAMPLES[0]);
}

const select = (key: string) => useScripts.setState({ selected: key });

/** what the main area shows: code and output side by side when there is room, one of code, output or API when not */
type View = "code" | "output" | "api";

export function ScriptsPanel() {
  const scripts = useProject((s) => s.current?.scripts) ?? [];
  const selected = useScripts((s) => s.selected);
  const claude = useScripts((s) => s.claude);
  const [view, setView] = useState<View>("code");
  const shown = shownOf(selected, scripts, claude);
  return (
    <div className="kscripts-wrap">
      <div className="kscripts">
        <ScriptList scripts={scripts} shown={shown.key} claude={claude} />
        <ScriptMain shown={shown} view={view} setView={setView} />
      </div>
    </div>
  );
}

// ---------- the list ----------

function Status({ k }: { k: string }) {
  const out = useScripts((s) => s.outputs[k]);
  const running = useScripts((s) => s.running?.key === k);
  if (running) return <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />;
  if (out?.status === "error") return <span className="kscripts-dot fail" aria-label="Stopped with an error" />;
  if (out?.checks.some((c) => c.status === "fail")) return <span className="kscripts-dot fail" aria-label="A check fails" />;
  return null;
}

function ScriptList({ scripts, shown, claude }: { scripts: ScriptRecord[]; shown: string; claude: { name: string } | null }) {
  const add = () => {
    const r = addScript();
    if ("error" in r) toast({ kind: "error", title: "No new script", detail: r.error });
  };
  const item = (key: string, name: string, extra?: React.ReactNode) => (
    <button key={key} className={`kscripts-item ${shown === key ? "active" : ""}`} onClick={() => select(key)}>
      <span className="n">{name}</span>
      {extra}
      <Status k={key} />
    </button>
  );
  return (
    <div className="kscripts-list">
      <div className="kscripts-head">
        <span>This design</span>
        <button className="icon-btn sm" onClick={add} aria-label="New script" data-tip="New script">
          <Icon.Plus size={13} />
        </button>
      </div>
      {scripts.map((s) => item(`script:${s.id}`, s.name, s.onChange ? <span className="kscripts-tag" data-tip="Runs after each change">auto</span> : null))}
      {!scripts.length && <div className="kscripts-none">No scripts yet. Start from an example, or a new one.</div>}
      <button className="kscripts-item ask" onClick={() => askClaude(SCRIPT_ASK)} data-tip="Claude writes one for you and runs it">
        <Icon.Sparkle size={12} />
        <span className="n">Ask Claude for one</span>
      </button>
      {claude && (
        <>
          <div className="kscripts-head">
            <span>Claude</span>
          </div>
          {item("claude", claude.name)}
        </>
      )}
      <div className="kscripts-head">
        <span>Examples</span>
      </div>
      {SCRIPT_EXAMPLES.map((e) => item(`example:${e.id}`, e.name))}
    </div>
  );
}

// ---------- the editor and its bar ----------

function run(shown: Shown) {
  const done = (p: Promise<ScriptOutput>) =>
    void p.then(
      (o) => {
        if (o.changed) toast({ kind: "success", title: `“${shown.name}” changed the design`, detail: "One version: undo brings back the design as it was before the run." });
      },
      (e) => toast({ kind: "error", title: "The script didn't run", detail: errorText(e) }),
    );
  if (shown.kind === "script") return done(runSaved(shown.script.id));
  if (shown.kind === "example") return done(runScript(shown.key, shown.name, shown.code, { mode: shown.example.onChange ? "check" : "run" }));
  done(runScript("claude", shown.name, shown.code));
}

function ScriptMain({ shown, view, setView }: { shown: Shown; view: View; setView: (v: View) => void }) {
  const running = useScripts((s) => s.running);
  const busy = useChat((s) => s.busy);
  const out = useScripts((s) => s.outputs[shown.key]);
  const errorLine = out?.status === "error" ? out.line : undefined;
  const here = running?.key === shown.key;
  const blocked = !!running && !here ? `“${running.name}” is running` : busy ? "Claude is working on the design" : null;
  const save = (key: string, code: string) => {
    const s = projectScripts().find((x) => `script:${x.id}` === key);
    if (!s || s.code === code) return;
    const why = saveScript({ ...s, code });
    if (why) toast({ kind: "error", title: "Not saved", detail: why });
  };
  const go = () => {
    if (blocked || here) return;
    if (view === "code") setView("output");
    run(shown);
  };
  // with code beside the output, "code" shows the output there
  const active = (v: View, list: View[]) => (list.includes("code") ? view === v : v === "api" ? view === "api" : view !== "api");
  const tabs = (list: View[]) => (
    <div className="kscripts-tabs" role="tablist">
      {list.map((v) => (
        <button key={v} role="tab" aria-selected={active(v, list)} className={active(v, list) ? "active" : ""} onClick={() => setView(v)}>
          {{ code: "Code", output: "Output", api: "kerf API" }[v]}
          {v === "output" && out?.status === "running" && <span className="spinner" style={{ width: 9, height: 9, borderWidth: 1.5 }} />}
          {v === "output" && out?.status === "error" && <span className="kscripts-dot fail" />}
        </button>
      ))}
    </div>
  );
  return (
    <div className="kscripts-main">
      <div className="kscripts-bar">
        {shown.kind === "script" ? <NameField script={shown.script} /> : <span className="kscripts-title">{shown.kind === "claude" ? `Claude: ${shown.name}` : shown.name}</span>}
        {shown.kind === "script" && <AfterEachChange script={shown.script} />}
        <div className="grow" />
        {here ? (
          <button className="btn sm danger" onClick={stopScript}>
            <Icon.Stop size={12} /> Stop
          </button>
        ) : (
          <button className="btn sm primary" onClick={go} disabled={!!blocked} data-tip={blocked ?? "Run it (Ctrl+Enter)"}>
            <Icon.Play size={12} /> {shown.kind === "example" ? "Try it" : "Run"}
          </button>
        )}
        {shown.kind !== "script" && (
          <button
            className="btn sm"
            onClick={() => {
              const r = addScript({ name: shown.name, code: shown.code });
              if ("error" in r) toast({ kind: "error", title: "Not added", detail: r.error });
            }}
            data-tip="A copy in this design, to change and keep"
          >
            <Icon.Copy size={12} /> {shown.kind === "example" ? "Use" : "Keep"}
          </button>
        )}
        {shown.kind === "script" && <DeleteButton script={shown.script} />}
      </div>
      {shown.kind === "example" && <div className="kscripts-about">{shown.example.about}</div>}
      {tabs(["code", "output", "api"])}
      <div className={`kscripts-split view-${view}`}>
        <ScriptEditor docKey={shown.key} value={shown.code} readOnly={shown.kind !== "script"} error={errorLine} onSave={save} onRun={go} />
        <div className="kscripts-out">
          {tabs(["output", "api"])}
          <div className="kscripts-out-body">
            {view === "api" ? <ApiHelp /> : out ? <RunOutput out={out} name={shown.name} /> : <div className="kscripts-none">Run the script to see what it makes: lines it logs, tables, files to download and checks. Ctrl+Enter runs it.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function NameField({ script }: { script: ScriptRecord }) {
  const [name, setName] = useState(script.name);
  useEffect(() => setName(script.name), [script.id, script.name]);
  const commit = () => {
    if (name === script.name) return;
    const why = saveScript({ ...script, name });
    if (why) {
      toast({ kind: "error", title: "Name not changed", detail: why });
      setName(script.name);
    }
  };
  return (
    <input
      className="kscripts-name"
      value={name}
      maxLength={60}
      aria-label="Script name"
      onChange={(e) => setName(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setName(script.name);
      }}
    />
  );
}

function AfterEachChange({ script }: { script: ScriptRecord }) {
  const set = (on: boolean) => {
    const { onChange: _, ...rest } = script;
    const why = saveScript(on ? { ...rest, onChange: true } : rest);
    if (why) toast({ kind: "error", title: "Not changed", detail: why });
  };
  return (
    <label className="kscripts-auto" data-tip="Runs after each change to the design, only looking: its kerf.check results join the Checks tab">
      <Toggle on={!!script.onChange} onChange={set} label="Run after each change" />
      <span>After each change</span>
    </label>
  );
}

function DeleteButton({ script }: { script: ScriptRecord }) {
  const remove = async () => {
    const ok = await confirmDialog({ title: `Delete “${script.name}”?`, body: "The script goes from this design. Undo doesn't bring it back.", confirm: "Delete", danger: true });
    if (!ok) return;
    deleteScript(script.id);
    useScripts.setState((s) => {
      const outputs = { ...s.outputs };
      delete outputs[`script:${script.id}`];
      return { outputs, selected: null };
    });
  };
  return (
    <button className="icon-btn sm" onClick={() => void remove()} aria-label="Delete the script" data-tip="Delete">
      <Icon.Trash size={13} />
    </button>
  );
}

// ---------- what a run made, and the API ----------

const secs = (ms: number) => (ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function RunOutput({ out, name }: { out: ScriptOutput; name: string }) {
  useTick(out.status === "running" ? 500 : 60_000);
  const ms = out.status === "running" ? Date.now() - out.startedAt : out.ms;
  const status =
    out.status === "running" ? `Running… ${secs(ms)}` : out.status === "done" ? `Done in ${secs(ms)}` : out.status === "stopped" ? `Stopped after ${secs(ms)}` : `Stopped with an error${out.line ? ` at line ${out.line}` : ""}`;
  const extra = [out.builds ? `${out.builds} other reading${out.builds === 1 ? "" : "s"} built` : "", out.files.length ? `${out.files.length} file${out.files.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  const p = out.progress;
  return (
    <div className="kscripts-run">
      <div className={`kscripts-status ${out.status}`}>
        {out.status === "running" ? <span className="spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} /> : out.status === "done" ? <Icon.Check size={13} /> : out.status === "error" ? <Icon.Alert size={13} /> : <Icon.Stop size={12} />}
        <span>{status}</span>
        {extra && <span className="dim">{extra}</span>}
      </div>
      {out.status === "running" && p && p.total > 0 && (
        <div className="kscripts-progress" role="progressbar" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done}>
          <div style={{ width: `${Math.min(100, (p.done / p.total) * 100)}%` }} />
          <span>
            {p.done} of {p.total}
            {p.label ? `: ${p.label}` : ""}
          </span>
        </div>
      )}
      {out.changed && <div className="kscripts-note">Changed the design as one version: undo brings back the design as it was before the run.</div>}
      {out.error && <div className="kscripts-error">{out.error}</div>}
      {out.value !== undefined && (
        <div className="kscripts-block">
          <div className="kscripts-label">Returned</div>
          <pre className="kscripts-value">{out.value}</pre>
        </div>
      )}
      {out.checks.length > 0 && (
        <div className="kscripts-block">
          <div className="kscripts-label">Checks</div>
          {out.checks.map((c) => (
            <div key={c.name} className={`kscripts-check ${c.status}`}>
              {c.status === "pass" ? <Icon.Check size={12} /> : c.status === "fail" ? <Icon.X size={12} /> : <Icon.Alert size={12} />}
              <span className="t">{c.name}</span>
              {c.detail && <span className="d">{c.detail}</span>}
            </div>
          ))}
        </div>
      )}
      {out.tables.map((t, i) => (
        <TableView key={i} t={t} n={i + 1} />
      ))}
      {out.files.length > 0 && <Files out={out} name={name} />}
      {out.lines.length > 0 && (
        <div className="kscripts-block">
          <div className="kscripts-label">Log</div>
          <div className="kscripts-log">
            {out.lines.map((l, i) => (
              <div key={i} className={l.level}>
                {l.text}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const ROWS_SHOWN = 100;

function TableView({ t, n }: { t: ScriptTable; n: number }) {
  const [all, setAll] = useState(false);
  const rows = all ? t.rows : t.rows.slice(0, ROWS_SHOWN);
  const title = t.title || `Table ${n}`;
  return (
    <div className="kscripts-block">
      <div className="kscripts-label">
        <span>{title}</span>
        <span className="dim">
          {t.rows.length} row{t.rows.length === 1 ? "" : "s"}
        </span>
        <button className="btn sm ghost" onClick={() => download(ScriptSession.csv(t), safeFileName(title, "csv"), "text/csv")} data-tip="Download as CSV">
          <Icon.Download size={12} /> CSV
        </button>
      </div>
      <div className="kscripts-table">
        <table>
          <thead>
            <tr>
              {t.columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j} className={typeof c === "number" ? "num" : ""}>
                    {c === null ? "" : String(c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length < t.rows.length && (
        <button className="btn sm ghost" onClick={() => setAll(true)}>
          Show all {t.rows.length} rows
        </button>
      )}
    </div>
  );
}

function Files({ out, name }: { out: ScriptOutput; name: string }) {
  const all = async () => {
    try {
      const bytes = await zip(out.files.map((f) => ({ name: f.name, data: f.data })));
      download(bytes, safeFileName(`${name} files`, "zip"), "application/zip");
    } catch (e) {
      toast({ kind: "error", title: "No zip made", detail: errorText(e) });
    }
  };
  return (
    <div className="kscripts-block">
      <div className="kscripts-label">
        <span>Files</span>
        {out.files.length > 1 && (
          <button className="btn sm ghost" onClick={() => void all()}>
            <Icon.Download size={12} /> All as a zip
          </button>
        )}
      </div>
      {out.files.map((f) => (
        <div key={f.name} className="kscripts-file">
          <span className="n">{f.name}</span>
          <span className="dim">{size(f.bytes)}</span>
          <button className="icon-btn sm" onClick={() => download(f.data as BlobPart, f.name.split("/").pop() || f.name, f.mime)} aria-label={`Download ${f.name}`} data-tip="Download">
            <Icon.Download size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

function ApiHelp() {
  return (
    <div className="kscripts-api">
      <p>
        Scripts are JavaScript: <code>await</code> works at the top level and <code>return</code> shows a value. Every <code>kerf</code> call returns a promise, so await it. Values are in mm, degrees, g and N. A script reaches the design only through
        <code>kerf</code>: it has no network, files or storage of its own.
      </p>
      {SCRIPT_API.map((a) => (
        <div key={a.sig} className="kscripts-api-row">
          <code>{a.sig}</code>
          <span>{a.doc}</span>
        </div>
      ))}
      <p className="dim">A run builds up to 300 other readings of the design, makes up to 200 files and stops after 30 minutes. A script that runs after each change may only look: no set or setSource.</p>
    </div>
  );
}
