// The overview: the first thing under the 3D view. While Claude models and
// you direct, the questions are "does it work?", "does it do what it's
// for?", "what is it?" and "what just changed?". Each card answers one and
// opens the full tab behind it. Selecting a part adds a card for that part
// with a peek at its code, so the design file is never more than a click away.

import { useMemo, type ReactNode } from "react";
import { useDesign, meshes } from "../core/engine";
import { useView, revealSpan } from "../app/view";
import { useProject, previewSource, endPreview, restoreVersion } from "../app/project";
import { useChat, sendMessage } from "../ai/chat";
import { openSpot } from "../app/spot";
import { attention, briefSummary, checkScope, designStats, massText, sizeText, placedBox, type UseStatus } from "../app/designStats";
import { lineCol } from "../lang/lexer";
import { diffStats } from "../core/sourceEdit";
import { materialDef, FINISHES, isPrinted, resolveFinish } from "../library/materials";
import { Icon, StatusIcon } from "./icons";
import { BIcon } from "./briefIcons";
import { mod, timeAgo, useTick } from "./common";
import { openFind } from "../app/ui";
import { runExport } from "../app/exportFormats";
import { askClaude, REVIEW_ASK } from "./chatDraft";
import { useApiKey } from "./ChatPanel";
import { useRealModel } from "./useRealModel";
import type { CheckItem } from "../core/checks";
import type { EvalPart } from "../core/model";
import "../styles/overview.css";

/** The overview's tab glyph: a gauge. */
export function OverviewGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 17a8 8 0 1 1 16 0" />
      <path d="M12 17l4-5" />
      <circle cx="12" cy="17" r="1.4" />
    </svg>
  );
}

export function Overview() {
  const selected = useView((s) => s.selected);
  let i = 0;
  return (
    <div className="ov" role="region" aria-label="Design overview">
      <VerdictCard i={i++} />
      <BriefCard i={i++} />
      {/* the design as a whole, or the part you are looking at */}
      {selected.length > 0 ? <SelectionCard key={selected.join(",")} ids={selected} i={i++} /> : <SpecsCard i={i++} />}
      <NextCard i={i++} />
      <ChangesCard i={i++} />
    </div>
  );
}

/**
 * Where to go from here, from what the design has and hasn't got yet: test
 * it, run it, plan how it's made, make the files for it. Each opens the tab or
 * file behind it, so the features lead on from one another instead of waiting
 * to be found.
 */
