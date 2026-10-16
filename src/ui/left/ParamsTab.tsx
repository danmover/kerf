// Params tab: the design's driving values as a compact, readable list.
//
// Each row reads as plain words first (the description), then the name used
// in code and what the value drives. Drag a value sideways to scrub it, click
// it to type, or open the row for a slider, the parts it moves and the checks
// it affects. Sections come from the `// ── Title ──` comments in the source.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { create } from "zustand";
import { useDesign, setSource } from "../../core/engine";
import { useView, revealSpan, select } from "../../app/view";
import { commitSource, endComparison, useProject } from "../../app/project";
import { setParamValue, toggleParamLock } from "../../core/sourceEdit";
import type { EvalParam, Model } from "../../core/model";
import type { CheckItem } from "../../core/checks";
import { fmtNum } from "../../lang/values";
import { Icon } from "../icons";
import { G } from "./glyphs";
import { autoRange, clampParam, displayUnit, isLiteral, paramImpacts, paramSections, roundTo, stepFor, type ParamImpact } from "./insights";
import { CodeSample, Highlight } from "./bits";

export function ParamsTab({ filter }: { filter: string }) {
  const model = useDesign((s) => s.model);
  const source = useDesign((s) => s.source);
  const [open, setOpen] = useState<string | null>(null);
  // sections depend on comment positions, so recompute when the parameter list moves
  const layoutKey = model?.params.map((p) => `${p.name}@${p.span.start}`).join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sections = useMemo(() => (model ? paramSections(source, model.params) : []), [layoutKey]);
  const impacts = useMemo(() => (model ? paramImpacts(model) : new Map<string, ParamImpact>()), [model?.graph]);
  // the rows render from the live model; sections only decide order and headings
  const live = useMemo(() => new Map((model?.params ?? []).map((p) => [p.name, p])), [model]);
  // leaving the tab mid-hover must not leave the viewport emphasis behind
  useEffect(() => () => previewParts(null), []);

  if (!model) return null;
  if (!model.params.length)
    return (
      <div className="lp-empty">
        <div>No parameters yet. Driving dimensions written like this show up here, ready to scrub:</div>
        <CodeSample lines={[["kw", "param"], ["sp", " "], ["id", "width"], ["sp", " = "], ["num", "80mm"], ["sp", " "], ["str", '"Outer width"']]} />
      </div>
    );

  const match = (p: EvalParam, title: string | null) => !filter || `${p.name} ${p.desc ?? ""} ${title ?? ""}`.toLowerCase().includes(filter);
  const shown = sections.map((s) => ({ ...s, params: s.params.map((p) => live.get(p.name) ?? p).filter((p) => match(p, s.title)) })).filter((s) => s.params.length);
  const titled = sections.some((s) => s.title);

  return (
    <div className="lp-params">
      {filter && !shown.length && <div className="lp-nomatch">No parameters match “{filter}”.</div>}
      {shown.map((s, si) => (
        <section key={`${s.title}-${si}`} className="lp-psection">
          {titled && (
            <div className="lp-section-head">
              <span className="lp-section-slashes">//</span>
              <span className="lp-section-title">
                <Highlight text={s.title ?? "Parameters"} q={filter} />
              </span>
              <span className="lp-section-rule" />
              <span className="lp-section-count">{s.params.length}</span>
            </div>
          )}
          {s.params.map((p) => (
            <ParamRow key={p.name} p={p} gap={!filter && s.breaks.has(p.name)} impact={impacts.get(p.name)} open={open === p.name} onToggle={() => setOpen(open === p.name ? null : p.name)} filter={filter} />
          ))}
        </section>
      ))}
    </div>
  );
}

// ---------- editing ----------

/** Last edit made from this panel, so its own changes do not flash as outside changes. */
const local = { name: "", t: 0 };

