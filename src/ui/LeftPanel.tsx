// Left panel: model structure, parameters, design decisions and version history.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDesign, setSource } from "../core/engine";
import { useView, revealSpan, select, type LeftTab } from "../app/view";
import { useProject, commitSource, restoreVersion, undo, redo } from "../app/project";
import { setParamValue, toggleParamLock, lineDiff } from "../core/sourceEdit";
import type { EvalParam, EvalPart } from "../core/model";
import { Icon } from "./icons";
import { Decisions } from "./DecisionsPanel";
import { Segmented, timeAgo, useTick, mod } from "./common";
import { fmtNum } from "../lang/values";
import type { VersionRecord } from "../persist/db";

export function LeftPanel() {
  const tab = useView((s) => s.leftTab);
  const model = useDesign((s) => s.model);
  return (
    <div className="panel panel-left">
      <div className="panel-head" style={{ justifyContent: "center" }}>
        <Segmented<LeftTab>
          id="left-tab"
          value={tab}
          onChange={(t) => useView.setState({ leftTab: t })}
          options={[
            { value: "structure", label: "tree", title: "Model structure" },
            { value: "params", label: <>params{model ? <sup>{model.params.length}</sup> : null}</>, title: "Parameters" },
            { value: "decisions", label: <>decisions{model?.decisions.length ? <sup>{model.decisions.length}</sup> : null}</>, title: "Design decisions" },
            { value: "history", label: "history", title: "Version history" },
          ]}
        />
      </div>
      <div className="panel-body">
        {tab === "structure" && <Structure />}
        {tab === "params" && <Params />}
        {tab === "decisions" && <Decisions />}
        {tab === "history" && <History />}
      </div>
    </div>
  );
}

// ---------- structure ----------

interface Row {
  name: string;
  label: string;
  ids: string[];
  part: EvalPart;
  count: number;
}

function iconFor(p: EvalPart) {
  if (p.kind === "part") return <Icon.Box size={13} />;
  switch (p.libKind) {
    case "spur_gear":
      return <Icon.Gear size={13} />;
    case "screw":
    case "nut":
    case "insert":
    case "dowel":
      return <Icon.Screw size={13} />;
    case "pcb":
    case "usb_c":
    case "connector":
      return <Icon.Chip size={13} />;
    default:
      return <Icon.Cube size={13} />;
  }
}

