// The analysis tab: pick an analysis, see its key numbers, set-up, notes
// and convergence, and choose how its results are drawn on the model.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { useDesign } from "../core/engine";
import { useView, revealSpan } from "../app/view";
import { useAnalysis, showResults, runFine, type StructuralRun, type ResultField } from "../analysis/runtime";
import { modeText, safetyAway, strengthVerdict, structuralVerdict } from "../analysis/summary";
import { describeRegion, type AnalysisSpec, type DrivetrainSpec, type StructuralSpec, type UciSpec } from "../analysis/spec";
import { uciItems, uciVerdict } from "../analysis/summary";
import { uciResult, UCI_ROAD } from "../core/uciChecks";
import type { CheckItem } from "../core/checks";
import type { StructuralResult } from "../analysis/fe/structural";
import type { DrivetrainResult } from "../analysis/drivetrain";
import { safetyColor, safetyT } from "../analysis/colormap";
import { FIELD_INFO, FIELDS, autoDeform, shownMode } from "./ResultsLayer";
import { dropVerdict, modeWords, resonances, vibrationText, vibrationVerdict } from "../analysis/dynamics";
import { Menu, MenuItem, Segmented } from "./common";
import { Icon, StatusIcon } from "./icons";
import { useChatDraft } from "./chatDraft";
import { AirflowControls, AirflowView } from "./AirflowView";
import { kindsFor } from "./analysisKinds";
import { useAirflow, showAirflow, yawMean, type AirflowRun } from "../analysis/aeroRuntime";
import { fmtNum } from "../lang/values";
import "../styles/analysis.css";

type Status = "pass" | "warn" | "fail" | "pending" | "info";

const sfStatus = (sf: number, target: number): Status => (sf >= target ? "pass" : sf >= 1 ? "warn" : "fail");
const sfText = (sf: number) => (!Number.isFinite(sf) || sf >= 100 ? "> 100" : fmtNum(sf, 2));
const v3 = (p: number[]) => `(${p.map((v) => fmtNum(v, 1)).join(", ")})`;

/** Open the analysis tab on one analysis and draw its results. */
export function openAnalysis(label: string) {
  useView.setState({ dockTab: "analysis", dockOpen: true });
  useAnalysis.setState({ selected: label });
  if (useAnalysis.getState().runs.get(label)?.result) showResults(label);
  if (useAirflow.getState().runs.get(label)?.result) showAirflow(label);
}