function useParamEdit(name: string) {
  const base = useRef<string | null>(null);
  const find = () => {
    // a "before" comparison is for looking; editing a value goes back to the real design first
    endComparison();
    const { source, model } = useDesign.getState();
    return { source, cur: model?.params.find((q) => q.name === name) };
  };
  const message = (cur: EvalParam, v: number | string | boolean) => {
    if (typeof v !== "number") return `Set ${name} to ${String(v)}`;
    const u = displayUnit(cur);
    return `Set ${name} to ${fmtNum(v * u.scale, 3)}${u.suffix ? (u.suffix === "°" ? "°" : " " + u.suffix) : ""}`;
  };
  const api = {
    begin() {
      endComparison();
      base.current = useDesign.getState().source;
      // a release outside the control still records the change
      window.addEventListener("pointerup", () => api.end(), { once: true });
    },
    /** live preview while dragging; one version is recorded on release */
    preview(v: number) {
      const { source, cur } = find();
      if (!cur || cur.value === v) return;
      local.name = name;
      local.t = Date.now();
      const next = setParamValue(source, cur, v);
      if (base.current === null) commitSource(next, "you", message(cur, v));
      else setSource(next);
    },
    end() {
      const b = base.current;
      base.current = null;
      const { source, cur } = find();
      if (b !== null && b !== source && cur) {
        local.t = Date.now();
        // restore the base so the commit records one undo step from it
        setSource(b);
        commitSource(source, "you", message(cur, cur.value));
      }
    },
    commit(v: number | string | boolean) {
      const { source, cur } = find();
      if (!cur || cur.value === v) return;
      local.name = name;
      local.t = Date.now();
      commitSource(setParamValue(source, cur, v), "you", message(cur, v));
    },
  };
  return api;
}

// Values changed by Claude, undo or the code editor flash and show what they
// were for a few seconds. Tracked here rather than in the rows so a change made
// while another tab is open still shows when you come back to this one.
const SHOW_CHANGE_MS = 6000;
const useRecent = create<Record<string, { before: number | string | boolean; at: number }>>(() => ({}));
let seen: { project: string | undefined; values: Map<string, number | string | boolean> } = { project: undefined, values: new Map() };
useDesign.subscribe((s, prev) => {
  if (!s.model || s.model === prev.model) return;
  const project = useProject.getState().current?.id;
  const values = new Map(s.model.params.map((p) => [p.name, p.value]));
  const changed: Record<string, { before: number | string | boolean; at: number }> = {};
  if (project === seen.project) {
    const now = Date.now();
    for (const [name, v] of values) {
      const before = seen.values.get(name);
      if (before === undefined || before === v) continue;
      if (local.name === name && now - local.t < 1500) continue;
      changed[name] = { before, at: now };
    }
  }
  seen = { project, values };
  if (!Object.keys(changed).length) return;
  useRecent.setState(changed);
  setTimeout(() => {
    const cur = useRecent.getState();
    const keep = Object.fromEntries(Object.entries(cur).filter(([, c]) => Date.now() - c.at < SHOW_CHANGE_MS - 50));
    useRecent.setState(keep, true);
  }, SHOW_CHANGE_MS);
});

// Emphasise the parts a parameter drives while the pointer rests on it.
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let previewing = false;
function previewParts(ids: string[] | null) {
  clearTimeout(previewTimer);
  if (useView.getState().focusCheck) return; // a focused check owns the emphasis
  if (ids && ids.length) {
    previewTimer = setTimeout(() => {
      previewing = true;
      useView.setState({ focusParts: ids });
    }, 140);
  } else if (previewing) {
    previewing = false;
    useView.setState({ focusParts: [] });
  }
}

