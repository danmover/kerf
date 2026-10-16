// How each part is made: a process picker per part with its check counts,
// a side-by-side comparison of every process for one part, the switch that
// draws process issues on the model, and the fix row for process checks.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDesign } from "../core/engine";
import { commitSource } from "../app/project";
import { useView } from "../app/view";
import type { CheckAction, CheckItem } from "../core/checks";
import type { EvalPart } from "../core/model";
import { PROCESSES, PROCESS_IDS } from "../mfg/profiles";
import { madeParts, summarize } from "../mfg/report";
import { setPartProcess, withSetting } from "../mfg/edit";
import { compareProcesses, type ProcessOption } from "../mfg/compare";
import type { ProcessId } from "../mfg/types";
import { StatusIcon, Icon } from "./icons";
import { Toggle } from "./common";
import { useChatDraft } from "./chatDraft";
import { useMfgView } from "./mfgView";
import "../styles/mfg.css";

const ROWS = 6;

function setProcess(part: EvalPart, id: ProcessId | null) {
  const { source } = useDesign.getState();
  const spec = id ? (part.process?.id === id ? part.process : { id, settings: {} }) : null;
  const next = setPartProcess(source, part, spec);
  if (next !== source) commitSource(next, "you", id ? `${part.label} made by ${PROCESSES[id].label}` : `${part.label}: no process`);
}

