// Features tab: the feature tree. Each part's steps in build order (body,
// adds, cuts, fillets, shells, patterns) with their values to type over,
// and the usual feature-tree edits: suppress, move up or down, delete, roll
// back to a step, pattern or mirror a step. Every edit is one ordinary,
// undoable change to the design text (core/features), made without Claude.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useChat } from "../../ai/chat";
import { isLive, useAgents } from "../../agents/progress";
import { commitSource, endPreview, previewSource, realSource, useProject } from "../../app/project";
import { revealSpan, select, useView } from "../../app/view";
import { evaluateOnly } from "../../core/engine";
import { deleteStep, designSteps, mirrorStep, moveStep, patternStep, rollbackTo, setField, toggleSuppress, type Axis, type PartSteps, type Step, type StepEdit, type StepField } from "../../core/features";
import type { Model } from "../../core/model";
import { fmtNum } from "../../lang/values";
import { Icon } from "../icons";
import { T } from "../sketch/glyphs";
import { useRealModel } from "../useRealModel";
import { Highlight } from "./bits";

const ICONS: Record<string, (s: number) => ReactNode> = {
  box: (s) => <Icon.Box size={s} />,
  cylinder: (s) => <Icon.Cylinder size={s} />,
  tube: (s) => <Icon.Cylinder size={s} />,
  cone: (s) => <Icon.Cylinder size={s} />,
  hole: (s) => <Icon.Hole size={s} />,
  fillet: (s) => <Icon.Fillet size={s} />,
  chamfer: (s) => <Icon.Chamfer size={s} />,
  shell: (s) => <Icon.Shell size={s} />,
  extrude: (s) => <T.Sketch size={s} />,
  revolve: (s) => <T.Sketch size={s} />,
  mirror: (s) => <Icon.Mirror size={s} />,
  shape_of: (s) => <Icon.Copy size={s} />,
  repeat: (s) => <Icon.Pattern size={s} />,
  place: (s) => <Icon.Move size={s} />,
  library: (s) => <Icon.Cube size={s} />,
  let: (s) => <Icon.Code size={s} />,
  cosmetic: (s) => <Icon.Sparkle size={s} />,
  choice: (s) => <Icon.Fork size={s} />,
};
const iconOf = (s: Step, size = 13) => (ICONS[s.kind === "repeat" ? "repeat" : (s.fn ?? "")] ?? ICONS[s.kind] ?? ICONS.box)(size);

const errorsOf = (m: Model | null) => (m?.diagnostics ?? []).filter((d) => d.severity === "error").map((d) => d.message);

/** Make an edit real, unless it would break the design; returns why not. */
export function commitStepEdit(r: StepEdit): string | null {
  if (!r.ok) return r.why;
  const before = errorsOf(evaluateOnly(realSource()));
  const broke = errorsOf(evaluateOnly(r.src)).filter((e) => !before.includes(e));
  if (broke.length) return `That would break the design: ${broke[0]}`;
  commitSource(r.src, "you", r.title);
  return null;
}