function NextCard({ i }: { i: number }) {
  const model = useDesign((s) => s.model);
  const fails = useDesign((s) => s.report?.counts.fail ?? 0);
  if (!model?.parts.length) return null;
  const made = model.parts.filter((p) => p.kind === "part" && !p.imported);
  const printed = made.some((p) => (p.process ? p.process.id === "fdm" || p.process.id === "sla" : isPrinted(p.material)));
  const steps: { key: string; icon: ReactNode; text: string; sub: string; run: () => void }[] = [];
  if (fails) steps.push({ key: "fix", icon: <Icon.Alert size={13} />, text: "Fix what's failing", sub: "Open the checks", run: () => openTab("checks") });
  if (!model.analyses.length && made.length) steps.push({ key: "test", icon: <Icon.Stress size={13} />, text: "Test it", sub: "Strength, drops, vibration or airflow", run: () => openTab("analysis") });
  if (model.machine) steps.push({ key: "sim", icon: <Icon.Flask size={13} />, text: "Run it", sub: "Simulate the firmware and the physics", run: () => openTab("sim") });
  if (made.length) steps.push({ key: "make", icon: <Icon.Factory size={13} />, text: "Plan how it's made", sub: "Process, machine limits, cost and time", run: () => openTab("make") });
  if (made.length) steps.push(printed ? { key: "plate", icon: <Icon.Grid size={13} />, text: "Print it", sub: "Every part turned to print, as a .3mf plate", run: () => void runExport("3mf-plate") } : { key: "dwg", icon: <Icon.Doc size={13} />, text: "Draw it up", sub: "Dimensioned drawings, as a PDF", run: () => void runExport("drawings") });
  steps.push({ key: "review", icon: <Icon.Sparkle size={13} />, text: "Get a second opinion", sub: "Claude reviews it like a careful engineer", run: () => askClaude(REVIEW_ASK) });
  return (
    <Card title="next" icon={<Icon.Chevron size={12} />} i={i} className="ov-next" action={<button className="ov-chip ov-find" onClick={openFind} data-tip={`Everything Kerf can do (${mod}K)`}>all</button>}>
      <ul className="ov-list">
        {steps.slice(0, 4).map((x) => (
          <li key={x.key}>
            <button className="ov-item ov-step" onClick={x.run}>
              {x.icon}
              <span className="ov-step-text">
                <span className="ov-item-text">{x.text}</span>
                <span className="ov-step-sub">{x.sub}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Card({ title, icon, i, action, children, className = "", onTitle }: { title: string; icon: ReactNode; i: number; action?: ReactNode; children: ReactNode; className?: string; onTitle?: () => void }) {
  return (
    <section className={`ov-card ${className}`} style={{ ["--i" as string]: i }}>
      <header className="ov-card-head">
        <button className="ov-card-title" onClick={onTitle} disabled={!onTitle} tabIndex={onTitle ? 0 : -1}>
          {icon}
          {title}
          {onTitle && <Icon.Chevron size={11} className="ov-go" />}
        </button>
        <div className="grow" />
        {action}
      </header>
      <div className="ov-card-body">{children}</div>
    </section>
  );
}

const openTab = (dockTab: string) => useView.setState({ dockTab, dockOpen: true });

function focusItem(i: CheckItem) {
  const v = useView.getState();
  const same = v.focusCheck === i.id;
  useView.setState({ focusCheck: same ? null : i.id, focusParts: same ? [] : i.parts ?? [] });
}

// ---------- does it work? ----------

const R = 25;
const C = 2 * Math.PI * R;

function Ring({ segments, spinning }: { segments: { value: number; cls: string }[]; spinning: boolean }) {
  const total = segments.reduce((n, s) => n + s.value, 0);
  let at = 0;
  return (
    <svg className={`ov-ring ${spinning ? "spinning" : ""}`} width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r={R} className="ov-ring-track" />
      {total > 0 &&
        segments.map((s) => {
          if (!s.value) return null;
          // a hairline gap between segments
          const len = Math.max(0, (s.value / total) * C - (segments.filter((x) => x.value).length > 1 ? 2 : 0));
          const el = <circle key={s.cls} cx="32" cy="32" r={R} className={`ov-ring-seg ${s.cls}`} style={{ strokeDasharray: `${len} ${C}`, strokeDashoffset: -at }} transform="rotate(-90 32 32)" />;
          at += (s.value / total) * C;
          return el;
        })}
    </svg>
  );
}

function VerdictCard({ i }: { i: number }) {
  const report = useDesign((s) => s.report);
  const reportRev = useDesign((s) => s.reportRev);
  const rev = useDesign((s) => s.rev);
  const stage = useDesign((s) => s.stage);
  const model = useDesign((s) => s.model);
  const source = useDesign((s) => s.source);
  const timings = useDesign((s) => s.timings);
  const kernelStatus = useDesign((s) => s.kernelStatus);
  const focusCheck = useView((s) => s.focusCheck);
  const busy = useChat((s) => s.busy);
  const hasKey = !!useApiKey();
  const errors = model?.diagnostics.filter((d) => d.severity === "error") ?? [];
  const stale = reportRev < rev || (stage !== "done" && stage !== "refining");
  const counts = report?.counts ?? { pass: 0, fail: 0, warn: 0, pending: 0, info: 0 };
  const items = useMemo(() => attention(report, 4), [report]);
  const empty = !!model && !model.parts.length && !errors.length;
  const secs = (timings.evalMs + timings.buildMs + timings.checksMs) / 1000;

  let headline: string;
  let tone: "pass" | "fail" | "warn" | "work" | "" = "";
  let sub: string;
  if (kernelStatus === "loading") {
    headline = "Starting the kernel";
    sub = "OpenCASCADE is loading.";
    tone = "work";
  } else if (errors.length) {
    headline = `${errors.length} source error${errors.length > 1 ? "s" : ""}`;
    sub = `Line ${lineCol(source, errors[0].start).line}: ${errors[0].message}`;
    tone = "fail";
  } else if (empty) {
    headline = "Nothing to check yet";
    sub = "Describe what you need in the chat and Claude will model it.";
  } else if (!report) {
    headline = "Building";
    sub = "Checks run once the geometry is built.";
    tone = "work";
  } else if (counts.fail) {
    headline = `${counts.fail} check${counts.fail > 1 ? "s" : ""} failing`;
    sub = `${counts.pass} pass${counts.warn ? ` · ${counts.warn} warning${counts.warn > 1 ? "s" : ""}` : ""}`;
    tone = "fail";
  } else {
    headline = `All ${counts.pass} checks pass`;
    sub = counts.warn ? `${counts.warn} warning${counts.warn > 1 ? "s" : ""} to look at` : checkScope(report);
    tone = counts.warn ? "warn" : "pass";
  }
  const big = errors.length ? errors.length : counts.fail ? counts.fail : counts.pass;
  const askFix = () => {
    const list = items.filter((x) => x.status === "fail").map((x) => `- ${x.title} (${x.detail})`);
    void sendMessage(`Fix ${list.length > 1 ? "these failing checks" : "this failing check"}:\n${list.join("\n")}`);
  };

  return (
    <Card title="status" icon={<Icon.Shield size={12} />} i={i} onTitle={() => openTab(errors.length ? "code" : "checks")} className={`ov-verdict ${tone}`}>
      <div className="ov-verdict-top">
        <div className="ov-ring-wrap">
          <Ring
            spinning={stale && !errors.length}
            segments={
              errors.length
                ? [{ value: 1, cls: "fail" }]
                : [
                    { value: counts.fail, cls: "fail" },
                    { value: counts.warn, cls: "warn" },
                    { value: counts.pass, cls: "pass" },
                    { value: counts.pending, cls: "pending" },
                  ]
            }
          />
          <span key={`${tone}${big}`} className={`ov-ring-n ${errors.length || counts.fail ? "fail" : report ? "pass" : ""}`}>
            {report || errors.length ? big : "–"}
          </span>
        </div>
        <div className="ov-verdict-text">
          <div key={headline} className={`ov-headline ${tone}`}>
            {headline}
          </div>
          <div className="ov-sub">{sub}</div>
          {!errors.length && report && (
            <div className="ov-meta">
              {stale ? (
                <span className="ov-updating">
                  <span className="spinner" /> updating
                </span>
              ) : (
                <>rebuilt in {secs.toFixed(1)} s</>
              )}
            </div>
          )}
        </div>
      </div>
      {errors.length > 0 ? (
        <div className="ov-actions">
          <button className="btn sm" onClick={() => (openTab("code"), setTimeout(() => useView.setState({ reveal: { span: { start: errors[0].start, end: errors[0].end }, nonce: Date.now() } }), 30))}>
            <Icon.Code size={12} /> Show in design.kerf
          </button>
        </div>
      ) : empty ? (
        <div className="ov-actions">
          <button className="btn sm" onClick={() => document.getElementById("chat-input")?.focus()}>
            <Icon.Sparkle size={12} /> Describe it to Claude
          </button>
          <button className="btn sm ghost" onClick={() => openTab("brief")}>
            <BIcon.Brief size={12} /> Write the brief
          </button>
        </div>
      ) : items.length > 0 ? (
        <>
          <ul className="ov-list">
            {items.map((x) => (
              <li key={x.id}>
                <button className={`ov-item ${focusCheck === x.id ? "focused" : ""}`} onClick={() => focusItem(x)} title={x.detail}>
                  <StatusIcon status={x.status} />
                  <span className="ov-item-text">{x.title}</span>
                  {x.level === "soft" && <span className="ov-soft">soft</span>}
                </button>
              </li>
            ))}
          </ul>
          {counts.fail > 0 && hasKey && (
            <div className="ov-actions">
              <button className="btn sm" disabled={busy} onClick={askFix}>
                <Icon.Sparkle size={12} /> Ask Claude to fix
              </button>
            </div>
          )}
        </>
      ) : report ? (
        <CategoryTally items={report.items} />
      ) : null}
    </Card>
  );
}

const CAT: Record<string, string> = { brief: "brief", requirement: "requirements", interference: "interference", access: "tool access", motion: "motion", gears: "gears", build: "build", info: "notes" };

function CategoryTally({ items }: { items: CheckItem[] }) {
  const cats = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of items) if (x.status === "pass") m.set(x.category, (m.get(x.category) ?? 0) + 1);
    return [...m.entries()];
  }, [items]);
  return (
    <div className="ov-tally">
      {cats.map(([c, n], k) => (
        <span key={c} className="ov-chip pass" style={{ ["--k" as string]: k }}>
          <Icon.Check size={10} /> {CAT[c] ?? c} <b>{n}</b>
        </span>
      ))}
    </div>
  );
}

// ---------- does it do what it's for? ----------

const USE_ICON: Record<UseStatus, ReactNode> = {
  pass: <StatusIcon status="pass" />,
  fail: <StatusIcon status="fail" />,
  warn: <StatusIcon status="warn" />,
  unchecked: <span className="ov-nocheck" aria-label="no check yet" />,
};

function BriefCard({ i }: { i: number }) {
  const model = useDesign((s) => s.model);
  const report = useDesign((s) => s.report);
  const focusCheck = useView((s) => s.focusCheck);
  const b = useMemo(() => briefSummary(model, report), [model, report]);
  if (!b) {
    return (
      <Card title="brief" icon={<BIcon.Brief size={12} />} i={i} onTitle={() => openTab("brief")} className="ov-brief">
        <p className="ov-empty">No brief yet. Say what it's for, where it's used and what it must survive, and each of those becomes a check.</p>
        <div className="ov-actions">
          <button className="btn sm" onClick={() => openTab("brief")}>
            <Icon.Plus size={12} /> Write the brief
          </button>
        </div>
      </Card>
    );
  }
  const passing = b.uses.filter((u) => u.status === "pass").length;
  return (
    <Card
      title="brief"
      icon={<BIcon.Brief size={12} />}
      i={i}
      onTitle={() => openTab("brief")}
      className="ov-brief"
      action={b.uses.length > 0 && <span className={`ov-chip ${passing === b.uses.length ? "pass" : b.uses.some((u) => u.status === "fail") ? "fail" : ""}`}>{`${passing}/${b.uses.length} uses`}</span>}
    >
      {b.data.purpose && <p className="ov-purpose">{b.data.purpose}</p>}
      {b.uses.length > 0 ? (
        <ul className="ov-list">
          {b.uses.map((u) => {
            const item = report?.items.find((x) => x.id === `use:${u.id}`);
            return (
              <li key={u.id}>
                <button className={`ov-item ${item && focusCheck === item.id ? "focused" : ""}`} onClick={() => (item ? focusItem(item) : openTab("brief"))} title={u.status === "unchecked" ? "No requirement checks this yet" : item?.detail}>
                  {USE_ICON[u.status]}
                  <span className="ov-item-text">{u.text}</span>
                  {u.assumed && <span className="ov-soft">assumed</span>}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="ov-empty">No uses yet: add what it must do, and each becomes a check.</p>
      )}
      {(b.fails.length > 0 || b.toConfirm > 0) && (
        <div className="ov-foot">
          {b.fails.length > 0 && (
            <button className="ov-link fail" onClick={() => focusItem(b.fails[0])}>
              {b.fails.length} brief limit{b.fails.length > 1 ? "s" : ""} broken
            </button>
          )}
          {b.toConfirm > 0 && (
            <button className="ov-link warn" onClick={() => openTab("brief")}>
              {b.toConfirm} assumption{b.toConfirm > 1 ? "s" : ""} to confirm
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------- what is it? ----------

function Fact({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="ov-fact">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function useStats(only?: (p: EvalPart) => boolean) {
  const model = useDesign((s) => s.model);
  const meshVersion = useDesign((s) => s.meshVersion);
  // meshVersion: volumes and boxes arrive with the meshes
  return useMemo(() => designStats(model, (h) => meshes.get(h), only), [model, meshVersion, only]); // eslint-disable-line react-hooks/exhaustive-deps
}

function SpecsCard({ i }: { i: number }) {
  const model = useDesign((s) => s.model);
  const stats = useStats();
  const brief = useMemo(() => briefSummary(model, null), [model]);
  const size = sizeText(stats.size);
  const mass = massText(stats.mass);
  return (
    <Card title="design" icon={<Icon.Cube size={12} />} i={i} onTitle={() => openTab("bom")} className="ov-specs">
      <dl className="ov-facts">
        <Fact k="size">
          <span key={size} className="ov-val">
            {size}
            {stats.size && <small> mm</small>}
          </span>
        </Fact>
        <Fact k="mass">
          <span key={mass} className="ov-val">
            {mass}
          </span>
          {stats.printedMass > 0 && Math.round(stats.printedMass) !== Math.round(stats.mass) && <small> · {massText(stats.printedMass)} printed</small>}
        </Fact>
        <Fact k="parts">
          <span key={`${stats.make}/${stats.buy}`} className="ov-val">
            {stats.make} <small>to make</small> · {stats.buy} <small>to buy</small>
          </span>
        </Fact>
        {brief?.data.process && <Fact k="process">{brief.data.process}</Fact>}
      </dl>
      {stats.materials.length > 0 && (
        <div className="ov-mats">
          {stats.materials.slice(0, 6).map((m, k) => (
            <span key={m.name} className="ov-mat" style={{ ["--k" as string]: k }} title={`${m.count} solid${m.count > 1 ? "s" : ""}${m.mass > 0 ? ` · ${massText(m.mass)}` : ""}`}>
              <span className="ov-swatch" style={{ background: m.color }} />
              {m.label}
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------- the selected part ----------

const KW = new Set(["design", "note", "brief", "param", "let", "component", "interface", "part", "require", "decision", "for", "in", "if", "else", "range", "locked", "hard", "soft", "option"]);
const OPS = new Set(["body", "add", "cut", "intersect"]);

/** Light highlighting for the code peek, in the editor's colours. */
function highlight(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\/\/.*$)|("(?:[^"\\]|\\.)*"?)|(#[0-9a-fA-F]{3,8}\b)|(\d+(?:\.\d+)?(?:mm|cm|deg|in|m)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|(.)/gm;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(code))) {
    const [t] = m;
    const cls = m[1] ? "c" : m[2] ? "s" : m[3] ? "h" : m[4] ? "n" : m[5] ? (KW.has(t) ? "k" : OPS.has(t) ? "o" : t === "lib" ? "l" : code[re.lastIndex] === ":" ? "p" : code[re.lastIndex] === "(" ? "f" : "v") : "";
    out.push(cls ? <span key={k++} className={`tk-${cls}`}>{t}</span> : t);
  }
  return out;
}

function SelectionCard({ ids, i }: { ids: string[]; i: number }) {
  const model = useDesign((s) => s.model);
  const source = useDesign((s) => s.source);
  const report = useDesign((s) => s.report);
  const isolate = useView((s) => s.isolate);
  const parts = useMemo(() => model?.parts.filter((p) => ids.includes(p.id)) ?? [], [model, ids]);
  const only = useMemo(() => {
    const set = new Set(ids);
    return (p: EvalPart) => set.has(p.id);
  }, [ids]);
  const stats = useStats(only);
  const checks = useMemo(() => (report?.items ?? []).filter((x) => x.parts?.some((p) => ids.includes(p))), [report, ids]);
  if (!parts.length) return null;
  const p = parts[0];
  const one = parts.length === 1;
  const fails = checks.filter((c) => c.status === "fail").length;
  const finish = one ? FINISHES[resolveFinish(p.material, p.finish)]?.label.toLowerCase() : undefined;
  const lines = source.slice(p.span.start, p.span.end).split("\n");
  const peek = lines.slice(0, 16).join("\n");
  const startLine = lineCol(source, p.span.start).line;
  const info = meshes.get(p.hash);
  const box = one && info ? placedBox(p, info) : null;
  const partSize = box ? sizeText([box[1][0] - box[0][0], box[1][1] - box[0][1], box[1][2] - box[0][2]]) : sizeText(stats.size);
  return (
    <Card
      title={one ? "selected" : `${parts.length} selected`}
      icon={<Icon.Target size={12} />}
      i={i}
      className="ov-sel"
      action={
        <button className="icon-btn sm" onClick={() => useView.setState({ selected: [], isolate: false })} aria-label="Clear the selection" data-tip="Clear selection (Esc)" data-tip-pos="left">
          <Icon.X size={12} />
        </button>
      }
    >
      <div className="ov-sel-head">
        <span className="ov-swatch big" style={{ background: p.color }} />
        <div style={{ minWidth: 0 }}>
          <div className="ov-sel-name">{one ? p.label : parts.map((x) => x.label).slice(0, 3).join(", ") + (parts.length > 3 ? "…" : "")}</div>
          <div className="ov-sel-sub">
            {one ? (
              <>
                <span className="mono">{p.id}</span> · {p.kind === "part" ? "make" : "buy"} · {materialDef(p.material)?.label ?? p.material}
                {finish ? `, ${finish}` : ""}
              </>
            ) : (
              <>{stats.make} to make · {stats.buy} to buy</>
            )}
          </div>
        </div>
      </div>
      <div className="ov-sel-facts mono">
        <span>{partSize} mm</span>
        <span>{massText(stats.mass)}</span>
        <span className={fails ? "fail" : checks.length ? "pass" : ""}>{checks.length ? (fails ? `${fails} failing` : `${checks.length} checks pass`) : "no checks"}</span>
      </div>
      {one && (
        <button className="ov-code" onClick={() => (openTab("code"), setTimeout(() => revealSpan(p.span), 30))} title="Open in design.kerf">
          <span className="ov-code-gutter" aria-hidden="true">
            {peek.split("\n").map((_, k) => (
              <span key={k}>{startLine + k}</span>
            ))}
          </span>
          <code>{highlight(peek)}</code>
          <span className="ov-code-more">
            lines {startLine}–{startLine + lines.length - 1}
          </span>
        </button>
      )}
      <div className="ov-actions">
        <button className="btn sm" onClick={() => (openTab("code"), setTimeout(() => revealSpan(p.span), 30))}>
          <Icon.Code size={12} /> design.kerf
        </button>
        <button className={`icon-btn sm ${isolate ? "active" : ""}`} onClick={() => useView.setState({ isolate: !isolate })} aria-label={isolate ? "Show all parts" : "Isolate"} title={isolate ? "Show all parts" : "Isolate: show only this"}>
          <Icon.Eye size={13} />
        </button>
        {one && (
          <button className="icon-btn sm" onClick={() => openSpot({ partId: p.id, label: p.label })} aria-label="Ask Claude about this part" title="Ask Claude about this part">
            <Icon.Pin size={13} />
          </button>
        )}
      </div>
    </Card>
  );
}

// ---------- what just changed? ----------

const WHO = { claude: "Claude", you: "You", system: "Kerf" } as const;

function ChangesCard({ i }: { i: number }) {
  useTick();
  const versions = useProject((s) => s.versions);
  const preview = useProject((s) => s.preview);
  const busy = useChat((s) => s.busy);
  // the real design, not a version being previewed
  const { source } = useRealModel();
  const recent = useMemo(() => {
    const list = [...versions].reverse().slice(0, 6);
    return list.map((v, k) => {
      const prev = versions[versions.length - 2 - k];
      return { v, stats: prev ? diffStats(prev.source, v.source) : null };
    });
  }, [versions]);
  const currentId = recent.find((r) => r.v.source === source)?.v.id;
  return (
    <Card title="recent changes" icon={<Icon.History size={12} />} i={i} onTitle={() => useView.setState({ leftTab: "history" })} className="ov-changes" action={versions.length > 0 && <span className="ov-chip">v{versions.length}</span>}>
      {recent.length ? (
        <ol className="ov-timeline">
          {recent.map(({ v, stats }, k) => {
            const key = `version:${v.id}`;
            const showing = preview?.key === key;
            const current = v.id === currentId;
            return (
              <li key={v.id} className={`${v.author} ${current ? "current" : ""} ${showing ? "showing" : ""}`}>
                <span className="ov-node" aria-hidden="true">
                  {v.author === "claude" ? <Icon.Sparkle size={10} /> : v.author === "you" ? <Icon.Edit size={9} /> : null}
                </span>
                <button
                  className="ov-ver"
                  disabled={current || (busy && !showing)}
                  onClick={() => (showing ? endPreview(key) : previewSource({ key, label: `Version: ${v.message}`, apply: () => restoreVersion(v) }, v.source))}
                  title={current ? "The design as it is now" : showing ? "Stop previewing" : "Preview this version in 3D"}
                >
                  <span className="ov-ver-msg">{v.message}</span>
                  <span className="ov-ver-meta">
                    {WHO[v.author]} · {timeAgo(v.ts)}
                    {stats && (stats.added > 0 || stats.removed > 0) && (
                      <>
                        {" "}
                        {stats.added > 0 && <span className="add">+{stats.added}</span>} {stats.removed > 0 && <span className="del">−{stats.removed}</span>}
                      </>
                    )}
                    {current && <span className="ov-now">now</span>}
                    {showing && <span className="ov-now showing">previewing</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="ov-empty">Every change you or Claude make is saved as a version here.</p>
      )}
    </Card>
  );
}
