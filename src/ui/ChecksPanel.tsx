// Engineering check results, with the conflict solver's proposals on top.

import { AnimatePresence, motion } from "framer-motion";
import { useMemo, useState } from "react";
import { useDesign, setHold, evaluateOnly } from "../core/engine";
import { useView, revealSpan } from "../app/view";
import { commitSource, endPreview, previewSource, realSource, useProject } from "../app/project";
import { setParamValue } from "../core/sourceEdit";
import { StatusIcon, Icon } from "./icons";
import { Segmented } from "./common";
import type { CheckItem } from "../core/checks";
import type { Model } from "../core/model";
import { PROCESSES } from "../mfg/profiles";
import type { FixOption } from "../core/feasibility";
import { fmtNum } from "../lang/values";
import { useChatDraft } from "./chatDraft";
import { CheckFix, FixAction, ManufacturingCard } from "./ManufacturingCard";
import { useChat, sendMessage } from "../ai/chat";
import { openSpot } from "../app/spot";
import { useApiKey } from "./ChatPanel";
import { openAnalysis } from "./AnalysisPanel";

export const CATEGORY_LABEL: Record<string, string> = {
  brief: "Brief",
  requirement: "Requirements",
  interference: "Interference",
  access: "Tool access",
  motion: "Motion",
  gears: "Gears",
  analysis: "Analysis",
  simulation: "Simulations",
  process: "Manufacturing",
  assembly: "Assembly",
  fit: "Real-world fit",
  vibration: "Vibration",
  knocks: "Drops and heat",
  springs: "Springs, clips and bands",
  build: "Build",
  electrical: "Wiring",
  engineering: "Calculations",
  testing: "Physical tests",
  info: "Needs analysis",
};

const BASIS_LABEL: Record<string, string> = {
  "needs analysis": "analysis",
  geometry: "geometry",
  parameters: "params",
  simulation: "fea",
  "virtual test": "sim",
  calculation: "calc",
  "electrical rules": "wiring rules",
  "physical test": "test",
};

/** The chat message behind "Ask Claude to fix": the check, its process and the suggested fix. */
function fixRequest(i: CheckItem, model: Model | null) {
  const part = i.category === "process" ? model?.parts.find((p) => p.id === i.parts?.[0]) : undefined;
  const how = part?.process ? ` for ${PROCESSES[part.process.id].label}` : "";
  return `Fix this ${i.status === "fail" ? "failing check" : "warning"}${how}: ${i.title} (${i.detail}).${i.fix ? ` Suggested fix: ${i.fix}` : ""}`;
}