export function FeaturesTab({ filter }: { filter: string }) {
  const { model, source } = useRealModel();
  const selected = useView((s) => s.selected);
  const busy = useChat((s) => s.busy);
  const building = useAgents((s) => isLive(s.run));
  const working = busy || building;
  const parts = useMemo(() => designSteps(source, model), [source, model]);
  const selectedBlocks = useMemo(() => new Set(selected.map((id) => model?.parts.find((p) => p.id === id)?.name).filter(Boolean) as string[]), [selected, model]);
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map());
  const [open, setOpen] = useState<string | null>(null);
  const [why, setWhy] = useState<{ key: string; text: string } | null>(null);
  const q = filter.trim().toLowerCase();

  // a part picked in the 3D view opens here
  useEffect(() => setToggled((t) => (t.size ? new Map([...t].filter(([b]) => !selectedBlocks.has(b))) : t)), [selectedBlocks]);

  if (!model) return <div className="lp-empty">The design is still loading.</div>;
  if (!parts.length) return <div className="lp-empty">No parts yet. Make one with the modelling tools (Tools above the 3D view), a sketch, or by describing it to Claude, and its steps show here.</div>;

  const isOpen = (b: string) => toggled.get(b) ?? (selectedBlocks.size ? selectedBlocks.has(b) : parts.length <= 3);
  const run = (key: string, r: StepEdit) => {
    const err = commitStepEdit(r);
    setWhy(err ? { key, text: err } : null);
    return !err;
  };
  const shown = parts
    .map((ps) => {
      const first = model.parts.find((p) => p.name === ps.block)!;
      // a pattern of components is listed once, without its "#1"
      const part = { ...first, label: first.label.replace(/ #1$/, "") };
      const nameHit = !q || ps.block.toLowerCase().includes(q) || part.label.toLowerCase().includes(q);
      const steps = nameHit ? ps.steps : ps.steps.filter((s) => s.title.toLowerCase().includes(q));
      return { ps, part, steps };
    })
    .filter((x) => x.steps.length);

  return (
    <div className="lp-parts ft">
      {working && <div className="ft-note">Claude is changing the design. The steps can be edited again when it is done.</div>}
      {q && !shown.length && <div className="lp-nomatch">No parts or steps match “{filter}”.</div>}
      {shown.map(({ ps, part, steps }) => {
        const expanded = isOpen(ps.block) || !!q;
        const ids = model.parts.filter((p) => p.name === ps.block).map((p) => p.id);
        return (
          <section className={`lp-group ${expanded ? "" : "collapsed"}`} key={ps.block}>
            <div
              className="lp-group-head"
              role="button"
              tabIndex={0}
              aria-expanded={expanded}
              onClick={() => {
                setToggled((t) => new Map(t).set(ps.block, !expanded));
                if (!expanded) select(ids);
              }}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), (e.currentTarget as HTMLElement).click())}
              onMouseEnter={() => useView.setState({ hovered: ids[0] })}
              onMouseLeave={() => useView.setState({ hovered: null })}
            >
              <span className="lp-chev">
                <Icon.Chevron size={11} />
              </span>
              <span className="ft-swatch" style={{ background: part.color }} />
              <span className="lp-group-name">
                <Highlight text={part.label} q={q} />
                {part.label !== ps.block && <span className="ft-block mono"> {ps.block}</span>}
              </span>
              <span className="lp-group-count">{ps.steps.length}</span>
            </div>
            <AnimatePresence initial={false}>
              {expanded && (
                <motion.div className="lp-group-body" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}>
                  {steps.map((s, i) => {
                    const key = `${ps.block}:${s.index}:${s.kind}`;
                    return (
                      <StepRow
                        key={key}
                        ps={ps}
                        step={s}
                        n={i + 1}
                        model={model}
                        q={q}
                        open={open === key}
                        onOpen={() => setOpen(open === key ? null : key)}
                        why={why?.key === key ? why.text : null}
                        run={(r) => run(key, r)}
                        working={working}
                        partId={ids[0]}
                      />
                    );
                  })}
                </motion.div>
              )}
            </AnimatePresence>
          </section>
        );
      })}
      <div className="ft-foot dim">Each step is a line of the design. Edits here are undoable (Ctrl Z) and Claude sees them like any other change.</div>
    </div>
  );
}

