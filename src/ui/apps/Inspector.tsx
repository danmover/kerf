// The app builder's side panel: the selected panel's settings (its title,
// size, signals and what each kind of panel takes), or with nothing selected
// the app's own (name, twin, grid). Each change is written into the design
// file at once, as a small edit to that panel's text.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useDesign } from "../../core/engine";
import { confirmDialog } from "../../app/ui";
import { revealSpan } from "../../app/view";
import { closeApp, openApp, selectPanel, storeFor, useApps } from "../../apps/session";
import { compiled, ExprError } from "../../apps/expr";
import { PANEL_KINDS, panelKindInfo, type AppSpec, type PanelKind, type PanelSpec, type SignalItem } from "../../apps/spec";
import { addPanel, canEditPanels, newPanel, q, removeApp, removePanel, renameApp, replacePanel, setAppProps } from "../../apps/source";
import { Menu, MenuItem } from "../common";
import { Icon } from "../icons";
import { askClaude } from "../chatDraft";
import { commitApp } from "./actions";
import { signalChoices, type SignalChoice } from "./choices";

const src = () => useDesign.getState().source;

// ---------- small inputs that write when you finish typing ----------

function TextIn({ value, onDone, placeholder, mono, check, area, list }: { value: string; onDone: (v: string) => void; placeholder?: string; mono?: boolean; check?: (v: string) => string | null; area?: boolean; list?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const err = check && draft !== value ? check(draft) : null;
  const done = () => {
    if (draft === value) return;
    if (check?.(draft)) return;
    onDone(draft);
  };
  const props = {
    className: `kai-in ${mono ? "mono" : ""} ${err ? "bad" : ""}`,
    value: draft,
    placeholder,
    spellCheck: false,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: done,
  };
  return (
    <>
      {area ? (
        <textarea {...props} rows={4} onKeyDown={(e) => e.key === "Escape" && setDraft(value)} />
      ) : (
        <input
          {...props}
          list={list}
          onKeyDown={(e) => {
            if (e.key === "Enter") done();
            if (e.key === "Escape") setDraft(value);
          }}
        />
      )}
      {err && <div className="kai-err">{err}</div>}
    </>
  );
}

function NumIn({ value, onDone, min, max, step, placeholder }: { value: number | undefined; onDone: (v: number | undefined) => void; min?: number; max?: number; step?: number; placeholder?: string }) {
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  useEffect(() => setDraft(value === undefined ? "" : String(value)), [value]);
  const done = () => {
    const t = draft.trim();
    if (t === "") return value !== undefined && onDone(undefined);
    let n = Number(t);
    if (!Number.isFinite(n)) return setDraft(value === undefined ? "" : String(value));
    if (min !== undefined) n = Math.max(min, n);
    if (max !== undefined) n = Math.min(max, n);
    if (n !== value) onDone(n);
    else setDraft(String(n));
  };
  return <input className="kai-in num" inputMode="decimal" value={draft} placeholder={placeholder} step={step} onChange={(e) => setDraft(e.target.value)} onBlur={done} onKeyDown={(e) => e.key === "Enter" && done()} />;
}

function Row({ label, children, tip }: { label: string; children: ReactNode; tip?: string }) {
  return (
    <label className="kai-row" data-tip={tip}>
      <span className="kai-l">{label}</span>
      <span className="kai-v">{children}</span>
    </label>
  );
}

const exprCheck = (v: string) => {
  if (!v.trim()) return "Give a signal or an expression";
  const c = compiled(v);
  return c instanceof ExprError ? c.message : null;
};

// ---------- signals ----------

function SignalRow({ s, onChange, onRemove, listId }: { s: SignalItem; onChange: (s: SignalItem) => void; onRemove?: () => void; listId: string }) {
  return (
    <div className="kai-sig">
      <div className="kai-sig-top">
        <TextIn value={s.expr} mono list={listId} check={exprCheck} onDone={(v) => onChange({ ...s, expr: v.trim() })} placeholder="signal or expression" />
        {onRemove && (
          <button className="icon-btn" onClick={onRemove} aria-label="Remove this signal" data-tip="Remove">
            <Icon.X size={12} />
          </button>
        )}
      </div>
      <div className="kai-sig-opts">
        <TextIn value={s.label ?? ""} placeholder="label" onDone={(v) => onChange({ ...s, label: v.trim() || undefined })} />
        <TextIn value={s.unit ?? ""} placeholder="unit" onDone={(v) => onChange({ ...s, unit: v.trim() || undefined })} />
      </div>
    </div>
  );
}

function SignalList({ items, onChange, choices, listId, max = 12 }: { items: SignalItem[]; onChange: (xs: SignalItem[]) => void; choices: SignalChoice[]; listId: string; max?: number }) {
  const [adding, setAdding] = useState("");
  const add = (expr: string) => {
    const e = expr.trim();
    if (!e || exprCheck(e)) return;
    const c = choices.find((x) => x.name === e);
    onChange([...items, { expr: e, unit: c?.unit || undefined }]);
    setAdding("");
  };
  return (
    <div className="kai-sigs">
      {items.map((s, i) => (
        <SignalRow
          key={`${i}:${s.expr}`}
          s={s}
          listId={listId}
          onChange={(n) => onChange(items.map((x, j) => (j === i ? n : x)))}
          onRemove={items.length > 1 ? () => onChange(items.filter((_, j) => j !== i)) : undefined}
        />
      ))}
      {items.length < max && (
        <div className="kai-add">
          <Icon.Plus size={12} />
          <input
            className="kai-in mono"
            list={listId}
            value={adding}
            placeholder="add a signal…"
            spellCheck={false}
            onChange={(e) => {
              const v = e.target.value;
              setAdding(v);
              // picking from the list adds it straight away
              if (choices.some((c) => c.name === v)) add(v);
            }}
            onKeyDown={(e) => e.key === "Enter" && add(adding)}
          />
        </div>
      )}
    </div>
  );
}

function ChoiceList({ id, choices }: { id: string; choices: SignalChoice[] }) {
  return (
    <datalist id={id}>
      {choices.map((c) => (
        <option key={c.name} value={c.name}>
          {[c.label !== c.name ? c.label : "", c.unit, c.from === "twin" ? "twin" : c.from === "derived" ? "derived" : ""].filter(Boolean).join(" · ")}
        </option>
      ))}
    </datalist>
  );
}

// ---------- the add menu ----------

export function AddPanelMenu({ app }: { app: AppSpec }) {
  const selected = useApps((s) => s.selected);
  const choices = () => signalChoices(app, storeFor(app));
  const add = (kind: PanelKind) => {
    if (!canEditPanels(app)) return revealSpan(app.span);
    const names = choices()
      .filter((c) => c.from !== "telemetry" || !["state", "fault", "line"].includes(c.name))
      .map((c) => c.name);
    const p = newPanel(kind, names);
    const after = selected !== null && selected < app.panels.length ? selected : undefined;
    commitApp(addPanel(src(), app, p, after), `Added a ${panelKindInfo(kind).label.toLowerCase()} panel to ${app.name}`);
    selectPanel(after !== undefined ? after + 1 : app.panels.length);
  };
  return (
    <Menu
      align="right"
      width={330}
      trigger={(o, toggle) => (
        <button className={`btn sm ${o ? "active" : ""}`} onClick={toggle} aria-haspopup="menu">
          <Icon.Plus size={12} /> Panel
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="menu-label">Add a panel</div>
          {PANEL_KINDS.map((k) => (
            <MenuItem
              key={k.kind}
              icon={<PanelGlyph kind={k.kind} />}
              hint={`${k.w}×${k.h}`}
              onClick={() => {
                close();
                add(k.kind);
              }}
            >
              <span className="kai-menu-t">
                {k.label}
                <small>{k.detail}</small>
              </span>
            </MenuItem>
          ))}
        </>
      )}
    </Menu>
  );
}

function PanelGlyph({ kind }: { kind: PanelKind }) {
  const d: Record<string, string> = {
    readout: "M3 5h10M3 8h7M3 11h9",
    gauge: "M3 11a5 5 0 0 1 10 0M8 11l3-3",
    chart: "M2 12l3-4 3 2 3-5 3 3",
    scope: "M8 3v10M3 8h10M5 6c2 4 4 4 6 0",
    bars: "M4 13V8M8 13V4M12 13V9",
    lamps: "M5 8a1.5 1.5 0 1 0 0.01 0M11 8a1.5 1.5 0 1 0 0.01 0",
    state: "M3 5h10v6H3zM5 8h4",
    controls: "M3 5h10M3 11h10M6 3v4M10 9v4",
    console: "M3 4h10v8H3zM5 7l2 1.5L5 10M8 10h3",
    log: "M4 4h8M4 7h8M4 10h5",
    table: "M3 4h10v8H3zM3 8h10M8 4v8",
    model: "M8 2l5 3v6l-5 3-5-3V5zM8 8l5-3M8 8v6M8 8L3 5",
    camera: "M2 5h3l1-1.5h4L11 5h3v7H2zM8 10.5a2 2 0 1 0 0.01 0",
    note: "M4 3h6l2 2v8H4zM6 7h4M6 10h4",
    custom: "M5 5L2 8l3 3M11 5l3 3-3 3M9 3L7 13",
  };
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d[kind] ?? d.note} />
    </svg>
  );
}

