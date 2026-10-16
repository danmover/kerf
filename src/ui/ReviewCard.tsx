// The self-review card: what the independent reviewer looked at, what it
// checked, what it found, and what happened to each finding.

import { AnimatePresence, motion } from "framer-motion";
import { useMemo, useRef, useState } from "react";
import { useChat, sendMessage, type ChatItem } from "../ai/chat";
import { AREAS, idsFor, inventoryDigest, type Finding, type FindingStatus, type ReviewResult, type ReviewStage, type ReviewView } from "../ai/review";
import { useDesign } from "../core/engine";
import { useView } from "../app/view";
import { Modal } from "./common";
import { Icon } from "./icons";

type ReviewItem = Extract<ChatItem, { kind: "review" }>;

const STAGES: { id: ReviewStage; label: string }[] = [
  { id: "waiting", label: "Waiting for the build and checks" },
  { id: "rendering", label: "Rendering 7 views" },
  { id: "measuring", label: "Measuring edges, walls and overhangs" },
  { id: "reviewing", label: "Reviewer looking at the design" },
  { id: "writing", label: "Writing up findings" },
];

const VERDICT = {
  pass: { label: "Passes", cls: "pass" },
  revise: { label: "Changes needed", cls: "warn" },
  decide: { label: "Your call needed", cls: "accent" },
} as const;

const STATUS: Record<FindingStatus, { label: string; cls: string }> = {
  open: { label: "open", cls: "warn" },
  fixed: { label: "fixed, checking", cls: "accent" },
  verified: { label: "fixed ✓", cls: "pass" },
  declined: { label: "kept", cls: "" },
  accepted: { label: "kept, agreed", cls: "pass" },
  needs_user: { label: "your call", cls: "accent" },
  still_open: { label: "still open", cls: "fail" },
};

