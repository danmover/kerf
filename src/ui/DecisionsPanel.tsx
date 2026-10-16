// The decisions behind the design: what was chosen, by whom and why, and the
// alternatives. Any option can be previewed in the 3D view, switched to in one
// click, or fine-tuned; structural options go to Claude.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { evaluateOnly } from "../core/engine";
import type { DecisionOption, EvalDecision, Model } from "../core/model";
import {
  chooseOption,
  decisionParams,
  decisionStatus,
  paramUnit,
  partsAffectedBy,
  recordCurrent,
  sameValue,
  setDecisionValue,
  withValues,
  type SetMap,
  type SetValue,
} from "../core/decisions";
import { commitSource, endPreview, previewSource, realSource, useProject } from "../app/project";
import { revealSpan, useView } from "../app/view";
import { useChat, sendMessage } from "../ai/chat";
import { fmtNum } from "../lang/values";
import { useRealModel } from "./useRealModel";
import { useChatDraft } from "./chatDraft";
import { ValueField } from "./ValueField";
import { CheckStrip, VerdictBadge, verdictFor } from "./CheckStrip";
import { Icon } from "./icons";

const fmt = (v: SetValue) => (typeof v === "number" ? fmtNum(v, 3) : String(v));
const setsOf = (o: DecisionOption): SetMap => Object.fromEntries(o.sets.map((s) => [s.param, s.value]));