export function ManufacturingCard() {
  const model = useDesign((s) => s.model);
  const results = useDesign((s) => s.process);
  const overlay = useMfgView((s) => s.overlay);
  const [all, setAll] = useState(false);
  const [comparing, setComparing] = useState<string | null>(null);
  const parts = useMemo(() => {
    const seen = new Set<string>();
    return (model ? madeParts(model) : []).filter((p) => !p.hidden && !seen.has(p.name) && seen.add(p.name));
  }, [model]);
  if (!parts.length) return null;
  const shown = all ? parts : parts.slice(0, ROWS);
  const anyProcess = parts.some((p) => p.process);

  return (
    <div className="mfg-card">
      <div className="mfg-head">
        <span className="field-label" style={{ margin: 0 }}>
          How it's made
        </span>
        <div className="grow" />
        {anyProcess && (
          <label className="mfg-switch">
            <span>Show issues on model</span>
            <Toggle on={overlay} onChange={(v) => useMfgView.setState({ overlay: v })} label="Show manufacturing issues on the model" />
          </label>
        )}
      </div>
      {shown.map((p) => (
        <PartRow key={p.id} part={p} summary={summarize(results[p.id])} error={results[p.id]?.error} comparing={comparing === p.id} onCompare={() => setComparing(comparing === p.id ? null : p.id)} />
      ))}
      {parts.length > ROWS && (
        <button className="btn sm ghost mfg-more" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${parts.length} parts`}
        </button>
      )}
    </div>
  );
}

function PartRow({ part, summary, error, comparing, onCompare }: { part: EvalPart; summary: ReturnType<typeof summarize>; error?: string; comparing: boolean; onCompare: () => void }) {
  const status = !part.process ? null : error ? "warn" : !summary ? "pending" : summary.fail ? "fail" : summary.warn ? "warn" : "pass";
  return (
    <div className="mfg-part">
      <div className="mfg-row">
        <span className="mfg-name" title={part.name}>
          {part.label}
        </span>
        <select className="select mfg-select" value={part.process?.id ?? ""} onChange={(e) => setProcess(part, (e.target.value || null) as ProcessId | null)} aria-label={`How ${part.label} is made`}>
          <option value="">Not chosen</option>
          {PROCESS_IDS.map((id) => (
            <option key={id} value={id}>
              {PROCESSES[id].label}
            </option>
          ))}
        </select>
        <span className="mfg-counts" title={summary?.issues.join("\n") || error || undefined}>
          {status && <StatusIcon status={status} />}
          {summary && (summary.fail || summary.warn) ? (
            <span className="mono">
              {summary.fail ? <span style={{ color: "var(--fail)" }}>{summary.fail} fail</span> : null}
              {summary.fail && summary.warn ? " · " : null}
              {summary.warn ? <span style={{ color: "var(--warn)" }}>{summary.warn} warn</span> : null}
            </span>
          ) : null}
        </span>
        <button className={`btn sm ghost ${comparing ? "active" : ""}`} onClick={onCompare} aria-expanded={comparing}>
          Compare
        </button>
      </div>
      <AnimatePresence initial={false}>{comparing && <Comparison part={part} />}</AnimatePresence>
    </div>
  );
}

function Comparison({ part }: { part: EvalPart }) {
  const [state, setState] = useState<{ options: ProcessOption[] | null; error: string }>({ options: null, error: "" });
  const latest = useRef(part);
  latest.current = part;
  // rerun when the geometry, material or process changes
  const key = `${part.hash}|${part.material}|${part.process?.id ?? ""}`;
  useEffect(() => {
    let live = true;
    setState({ options: null, error: "" });
    compareProcesses(latest.current).then(
      (options) => live && setState({ options, error: "" }),
      (e) => live && setState({ options: null, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [key]);
  return (
    <motion.div className="mfg-compare" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
      <div className="mfg-compare-title">Which process suits {part.label} as it is shaped now</div>
      {state.error && <div className="detail">{state.error}</div>}
      {!state.options && !state.error && (
        <div className="row dim" style={{ gap: 8, fontSize: 12 }}>
          <span className="spinner" style={{ width: 12, height: 12 }} /> Checking against {PROCESS_IDS.length} processes…
        </div>
      )}
      {state.options?.map((o, i) => {
        const s = o.summary;
        const st = !s ? "info" : s.fail ? "fail" : s.warn ? "warn" : "pass";
        const current = part.process?.id === o.id;
        return (
          <motion.div key={o.id} className={`mfg-option ${current ? "current" : ""}`} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.025 }}>
            <StatusIcon status={st} />
            <div style={{ minWidth: 0 }}>
              <div className="title">
                {PROCESSES[o.id].label}
                <span className="mono dim"> {s ? `${s.fail} fail · ${s.warn} warn` : "could not check"}</span>
              </div>
              <div className="detail">{s?.issues.slice(0, 2).join(" · ") || (s ? "Every rule passes" : o.result.error)}</div>
            </div>
            {current ? (
              <span className="chip">current</span>
            ) : (
              <button className="btn sm" onClick={() => setProcess(part, o.id)}>
                Use
              </button>
            )}
          </motion.div>
        );
      })}
    </motion.div>
  );
}

function applyAction(a: CheckAction) {
  const { source, model } = useDesign.getState();
  const part = model?.parts.find((p) => p.id === a.part);
  if (!part?.process) return;
  const next = setPartProcess(source, part, withSetting(part.process, a.setting, a.value));
  if (next !== source) {
    commitSource(next, "you", `${part.label}: ${a.label.charAt(0).toLowerCase()}${a.label.slice(1)}`);
    useView.setState({ focusCheck: null, focusParts: [] });
  }
}

/** Fix line under a process check: the suggestion, and once focused a one-click option and a hand-off to Claude. */
export function CheckFix({ item, expanded }: { item: CheckItem; expanded: boolean }) {
  const setDraft = useChatDraft((s) => s.set);
  const part = useDesign((s) => s.model?.parts.find((p) => p.id === item.parts?.[0]));
  if (!item.fix && !item.action) return null;
  const how = part?.process ? PROCESSES[part.process.id].label : "its process";
  return (
    <div className="mfg-fix" onClick={(e) => expanded && e.stopPropagation()}>
      {item.fix && (
        <div>
          <span className="mfg-fix-label">Fix</span> {item.fix}
        </div>
      )}
      {expanded && (
        <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: "wrap" }}>
          {item.action && (
            <button className="btn sm primary" onClick={() => applyAction(item.action!)}>
              {item.action.label}
            </button>
          )}
          <button className="btn sm ghost" onClick={() => setDraft(`Fix "${item.title}" for ${how}. ${item.detail}${item.fix ? ` Suggested fix: ${item.fix}` : ""}`)}>
            <Icon.Sparkle size={13} /> Ask Claude to fix it
          </button>
        </div>
      )}
    </div>
  );
}
