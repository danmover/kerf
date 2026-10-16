// A decision Claude puts to the user. Each option can be shown in the 3D
// view with its checks, its values fine-tuned, and a note added for Claude
// before choosing. The answer is recorded as a decision in the design.

import { motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { useChat, choose, type ChatItem } from "../ai/chat";
import type { AskOption } from "../ai/tools";
import { evaluateOnly } from "../core/engine";
import { paramUnit, sameValue, withValues, type SetMap, type SetValue } from "../core/decisions";
import { endPreview, previewSource, realSource, useProject } from "../app/project";
import { showDecision } from "../app/view";
import { fmtNum } from "../lang/values";
import { useRealModel } from "./useRealModel";
import { ValueField } from "./ValueField";
import { CheckStrip, VerdictBadge, verdictFor } from "./CheckStrip";
import { Icon } from "./icons";

type ChoiceItem = Extract<ChatItem, { kind: "choice" }>;

const hasValues = (o: AskOption) => !!o.set && Object.keys(o.set).length > 0;
const fmt = (v: SetValue) => (typeof v === "number" ? fmtNum(v, 3) : String(v));

export function ChoiceCard({ it }: { it: ChoiceItem }) {
  const pending = useChat((s) => s.pendingChoice);
  const busy = useChat((s) => s.busy);
  const live = pending?.itemId === it.id && !busy;
  const answered = it.chosen !== undefined;
  const key = `choice:${it.id}`;
  const previewing = useProject((s) => s.preview?.key === key);
  const { model: base, source: baseSrc } = useRealModel();
  const [sel, setSel] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, SetMap>>({});
  const [note, setNote] = useState("");
  const noteRef = useRef("");
  noteRef.current = note;
  const editsRef = useRef(edits);
  editsRef.current = edits;

  // the preview belongs to this card: end it when the card is answered or goes away
  useEffect(() => {
    if (!live) endPreview(key);
  }, [live, key]);
  useEffect(() => () => endPreview(key), [key]);

  const valuesFor = (o: AskOption, extra?: SetMap): SetMap => ({ ...(o.set ?? {}), ...(editsRef.current[o.label] ?? {}), ...(extra ?? {}) });

  // what each option does to the parametric requirements, before it is built
  const verdicts = useMemo(() => {
    if (!live || !base) return {};
    const out: Record<string, ReturnType<typeof verdictFor>> = {};
    for (const o of it.options) if (hasValues(o)) out[o.label] = verdictFor(evaluateOnly(withValues(baseSrc, base, valuesFor(o))));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, base, baseSrc, edits, it.options]);

  const submit = (o: AskOption) => void choose(it.id, o.label, { values: edits[o.label], note });

  const show = (o: AskOption, vals: SetMap) => {
    if (!base || !hasValues(o)) return endPreview(key);
    const src = withValues(realSource(), base, vals);
    previewSource({ key, label: o.label, apply: () => void choose(it.id, o.label, { values: editsRef.current[o.label], note: noteRef.current }) }, src);
  };

  const pick = (o: AskOption) => {
    if (!live) return;
    if (sel === o.label) {
      setSel(null);
      endPreview(key);
      return;
    }
    setSel(o.label);
    show(o, valuesFor(o));
  };

  const setValue = (o: AskOption, param: string, v: SetValue, commit: boolean) => {
    const next = { ...(editsRef.current[o.label] ?? {}), [param]: v };
    if (commit) {
      editsRef.current = { ...editsRef.current, [o.label]: next };
      setEdits(editsRef.current);
    }
    show(o, { ...(o.set ?? {}), ...next });
  };

  const reset = (o: AskOption) => {
    editsRef.current = { ...editsRef.current, [o.label]: {} };
    setEdits(editsRef.current);
    show(o, o.set ?? {});
  };

  return (
    <motion.div className={`choice-card ${answered ? "answered" : ""}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
      <div className="row cc-head">
        <Icon.Fork size={13} />
        <span className="mono">YOUR DECISION</span>
        {it.title && <span className="cc-title">{it.title}</span>}
      </div>
      <div className="q">{it.question}</div>
      {it.options.map((o) => {
        const isSel = live && sel === o.label;
        const chosen = it.chosen === o.label;
        const vals = chosen && it.values ? it.values : valuesFor(o);
        const edited = Object.entries(edits[o.label] ?? {}).some(([k, v]) => !sameValue(v, o.set?.[k]));
        const v = verdicts[o.label];
        return (
          <div key={o.label} className={`choice-opt ${isSel ? "selected" : ""} ${chosen ? "chosen" : ""} ${answered && !chosen ? "dimmed" : ""}`}>
            <button type="button" className="co-head" disabled={!live} onClick={() => pick(o)} aria-expanded={isSel}>
              <div className="l">
                <span className="co-radio" aria-hidden="true" />
                <span className="grow">{o.label}</span>
                {o.recommended && <span className="chip accent">recommended</span>}
                {v && !isSel && <VerdictBadge v={v} compact />}
              </div>
              <div className="c">{o.consequence}</div>
              {hasValues(o) && !isSel && (
                <div className="cc-values">
                  {Object.entries(vals).map(([k, x]) => (
                    <span key={k} className={`cc-val ${chosen && it.values && !sameValue(x, o.set?.[k]) ? "accent" : ""}`}>
                      <span className="k">{k}</span> {fmt(x)}
                      {paramUnit(base, k)}
                    </span>
                  ))}
                </div>
              )}
            </button>
            {isSel && (
              <motion.div className="cc-body" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}>
                {hasValues(o) && (
                  <div className="cc-fields">
                    {Object.entries(vals).map(([k, x]) => (
                      <ValueField
                        key={k}
                        name={k}
                        from={base?.params.find((p) => p.name === k)?.value}
                        value={x}
                        unit={paramUnit(base, k)}
                        accent={!sameValue(x, o.set?.[k])}
                        onLive={(nv) => setValue(o, k, nv, false)}
                        onCommit={(nv) => setValue(o, k, nv, true)}
                      />
                    ))}
                  </div>
                )}
                {previewing && (
                  <div className="cc-live">
                    <span className="live-dot" /> In the 3D view <CheckStrip />
                  </div>
                )}
                <input
                  className="cc-note"
                  placeholder="Add a note for Claude (optional)"
                  value={note}
                  maxLength={2000}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      submit(o);
                    }
                  }}
                  aria-label="Note for Claude"
                />
                <div className="row" style={{ gap: 6, marginTop: 8 }}>
                  <button className="btn sm primary" onClick={() => submit(o)}>
                    <Icon.Check size={13} /> Choose this
                  </button>
                  {edited && (
                    <button className="btn sm ghost" onClick={() => reset(o)} data-tip="Back to the values Claude proposed">
                      <Icon.Undo size={12} /> Reset values
                    </button>
                  )}
                </div>
              </motion.div>
            )}
            {chosen && it.note && <div className="cc-answer-note">“{it.note}”</div>}
          </div>
        );
      })}
      {live && <div className="cc-foot">{it.options.some(hasValues) ? "Click an option to see it in the 3D view and adjust it. Or type a different answer below." : "Pick an option, or type a different answer below."}</div>}
      {answered && it.decision && (
        <button className="btn sm ghost cc-open" onClick={() => showDecision(it.decision!)}>
          <Icon.Fork size={12} /> In Decisions: switch or fine-tune it any time
        </button>
      )}
    </motion.div>
  );
}