function Structure() {
  const model = useDesign((s) => s.model);
  const report = useDesign((s) => s.report);
  const selected = useView((s) => s.selected);
  const hiddenIds = useView((s) => s.hiddenIds);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const groups = useMemo(() => {
    const g = new Map<string, Row[]>();
    if (!model) return g;
    const byName = new Map<string, Row>();
    for (const p of model.parts) {
      let r = byName.get(p.name);
      if (!r) {
        r = { name: p.name, label: p.kind === "component" ? p.name : p.name, ids: [], part: p, count: 0 };
        byName.set(p.name, r);
        const list = g.get(p.group || "Parts") ?? [];
        list.push(r);
        g.set(p.group || "Parts", list);
      }
      r.ids.push(p.id);
      if (!p.id.includes(".")) r.count++;
    }
    return g;
  }, [model]);
  const failing = useMemo(() => new Set((report?.items ?? []).filter((i) => i.status === "fail").flatMap((i) => i.parts ?? [])), [report]);

  if (!model) return null;
  if (!model.parts.length)
    return (
      <div className="empty-state" style={{ margin: 12 }}>
        No parts yet. Ask Claude to design something, or add a <span className="mono">part</span> in the code editor.
      </div>
    );

  return (
    <div className="tree">
      <div style={{ padding: "6px 10px 10px" }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{model.name}</div>
        {model.notes.map((n, i) => (
          <div key={i} className="dim" style={{ fontSize: 12, marginTop: 4 }}>
            {n}
          </div>
        ))}
      </div>
      {[...groups.entries()].map(([group, rows]) => {
        const isCollapsed = collapsed.has(group);
        return (
          <div className="tree-group" key={group}>
            <div
              className="tree-group-head"
              onClick={() => {
                const n = new Set(collapsed);
                if (isCollapsed) n.delete(group);
                else n.add(group);
                setCollapsed(n);
              }}
            >
              <span style={{ transform: isCollapsed ? "rotate(0)" : "rotate(90deg)", display: "inline-grid", transition: "transform .15s" }}>
                <Icon.Chevron size={11} />
              </span>
              {group}
              <span style={{ marginLeft: "auto" }}>{rows.length}</span>
            </div>
            <AnimatePresence initial={false}>
              {!isCollapsed && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} style={{ overflow: "hidden" }}>
                  {rows.map((r, idx) => {
                    const isSel = r.ids.some((id) => selected.includes(id));
                    const hidden = r.ids.every((id) => hiddenIds.includes(id)) || r.part.hidden;
                    const bad = r.ids.some((id) => failing.has(id));
                    return (
                      <motion.div
                        key={r.name}
                        className={`tree-row ${isSel ? "selected" : ""} ${hidden ? "hidden-part" : ""}`}
                        initial={{ opacity: 0, x: -6 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: Math.min(idx * 0.02, 0.3) }}
                        onClick={(e) => {
                          if (e.shiftKey || e.metaKey || e.ctrlKey) select(isSel ? selected.filter((x) => !r.ids.includes(x)) : [...selected, ...r.ids]);
                          else select(r.ids);
                        }}
                        onDoubleClick={() => revealSpan(r.part.span)}
                        onMouseEnter={() => useView.setState({ hovered: r.ids[0] })}
                        onMouseLeave={() => useView.setState({ hovered: null })}
                      >
                        <span className="swatch" style={{ background: r.part.color }} />
                        <span style={{ color: "var(--text-3)", display: "inline-grid" }}>{iconFor(r.part)}</span>
                        <span className="name">{r.label}</span>
                        {bad && <span className="dot fail" data-tip="Has a failing check" />}
                        {r.part.motion && Math.abs(r.part.motion.ratio) > 0 && (
                          <span className="meta" data-tip={`Turns at ${fmtNum(Math.abs(r.part.motion.ratio), 3)}× the input`}>
                            ↻
                          </span>
                        )}
                        {r.part.locked && (
                          <span style={{ color: "var(--text-4)", display: "inline-grid" }} data-tip="Locked: Claude will keep it unchanged">
                            <Icon.Lock size={11} />
                          </span>
                        )}
                        <span className="meta">{r.part.kind === "component" ? (r.count > 1 ? `×${r.count}` : r.part.libKind) : r.count > 1 ? `×${r.count}` : ""}</span>
                        <span className="row-actions">
                          <button
                            className="icon-btn sm"
                            aria-label={hidden ? "Show" : "Hide"}
                            onClick={(e) => {
                              e.stopPropagation();
                              useView.setState((s) => ({ hiddenIds: hidden ? s.hiddenIds.filter((x) => !r.ids.includes(x)) : [...new Set([...s.hiddenIds, ...r.ids])] }));
                            }}
                          >
                            {hidden ? <Icon.EyeOff size={13} /> : <Icon.Eye size={13} />}
                          </button>
                          <button
                            className="icon-btn sm"
                            aria-label="Show in code"
                            onClick={(e) => {
                              e.stopPropagation();
                              revealSpan(r.part.span);
                            }}
                          >
                            <Icon.Code size={13} />
                          </button>
                        </span>
                      </motion.div>
                    );
                  })}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
      {hiddenIds.length > 0 && (
        <button className="btn sm ghost" style={{ margin: "6px 8px" }} onClick={() => useView.setState({ hiddenIds: [] })}>
          <Icon.Eye size={13} /> Show {hiddenIds.length} hidden
        </button>
      )}
    </div>
  );
}

// ---------- parameters ----------

function Params() {
  const model = useDesign((s) => s.model);
  if (!model) return null;
  if (!model.params.length)
    return (
      <div className="empty-state" style={{ margin: 12 }}>
        No parameters. Driving dimensions written as <span className="mono">param width = 80mm</span> appear here with sliders.
      </div>
    );
  return (
    <div>
      {model.params.map((p) => (
        <ParamRow key={p.name} p={p} />
      ))}
    </div>
  );
}

function autoRange(p: EvalParam): [number, number] {
  const v = p.value as number;
  if (p.min !== undefined && p.max !== undefined) return [p.min, p.max];
  if (v === 0) return [p.min ?? -50, p.max ?? 50];
  const lo = p.min ?? (v > 0 ? v * 0.25 : v * 4);
  const hi = p.max ?? (v > 0 ? v * 2.5 : v * 0.25);
  return [Math.min(lo, hi), Math.max(lo, hi)];
}

function ParamRow({ p }: { p: EvalParam }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const prevValue = useRef(p.value);
  const dragBase = useRef<string | null>(null);
  useEffect(() => {
    if (prevValue.current !== p.value) {
      prevValue.current = p.value;
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 1200);
      return () => clearTimeout(t);
    }
  }, [p.value]);

  const commit = (value: number | string | boolean) => {
    const { source, model } = useDesign.getState();
    const cur = model?.params.find((q) => q.name === p.name);
    if (!cur || cur.value === value) return;
    const unit = typeof value === "number" && /mm$/.test(cur.text) ? " mm" : "";
    commitSource(setParamValue(source, cur, value), "you", `Set ${p.name} to ${typeof value === "number" ? fmtNum(value) : String(value)}${unit}`);
  };

  const isNum = typeof p.value === "number";
  const [lo, hi] = isNum ? autoRange(p) : [0, 1];
  const v = isNum ? (p.value as number) : 0;
  const step = Math.abs(hi - lo) > 50 ? 1 : Math.abs(hi - lo) > 5 ? 0.1 : 0.01;
  const pct = isNum ? ((v - lo) / (hi - lo || 1)) * 100 : 0;
  const literal = /^-?\d+(\.\d+)?\s*[a-zA-Z%]*$|^".*"$|^(true|false)$/.test(p.text.trim());

  return (
    <div className={`param ${flash ? "changed" : ""}`}>
      <div className="param-head">
        <button className="param-name" style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }} onClick={() => revealSpan(p.span)} data-tip="Show in code">
          {p.name}
        </button>
        <button
          className="icon-btn sm"
          style={{ color: p.locked ? "var(--warn)" : "var(--text-4)" }}
          onClick={() => {
            const { source, model } = useDesign.getState();
            const cur = model?.params.find((q) => q.name === p.name);
            if (cur) commitSource(toggleParamLock(source, cur), "you", `${cur.locked ? "Unlocked" : "Locked"} ${p.name}`);
          }}
          aria-label={p.locked ? "Unlock" : "Lock"}
          data-tip={p.locked ? "Locked: Claude keeps this value. Click to unlock." : "Lock this value so Claude keeps it"}
        >
          {p.locked ? <Icon.Lock size={12} /> : <Icon.Unlock size={12} />}
        </button>
        <div className="grow" />
        {typeof p.value === "boolean" ? (
          <button className={`toggle ${p.value ? "on" : ""}`} disabled={p.locked} onClick={() => commit(!p.value)} aria-label={p.name} />
        ) : (
          <input
            className="param-value"
            value={draft ?? (isNum ? fmtNum(v, 3) : String(p.value))}
            disabled={p.locked}
            aria-label={`${p.name} value`}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={() => {
              if (draft !== null) {
                if (isNum) {
                  const n = Number(draft.replace(/[a-z ]+$/i, ""));
                  if (Number.isFinite(n)) commit(n);
                } else commit(draft.replace(/^"|"$/g, ""));
              }
              setDraft(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                setDraft(null);
                (e.target as HTMLInputElement).blur();
              }
              if (isNum && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                e.preventDefault();
                const d = (e.shiftKey ? 10 : 1) * (step >= 1 ? 1 : step * 10) * (e.key === "ArrowUp" ? 1 : -1);
                commit(Math.round((v + d) * 1000) / 1000);
              }
            }}
          />
        )}
      </div>
      {p.desc && <div className="param-desc">{p.desc}</div>}
      {!literal && <div className="param-desc" style={{ color: "var(--text-4)" }}>= {p.text} (editing replaces the expression)</div>}
      {isNum && !p.locked && (
        <input
          className="slider"
          type="range"
          min={lo}
          max={hi}
          step={step}
          value={Math.min(hi, Math.max(lo, v))}
          style={{ ["--p" as string]: `${Math.min(100, Math.max(0, pct))}%` }}
          aria-label={`${p.name} slider`}
          onPointerDown={() => (dragBase.current = useDesign.getState().source)}
          onChange={(e) => {
            // live preview while dragging; the version is recorded on release
            const { source, model } = useDesign.getState();
            const cur = model?.params.find((q) => q.name === p.name);
            if (!cur) return;
            const next = setParamValue(source, cur, Number(e.target.value));
            if (dragBase.current === null) commitSource(next, "you", `Set ${p.name} to ${fmtNum(Number(e.target.value))}`);
            else setSource(next);
          }}
          onPointerUp={() => {
            const base = dragBase.current;
            dragBase.current = null;
            const { source } = useDesign.getState();
            if (base !== null && base !== source) {
              // restore the base so the commit records one undo step from it
              setSource(base);
              commitSource(source, "you", `Set ${p.name} to ${fmtNum(useDesign.getState().model?.params.find((q) => q.name === p.name)?.value as number)}`);
            }
          }}
        />
      )}
      {p.usedBy.length > 0 && (
        <div className="used-by">
          {p.usedBy.slice(0, 8).map((u) => (
            <span key={u} className="chip" style={{ fontSize: 10 }}>
              {u.replace(/^require:/, "✓ ")}
            </span>
          ))}
          {p.usedBy.length > 8 && <span className="chip">+{p.usedBy.length - 8}</span>}
        </div>
      )}
    </div>
  );
}

// ---------- history ----------

function History() {
  useTick();
  const versions = useProject((s) => s.versions);
  const undoN = useProject((s) => s.undo.length);
  const redoN = useProject((s) => s.redo.length);
  const source = useDesign((s) => s.source);
  const [open, setOpen] = useState<string | null>(null);
  const list = [...versions].reverse();
  const currentId = list.find((v) => v.source === source)?.id;
  return (
    <div>
      <div className="row" style={{ padding: "10px 12px", borderBottom: "1px solid var(--line)" }}>
        <button className="btn sm" disabled={!undoN} onClick={undo} data-tip={`Undo (${mod}Z)`}>
          <Icon.Undo size={13} /> Undo
        </button>
        <button className="btn sm" disabled={!redoN} onClick={redo} data-tip={`Redo (${mod}⇧Z)`}>
          <Icon.Redo size={13} /> Redo
        </button>
        <div className="grow" />
        <span className="mono dim" style={{ fontSize: 10.5 }}>
          {versions.length} versions
        </span>
      </div>
      <div style={{ padding: "6px 0" }}>
        {list.map((v, i) => (
          <VersionRow key={v.id} v={v} prev={list[i + 1]} current={v.id === currentId} open={open === v.id} onToggle={() => setOpen(open === v.id ? null : v.id)} />
        ))}
      </div>
    </div>
  );
}

function VersionRow({ v, prev, current, open, onToggle }: { v: VersionRecord; prev?: VersionRecord; current: boolean; open: boolean; onToggle: () => void }) {
  const diff = useMemo(() => (open ? lineDiff(prev?.source ?? "", v.source, 1) : []), [open, prev, v]);
  return (
    <div className={`history-item ${current ? "current" : ""}`}>
      <div className={`history-node ${v.author}`}>{v.author === "claude" ? "AI" : v.author === "you" ? "YOU".slice(0, 2) : "·"}</div>
      <div style={{ minWidth: 0 }}>
        <div className="msg">{v.message}</div>
        <div className="when">
          {v.author === "claude" ? "Claude" : v.author === "you" ? "You" : "Kerf"} · {timeAgo(v.ts)}
          {current && <span style={{ color: "var(--accent-2)" }}> · current</span>}
        </div>
        <div className="actions">
          <button className="btn sm ghost" onClick={onToggle}>
            {open ? "Hide changes" : "Changes"}
          </button>
          {!current && (
            <button className="btn sm ghost" onClick={() => restoreVersion(v)}>
              <Icon.History size={12} /> Restore
            </button>
          )}
        </div>
        {open && (
          <div className="diff" style={{ borderRadius: 6, border: "1px solid var(--line-2)", marginTop: 6 }}>
            {diff.length ? (
              diff.map((l, i) => (
                <div key={i} className={`ln ${l.kind}`}>
                  <span className="n">{l.b ?? l.a ?? ""}</span>
                  <span>{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
                  <span>{l.text}</span>
                </div>
              ))
            ) : (
              <div className="dim" style={{ padding: 8 }}>
                No source changes.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