// ---------- the inspector ----------

export function Inspector({ app, index }: { app: AppSpec; index: number | null }) {
  const p = index !== null ? app.panels[index] : undefined;
  return <aside className="kapp-side">{p && index !== null ? <PanelSettings key={index} app={app} index={index} p={p} /> : <AppSettings app={app} />}</aside>;
}

function PanelSettings({ app, index, p }: { app: AppSpec; index: number; p: PanelSpec }) {
  const info = panelKindInfo(p.kind);
  const store = storeFor(app);
  const choices = useMemo(() => signalChoices(app, store), [app, store, store.version > 0]);
  const listId = `kai-sigs-${index}`;
  const editable = !!p.span;
  const change = (n: PanelSpec, what = "Changed") => commitApp(replacePanel(src(), app, index, n), `${what} ${n.title || info.label} in ${app.name}`);
  const set = <K extends keyof PanelSpec>(k: K, v: PanelSpec[K]) => change({ ...p, [k]: v } as PanelSpec);

  let body: ReactNode = null;
  switch (p.kind) {
    case "readout":
    case "chart":
    case "bars":
    case "table":
      body = (
        <>
          <div className="kai-h">Signals</div>
          <SignalList items={p.signals} choices={choices} listId={listId} onChange={(signals) => change({ ...p, signals })} />
          {p.kind === "readout" && (
            <Row label="Big numbers">
              <input type="checkbox" checked={p.big} onChange={(e) => change({ ...p, big: e.target.checked })} />
            </Row>
          )}
          {p.kind === "chart" && (
            <Row label="Window, s" tip="How many seconds the chart shows (blank: the app's own)">
              <NumIn value={p.window || undefined} min={1} max={3600} placeholder={String(app.window)} onDone={(v) => change({ ...p, window: v ?? 0 })} />
            </Row>
          )}
          {(p.kind === "chart" || p.kind === "bars") && (
            <>
              <Row label="From" tip="The bottom of the scale (blank: fits the values)">
                <NumIn value={p.min} placeholder="auto" onDone={(v) => change({ ...p, min: v })} />
              </Row>
              <Row label="To">
                <NumIn value={p.max} placeholder="auto" onDone={(v) => change({ ...p, max: v })} />
              </Row>
            </>
          )}
        </>
      );
      break;
    case "camera":
      body = (
        <>
          <div className="kai-h">Values over the picture</div>
          <SignalList items={p.overlay} choices={choices} listId={listId} onChange={(overlay) => change({ ...p, overlay })} max={6} />
        </>
      );
      break;
    case "gauge":
      body = (
        <>
          <div className="kai-h">Signal</div>
          <SignalRow s={p.signal} listId={listId} onChange={(signal) => change({ ...p, signal })} />
          <Row label="From">
            <NumIn value={p.min} onDone={(v) => change({ ...p, min: v ?? 0 })} />
          </Row>
          <Row label="To">
            <NumIn value={p.max} onDone={(v) => change({ ...p, max: v ?? 100 })} />
          </Row>
        </>
      );
      break;
    case "scope":
      body = (
        <>
          <div className="kai-h">Across</div>
          <SignalRow s={p.x} listId={listId} onChange={(x) => change({ ...p, x })} />
          <div className="kai-h">Up</div>
          <SignalRow s={p.y} listId={listId} onChange={(y) => change({ ...p, y })} />
          <Row label="Range ±" tip="Half the width shown (blank: fits the trail)">
            <NumIn value={p.range} min={0} placeholder="auto" onDone={(v) => change({ ...p, range: v })} />
          </Row>
          <Row label="Trail, s">
            <NumIn value={p.trail} min={0.2} max={120} onDone={(v) => change({ ...p, trail: v ?? 4 })} />
          </Row>
        </>
      );
      break;
    case "log":
      body = (
        <Row label="Lines matching" tip="A pattern (a regular expression); blank shows every line">
          <TextIn value={p.match ?? ""} mono placeholder="FAULT|done" check={(v) => (v && !validRegex(v) ? "That pattern is not a valid regular expression" : null)} onDone={(v) => change({ ...p, match: v || undefined })} />
        </Row>
      );
      break;
    case "console":
      body = (
        <Row label="Suggested commands" tip="Shown as you type, separated by commas">
          <TextIn value={p.commands.join(", ")} mono placeholder="help, status" onDone={(v) => change({ ...p, commands: v.split(",").map((x) => x.trim()).filter(Boolean) })} />
        </Row>
      );
      break;
    case "note":
      body = (
        <>
          <div className="kai-h">Text</div>
          <TextIn area value={p.text} onDone={(v) => change({ ...p, text: v })} />
        </>
      );
      break;
    case "model":
      body = (
        <>
          <Row label="View from">
            <select className="kai-in" value={p.view} onChange={(e) => change({ ...p, view: e.target.value as typeof p.view })}>
              <option value="iso">corner</option>
              <option value="front">front</option>
              <option value="side">side</option>
              <option value="top">top</option>
            </select>
          </Row>
          <Row label="Parts" tip="Which parts to show, separated by commas (blank: all)">
            <TextIn value={p.parts.join(", ")} placeholder="all of them" onDone={(v) => change({ ...p, parts: v.split(",").map((x) => x.trim()).filter(Boolean) })} />
          </Row>
          <div className="kai-note">
            {p.moves.length
              ? `${p.moves.length} part${p.moves.length === 1 ? "" : "s"} moved by live values: edit them in the design file.`
              : "On the simulated twin the parts move where the physics puts them. To move parts on the real machine, add slide(), turn() or spin() moves in the design file, or ask Claude."}
          </div>
        </>
      );
      break;
    case "lamps":
      body = <div className="kai-note">{p.lamps.map((l) => `${l.label}: ${l.when}`).join("\n")}</div>;
      break;
    case "controls":
      body = (
        <div className="kai-note">
          {p.controls.map((c) => `${c.label}: ${c.kind === "toggle" ? `${c.on} / ${c.off}` : c.send}`).join("\n")}
          {"\n\n"}Buttons, sliders and switches are written in the design file: open it there, or ask Claude for the controls you want.
        </div>
      );
      break;
    case "custom":
      body = <div className="kai-note">Custom drawing code, reading {p.uses.length ? p.uses.join(", ") : "no signals yet"}. Edit the code in the design file, or ask Claude to draw what you want.</div>;
      break;
  }

  return (
    <div className="kai">
      <ChoiceList id={listId} choices={choices} />
      <div className="kai-top">
        <span className="kai-kind">{info.label}</span>
        <button className="icon-btn" onClick={() => selectPanel(null)} aria-label="Back to the app's settings" data-tip="The app's settings">
          <Icon.X size={12} />
        </button>
      </div>
      <div className="kai-sub">{info.detail}</div>
      {!editable && <div className="kai-note">This panel is written in a way the builder cannot edit (from a variable or a loop): change it in the design file.</div>}
      <fieldset disabled={!editable} className="kai-fields">
        <Row label="Title">
          <TextIn value={p.title} placeholder={info.label} onDone={(v) => set("title", v)} />
        </Row>
        <Row label="Size" tip="Columns × rows of the grid; drag the panel's corner to resize">
          <span className="kai-size">
            <NumIn value={p.w} min={1} max={12} onDone={(v) => set("w", v ?? info.w)} />×<NumIn value={p.h} min={1} max={12} onDone={(v) => set("h", v ?? info.h)} />
          </span>
        </Row>
        {body}
      </fieldset>
      <div className="kai-actions">
        {p.span && (
          <button className="btn sm ghost" onClick={() => revealSpan(p.span!)}>
            <Icon.Code size={12} /> In the design file
          </button>
        )}
        <button className="btn sm ghost" onClick={() => askClaude(`In the app “${app.name}”, change the ${info.label.toLowerCase()} panel “${p.title || info.label}”: `)}>
          <Icon.Sparkle size={12} /> Ask Claude
        </button>
        <button
          className="btn sm ghost danger"
          disabled={!editable}
          onClick={() => {
            commitApp(removePanel(src(), app, index), `Removed ${p.title || info.label} from ${app.name}`);
            selectPanel(null);
          }}
        >
          <Icon.Trash size={12} /> Remove
        </button>
      </div>
    </div>
  );
}