function StepRow({
  ps,
  step,
  n,
  model,
  q,
  open,
  onOpen,
  why,
  run,
  working,
  partId,
}: {
  ps: PartSteps;
  step: Step;
  n: number;
  model: Model;
  q: string;
  open: boolean;
  onOpen: () => void;
  why: string | null;
  run: (r: StepEdit) => boolean;
  working: boolean;
  partId: string;
}) {
  const preview = useProject((s) => s.preview?.key ?? null);
  const rollKey = `rollback:${ps.block}`;
  const rolled = preview?.startsWith(`${rollKey}:`) ? Number(preview.slice(rollKey.length + 1)) : null;
  const after = rolled !== null && step.index > rolled && step.kind !== "place";
  const [form, setForm] = useState<"pattern" | "mirror" | null>(null);
  const err = model.diagnostics.find((d) => d.severity === "error" && d.start >= step.span.start && d.end <= step.span.end);
  const src = () => realSource();
  const canRoll = step.kind !== "place" && step.kind !== "library";
  return (
    <div className={`ft-step ${open ? "open" : ""} ${step.suppressed ? "is-off" : ""} ${after ? "is-after" : ""}`}>
      <div
        className={`lp-row ft-row ${open ? "selected" : ""} ${err ? "is-failing" : ""}`}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onOpen}
        onKeyDown={(e) => e.key === "Enter" && onOpen()}
        onDoubleClick={() => revealSpan(step.span)}
        onMouseEnter={() => useView.setState({ hovered: partId })}
        onMouseLeave={() => useView.setState({ hovered: null })}
      >
        <span className="ft-n mono">{n}</span>
        <span className="lp-kind">{iconOf(step)}</span>
        <span className="lp-row-text">
          <span className="lp-row-desc ft-title">
            <Highlight text={step.title} q={q} />
          </span>
        </span>
        <span className="lp-row-badges">
          {err && <span className="lp-dot fail" data-tip={err.message} data-tip-pos="left" />}
          {step.suppressed && <span className="ft-off">off</span>}
        </span>
        <span className="lp-row-actions">
          {step.editable && (
            <button
              className="lp-icon-btn"
              aria-label={step.suppressed ? "Bring the step back" : "Suppress the step"}
              data-tip={step.suppressed ? "Bring it back" : "Suppress: leave it out of the build, keeping it here"}
              data-tip-pos="left"
              disabled={working}
              onClick={(e) => {
                e.stopPropagation();
                run(toggleSuppress(src(), ps.block, step.index));
              }}
            >
              {step.suppressed ? <Icon.EyeOff size={13} /> : <Icon.Eye size={13} />}
            </button>
          )}
          <button
            className="lp-icon-btn"
            aria-label="Show the step in code"
            data-tip="Show in code"
            data-tip-pos="left"
            onClick={(e) => {
              e.stopPropagation();
              revealSpan(step.span);
            }}
          >
            <Icon.Code size={13} />
          </button>
        </span>
      </div>
      {open && (
        <div className="ft-body">
          {step.fields.length > 0 ? (
            <div className="ft-fields">
              {step.fields.map((f, i) => (
                <FieldInput key={`${f.span.start}:${i}`} field={f} model={model} disabled={working} onCommit={(text) => run(setField(src(), f, text))} />
              ))}
            </div>
          ) : (
            <div className="dim ft-hint">Nothing to type over here. Open it in code to change it.</div>
          )}
          {err && <div className="ft-msg fail">{err.message}</div>}
          {why && <div className="ft-msg warn">{why}</div>}
          <div className="ft-actions">
            {step.editable && (
              <>
                <button className="btn sm ghost" disabled={working} onClick={() => run(moveStep(src(), ps.block, step.index, -1))} data-tip="Move it one step earlier">
                  <Icon.ChevronDown size={11} style={{ transform: "rotate(180deg)" }} /> Earlier
                </button>
                <button className="btn sm ghost" disabled={working} onClick={() => run(moveStep(src(), ps.block, step.index, 1))} data-tip="Move it one step later">
                  <Icon.ChevronDown size={11} /> Later
                </button>
              </>
            )}
            {canRoll && (
              <button
                className={`btn sm ${rolled === step.index ? "" : "ghost"}`}
                aria-pressed={rolled === step.index}
                onClick={() => {
                  const key = `${rollKey}:${step.index}`;
                  if (preview === key) return endPreview(key);
                  const back = rollbackTo(src(), ps.block, step.index);
                  if (back) previewSource({ key, label: `${ps.block} as it is after step ${n}` }, back);
                }}
                data-tip="Show the part as it is after this step, without the steps below (nothing is changed)"
              >
                <Icon.History size={11} /> {rolled === step.index ? "Show all steps" : "Roll back here"}
              </button>
            )}
            {step.repeatable && (
              <>
                <button className={`btn sm ${form === "pattern" ? "" : "ghost"}`} disabled={working} onClick={() => setForm(form === "pattern" ? null : "pattern")}>
                  <Icon.Pattern size={11} /> Pattern
                </button>
                <button className={`btn sm ${form === "mirror" ? "" : "ghost"}`} disabled={working} onClick={() => setForm(form === "mirror" ? null : "mirror")}>
                  <Icon.Mirror size={11} /> Mirror
                </button>
              </>
            )}
            {step.editable && (
              <button className="btn sm ghost danger-text" disabled={working} onClick={() => run(deleteStep(src(), ps.block, step.index))} data-tip="Delete the step (undo brings it back)">
                <Icon.Trash size={11} /> Delete
              </button>
            )}
          </div>
          {form === "pattern" && <PatternForm onApply={(spec) => run(patternStep(src(), ps.block, step.index, spec)) && setForm(null)} />}
          {form === "mirror" && <MirrorForm onApply={(axis, at) => run(mirrorStep(src(), ps.block, step.index, axis, at)) && setForm(null)} />}
        </div>
      )}
    </div>
  );
}