export function ReviewCard({ it }: { it: ReviewItem }) {
  const r = it.result;
  const verdict = r ? VERDICT[r.verdict] : null;
  return (
    <motion.div className={`review-card ${it.status}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} layout="position">
      <div className="rv-head">
        <span className="rv-icon">{it.status === "running" ? <div className="spinner" /> : it.status === "error" ? <Icon.Alert size={14} /> : <Icon.Eye size={14} />}</span>
        <span className="rv-title">
          {it.status === "running" ? <span className="shimmer-text">Reviewing the design</span> : "Self-review"}
          <span className="rv-round">round {it.round}</span>
        </span>
        {it.auto && (
          <span className="chip" data-tip="Kerf asked for this review because the design changed substantially. Change this in Settings → Self-review.">
            auto
          </span>
        )}
        <span className="grow" />
        {verdict && <span className={`chip ${verdict.cls}`}>{verdict.label}</span>}
        {it.status === "error" && <span className="chip fail">did not run</span>}
      </div>
      {it.status === "running" && <Running it={it} />}
      {it.status === "error" && <div className="rv-error">{it.error}</div>}
      {r && <Result it={it} r={r} />}
    </motion.div>
  );
}

// ---------- running ----------

function Running({ it }: { it: ReviewItem }) {
  const stage = it.progress?.stage ?? "waiting";
  const at = stage === "closeup" ? STAGES.findIndex((s) => s.id === "reviewing") : STAGES.findIndex((s) => s.id === stage);
  const views = it.progress?.views ?? [];
  return (
    <div className="rv-body">
      <div className="rv-stages">
        {STAGES.map((s, i) => (
          <div key={s.id} className={`rv-stage ${i < at ? "done" : i === at ? "now" : ""}`}>
            <span className="rv-tick">{i < at ? <Icon.Check size={11} /> : i === at ? <span className="rv-pulse" /> : null}</span>
            <span>{i === at && it.progress?.detail && s.id !== "waiting" ? it.progress.detail : s.label}</span>
          </div>
        ))}
      </div>
      {views.length > 0 && (
        <div className="rv-strip">
          <AnimatePresence initial={false}>
            {views.map((src, i) => (
              <motion.img key={i} src={src} alt="" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.25 }} />
            ))}
          </AnimatePresence>
        </div>
      )}
      <div className="tc-progress" />
    </div>
  );
}

// ---------- result ----------

function Result({ it, r }: { it: ReviewItem; r: ReviewResult }) {
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [showChecked, setShowChecked] = useState(false);
  const views = r.views.filter((v) => v.image);
  const before = usePreviousIso(it);
  const settled = r.earlier.filter((f) => f.status === "verified" || f.status === "accepted");
  const unsettled = r.earlier.filter((f) => !(f.status === "verified" || f.status === "accepted"));
  const issues = r.checked.filter((c) => c.result === "issues").length;
  const tokens = r.usage.input + r.usage.output + r.usage.cacheRead;

  return (
    <div className="rv-body">
      <div className="rv-summary">{r.summary}</div>

      {views.length ? (
        <div className="rv-strip" role="list" aria-label="What the reviewer looked at">
          {views.map((v, i) => (
            <button key={i} className={`rv-thumb ${v.closeup ? "closeup" : ""}`} onClick={() => setLightbox(i)} data-tip={v.closeup ? `Close-up: ${v.closeup.why}` : v.label} role="listitem">
              <img src={v.image} alt={v.label} />
              {v.closeup && (
                <span className="rv-zoom">
                  <Icon.Target size={10} />
                </span>
              )}
            </button>
          ))}
        </div>
      ) : (
        it.thumb && <img className="rv-sheet" src={it.thumb} alt="The views the reviewer looked at" />
      )}

      {before && views[0] && <Compare before={before} after={views[0].image} />}

      <button className="rv-section-toggle" onClick={() => setShowChecked((s) => !s)} aria-expanded={showChecked}>
        <Icon.Chevron size={11} style={{ transform: showChecked ? "rotate(90deg)" : undefined, transition: "transform .15s" }} />
        What it checked
        <span className="rv-areas-mini">
          {AREAS.map((a) => {
            const c = r.checked.find((x) => x.area === a.id);
            return <span key={a.id} className={`rv-dot ${c?.result === "issues" ? "issues" : c?.result === "n/a" ? "na" : "ok"}`} data-tip={`${a.label}: ${c?.result ?? "not reported"}`} />;
          })}
        </span>
        <span className="dim">{issues ? `${issues} with issues` : "all clear"}</span>
      </button>
      <AnimatePresence initial={false}>
        {showChecked && (
          <motion.div className="rv-areas" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
            {AREAS.map((a) => {
              const c = r.checked.find((x) => x.area === a.id);
              return (
                <div key={a.id} className={`rv-area ${c?.result === "issues" ? "issues" : c?.result === "n/a" ? "na" : "ok"}`}>
                  <span className="rv-area-icon">{c?.result === "issues" ? <Icon.Alert size={12} /> : c?.result === "n/a" ? "–" : <Icon.Check size={12} />}</span>
                  <span className="rv-area-label">{a.label}</span>
                  <span className="rv-area-note">{c?.note || (c ? "" : "Not reported")}</span>
                </div>
              );
            })}
            {r.assumptions && (
              <div className="rv-assumed">
                <span className="mono">Assumed</span> {r.assumptions}
              </div>
            )}
            <div className="rv-digest mono">{inventoryDigest(r.inventory)}</div>
          </motion.div>
        )}
      </AnimatePresence>

      {(unsettled.length > 0 || settled.length > 0) && (
        <div className="rv-group">
          <div className="rv-group-head mono">From earlier rounds</div>
          {[...unsettled, ...settled].map((f) => (
            <FindingRow key={f.id} f={f} />
          ))}
        </div>
      )}

      {r.findings.length > 0 ? (
        <div className="rv-group">
          {r.earlier.length > 0 && <div className="rv-group-head mono">New this round</div>}
          {r.findings.map((f) => (
            <FindingRow key={f.id} f={f} />
          ))}
        </div>
      ) : (
        <div className="rv-clean">
          <Icon.Check size={12} /> {r.round > 1 ? "No new problems found." : "No problems worth fixing found."}
        </div>
      )}

      <div className="rv-foot mono">
        <span>{r.views.length} views{r.views.some((v) => v.closeup) ? ` incl. ${r.views.filter((v) => v.closeup).length} close-up${r.views.filter((v) => v.closeup).length > 1 ? "s" : ""}` : ""}</span>
        <span>·</span>
        <span>{(r.ms / 1000).toFixed(0)} s</span>
        <span>·</span>
        <span data-tip={`${r.usage.input.toLocaleString()} in, ${r.usage.cacheRead.toLocaleString()} cached, ${r.usage.output.toLocaleString()} out, ${r.usage.calls} call${r.usage.calls > 1 ? "s" : ""} to ${r.model}`}>{formatTokens(tokens)} tokens</span>
      </div>

      <Lightbox views={views} index={lightbox} onIndex={setLightbox} />
    </div>
  );
}

function FindingRow({ f }: { f: Finding }) {
  const [open, setOpen] = useState(false);
  const busy = useChat((s) => s.busy);
  const st = STATUS[f.status];
  const done = f.status === "verified" || f.status === "accepted";
  const actionable = !busy && (f.status === "open" || f.status === "still_open" || f.status === "needs_user" || f.status === "declined");
  return (
    <div className={`rv-finding sev-${f.severity} ${done ? "done" : ""}`}>
      <button className="rv-f-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`rv-sev ${f.severity}`}>{f.severity}</span>
        <span className="rv-f-id mono">{f.id}</span>
        <span className="rv-f-title">{f.title}</span>
        <span className={`chip ${st.cls}`}>{st.label}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="rv-f-body" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
            <div className="rv-f-detail">{f.detail}</div>
            <div className="rv-f-fix">
              <span className="mono">Fix</span>
              <span>{f.fix}</span>
            </div>
            {f.response && (
              <div className="rv-f-note">
                <span className="mono">Claude</span>
                <span>{f.response}</span>
              </div>
            )}
            {f.note && (
              <div className="rv-f-note">
                <span className="mono">Reviewer</span>
                <span>{f.note}</span>
              </div>
            )}
            <div className="row rv-f-actions">
              {f.parts.map((p) => (
                <PartChip key={p} name={p} />
              ))}
              <span className="grow" />
              {actionable && (
                <button className="btn sm" onClick={() => void sendMessage(`Please fix review finding ${f.id} (${f.title}). Suggested fix: ${f.fix}`)}>
                  <Icon.Wrench size={12} /> Ask Claude to fix
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** A part name that highlights the part in the 3D view. */
function PartChip({ name }: { name: string }) {
  const model = useDesign((s) => s.model);
  const ids = useMemo(() => (model ? idsFor(model, [name]) : []), [model, name]);
  const focused = useView((s) => ids.length > 0 && ids.every((id) => s.focusParts.includes(id)));
  return (
    <button
      className={`chip part-chip ${focused ? "accent" : ""}`}
      disabled={!ids.length}
      onClick={() => useView.setState(focused ? { focusParts: [], focusCheck: null } : { focusParts: ids, selected: ids, focusCheck: null })}
      data-tip={ids.length ? "Show this part in the 3D view" : "Not in the current design"}
    >
      <Icon.Cube size={10} /> {name}
    </button>
  );
}

// ---------- before and after ----------

/** The 3/4 view from the previous round of this review, when it is still in memory. */
function usePreviousIso(it: ReviewItem): string | null {
  return useChat((s) => {
    if (it.round < 2) return null;
    const at = s.items.findIndex((x) => x.id === it.id);
    for (let i = at - 1; i >= 0; i--) {
      const x = s.items[i];
      if (x.kind === "review" && x.result && x.round === it.round - 1) return x.result.views[0]?.image || null;
      if (x.kind === "user") break;
    }
    return null;
  });
}

function Compare({ before, after }: { before: string; after: string }) {
  const [t, setT] = useState(0.5);
  const box = useRef<HTMLDivElement>(null);
  const drag = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (r) setT(Math.min(1, Math.max(0, (clientX - r.left) / r.width)));
  };
  return (
    <div className="rv-compare">
      <div
        ref={box}
        className="rv-compare-box"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          drag(e.clientX);
        }}
        onPointerMove={(e) => e.buttons && drag(e.clientX)}
        role="slider"
        aria-label="Compare before and after the fixes"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(t * 100)}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setT((v) => Math.max(0, v - 0.05));
          if (e.key === "ArrowRight") setT((v) => Math.min(1, v + 0.05));
        }}
      >
        <img src={after} alt="After the fixes" draggable={false} />
        <img src={before} alt="Before the fixes" draggable={false} style={{ clipPath: `inset(0 ${(1 - t) * 100}% 0 0)` }} />
        <div className="rv-compare-line" style={{ left: `${t * 100}%` }} />
        <span className="rv-compare-tag l mono">before</span>
        <span className="rv-compare-tag r mono">after</span>
      </div>
    </div>
  );
}

// ---------- enlarged views ----------

function Lightbox({ views, index, onIndex }: { views: ReviewView[]; index: number | null; onIndex: (i: number | null) => void }) {
  const v = index === null ? null : views[index];
  const step = (d: number) => index !== null && onIndex((index + d + views.length) % views.length);
  return (
    <Modal open={v !== null} onClose={() => onIndex(null)} title={v ? `${index! + 1} of ${views.length} · ${v.label}` : ""} width={1040} icon={<Icon.Eye size={15} />}>
      {v && (
        <div
          className="rv-lightbox"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") step(-1);
            if (e.key === "ArrowRight") step(1);
          }}
        >
          <img src={v.image} alt={v.label} />
          {v.closeup && (
            <div className="rv-lb-why">
              <Icon.Target size={12} /> The reviewer asked for this close-up: {v.closeup.why}
            </div>
          )}
          <div className="row" style={{ justifyContent: "space-between", padding: "10px 16px" }}>
            <button className="btn sm" onClick={() => step(-1)}>
              ← Previous
            </button>
            <button className="btn sm" onClick={() => step(1)}>
              Next →
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function formatTokens(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}