const validRegex = (s: string) => {
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
};

const BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 250000, 460800, 921600];

function AppSettings({ app }: { app: AppSpec }) {
  const model = useDesign((s) => s.model);
  const scenarios = (model?.scenarios ?? []).filter((s) => s.spec.world.kind !== "printer" && !s.spec.physicsOnly);
  const set = (props: Record<string, string | null>, what: string) => commitApp(setAppProps(src(), app, props), `${what} in ${app.name}`);
  const telemetry = app.telemetry.map((f) => (f.kind === "csv" ? `csv ${f.prefix || "(no word)"}: ${f.columns.map((c) => c.name + (c.unit ? `:${c.unit}` : "")).join(" ")}` : f.kind === "json" ? `json ${f.prefix || "lines"}` : `keys ${f.prefix || "name=value"}${f.spaced ? " (spaced)" : ""}`));
  return (
    <div className="kai">
      <div className="kai-top">
        <span className="kai-kind">App</span>
      </div>
      <div className="kai-sub">Click a panel to change it. Drag a panel by its title to move it, or by its corner to resize it.</div>
      <Row label="Name">
        <TextIn
          value={app.name}
          check={(v) => (!v.trim() ? "Give the app a name" : model?.apps?.some((a) => a !== app && a.name === v.trim()) ? "Another app has that name" : null)}
          onDone={(v) => {
            const name = v.trim();
            commitApp(renameApp(src(), app, name), `Renamed the app ${app.name} to ${name}`);
            openApp(name, { edit: true });
          }}
        />
      </Row>
      <Row label="About">
        <TextIn value={app.about ?? ""} placeholder="a line under the name" onDone={(v) => set({ about: v.trim() ? q(v.trim()) : null }, "Changed what it says about")} />
      </Row>
      <Row label="Twin" tip="The simulation scenario the twin runs the firmware in">
        <select className="kai-in" value={app.twin ?? ""} onChange={(e) => set({ twin: q(e.target.value || "none") }, "Changed the twin")}>
          {scenarios.map((s) => (
            <option key={s.label} value={s.label}>
              {s.label}
            </option>
          ))}
          <option value="">none</option>
        </select>
      </Row>
      <Row label="Baud" tip="The real machine's serial speed">
        <select className="kai-in" value={app.baud} onChange={(e) => set({ baud: e.target.value }, "Changed the baud rate")}>
          {[...new Set([...BAUDS, app.baud])].sort((a, b) => a - b).map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Columns" tip="How many panels fit across on a wide screen">
        <NumIn value={app.columns} min={1} max={12} onDone={(v) => set({ columns: v === undefined ? null : String(v) }, "Changed the columns")} />
      </Row>
      <Row label="Chart window, s">
        <NumIn value={app.window} min={1} max={3600} onDone={(v) => set({ window: v === undefined ? null : String(v) }, "Changed the chart window")} />
      </Row>
      <Row label="On connect" tip="Lines sent when the app connects, separated by commas (to start the data stream)">
        <TextIn value={app.hello.join(", ")} mono placeholder="nothing" onDone={(v) => set({ hello: v.trim() ? `[${v.split(",").map((x) => q(x.trim())).filter((x) => x !== '""').join(", ")}]` : null }, "Changed what it sends on connect")} />
      </Row>
      <div className="kai-h">How it reads the firmware's lines</div>
      <div className="kai-note mono">{telemetry.length ? telemetry.join("\n") : "name=value pairs (the default)"}</div>
      <div className="kai-actions">
        <button className="btn sm ghost" onClick={() => revealSpan(app.span)}>
          <Icon.Code size={12} /> In the design file
        </button>
        <button
          className="btn sm ghost danger"
          onClick={async () => {
            const ok = await confirmDialog({ title: `Delete the app “${app.name}”?`, body: "Its block leaves the design file. Undo brings it back.", confirm: "Delete", danger: true });
            if (!ok) return;
            closeApp();
            commitApp(removeApp(src(), app), `Deleted the app ${app.name}`);
          }}
        >
          <Icon.Trash size={12} /> Delete app
        </button>
      </div>
    </div>
  );
}