/** A value to type over: Enter or leaving the field applies it, Escape puts it back. */
function FieldInput({ field, model, disabled, onCommit }: { field: StepField; model: Model; disabled: boolean; onCommit: (text: string) => boolean }) {
  const [text, setText] = useState(field.text);
  useEffect(() => setText(field.text), [field.text]);
  const param = /^[A-Za-z_]\w*$/.test(field.text) ? model.params.find((p) => p.name === field.text) : undefined;
  const commit = () => {
    if (text.trim() === field.text.trim()) return;
    if (!onCommit(text)) setText(field.text);
  };
  return (
    <label className="ft-field">
      <span className="ft-label mono">
        {field.of ? <span className="dim">{field.of} · </span> : null}
        {field.label}
      </span>
      <input
        className="input mono"
        value={text}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setText(field.text);
            e.stopPropagation();
          }
          // a plain number steps with the arrow keys (Shift ×10, Alt ×0.1)
          if ((e.key === "ArrowUp" || e.key === "ArrowDown") && /^-?\d*\.?\d+$/.test(text.trim())) {
            e.preventDefault();
            const step = (e.shiftKey ? 10 : e.altKey ? 0.1 : 1) * (e.key === "ArrowUp" ? 1 : -1);
            setText(fmtNum(parseFloat(text) + step, 3));
          }
        }}
      />
      {param && typeof param.value === "number" && (
        <span className="ft-param dim mono" data-tip="A parameter: change it here or in the params tab, and everything using it follows">
          = {fmtNum(param.value, 3)}
        </span>
      )}
    </label>
  );
}

function NumIn({ label, value, onChange, unit }: { label: string; value: number; onChange: (v: number) => void; unit?: string }) {
  const [t, setT] = useState(String(value));
  return (
    <label className="ft-field small">
      <span className="ft-label mono">{label}</span>
      <input
        className="input mono"
        type="number"
        value={t}
        onChange={(e) => {
          setT(e.target.value);
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
      {unit && <span className="dim mono ft-unit">{unit}</span>}
    </label>
  );
}

const AXES: Axis[] = ["X", "Y", "Z"];

function AxisPick({ value, onChange, label = "along" }: { value: Axis; onChange: (a: Axis) => void; label?: string }) {
  return (
    <label className="ft-field small">
      <span className="ft-label mono">{label}</span>
      <select className="select" value={value} onChange={(e) => onChange(e.target.value as Axis)}>
        {AXES.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
    </label>
  );
}

function PatternForm({ onApply }: { onApply: (spec: Parameters<typeof patternStep>[3]) => void }) {
  const [kind, setKind] = useState<"line" | "round">("line");
  const [count, setCount] = useState(3);
  const [gap, setGap] = useState(10);
  const [axis, setAxis] = useState<Axis>("X");
  const [angle, setAngle] = useState(360);
  const [c, setC] = useState<[number, number, number]>([0, 0, 0]);
  const step: [number, number, number] = [0, 0, 0];
  step[AXES.indexOf(axis)] = gap;
  return (
    <div className="ft-form">
      <div className="ft-kind">
        <button className={`btn sm ${kind === "line" ? "primary" : "ghost"}`} onClick={() => setKind("line")}>
          <Icon.Pattern size={11} /> In a row
        </button>
        <button className={`btn sm ${kind === "round" ? "primary" : "ghost"}`} onClick={() => (setKind("round"), setAxis("Z"))}>
          <Icon.PatternRound size={11} /> Round an axis
        </button>
      </div>
      <NumIn label="copies" value={count} onChange={setCount} />
      {kind === "line" ? (
        <>
          <NumIn label="apart" value={gap} onChange={setGap} unit="mm" />
          <AxisPick value={axis} onChange={setAxis} />
        </>
      ) : (
        <>
          <NumIn label="over" value={angle} onChange={setAngle} unit="°" />
          <AxisPick value={axis} onChange={setAxis} label="round" />
          <NumIn label="centre x" value={c[0]} onChange={(v) => setC([v, c[1], c[2]])} unit="mm" />
          <NumIn label="centre y" value={c[1]} onChange={(v) => setC([c[0], v, c[2]])} unit="mm" />
          <NumIn label="centre z" value={c[2]} onChange={(v) => setC([c[0], c[1], v])} unit="mm" />
        </>
      )}
      <button className="btn sm primary" onClick={() => onApply(kind === "line" ? { kind, count, step } : { kind, count, angle, axis, center: c })}>
        <Icon.Bolt size={11} /> {kind === "line" ? `${count} in a row, ${fmtNum(gap, 2)} mm apart` : `${count} round ${axis}`}
      </button>
    </div>
  );
}

function MirrorForm({ onApply }: { onApply: (axis: Axis, at: number) => void }) {
  const [axis, setAxis] = useState<Axis>("X");
  const [at, setAt] = useState(0);
  return (
    <div className="ft-form">
      <AxisPick value={axis} onChange={setAxis} label="across" />
      <NumIn label={`plane at ${axis.toLowerCase()}`} value={at} onChange={setAt} unit="mm" />
      <button className="btn sm primary" onClick={() => onApply(axis, at)}>
        <Icon.Bolt size={11} /> Mirror across the {axis === "X" ? "YZ" : axis === "Y" ? "XZ" : "XY"} plane
      </button>
      <div className="dim ft-hint">Both copies stay linked: change the step and its mirror image follows.</div>
    </div>
  );
}