function kindGlyph(p: EvalParam) {
  if (typeof p.value === "boolean") return <G.Switch size={13} />;
  if (typeof p.value === "string") return <G.Text size={13} />;
  const u = displayUnit(p);
  if (u.suffix === "mm") return <G.Length size={13} />;
  if (u.suffix === "°") return <G.Angle size={13} />;
  if (u.integer) return <G.Count size={13} />;
  return <G.Number size={13} />;
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// ---------- a row ----------

function ParamRow({ p, gap, impact, open, onToggle, filter }: { p: EvalParam; gap: boolean; impact?: ParamImpact; open: boolean; onToggle: () => void; filter: string }) {
  const edit = useParamEdit(p.name);
  const was = useRecent((s) => s[p.name]);
  const report = useDesign((s) => s.report);
  const unit = displayUnit(p);
  const show = (v: number | string | boolean) => (typeof v === "number" ? fmtNum(v * unit.scale, 3) : String(v));
  const failing = useMemo(() => (impact?.checks ?? []).filter((label) => report?.items.some((i) => i.id === `req:${label}` && i.status === "fail")).length, [impact, report]);

  const isNum = typeof p.value === "number";
  const [lo, hi] = isNum ? autoRange(p) : [0, 1];
  const pct = isNum ? Math.min(100, Math.max(0, (((p.value as number) - lo) / (hi - lo || 1)) * 100)) : 0;
  const parts = impact?.parts.length ?? 0;
  const checks = impact?.checks.length ?? 0;
  const title = p.desc || p.name;

  return (
    <div
      className={`lp-param ${open ? "open" : ""} ${p.locked ? "locked" : ""} ${was ? "changed" : ""} ${gap ? "gap" : ""} ${failing ? "failing" : ""}`}
      data-param={p.name}
      style={{ "--pct": `${pct}%` } as CSSProperties}
    >
      {was && <span key={was.at} className="lp-flash" aria-hidden="true" />}
      <div className="lp-param-main" onClick={onToggle} role="button" tabIndex={-1} aria-expanded={open}>
        <span className="lp-pkind" aria-hidden="true">
          {kindGlyph(p)}
        </span>
        <span className="lp-ptext">
          <span className="lp-ptitle" title={p.desc && p.desc.length > 34 ? p.desc : undefined}>
            <Highlight text={title} q={filter} />
          </span>
          <span className="lp-psub">
            {p.desc && (
              <span className="lp-pname">
                <Highlight text={p.name} q={filter} />
              </span>
            )}
            {failing > 0 && (
              <span className="lp-pfail" data-tip={`${failing} of the checks this value affects ${failing === 1 ? "fails" : "fail"}`} data-tip-pos="top">
                <G.Cross size={10} />
                {failing} failing
              </span>
            )}
            {(parts > 0 || checks > 0) && (
              <span
                className="lp-pimpact"
                onMouseEnter={() => previewParts(impact!.partIds)}
                onMouseLeave={() => previewParts(null)}
                data-tip={impact!.direct.length ? `Shapes ${impact!.direct.slice(0, 3).join(", ")}${impact!.direct.length > 3 ? "…" : ""}` : "Through derived values"}
                data-tip-pos="top"
              >
                <G.Arrow size={10} />
                {[parts ? plural(parts, "part") : "", checks ? plural(checks, "check") : ""].filter(Boolean).join(" · ")}
              </span>
            )}
          </span>
        </span>
        <span className="lp-pvalue-wrap" onClick={(e) => e.stopPropagation()}>
          <AnimatePresence>
            {was && (
              <motion.span className="lp-was" initial={{ opacity: 0, x: 6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} data-tip="Value before the last change" data-tip-pos="left">
                <s>{show(was.before)}</s>
                <G.Arrow size={9} />
              </motion.span>
            )}
          </AnimatePresence>
          <ValueControl p={p} edit={edit} unitSuffix={unit.suffix} scale={unit.scale} />
        </span>
        <LockButton p={p} />
      </div>
      {isNum && !open && p.min !== undefined && p.max !== undefined && <div className="lp-prange" aria-hidden="true" />}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="lp-pdetail" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}>
            <ParamDetail p={p} lo={lo} hi={hi} pct={pct} impact={impact} edit={edit} unit={unit.suffix} scale={unit.scale} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function LockButton({ p }: { p: EvalParam }) {
  return (
    <button
      className={`lp-icon-btn lp-plock ${p.locked ? "on" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        const { source, model } = useDesign.getState();
        const cur = model?.params.find((q) => q.name === p.name);
        if (cur) commitSource(toggleParamLock(source, cur), "you", `${cur.locked ? "Unlocked" : "Locked"} ${p.name}`);
      }}
      aria-label={p.locked ? `Unlock ${p.name}` : `Lock ${p.name}`}
      data-tip={p.locked ? "Locked: Claude keeps this value" : "Lock so Claude keeps this value"}
      data-tip-pos="left"
    >
      {p.locked ? <Icon.Lock size={12} /> : <Icon.Unlock size={12} />}
    </button>
  );
}

// ---------- the value: scrub, type or toggle ----------

type Edit = ReturnType<typeof useParamEdit>;

function ValueControl({ p, edit, unitSuffix, scale }: { p: EvalParam; edit: Edit; unitSuffix: string; scale: number }) {
  const [typing, setTyping] = useState<string | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const drag = useRef<{ x: number; v: number; moved: boolean; last: number; raf: number } | null>(null);
  // a row that goes away mid-drag (Claude renamed or removed the parameter) must not leave the page unselectable
  useEffect(
    () => () => {
      if (drag.current) cancelAnimationFrame(drag.current.raf);
      document.body.classList.remove("lp-scrubbing");
    },
    [],
  );

  if (typeof p.value === "boolean")
    return <button className={`toggle lp-ptoggle ${p.value ? "on" : ""}`} role="switch" aria-checked={p.value} disabled={p.locked} onClick={() => edit.commit(!p.value)} aria-label={p.name} />;

  const isNum = typeof p.value === "number";
  const v = isNum ? (p.value as number) : 0;
  const display = isNum ? fmtNum(v * scale, 3) : String(p.value);

  const finishTyping = () => {
    if (typing === null) return;
    const t = typing.trim();
    setTyping(null);
    if (!t) return;
    if (isNum) {
      const n = Number(t.replace(/[a-zA-Z°%·\s]+$/, ""));
      if (Number.isFinite(n)) edit.commit(n / scale);
    } else edit.commit(t.replace(/^"|"$/g, ""));
  };

  if (typing !== null)
    return (
      <span className={`lp-pvalue editing ${isNum ? "num" : "str"}`}>
        <input
          autoFocus
          value={typing}
          aria-label={`${p.name} value`}
          spellCheck={false}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setTyping(e.target.value)}
          onBlur={finishTyping}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              e.stopPropagation();
              setTyping(null);
            }
          }}
        />
        {unitSuffix && <span className="lp-unit">{unitSuffix}</span>}
      </span>
    );

  const step = isNum ? stepFor(p) : 1;
  const [lo, hi] = isNum ? autoRange(p) : [0, 1];
  const perPx = Math.max(step / 4, (hi - lo) / 300);
  const nudge = (dir: number, big: boolean) => edit.commit(clampParam(p, roundTo(v + dir * step * (big ? 10 : 1), step)));

  return (
    <span
      className={`lp-pvalue ${isNum ? "num" : "str"} ${scrubbing ? "scrubbing" : ""} ${p.locked ? "disabled" : ""}`}
      role={isNum ? "spinbutton" : "button"}
      tabIndex={0}
      aria-label={`${p.name} value`}
      aria-valuenow={isNum ? v : undefined}
      aria-disabled={p.locked}
      data-tip={p.locked ? "" : isNum ? "Drag to scrub · click to type" : "Click to edit"}
      data-tip-pos="left"
      onPointerDown={(e) => {
        if (p.locked || e.button !== 0) return;
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, v, moved: false, last: v, raf: 0 };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || !isNum) return;
        const dx = e.clientX - d.x;
        if (!d.moved) {
          if (Math.abs(dx) < 3) return;
          d.moved = true;
          setScrubbing(true);
          document.body.classList.add("lp-scrubbing");
          edit.begin();
        }
        const next = clampParam(p, roundTo(d.v + dx * perPx * (e.shiftKey ? 0.1 : 1), e.shiftKey ? step / 10 : step));
        if (next === d.last) return;
        d.last = next;
        cancelAnimationFrame(d.raf);
        d.raf = requestAnimationFrame(() => edit.preview(next));
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        if (d.moved) {
          cancelAnimationFrame(d.raf);
          edit.preview(d.last);
          edit.end();
          setScrubbing(false);
          document.body.classList.remove("lp-scrubbing");
        } else setTyping(isNum ? display : String(p.value));
      }}
      onPointerCancel={() => {
        if (drag.current?.moved) {
          cancelAnimationFrame(drag.current.raf);
          edit.end();
          setScrubbing(false);
          document.body.classList.remove("lp-scrubbing");
        }
        drag.current = null;
      }}
      onKeyDown={(e) => {
        if (p.locked) return;
        if (e.key === "Enter" || e.key === "F2") {
          e.preventDefault();
          setTyping(isNum ? display : String(p.value));
        } else if (isNum && (e.key === "ArrowUp" || e.key === "ArrowRight")) {
          e.preventDefault();
          nudge(1, e.shiftKey);
        } else if (isNum && (e.key === "ArrowDown" || e.key === "ArrowLeft")) {
          e.preventDefault();
          nudge(-1, e.shiftKey);
        }
      }}
    >
      {isNum ? <span className="lp-num">{display}</span> : <span className="lp-str">"{display}"</span>}
      {unitSuffix && <span className={`lp-unit ${unitSuffix === "°" ? "deg" : ""}`}>{unitSuffix}</span>}
    </span>
  );
}

// ---------- the open row ----------

function ParamDetail({ p, lo, hi, pct, impact, edit, unit, scale }: { p: EvalParam; lo: number; hi: number; pct: number; impact?: ParamImpact; edit: Edit; unit: string; scale: number }) {
  const model = useDesign((s) => s.model);
  const report = useDesign((s) => s.report);
  const isNum = typeof p.value === "number";
  const v = isNum ? (p.value as number) : 0;
  const step = isNum ? stepFor(p) : 1;
  const fmt = (n: number) => `${fmtNum(n * scale, 3)}${unit === "°" ? "°" : ""}`;
  return (
    <div className="lp-pdetail-in">
      {isNum && !p.locked && (
        <div className="lp-slider">
          <input
            className="slider"
            type="range"
            min={lo}
            max={hi}
            step={step}
            value={Math.min(hi, Math.max(lo, v))}
            style={{ ["--p" as string]: `${pct}%` }}
            aria-label={`${p.name} slider`}
            onPointerDown={() => edit.begin()}
            onChange={(e) => edit.preview(Number(e.target.value))}
            onPointerUp={() => edit.end()}
          />
          <div className="lp-slider-ends">
            <span>{fmt(lo)}</span>
            <span>{p.min !== undefined && p.max !== undefined ? "declared range" : ""}</span>
            <span>{fmt(hi)}</span>
          </div>
        </div>
      )}
      {p.locked && <div className="lp-pnote">Locked. Claude keeps this value; unlock it to change it here.</div>}
      {!isLiteral(p) && (
        <div className="lp-pexpr">
          <span className="tk-op">=</span> <span className="tk-expr">{p.text}</span>
          <span className="lp-pnote"> · typing a value replaces this expression</span>
        </div>
      )}
      {impact && impact.parts.length > 0 && model && <DrivesList impact={impact} model={model} />}
      {impact && impact.checks.length > 0 && <ChecksList labels={impact.checks} items={report?.items ?? []} />}
      {impact && !impact.parts.length && !impact.checks.length && <div className="lp-pnote">Nothing reads this value yet.</div>}
      <div className="lp-pactions">
        <button className="btn sm ghost" onClick={() => revealSpan(p.span)}>
          <Icon.Code size={12} /> Show in code
        </button>
      </div>
    </div>
  );
}

function DetailLabel({ children }: { children: ReactNode }) {
  return <div className="lp-dlabel">{children}</div>;
}

function DrivesList({ impact, model }: { impact: ParamImpact; model: Model }) {
  const direct = new Set(impact.direct);
  const groups: [string, string[]][] = [
    ["Shapes", impact.parts.filter((n) => direct.has(n))],
    [direct.size ? "Also moves, through derived values" : "Moves or reshapes, through derived values", impact.parts.filter((n) => !direct.has(n))],
  ];
  return (
    <div className="lp-dblock" onMouseEnter={() => previewParts(impact.partIds)} onMouseLeave={() => previewParts(null)}>
      {groups
        .filter(([, names]) => names.length)
        .map(([label, names]) => (
          <div key={label} className="lp-dgroup">
            <DetailLabel>{label}</DetailLabel>
            <PartChips names={names} model={model} strong={label === "Shapes"} />
          </div>
        ))}
    </div>
  );
}

function PartChips({ names, model, strong }: { names: string[]; model: Model; strong: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? names : names.slice(0, 8);
  return (
    <div className="lp-chips">
      {shown.map((name) => {
        const ids = model.parts.filter((x) => x.name === name).map((x) => x.id);
        const part = model.parts.find((x) => x.name === name);
        return (
          <button key={name} className={`lp-chip ${strong ? "strong" : ""}`} onClick={() => select(ids)} onMouseEnter={() => useView.setState({ hovered: ids[0] })} onMouseLeave={() => useView.setState({ hovered: null })}>
            <span className="lp-swatch sm" style={{ background: part?.color }} />
            {name}
          </button>
        );
      })}
      {names.length > shown.length && (
        <button className="lp-chip more" onClick={() => setAll(true)}>
          +{names.length - shown.length} more
        </button>
      )}
    </div>
  );
}

function ChecksList({ labels, items }: { labels: string[]; items: CheckItem[] }) {
  return (
    <div className="lp-dblock">
      <DetailLabel>Checked by</DetailLabel>
      <div className="lp-checks">
        {labels.map((label) => {
          const item = items.find((i) => i.id === `req:${label}`);
          const status = item?.status ?? "pending";
          return (
            <button
              key={label}
              className={`lp-check ${status}`}
              onClick={() => item && useView.setState({ dockTab: "checks", dockOpen: true, focusCheck: item.id, focusParts: item.parts ?? [] })}
              data-tip={item?.detail ?? ""}
              data-tip-pos="top"
            >
              <span className="lp-check-icon">{status === "pass" ? <G.Check size={11} /> : status === "fail" ? <G.Cross size={11} /> : <span className="lp-dot" />}</span>
              <span className="lp-check-label">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