export function AnalysisPanel() {
  const model = useDesign((s) => s.model);
  const runs = useAnalysis((s) => s.runs);
  const drivetrain = useAnalysis((s) => s.drivetrain);
  const shown = useAnalysis((s) => s.shown);
  const selected = useAnalysis((s) => s.selected);
  const report = useDesign((s) => s.report);
  const airRuns = useAirflow((s) => s.runs);
  const specs = model?.analyses ?? [];
  const spec = specs.find((a) => a.label === selected) ?? specs.find((a) => a.label === shown) ?? specs[0];

  if (!model) return <div className="an-body mono dim">Building the design…</div>;
  if (!specs.length) return <EmptyState />;
  return (
    <div className="an">
      <div className="an-head">
        {specs.map((a) => (
          <Pick key={a.label} spec={a} active={a.label === spec?.label} run={runs.get(a.label)} dt={drivetrain.get(a.label)} items={report?.items} air={airRuns.get(a.label)} />
        ))}
        <AddAnalysis />
        <div className="grow" />
        {spec?.kind === "structural" && <FineButton spec={spec} run={runs.get(spec.label)} />}
        {spec && <AskButton spec={spec} run={spec.kind === "structural" ? runs.get(spec.label) : undefined} dt={spec.kind === "drivetrain" ? drivetrain.get(spec.label) : undefined} air={spec.kind === "airflow" ? airRuns.get(spec.label) : undefined} />}
        {spec?.kind === "structural" && <StructuralControls spec={spec} run={runs.get(spec.label)} />}
        {spec?.kind === "airflow" && <AirflowControls spec={spec} run={airRuns.get(spec.label)} />}
      </div>
      <div className="an-body">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={spec?.label} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            {spec?.kind === "structural" && <StructuralView spec={spec} run={runs.get(spec.label)} />}
            {spec?.kind === "drivetrain" && <DrivetrainView spec={spec} result={drivetrain.get(spec.label)} />}
            {spec?.kind === "uci" && <UciView spec={spec} items={uciItems(spec, report?.items ?? [])} />}
            {spec?.kind === "airflow" && <AirflowView spec={spec} run={airRuns.get(spec.label)} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

// ---------- header ----------

function Pick({ spec, active, run, dt, items, air }: { spec: AnalysisSpec; active: boolean; run?: StructuralRun; dt?: DrivetrainResult; items?: CheckItem[]; air?: AirflowRun }) {
  let status: Status = "pending";
  let val = "";
  if (spec.kind === "uci") {
    const mine = uciItems(spec, items ?? []);
    status = uciVerdict(mine);
    const fails = mine.filter((i) => i.status === "fail").length;
    val = status === "pending" ? "" : fails ? `${fails} failing` : status === "warn" ? "check" : "legal";
  } else if (spec.kind === "airflow") {
    if (air?.status === "error") {
      status = air.error === "Stopped." && air.result ? "info" : "fail";
      val = air.error === "Stopped." ? "stopped" : "error";
    } else if (air?.result && air.status === "done") {
      const cda = yawMean(air.result, (y) => y.cda);
      status = spec.maxCda !== undefined ? (cda <= spec.maxCda ? "pass" : "fail") : "info";
      val = `CdA ${fmtNum(cda, 3)}`;
    } else val = air?.status === "running" ? `${Math.round(air.frac * 100)}%` : air ? "waiting" : "";
  } else if (spec.kind === "structural") {
    if (run?.status === "error") {
      status = "fail";
      val = "error";
    } else if (run?.result && run.status === "done") {
      const r = run.result;
      status = structuralVerdict(spec, r);
      val = r.drop ? `${fmtNum(r.drop.g, 0)} g · SF ${sfText(r.minSafety.value)}` : r.modal && !(r.maxDisp.value > 0) ? `${fmtNum(r.modal.modes[0]?.freq ?? 0, 0)} Hz` : `SF ${sfText(r.minSafety.value)}`;
    } else val = run ? `${Math.round((run.frac ?? 0) * 100)}%` : "";
  } else if (dt) {
    const fails = dt.items.filter((i) => i.status === "fail").length;
    const warns = dt.items.filter((i) => i.status === "warn").length;
    status = dt.error || fails ? "fail" : warns ? "warn" : "pass";
    val = dt.error ? "error" : fails ? `${fails} failing` : warns ? `${warns} to check` : "passes";
  }
  return (
    <button className={`an-pick ${active ? "active" : ""}`} onClick={() => useAnalysis.setState({ selected: spec.label })} aria-pressed={active}>
      <span className={`dot ${status}`} />
      {spec.label}
      {val && <span className={`val ${status}`}>{val}</span>}
    </button>
  );
}

function StructuralControls({ spec, run }: { spec: StructuralSpec; run?: StructuralRun }) {
  const shown = useAnalysis((s) => s.shown);
  const field = useAnalysis((s) => s.field);
  const deform = useAnalysis((s) => s.deform);
  const trueScale = useAnalysis((s) => s.trueScale);
  const animate = useAnalysis((s) => s.animate);
  const on = shown === spec.label;
  const hasResult = !!run?.result;
  return (
    <div className="an-ctl">
      <button className={`an-toggle ${on ? "on" : ""}`} disabled={!hasResult} onClick={() => showResults(on ? null : spec.label)} aria-pressed={on} data-tip="Colour the model by the results">
        {on ? <Icon.Eye size={13} /> : <Icon.EyeOff size={13} />} on model
      </button>
      <Segmented<ResultField>
        id="an-field"
        value={field}
        onChange={(f) => {
          useAnalysis.setState({ field: f });
          if (hasResult) showResults(spec.label);
        }}
        options={FIELDS.map((f) => ({ value: f, label: FIELD_INFO[f].short.toLowerCase(), title: FIELD_INFO[f].label }))}
      />
      <span className="mono dim" style={{ fontSize: 10.5 }} data-tip="How much the deflection is exaggerated">
        shape
      </span>
      <input
        className="slider"
        type="range"
        min={0}
        max={3}
        step={0.05}
        value={trueScale ? 1 : deform}
        disabled={trueScale}
        aria-label="Deformation exaggeration"
        style={{ ["--p" as string]: `${((trueScale ? 1 : deform) / 3) * 100}%` }}
        onChange={(e) => useAnalysis.setState({ deform: Number(e.target.value) })}
      />
      <button className={`an-toggle ${trueScale ? "on" : ""}`} onClick={() => useAnalysis.setState({ trueScale: !trueScale })} aria-pressed={trueScale} data-tip="Show the deflection at its real size">
        1:1
      </button>
      <button className={`an-toggle ${animate ? "on" : ""}`} onClick={() => useAnalysis.setState({ animate: !animate })} aria-pressed={animate} data-tip="Animate between the unloaded and loaded shape">
        {animate ? <Icon.Pause size={12} /> : <Icon.Play size={12} />} animate
      </button>
    </div>
  );
}

function FineButton({ spec, run }: { spec: StructuralSpec; run?: StructuralRun }) {
  const busy = run?.status === "running" || run?.status === "waiting";
  return (
    <button className="btn sm" disabled={busy || run?.fine || !run} onClick={() => runFine(spec.label)} data-tip={run?.fine ? "Already at fine resolution" : "Re-run with about 110,000 elements for a closer answer"}>
      <Icon.Refresh size={13} /> {run?.fine ? "fine mesh" : "Run fine"}
    </button>
  );
}

function AskButton({ spec, run, dt, air }: { spec: AnalysisSpec; run?: StructuralRun; dt?: DrivetrainResult; air?: AirflowRun }) {
  const setDraft = useChatDraft((s) => s.set);
  const err = run?.status === "error" ? run.error : air?.status === "error" && air.error !== "Stopped." ? air.error : dt?.error;
  const text = err
    ? `The "${spec.label}" analysis can't run: ${err} Please fix the set-up.`
    : spec.kind === "uci"
      ? `Make the bike pass every item of the "${spec.label}" UCI rules check, keeping it as fast as you can.`
      : spec.kind === "airflow"
        ? `Look at the "${spec.label}" airflow results: where does the drag come from? Reshape the parts that cost the most to cut the drag (keep them strong, legal and makeable), re-run the airflow after each change and tell me what each change saved.`
        : `Explain the "${spec.label}" analysis results and suggest how to strengthen the weakest area without adding much material.`;
  return (
    <button className="btn sm ghost" onClick={() => setDraft(text)}>
      <Icon.Sparkle size={13} /> Ask Claude
    </button>
  );
}

// ---------- structural ----------

function StructuralView({ spec, run }: { spec: StructuralSpec; run?: StructuralRun }) {
  const r = run?.result;
  const busy = run?.status === "running" || run?.status === "waiting";
  return (
    <>
      {busy && <RunProgress run={run!} updating={!!r} />}
      {run?.status === "error" && <RunError spec={spec} run={run} />}
      {r?.modal && <ModesBox spec={spec} r={r} />}
      {r?.drop && <DropBox spec={spec} r={r} />}
      {r && !(r.modal && !(r.maxDisp.value > 0)) && <ResultCards spec={spec} r={r} />}
      <div className="an-cols">
        <div>
          <SetupBox spec={spec} r={r} run={run} />
        </div>
        <div>
          {r && <NotesBox spec={spec} r={r} />}
          {(r || (run && run.trace.length > 1)) && <ConvergenceBox run={run!} r={r} />}
        </div>
      </div>
    </>
  );
}

/** Natural frequencies: one row per mode; picking one swings its shape on the model. */
function ModesBox({ spec, r }: { spec: StructuralSpec; r: StructuralResult }) {
  const picked = useAnalysis((s) => s.mode);
  const shown = useAnalysis((s) => s.shown);
  const active = shown === spec.label ? shownMode(r, picked) : null;
  const hits = resonances(spec, r);
  const text = vibrationText(spec, r);
  const status = vibrationVerdict(spec, r);
  return (
    <div className="an-box" style={{ marginBottom: 12 }}>
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <StatusIcon status={status} />
        <b>Natural frequencies</b>
        <span className="dim mono">
          {[spec.modal?.excite.length ? `against ${spec.modal.excite.map((e) => e.label).join(", ")}` : "", spec.modal?.ringing ? `ringing after ${fmtNum(spec.modal.ringing, 0)} mm/s² moves` : ""].filter(Boolean).join(" · ") || "nothing set to shake it (excite:)"}
        </span>
      </div>
      <table className="an-table">
        <tbody>
          {r.modal!.modes.map((m, i) => {
            const hit = hits.find((h) => h.index === i);
            return (
              <tr
                key={i}
                className={`an-mode ${active === i ? "active" : ""}`}
                onClick={() => {
                  showResults(spec.label);
                  useAnalysis.setState({ mode: i });
                }}
                style={{ cursor: "pointer" }}
                aria-pressed={active === i}
              >
                <td className="mono">{i + 1}</td>
                <td className="mono">{fmtNum(m.freq, m.freq < 100 ? 1 : 0)} Hz</td>
                <td>{modeWords(m)}</td>
                <td className={hit ? hit.status : "dim"}>{hit ? `${hit.source.label}: ${hit.status === "fail" ? "resonates" : "close"}` : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="an-note" style={{ marginTop: 8 }}>
        {text.notes}
      </div>
      {text.fix && <div className="an-note">{text.fix}</div>}
    </div>
  );
}

function DropBox({ spec, r }: { spec: StructuralSpec; r: StructuralResult }) {
  const d = r.drop!;
  const status = dropVerdict(spec, r, strengthVerdict(spec, r).status);
  return (
    <div className="an-grid" style={{ marginBottom: 12 }}>
      <div className={`an-stat ${status}`}>
        <div className="k">{d.tip ? "Tip-over" : "Fall"}</div>
        <div className="v">
          {d.tip ? fmtNum(d.height, 0) : fmtNum(d.height / 1000, 2)}
          <small>{d.tip ? "mm the centre falls" : "m"}</small>
        </div>
        <div className="s">
          onto {d.floor} at {fmtNum(d.speed, 1)} m/s
        </div>
      </div>
      <div className={`an-stat ${status}`}>
        <div className="k">Peak deceleration</div>
        <div className="v">
          {fmtNum(d.g, 0)}
          <small>g</small>
        </div>
        <div className="s">
          {fmtNum(d.force, 0)} N where it lands, over {fmtNum(d.pulseMs, d.pulseMs < 1 ? 2 : 1)} ms
        </div>
      </div>
      <div className={`an-stat ${status}`}>
        <div className="k">The parts feel</div>
        <div className="v">
          {fmtNum(d.felt, 0)}
          <small>g</small>
        </div>
        <div className="s">{Number.isFinite(d.bodyHz) ? `they flex at ${fmtNum(d.bodyHz, 0)} Hz · ×${fmtNum(d.amplification, 2)}` : "they barely flex"}</div>
      </div>
    </div>
  );
}

function RunProgress({ run, updating }: { run: StructuralRun; updating: boolean }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const t = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, (now - run.startedAt) / 1000);
  return (
    <div className="an-box" style={{ marginBottom: 12 }}>
      <div className="row" style={{ gap: 10 }}>
        <span className="spinner" />
        <span style={{ fontSize: 12.5 }}>{updating ? "Updating the results for your latest change" : "Running the stress analysis"}</span>
        <span className="mono dim" style={{ fontSize: 11 }}>
          {run.status === "waiting" ? "queued" : run.stage.toLowerCase()}
          {run.iter ? ` · iteration ${run.iter}` : ""}
          {run.residual ? ` · residual ${run.residual.toExponential(1)}` : ""} · {fmtNum(secs, 1)} s
        </span>
      </div>
      <div className="an-progress">
        <div style={{ width: `${Math.round(run.frac * 100)}%` }} />
      </div>
    </div>
  );
}

function RunError({ spec, run }: { spec: StructuralSpec; run: StructuralRun }) {
  return (
    <div className="an-box" style={{ marginBottom: 12, borderColor: "rgb(var(--fail-rgb) / 0.4)", background: "var(--fail-soft)" }}>
      <div className="an-note" style={{ color: "var(--fail-ink)" }}>
        <Icon.Alert size={15} />
        <div className="grow">
          <div style={{ fontWeight: 600, marginBottom: 2 }}>{run.setup ? "This set-up can't be solved as written" : "The analysis did not finish"}</div>
          {run.error}
        </div>
        <button className="btn sm" onClick={() => revealSpan(spec.span)}>
          <Icon.Code size={13} /> Show in code
        </button>
      </div>
    </div>
  );
}

function ResultCards({ spec, r }: { spec: StructuralSpec; r: StructuralResult }) {
  const field = useAnalysis((s) => s.field);
  const shown = useAnalysis((s) => s.shown);
  const pick = (f: ResultField) => {
    useAnalysis.setState({ field: f });
    showResults(spec.label);
  };
  const on = (f: ResultField) => shown === spec.label && field === f;
  const sf = r.minSafety.value;
  const st = strengthVerdict(spec, r).status;
  const away = safetyAway(r);
  const dispStatus: Status | "" = spec.maxDeflection === undefined ? "" : r.maxDisp.value <= spec.maxDeflection ? "pass" : "fail";
  const sfBar = safetyColor(safetyT(sf, spec.safety)).map((c) => Math.round(c * 255)).join(",");
  const exag = autoDeform(r);
  return (
    <div className="an-grid">
      <button className={`an-stat ${st} ${on("safety") ? "active" : ""}`} onClick={() => pick("safety")}>
        <div className="k">Safety factor</div>
        <div className="v">
          {sfText(sf)}
          <small>target {fmtNum(spec.safety, 1)}</small>
        </div>
        <div className="s">
          against {modeText(r, spec.cycles)}
          {away && ` · ${sfText(away.value)} a short way from the support or load`}
        </div>
        <div className="bar" style={{ background: `rgb(${sfBar})` }} />
      </button>
      <button className={`an-stat ${on("stress") ? "active" : ""}`} onClick={() => pick("stress")}>
        <div className="k">Peak stress</div>
        <div className="v">
          {fmtNum(r.maxStress.value, r.maxStress.value < 10 ? 2 : 1)}
          <small>MPa</small>
        </div>
        <div className="s">von Mises near {v3(r.maxStress.at)}{r.maxStress.nearBoundary && r.maxStress.away ? ` · ${fmtNum(r.maxStress.away.value, 1)} MPa just off the support or load` : ""}</div>
      </button>
      <button className={`an-stat ${dispStatus} ${on("disp") ? "active" : ""}`} onClick={() => pick("disp")}>
        <div className="k">Deflection</div>
        <div className="v">
          {fmtNum(r.maxDisp.value, r.maxDisp.value < 0.1 ? 4 : 3)}
          <small>mm</small>
        </div>
        <div className="s">
          {spec.maxDeflection !== undefined ? `limit ${fmtNum(spec.maxDeflection, 3)} mm · ` : ""}at {v3(r.maxDisp.at)}
          {exag > 1.5 ? ` · drawn ×${fmtNum(exag, exag < 10 ? 1 : 0)}` : ""}
        </div>
      </button>
      <button className={`an-stat ${on("strain") ? "active" : ""}`} onClick={() => pick("strain")}>
        <div className="k">Peak strain</div>
        <div className="v">
          {fmtNum(Math.abs(r.maxStrain.value) * 100, 3)}
          <small>%</small>
        </div>
        <div className="s">largest principal strain, {fmtNum(Math.abs(r.maxStrain.value) * 1e6, 0)} µε</div>
      </button>
      <div className="an-stat">
        <div className="k">Mass</div>
        <div className="v">
          {fmtNum(r.mass, r.mass < 10 ? 2 : 1)}
          <small>g</small>
        </div>
        <div className="s">{fmtNum(r.volume / 1000, 2)} cm³ of {[...new Set(r.materials.map((m) => m.name))].join(", ")}</div>
      </div>
      <div className="an-stat">
        <div className="k">Model</div>
        <div className="v">
          {r.mesh.elements.toLocaleString()}
          <small>elements</small>
        </div>
        <div className="s">
          {r.mesh.cell.map((c) => fmtNum(c, 2)).join(" × ")} mm cells · {fmtNum(r.solve.ms.total / 1000, 1)} s
        </div>
      </div>
    </div>
  );
}

function SetupBox({ spec, r, run }: { spec: StructuralSpec; r?: StructuralResult; run?: StructuralRun }) {
  const loadText = (i: number) => {
    const l = spec.loads[i];
    const info = r?.loads[i];
    if (l.t === "force") return `${fmtNum(Math.hypot(...l.f), 1)} N along ${v3(l.f.map((x) => x / (Math.hypot(...l.f) || 1)))} on ${describeRegion(l.region)}`;
    if (l.t === "pressure") return `${fmtNum(l.p, 3)} MPa on ${describeRegion(l.region)}${info ? ` (${fmtNum(info.magnitude, 1)} N over ${fmtNum(info.area, 0)} mm²)` : ""}`;
    return `${fmtNum(l.torque / 1000, 2)} N·m about ${v3(l.axis)} on ${describeRegion(l.region)}`;
  };
  return (
    <div className="an-box">
      <h4>
        Set-up
        <div className="grow" />
        <button className="btn sm ghost" style={{ height: 20 }} onClick={() => revealSpan(spec.span)}>
          <Icon.Code size={12} /> edit
        </button>
      </h4>
      <div className="an-setup">
        <div>
          <span className="tag">parts</span>
          {spec.parts.join(", ")}
        </div>
        <div>
          <span className="tag">material</span>
          {r ? r.materials.map((m) => `${m.name} (E ${fmtNum(m.E / 1000, 1)} GPa, yield ${fmtNum(m.yield, 0)} MPa${m.assumed ? ", assumed" : ""})`).join("; ") : spec.material ?? "from the parts"}
        </div>
        {spec.supports.map((s, i) => (
          <div key={`s${i}`}>
            <span className="tag">{s.dir ? "roller" : "fixed"}</span>
            {describeRegion(s.region)}
            {s.dir ? ` · held along ${v3(s.dir)}` : ""}
            {r?.supports[i] ? <span className="dim"> · reaction {fmtNum(Math.hypot(...r.supports[i].reaction), 1)} N</span> : null}
          </div>
        ))}
        {spec.loads.map((_, i) => (
          <div key={`l${i}`}>
            <span className="tag">{spec.loads[i].t}</span>
            {loadText(i)}
          </div>
        ))}
        {spec.accel && (
          <div>
            <span className="tag">accel</span>
            {v3(spec.accel)} g
          </div>
        )}
        {(spec.printed || r?.materials.some((m) => m.layerFactor < 1)) && (
          <div>
            <span className="tag">printed</span>
            layers stacked along {v3(spec.buildDir)}
          </div>
        )}
        {spec.cycles !== undefined && (
          <div>
            <span className="tag">cycles</span>
            {spec.cycles.toExponential(0)}
          </div>
        )}
        <div>
          <span className="tag">mesh</span>
          {run?.resolution ?? (typeof spec.resolution === "string" ? spec.resolution : `${spec.resolution.h} mm`)}
        </div>
      </div>
    </div>
  );
}

function NotesBox({ spec, r }: { spec: StructuralSpec; r: StructuralResult }) {
  return (
    <div className="an-box">
      <h4>What to keep in mind</h4>
      {r.warnings.map((w, i) => (
        <div key={i} className="an-note">
          <Icon.Alert size={13} style={{ color: "var(--warn)" }} />
          <span>{w}</span>
        </div>
      ))}
      <div className="an-note">
        <Icon.Info size={13} style={{ color: "var(--text-3)" }} />
        <span className="dim">
          Linear elastic analysis on a {fmtNum(r.mesh.h, 2)} mm voxel grid: small deflections, no contact, buckling or creep. Peaks are smoothed at sharp corners and fillets smaller than a cell. Use it to compare designs and find weak spots; test a printed part before relying on it{spec.safety < 2 ? ", especially with a safety target under 2" : ""}.
        </span>
      </div>
    </div>
  );
}

function ConvergenceBox({ run, r }: { run: StructuralRun; r?: StructuralResult }) {
  const trace = run.status === "running" && run.trace.length > 1 ? run.trace : r?.solve.history ?? run.trace;
  const pts = useMemo(() => {
    const ys = trace.map((v) => Math.log10(Math.max(v, 1e-12)));
    if (ys.length < 2) return "";
    const lo = Math.min(-6.5, ...ys);
    const hi = Math.max(0, ...ys);
    return ys.map((y, i) => `${((i / (ys.length - 1)) * 100).toFixed(2)},${(4 + ((hi - y) / (hi - lo)) * 46).toFixed(2)}`).join(" ");
  }, [trace]);
  const balance = r ? r.equilibrium : null;
  return (
    <div className="an-box">
      <h4>
        Solver
        <div className="grow" />
        {r && (
          <span className={`chip ${r.solve.converged ? "pass" : "warn"}`} style={{ height: 18, letterSpacing: 0, textTransform: "none" }}>
            {r.solve.converged ? `converged in ${r.solve.iterations}` : `stopped at ${r.solve.iterations}`}
          </span>
        )}
      </h4>
      {pts && (
        <svg className="an-spark" viewBox="0 0 100 54" preserveAspectRatio="none" aria-label="Residual per iteration">
          <polyline points={pts} fill="none" stroke="var(--accent-2)" strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      <div className="mono dim" style={{ fontSize: 10.5, marginTop: 4 }}>
        residual per iteration (log)
        {r && ` · ${r.mesh.levels} grid levels · ${r.mesh.dofs.toLocaleString()} unknowns`}
        {balance !== null && ` · reactions balance loads within ${balance < 1e-3 ? "0.1" : fmtNum(balance * 100, 1)}%`}
      </div>
    </div>
  );
}

// ---------- UCI rules ----------

function UciView({ spec, items }: { spec: UciSpec; items: CheckItem[] }) {
  const model = useDesign((s) => s.model);
  const r = model ? uciResult(model, spec.label) : undefined;
  if (!items.length) return <div className="mono dim">Measuring…</div>;
  const st = (key: string): Status => (items.find((i) => i.id === `uci:${spec.label}:${key}`)?.status as Status) ?? "info";
  const L = UCI_ROAD;
  const stat = (key: string, k: string, v: number | undefined, unit: string, s: string, d = 0) =>
    v !== undefined && (
      <div className={`an-stat ${st(key)}`}>
        <div className="k">{k}</div>
        <div className="v">
          {fmtNum(v, d)}
          <small>{unit}</small>
        </div>
        <div className="s">{s}</div>
      </div>
    );
  const order: Record<string, number> = { fail: 0, warn: 1, pending: 2, pass: 3, info: 4 };
  return (
    <>
      <div className="an-grid">
        {stat("weight", "Weight", r?.weight !== undefined ? r.weight / 1000 : undefined, "kg", `at least ${fmtNum(L.weight / 1000, 1)} kg${r?.declared.length ? ` · ${r.declared.length} part${r.declared.length === 1 ? "" : "s"} by mass:` : ""}`, 2)}
        {stat("setback", "Saddle setback", r?.setback, "mm", `nose behind the crank axle, at least ${L.setback}`)}
        {stat("bar-width", "Bar width", r?.barWidth, "mm", `outside to outside, at least ${L.barWidth}`)}
        {stat("hoods", "Lever gap", r?.hoodGap, "mm", `inside to inside, at least ${L.hoodGap}`)}
        {stat("bb-height", "Bottom bracket", r?.bbHeight, "mm", `above the ground, ${L.bbHeight[0]} to ${L.bbHeight[1]}`)}
        {stat("size", "Length", r?.length, "mm", `at most ${L.length}; ${fmtNum(r?.width ?? 0, 0)} wide of ${L.width}`)}
      </div>
      <div className="an-box" style={{ marginTop: 12 }}>
        <h4>UCI road racing rules (2026)</h4>
        {[...items]
          .sort((a, b) => order[a.status] - order[b.status])
          .map((i) => (
            <div key={i.id} className="an-note">
              <StatusIcon status={i.status} />
              <span className="grow">
                <b>{i.title.replace(/^UCI: /, "")}</b> <span className="dim">{i.detail}</span>
                {i.fix && <div style={{ marginTop: 2 }}>{i.fix}</div>}
              </span>
            </div>
          ))}
      </div>
    </>
  );
}

// ---------- drivetrain ----------

function DrivetrainView({ spec, result }: { spec: DrivetrainSpec; result?: DrivetrainResult }) {
  if (!result) return <div className="mono dim">Calculating…</div>;
  if (result.error)
    return (
      <div className="an-box" style={{ borderColor: "rgb(var(--fail-rgb) / 0.4)", background: "var(--fail-soft)" }}>
        <div className="an-note" style={{ color: "var(--fail-ink)" }}>
          <Icon.Alert size={15} />
          <span className="grow">{result.error}</span>
          <button className="btn sm" onClick={() => revealSpan(spec.span)}>
            <Icon.Code size={13} /> Show in code
          </button>
        </div>
      </div>
    );
  const teeth = result.meshes.flatMap((m) => m.teeth.map((t) => ({ ...t, force: m.force, speed: m.speed })));
  const weakTooth = teeth.reduce<(typeof teeth)[number] | null>((a, t) => (!a || t.safety < a.safety ? t : a), null);
  const shortBearing = result.bearings.reduce<DrivetrainResult["bearings"][number] | null>((a, b) => (!a || b.life < a.life ? b : a), null);
  const weakShaft = result.shafts.reduce<DrivetrainResult["shafts"][number] | null>((a, s) => (!a || s.safety < a.safety ? s : a), null);
  const out = result.outputs[result.outputs.length - 1];
  const lifeTarget = spec.life;
  return (
    <>
      <div className="an-grid">
        <div className="an-stat">
          <div className="k">Input</div>
          <div className="v">
            {fmtNum(result.power, result.power < 10 ? 2 : 1)}
            <small>W</small>
          </div>
          <div className="s">
            {fmtNum(spec.torque / 1000, 3)} N·m at {fmtNum(spec.speed, 0)} rpm
          </div>
        </div>
        {out && (
          <div className="an-stat">
            <div className="k">Output</div>
            <div className="v">
              {fmtNum(out.torque / 1000, 2)}
              <small>N·m</small>
            </div>
            <div className="s">
              {out.name} at {fmtNum(out.rpm, 1)} rpm
            </div>
          </div>
        )}
        {weakTooth && (
          <div className={`an-stat ${sfStatus(weakTooth.safety, spec.safety)}`}>
            <div className="k">Weakest teeth</div>
            <div className="v">
              {sfText(weakTooth.safety)}
              <small>safety</small>
            </div>
            <div className="s">
              {weakTooth.gear} (z{weakTooth.z}): {fmtNum(weakTooth.stress, 1)} of {fmtNum(weakTooth.allowable, 1)} MPa
            </div>
          </div>
        )}
        {shortBearing && (
          <div className={`an-stat ${lifeTarget === undefined ? "" : shortBearing.life >= lifeTarget ? "pass" : "fail"}`}>
            <div className="k">Shortest bearing life</div>
            <div className="v">
              {Number.isFinite(shortBearing.life) ? fmtHours(shortBearing.life) : "∞"}
              <small>h</small>
            </div>
            <div className="s">
              {shortBearing.id} ({shortBearing.code}) · {fmtNum(shortBearing.load, 1)} N{lifeTarget !== undefined ? ` · target ${fmtHours(lifeTarget)} h` : ""}
            </div>
          </div>
        )}
        {weakShaft && (
          <div className={`an-stat ${sfStatus(weakShaft.safety, spec.safety)}`}>
            <div className="k">Weakest shaft</div>
            <div className="v">
              {sfText(weakShaft.safety)}
              <small>safety</small>
            </div>
            <div className="s">
              ⌀{fmtNum(weakShaft.d, 1)} mm {weakShaft.material}
              {weakShaft.assumed ? " (assumed)" : ""} · {fmtNum(weakShaft.shear, 1)} MPa shear
            </div>
          </div>
        )}
      </div>

      {teeth.length > 0 && (
        <div className="an-box" style={{ marginTop: 12 }}>
          <h4>Gear teeth · bending (Lewis)</h4>
          <table className="an-table">
            <thead>
              <tr>
                <th>Gear</th>
                <th className="num">Teeth</th>
                <th>Material</th>
                <th className="num">Tooth force</th>
                <th className="num">Stress</th>
                <th className="num">Allowable</th>
                <th>Safety</th>
              </tr>
            </thead>
            <tbody>
              {teeth.map((t, i) => (
                <tr key={i}>
                  <td>{t.gear}</td>
                  <td className="num">{t.z}</td>
                  <td>{t.material}</td>
                  <td className="num">{fmtNum(t.force, 1)} N</td>
                  <td className="num">{fmtNum(t.stress, 1)} MPa</td>
                  <td className="num">
                    {fmtNum(t.allowable, 1)} MPa <span className="dim">{t.basis}</span>
                  </td>
                  <td>
                    <SafetyMeter sf={t.safety} target={spec.safety} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="an-cols">
        <div>
          {result.bearings.length > 0 && (
            <div className="an-box">
              <h4>Bearings · rating life (L10)</h4>
              <table className="an-table">
                <thead>
                  <tr>
                    <th>Bearing</th>
                    <th className="num">Load</th>
                    <th className="num">Speed</th>
                    <th className="num">Life</th>
                    <th>{lifeTarget !== undefined ? "Status" : ""}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.bearings.map((b) => (
                    <tr key={b.id}>
                      <td>
                        {b.id} <span className="dim mono">{b.code}</span>
                      </td>
                      <td className="num">{fmtNum(b.load, 1)} N</td>
                      <td className="num">{fmtNum(b.rpm, 0)} rpm</td>
                      <td className="num">{Number.isFinite(b.life) ? `${fmtHours(b.life)} h` : "∞"}</td>
                      <td>{lifeTarget !== undefined && <StatusIcon status={b.life >= lifeTarget ? "pass" : "fail"} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {result.shafts.length > 0 && (
            <div className="an-box">
              <h4>Shafts · torsion</h4>
              <table className="an-table">
                <thead>
                  <tr>
                    <th>Carries</th>
                    <th className="num">⌀</th>
                    <th className="num">Torque</th>
                    <th className="num">Shear</th>
                    <th>Safety</th>
                  </tr>
                </thead>
                <tbody>
                  {result.shafts.map((s, i) => (
                    <tr key={i}>
                      <td>{s.gears.join(", ")}</td>
                      <td className="num">{fmtNum(s.d, 1)} mm</td>
                      <td className="num">{fmtNum(s.torque / 1000, 3)} N·m</td>
                      <td className="num">{fmtNum(s.shear, 1)} MPa</td>
                      <td>
                        <SafetyMeter sf={s.safety} target={spec.safety} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div>
          <div className="an-box">
            <h4>What to keep in mind</h4>
            {result.warnings.map((w, i) => (
              <div key={i} className="an-note">
                <Icon.Alert size={13} style={{ color: "var(--warn)" }} />
                <span>{w}</span>
              </div>
            ))}
            <div className="an-note">
              <Icon.Info size={13} style={{ color: "var(--text-3)" }} />
              <span className="dim">
                First-pass textbook sizing: Lewis tooth bending with a velocity factor, bearing L10 life from the tooth loads, and shaft torsion. It leaves out tooth contact (pitting) stress, wear, heat build-up in plastic gears and misalignment, so run the real mechanism under load before trusting it.
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function fmtHours(h: number): string {
  if (h >= 1e6) return `${fmtNum(h / 1e6, 1)}M`;
  if (h >= 1e4) return `${fmtNum(h / 1000, 0)}k`;
  return fmtNum(h, h < 10 ? 1 : 0);
}

function SafetyMeter({ sf, target }: { sf: number; target: number }) {
  const t = safetyT(sf, target);
  const c = safetyColor(t).map((v) => Math.round(v * 255)).join(",");
  const st = sfStatus(sf, target);
  return (
    <span className="row" style={{ gap: 8 }}>
      <span className="an-meter" aria-hidden="true">
        <div style={{ width: `${Math.max(3, t * 100)}%`, background: `rgb(${c})` }} />
        <span className="goal" style={{ left: "50%" }} />
      </span>
      <span className="mono" style={{ fontSize: 11.5, color: st === "fail" ? "var(--fail)" : st === "warn" ? "var(--warn)" : "var(--pass)" }}>
        {sfText(sf)}
      </span>
    </span>
  );
}

// ---------- adding one ----------

/** The kinds of analysis this design could have, each a draft for Claude, so a second kind is as easy to add as the first. */
function AddAnalysis() {
  const model = useDesign((s) => s.model);
  const setDraft = useChatDraft((s) => s.set);
  const kinds = kindsFor(model);
  return (
    <Menu
      width={330}
      trigger={(open, toggle) => (
        <button className={`an-add ${open ? "open" : ""}`} onClick={toggle} aria-label="Add an analysis" data-tip="Add an analysis: Claude sets it up from how the design is used">
          <Icon.Plus size={12} /> add
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="menu-label">Ask Claude to set up</div>
          {kinds.map((k) => {
            const I = Icon[k.icon];
            const n = model?.analyses.filter(k.is).length ?? 0;
            return (
              <MenuItem key={k.id} icon={<I size={14} />} hint={n ? `${n} here` : undefined} onClick={() => (close(), setDraft(k.ask))}>
                <div>
                  <div>{k.label}</div>
                  <div className="dim" style={{ fontSize: 11 }}>
                    {k.detail}
                  </div>
                </div>
              </MenuItem>
            );
          })}
        </>
      )}
    </Menu>
  );
}

// ---------- empty state ----------

function EmptyState() {
  const setDraft = useChatDraft((s) => s.set);
  const model = useDesign((s) => s.model);
  const kinds = kindsFor(model);
  return (
    <div className="an-body">
      <div className="an-empty">
        <div>
          <div className="row" style={{ gap: 10, marginBottom: 8 }}>
            <span style={{ color: "var(--accent-2)" }}>
              <Icon.Stress size={22} />
            </span>
            <span style={{ fontWeight: 600, fontSize: 14 }}>No analysis yet</span>
          </div>
          <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
            An analysis puts the design through what it will face in use and colours the model with the results. Each one adds checks that re-run whenever the design changes. Pick one and Claude works out the loads, speeds or rules from what the design is for.
          </div>
          <div className="an-kinds">
            {kinds.map((k, i) => {
              const I = Icon[k.icon];
              return (
                <button key={k.id} className={`an-kind ${i === 0 ? "first" : ""}`} onClick={() => setDraft(k.ask)}>
                  <span className="an-kind-icon">
                    <I size={15} />
                  </span>
                  <span>
                    <span className="an-kind-label">{k.label}</span>
                    <span className="an-kind-detail">{k.detail}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <pre className="an-code">
          <span className="kw">analysis</span> <span className="str">"Shelf load"</span> {"{"}
          {"\n  "}parts: [bracket]
          {"\n  "}fix: <span className="fn">face</span>(bracket, -Y) <span className="cm">// screwed to the wall</span>
          {"\n  "}load: <span className="fn">force</span>(<span className="fn">face</span>(bracket, +Z), (0, 0, -<span className="num">50N</span>))
          {"\n  "}safety: <span className="num">2</span>
          {"\n  "}max_deflection: <span className="num">0.5mm</span>
          {"\n"}
          {"}"}
        </pre>
      </div>
    </div>
  );
}