export function ChecksPanel() {
  const report = useDesign((s) => s.report);
  const reportRev = useDesign((s) => s.reportRev);
  const rev = useDesign((s) => s.rev);
  const stage = useDesign((s) => s.stage);
  const checksError = useDesign((s) => s.checksError);
  const focusCheck = useView((s) => s.focusCheck);
  const busy = useChat((s) => s.busy);
  const hasKey = !!useApiKey();
  const model = useDesign((s) => s.model);
  const [filter, setFilter] = useState<"all" | "issues">("all");
  const stale = reportRev < rev;

  const groups = useMemo(() => {
    const items = (report?.items ?? []).filter((i) => filter === "all" || i.status === "fail" || i.status === "warn" || i.status === "pending");
    const m = new Map<string, CheckItem[]>();
    for (const i of items) m.set(i.category, [...(m.get(i.category) ?? []), i]);
    return [...m.entries()];
  }, [report, filter]);

  const focus = (i: CheckItem) => {
    const same = focusCheck === i.id;
    useView.setState({ focusCheck: same ? null : i.id, focusParts: same ? [] : i.parts ?? [] });
    if (!same && i.span) revealSpan(i.span);
    // a stress result opens on the model
    const fea = /^fea:(.*):(strength|stiffness|notes)$/.exec(i.id);
    if (!same && fea) openAnalysis(fea[1]);
  };

  return (
    <div className="checks">
      <div className="checks-summary">
        {report ? (
          <>
            <span className={`chip ${report.counts.fail ? "fail" : "pass"}`}>
              {report.counts.fail ? `${report.counts.fail} failing` : "all hard checks pass"}
            </span>
            <span className="mono dim" style={{ fontSize: 11 }}>
              {report.counts.pass} pass · {report.counts.warn} warn · {report.counts.info} notes
            </span>
          </>
        ) : (
          <span className="mono dim" style={{ fontSize: 11 }}>
            {stage === "idle" ? "No checks yet" : "Building geometry before checking…"}
          </span>
        )}
        {stale && report && (
          <span className="row mono" style={{ fontSize: 11, color: "var(--accent-2)", gap: 6 }}>
            <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} /> updating
          </span>
        )}
        <div className="grow" />
        <Segmented id="checks-filter" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "issues", label: "Issues" }]} />
      </div>

      {checksError && (
        <div className="banner error" style={{ borderRadius: 0 }}>
          <Icon.Alert size={14} /> The kernel could not finish the checks: {checksError}
        </div>
      )}

      <ConflictCard />
      <ManufacturingCard />

      <div style={{ opacity: stale ? 0.6 : 1, transition: "opacity .2s" }}>
        {groups.map(([cat, items]) => (
          <div key={cat}>
            <div className="tree-group-head" style={{ padding: "10px 14px 4px", cursor: "default" }}>
              {CATEGORY_LABEL[cat] ?? cat} <span className="dim">{items.length}</span>
            </div>
            <AnimatePresence initial={false}>
              {items.map((i) => (
                <motion.div
                  key={i.id}
                  layout="position"
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  className={`check-item ${focusCheck === i.id ? "focused" : ""}`}
                  onClick={() => focus(i)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && focus(i)}
                >
                  <StatusIcon status={i.status} />
                  <div style={{ minWidth: 0 }}>
                    <div className="title">
                      {i.title}
                      {i.level === "soft" && <span className="chip" style={{ marginLeft: 6, height: 16, fontSize: 9.5 }}>soft</span>}
                    </div>
                    <div className="detail">{i.detail}</div>
                    {i.fix && <CheckFix item={i} />}
                    {i.category === "requirement" && i.uses && (
                      <div className="row" style={{ gap: 4, marginTop: 3, flexWrap: "wrap" }}>
                        {i.uses.map((u) => (
                          <span key={u} className="chip" style={{ height: 16, fontSize: 9.5 }} title="Brief use this requirement checks">
                            for {u}
                          </span>
                        ))}
                      </div>
                    )}
                    {focusCheck === i.id && (i.action || ((i.status === "fail" || i.status === "warn") && hasKey)) && (
                      <div className="row" style={{ gap: 4, marginTop: 6, flexWrap: "wrap" }} onClick={(e) => e.stopPropagation()}>
                        {i.action && <FixAction action={i.action} />}
                        {(i.status === "fail" || i.status === "warn") && hasKey && (
                          <>
                            <button className="btn sm" disabled={busy} onClick={() => void sendMessage(fixRequest(i, model), { design: true })}>
                              <Icon.Sparkle size={12} /> Ask Claude to fix
                            </button>
                            {i.parts?.[0] && model?.parts.some((p) => p.id === i.parts![0]) && (
                              <button className="btn sm ghost" onClick={() => openSpot({ partId: i.parts![0], label: model.parts.find((p) => p.id === i.parts![0])!.label })}>
                                <Icon.Pin size={12} /> Talk about it
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="basis">{BASIS_LABEL[i.basis] ?? i.basis}</div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        ))}
        {report && groups.length === 0 && (
          <div className="empty-state" style={{ margin: 16 }}>
            {filter === "issues" ? "No issues. Every check passes." : "This design has no checks yet. Add require statements, or ask Claude to add them."}
          </div>
        )}
      </div>
    </div>
  );
}

function ConflictCard() {
  const conflict = useDesign((s) => s.conflict);
  const state = useDesign((s) => s.conflictState);
  const hold = useDesign((s) => s.hold);
  const setDraft = useChatDraft((s) => s.set);
  if (state === "idle") return null;
  if (state === "solving" && !conflict)
    return (
      <div className="conflict">
        <div className="row">
          <div className="spinner" /> <span>Hard requirements conflict. Searching for the smallest parameter changes…</span>
        </div>
      </div>
    );
  if (!conflict) return null;
  const fixedSource = (o: FixOption) => {
    // always from the real design, even while a fix is being previewed
    const source = realSource();
    const m = evaluateOnly(source);
    let src = source;
    // apply from the end of the file backwards so spans stay valid
    const changes = [...o.changes].sort((a, b) => {
      const pa = m.params.find((p) => p.name === a.param)?.valueSpan.start ?? 0;
      const pb = m.params.find((p) => p.name === b.param)?.valueSpan.start ?? 0;
      return pb - pa;
    });
    for (const c of changes) {
      const p = m.params.find((q) => q.name === c.param);
      if (p) src = setParamValue(src, p, c.to);
    }
    return src;
  };
  const apply = (o: FixOption) => commitSource(fixedSource(o), "you", `Applied fix: ${o.summary}`);
  const toggleHold = (name: string) => setHold(hold.includes(name) ? hold.filter((h) => h !== name) : [...hold, name]);
  const candidates = [...new Set([...conflict.adjustable, ...hold])];
  return (
    <motion.div className={`conflict ${conflict.infeasible ? "infeasible" : ""}`} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <span style={{ color: conflict.infeasible ? "var(--fail)" : "var(--warn)", marginTop: 1 }}>
          <Icon.Alert size={16} />
        </span>
        <div className="grow">
          <div style={{ fontWeight: 600 }}>{conflict.infeasible ? "These requirements cannot all be met" : "Requirements conflict"}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            {conflict.failing.map((f) => `${f.label} (${f.detail})`).join(" · ")}
          </div>
        </div>
        {state === "solving" && <div className="spinner" />}
      </div>
      {conflict.infeasible ? (
        <div style={{ fontSize: 12.5, marginTop: 10 }} className="muted">
          No change to the adjustable parameters satisfies every hard requirement. Relax a requirement, release a held value, or change the concept.
        </div>
      ) : (
        conflict.options.map((o, i) => (
          <div key={i} className="fix-option">
            <span className="chip accent">{i === 0 ? "gentlest" : `option ${i + 1}`}</span>
            <span className="grow" style={{ minWidth: 0 }}>
              {o.changes.map((c) => (
                <span key={c.param} style={{ marginRight: 10 }}>
                  {c.param} <span className="dim">{fmtNum(c.from)}</span> → <span style={{ color: "var(--accent-2)" }}>{fmtNum(c.to)}</span>
                </span>
              ))}
            </span>
            <FixPreviewButton index={i} label={o.summary} source={() => fixedSource(o)} apply={() => apply(o)} />
            <button className="btn sm primary" onClick={() => apply(o)}>
              Apply
            </button>
          </div>
        ))
      )}
      {candidates.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="field-label" style={{ marginBottom: 4 }}>
            Keep fixed
          </div>
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            {candidates.map((n) => (
              <button key={n} className={`chip ${hold.includes(n) ? "accent" : ""}`} style={{ cursor: "pointer" }} onClick={() => toggleHold(n)} aria-pressed={hold.includes(n)}>
                {hold.includes(n) ? <Icon.Lock size={10} /> : null} {n}
              </button>
            ))}
          </div>
        </div>
      )}
      <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={() => setDraft(`The requirements conflict (${conflict.failing.map((f) => f.label).join(", ")}). What are my options?`)}>
        <Icon.Sparkle size={13} /> Ask Claude for other options
      </button>
    </motion.div>
  );
}

/** Show a proposed fix in the 3D view before applying it. */
function FixPreviewButton({ index, label, source, apply }: { index: number; label: string; source: () => string; apply: () => void }) {
  const key = `fix:${index}`;
  const showing = useProject((s) => s.preview?.key === key);
  // while Claude works it edits the real design, so a preview would only flash
  const busy = useChat((s) => s.busy);
  return (
    <button className={`btn sm ${showing ? "" : "ghost"}`} aria-pressed={showing} disabled={busy && !showing} onClick={() => (showing ? endPreview(key) : previewSource({ key, label: `Fix: ${label}`, apply }, source()))}>
      <Icon.Eye size={12} /> {showing ? "Stop" : "Preview"}
    </button>
  );
}