export function Decisions() {
  const { model, source } = useRealModel();
  const focus = useView((s) => s.decisionFocus);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focus) return;
    setOpen((o) => new Set(o).add(focus.name));
    const t = setTimeout(() => list.current?.querySelector(`[data-decision="${CSS.escape(focus.name)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 60);
    return () => clearTimeout(t);
  }, [focus]);

  if (!model) return null;
  if (!model.decisions.length)
    return (
      <div className="empty-state" style={{ margin: 12 }}>
        <div style={{ color: "var(--text-2)", marginBottom: 6 }}>No decisions recorded yet.</div>
        When Claude asks you to choose, or makes a notable choice itself, it lands here with the alternatives. You can then preview another option in 3D, switch to it, or fine-tune the values. Decisions are <span className="mono">decision</span> blocks in the design file.
      </div>
    );
  const yours = model.decisions.filter((d) => d.by === "you").length;
  return (
    <div className="decisions" ref={list}>
      <div className="dec-intro mono">
        {model.decisions.length} decision{model.decisions.length > 1 ? "s" : ""} · {yours} yours · {model.decisions.length - yours} by Claude
      </div>
      {model.decisions.map((d) => (
        <DecisionCard
          key={d.name}
          d={d}
          model={model}
          source={source}
          open={open.has(d.name)}
          onToggle={() =>
            setOpen((o) => {
              const n = new Set(o);
              if (n.has(d.name)) n.delete(d.name);
              else n.add(d.name);
              return n;
            })
          }
        />
      ))}
    </div>
  );
}

function DecisionCard({ d, model, source, open, onToggle }: { d: EvalDecision; model: Model; source: string; open: boolean; onToggle: () => void }) {
  const st = decisionStatus(d, model);
  const busy = useChat((s) => s.busy);
  const preview = useProject((s) => s.preview);
  const setDraft = useChatDraft((s) => s.set);
  const [edits, setEdits] = useState<Record<string, SetMap>>({});
  const key = `decision:${d.name}`;
  const previewingLabel = preview?.key === key ? preview.label : null;
  const affected = useMemo(() => partsAffectedBy(model, decisionParams(d)), [model, d]);
  const isClaude = d.by === "claude";

  // instant verdicts: what each option would do to the parametric requirements
  const verdicts = useMemo(() => {
    if (!open) return {};
    const out: Record<string, ReturnType<typeof verdictFor>> = {};
    for (const o of d.options) if (o.sets.length) out[o.label] = verdictFor(evaluateOnly(withValues(source, model, { ...setsOf(o), ...(edits[o.label] ?? {}) })));
    return out;
  }, [open, d, source, model, edits]);

  const hover = (on: boolean) => {
    if (useView.getState().focusCheck) return;
    useView.setState({ focusParts: on ? affected : [] });
  };

  const valuesFor = (o: DecisionOption): SetMap => ({ ...setsOf(o), ...(edits[o.label] ?? {}) });

  const switchTo = (o: DecisionOption, values = edits[o.label]) => {
    const real = realSource();
    const m = evaluateOnly(real);
    const next = chooseOption(real, m, d.name, o.label, { values });
    const tweaks = Object.entries(values ?? {}).filter(([k, v]) => !sameValue(v, setsOf(o)[k]));
    commitSource(next, "you", `${o.label === d.chose ? "Restored" : "Switched"} “${d.title}” to “${o.label}”${tweaks.length ? ` (${tweaks.map(([k, v]) => `${k} ${fmt(v)}`).join(", ")})` : ""}`);
    setEdits((e) => ({ ...e, [o.label]: {} }));
  };

  const showOption = (o: DecisionOption, vals: SetMap) => {
    const real = realSource();
    previewSource({ key, label: `${d.title}: ${o.label}`, apply: () => switchTo(o, vals) }, withValues(real, evaluateOnly(real), vals));
  };

  const togglePreview = (o: DecisionOption) => {
    if (previewingLabel === `${d.title}: ${o.label}`) endPreview(key);
    else showOption(o, valuesFor(o));
  };

  const editOption = (o: DecisionOption, param: string, v: SetValue, commit: boolean) => {
    const next = { ...(edits[o.label] ?? {}), [param]: v };
    if (commit) setEdits((e) => ({ ...e, [o.label]: next }));
    showOption(o, { ...setsOf(o), ...next });
  };

  // the chosen option's values move the parameters and the record together
  const tune = (param: string, v: SetValue, commit: boolean) => {
    const real = realSource();
    const m = evaluateOnly(real);
    const next = setDecisionValue(real, m, d.name, param, v);
    if (commit) commitSource(next, "you", `Set ${param} to ${fmt(v)}${paramUnit(m, param) === "mm" ? " mm" : ""} (${d.title})`);
    else previewSource({ key: `tune:${d.name}`, label: `${d.title}: ${param}`, quiet: true }, next);
  };

  return (
    <motion.div className={`decision ${open ? "open" : ""}`} data-decision={d.name} layout="position" onMouseEnter={() => hover(true)} onMouseLeave={() => hover(false)}>
      <button type="button" className="dec-head" onClick={onToggle} aria-expanded={open}>
        <span className={`dec-by ${isClaude ? "claude" : d.by === "you" ? "you" : ""}`}>{isClaude ? "AI" : d.by === "you" ? "YOU" : "·"}</span>
        <span className="dec-main">
          <span className="dec-title">{d.title}</span>
          <span className="dec-chose">{st.chosen ? st.chosen.label : d.chose ?? "Not decided yet"}</span>
          {st.chosen && st.chosen.sets.length > 0 && (
            <span className="dec-vals mono">
              {st.chosen.sets.map((s) => {
                const cur = model.params.find((p) => p.name === s.param)?.value;
                return (
                  <span key={s.param} className={cur !== undefined && !sameValue(cur, s.value) ? "drift" : ""}>
                    {s.param} {fmt(cur ?? s.value)}
                  </span>
                );
              })}
            </span>
          )}
        </span>
        {st.drift.length > 0 ? <span className="chip warn">adjusted</span> : !d.chose ? <span className="chip">open</span> : null}
        <Icon.ChevronDown size={12} className="dec-caret" />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="dec-body" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
            {d.ask && <div className="dec-ask">{d.ask}</div>}
            {d.why && (
              <div className="dec-why">
                <span className="mono dim">why</span> {d.why}
              </div>
            )}
            {st.drift.length > 0 && (
              <div className="dec-drift">
                <div>
                  Changed since this was decided:{" "}
                  {st.drift.map((x, i) => (
                    <span key={x.param} className="mono">
                      {i > 0 && ", "}
                      {x.param} {fmt(x.recorded)} → {fmt(x.current)}
                    </span>
                  ))}
                </div>
                <div className="row" style={{ gap: 6, marginTop: 6 }}>
                  <button className="btn sm" onClick={() => commitSource(recordCurrent(realSource(), evaluateOnly(realSource()), d.name), "you", `Kept the new values in “${d.title}”`)}>
                    Keep new values
                  </button>
                  <button className="btn sm ghost" onClick={() => st.chosen && switchTo(st.chosen, {})}>
                    <Icon.Undo size={12} /> Restore decided values
                  </button>
                </div>
              </div>
            )}

            <div className="dec-options">
              {d.options.map((o) => {
                const chosen = o.label === d.chose;
                const showing = previewingLabel === `${d.title}: ${o.label}`;
                const vals = valuesFor(o);
                const v = verdicts[o.label];
                return (
                  <div key={o.label} className={`dec-opt ${chosen ? "chosen" : ""} ${showing ? "showing" : ""}`}>
                    <div className="dec-opt-head">
                      <span className="co-radio" aria-hidden="true" />
                      <span className="grow">{o.label}</span>
                      {!chosen && v && <VerdictBadge v={v} compact />}
                    </div>
                    {o.note && <div className="dec-note">{o.note}</div>}
                    {o.sets.length > 0 && chosen && (
                      <div className="cc-fields">
                        {o.sets.map((s) => {
                          const cur = model.params.find((p) => p.name === s.param);
                          return <ValueField key={s.param} name={s.param} value={cur?.value ?? s.value} unit={paramUnit(model, s.param)} disabled={!cur || cur.locked || busy} onLive={(nv) => tune(s.param, nv, false)} onCommit={(nv) => tune(s.param, nv, true)} />;
                        })}
                      </div>
                    )}
                    {o.sets.length > 0 && !chosen && (
                      <div className="cc-fields">
                        {o.sets.map((s) =>
                          showing ? (
                            <ValueField key={s.param} name={s.param} value={vals[s.param]} unit={paramUnit(model, s.param)} accent={!sameValue(vals[s.param], s.value)} onLive={(nv) => editOption(o, s.param, nv, false)} onCommit={(nv) => editOption(o, s.param, nv, true)} />
                          ) : (
                            <span key={s.param} className="cc-val">
                              <span className="k">{s.param}</span> {fmt(vals[s.param])}
                              {paramUnit(model, s.param)}
                            </span>
                          ),
                        )}
                      </div>
                    )}
                    {showing && (
                      <div className="cc-live">
                        <span className="live-dot" /> <CheckStrip />
                      </div>
                    )}
                    {!chosen && (
                      <div className="row dec-actions">
                        {o.sets.length > 0 ? (
                          <>
                            <button className={`btn sm ${showing ? "" : "ghost"}`} disabled={busy} onClick={() => togglePreview(o)}>
                              <Icon.Eye size={12} /> {showing ? "Stop" : "Preview"}
                            </button>
                            <button className={`btn sm ${showing ? "primary" : ""}`} disabled={busy} onClick={() => switchTo(o)}>
                              Switch to this
                            </button>
                          </>
                        ) : (
                          <button className="btn sm" disabled={busy} onClick={() => void sendMessage(`Switch the decision “${d.title}” to “${o.label}”.`, { design: true })} data-tip="This needs a design change, so Claude makes it">
                            <Icon.Sparkle size={12} /> Ask Claude to switch
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="row dec-foot">
              <button className="btn sm ghost" onClick={() => setDraft(`About the decision “${d.title}”: `)}>
                <Icon.Chat size={12} /> Discuss
              </button>
              <button
                className="btn sm ghost"
                onClick={() => {
                  useView.setState({ dockOpen: true, dockTab: "code" });
                  requestAnimationFrame(() => revealSpan(d.span));
                }}
              >
                <Icon.Code size={12} /> Code
              </button>
              {affected.length > 0 && <span className="dim mono" style={{ fontSize: 10.5, marginLeft: "auto" }}>shapes {new Set(model.parts.filter((p) => affected.includes(p.id)).map((p) => p.name)).size} parts</span>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
