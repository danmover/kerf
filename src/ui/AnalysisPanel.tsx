// The analysis tab: pick an analysis, see its key numbers, set-up, notes
// and convergence, and choose how its results are drawn on the model.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { useDesign } from "../core/engine";
import { useView, revealSpan } from "../app/view";
import { useAnalysis, showResults, runFine, runAccuracyCheck, runTopology, stopTopology, type StructuralRun, type ResultField } from "../analysis/runtime";
import { topologyText } from "../analysis/topologySummary";
import { fileStem, outlineDxf, shapeStl } from "../analysis/topologyExport";
import { download } from "../persist/files";
import { dirWords, largeText, modeText, staticSafety, strengthVerdict, structuralVerdict } from "../analysis/summary";
import { count, designWords, fatigueText, fatigueVerdict, lifeText } from "../analysis/fatigueSummary";
import { cycleWords, cyclesAt, MEAN_STRESS, type SnCurve } from "../analysis/fe/fatigue";
import { describeRegion, type AnalysisSpec, type DrivetrainSpec, type StructuralSpec, type StudySpec, type UciSpec } from "../analysis/spec";
import { applyStudyRun, startStudy, stopStudy, useStudies, type StudyState } from "../analysis/studyRuntime";
import type { StudyRun } from "../analysis/study";
import { MEASURE_UNIT } from "../analysis/studyLang";
import { uciItems, uciVerdict } from "../analysis/summary";
import { uciResult, UCI_ROAD } from "../core/uciChecks";
import type { CheckItem } from "../core/checks";
import type { StructuralResult, ThermalResult } from "../analysis/fe/structural";
import type { DrivetrainResult } from "../analysis/drivetrain";
import { safetyColor, safetyT } from "../analysis/colormap";
import { FIELD_INFO, autoDeform, fieldFor, resultFields, shownMode } from "./ResultsLayer";
import { accuracyText, amps, bucklingText, bucklingVerdict, degC, density, duration, ohms, temperatureText, temperatureVerdict, volts, watts } from "../analysis/thermalSummary";
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
  const studies = useStudies((s) => s.runs);
  const specs = model?.analyses ?? [];
  const spec = specs.find((a) => a.label === selected) ?? specs.find((a) => a.label === shown) ?? specs[0];

  if (!model) return <div className="an-body mono dim">Building the design…</div>;
  if (!specs.length) return <EmptyState />;
  return (
    <div className="an">
      <div className="an-head">
        {specs.map((a) => (
          <Pick key={a.label} spec={a} active={a.label === spec?.label} run={runs.get(a.label)} dt={drivetrain.get(a.label)} items={report?.items} air={airRuns.get(a.label)} study={studies.get(a.label)} />
        ))}
        <AddAnalysis />
        <div className="grow" />
        {spec?.kind === "structural" && !spec.topology && <FineButton spec={spec} run={runs.get(spec.label)} />}
        {spec?.kind === "structural" && !spec.topology && <AccuracyButton spec={spec} run={runs.get(spec.label)} />}
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
            {spec?.kind === "study" && <StudyView spec={spec} st={studies.get(spec.label)} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

// ---------- header ----------

function Pick({ spec, active, run, dt, items, air, study }: { spec: AnalysisSpec; active: boolean; run?: StructuralRun; dt?: DrivetrainResult; items?: CheckItem[]; air?: AirflowRun; study?: StudyState }) {
  let status: Status = "pending";
  let val = "";
  if (spec.kind === "study") {
    const best = study?.result && study.result.best !== null ? study.result.runs[study.result.best] : null;
    if (study?.status === "running") val = `${study.progress?.done ?? 0}/${spec.runs}`;
    else if (study?.status === "error") {
      status = "fail";
      val = "error";
    } else if (study?.result) {
      status = best ? "pass" : "fail";
      val = best && best.goal !== null ? `${fmtNum(best.goal, Math.abs(best.goal) < 10 ? 2 : 1)}${MEASURE_UNIT[spec.goal.what] ? ` ${MEASURE_UNIT[spec.goal.what]}` : ""}` : "none pass";
    }
  } else if (spec.kind === "uci") {
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
  } else if (spec.kind === "structural" && spec.topology) {
    const t = run?.result?.topology;
    if (run?.status === "error") {
      status = "fail";
      val = "error";
    } else if (run?.status === "running" || run?.status === "waiting") val = `${Math.round((run.frac ?? 0) * 100)}%`;
    else if (t) {
      status = "info";
      val = `${Math.round(t.kept * 100)} % · ${Math.round(t.stiffness * 100)} % stiff${run?.status === "idle" ? " · old" : ""}`;
    } else {
      status = "info";
      val = "ready";
    }
  } else if (spec.kind === "structural") {
    if (run?.status === "error") {
      status = "fail";
      val = "error";
    } else if (run?.result && run.status === "done") {
      const r = run.result;
      status = structuralVerdict(spec, r);
      const buckle = r.buckling?.factors[0];
      val = r.heatOnly && r.thermal
        ? degC(r.thermal.maxTemp.value)
        : r.drop
          ? `${fmtNum(r.drop.g, 0)} g · SF ${sfText(r.minSafety.value)}`
          : r.modal && !(r.maxDisp.value > 0)
            ? `${fmtNum(r.modal.modes[0]?.freq ?? 0, 0)} Hz`
            : `SF ${sfText(r.minSafety.value)}${buckle !== undefined ? ` · buckles ×${fmtNum(buckle, buckle < 10 ? 1 : 0)}` : r.thermal && spec.thermal ? ` · ${degC(r.thermal.maxTemp.value)}` : ""}`;
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
  const r = run?.result;
  const hasResult = !!r;
  const heatOnly = !!r?.heatOnly;
  return (
    <div className="an-ctl">
      <button className={`an-toggle ${on ? "on" : ""}`} disabled={!hasResult} onClick={() => showResults(on ? null : spec.label)} aria-pressed={on} data-tip="Colour the model by the results">
        {on ? <Icon.Eye size={13} /> : <Icon.EyeOff size={13} />} on model
      </button>
      {!heatOnly && (
        <Segmented<ResultField>
          id="an-field"
          value={fieldFor(r, field)}
          onChange={(f) => {
            useAnalysis.setState({ field: f });
            if (hasResult) showResults(spec.label);
          }}
          options={resultFields(r).map((f) => ({ value: f, label: FIELD_INFO[f].short.toLowerCase(), title: FIELD_INFO[f].label }))}
        />
      )}
      {!heatOnly && <ShapeControls deform={deform} trueScale={trueScale} animate={animate} />}
    </div>
  );
}

/** How the deformed shape is drawn: exaggeration, true scale and animation. */
function ShapeControls({ deform, trueScale, animate }: { deform: number; trueScale: boolean; animate: boolean }) {
  return (
    <>
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
    </>
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

function AccuracyButton({ spec, run }: { spec: StructuralSpec; run?: StructuralRun }) {
  const busy = run?.status === "running" || run?.status === "waiting";
  const checked = !!run?.result?.convergence;
  return (
    <button className="btn sm" disabled={busy || checked || !run?.result} onClick={() => runAccuracyCheck(spec.label)} data-tip={checked ? "Solved twice: see Accuracy below" : "Solve again with smaller elements and show how far each answer moves"}>
      <Icon.Target size={13} /> {checked ? "accuracy checked" : "Check accuracy"}
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
      : spec.kind === "study"
        ? `Run the "${spec.label}" design study, tell me which design is best and why, and apply it if it still passes everything.`
        : spec.kind === "structural" && spec.topology
        ? run?.result?.topology
          ? `Model the shape the "${spec.label}" topology optimisation found as a real part: follow its members and openings${run.result.topology.outline ? " (use its profile outline)" : ""}, round it for making it, keep the mounting faces and holes, then check the new part in its own analysis against the same loads and tell me its mass and safety factor.`
          : `Run the "${spec.label}" topology optimisation and tell me what shape it finds.`
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
  if (spec.topology) return <TopologyView spec={spec} run={run} />;
  return (
    <>
      {busy && <RunProgress run={run!} updating={!!r} />}
      {run?.status === "error" && <RunError spec={spec} run={run} />}
      {r?.modal && <ModesBox spec={spec} r={r} />}
      {r?.drop && <DropBox spec={spec} r={r} />}
      {r?.thermal && <HeatBox spec={spec} r={r} />}
      {r?.thermal?.currents?.length ? <CurrentBox spec={spec} r={r} /> : null}
      {r?.buckling && <BucklingBox spec={spec} r={r} />}
      {r?.fatigue && <FatigueBox spec={spec} r={r} />}
      {r && !r.heatOnly && !(r.modal && !(r.maxDisp.value > 0)) && <ResultCards spec={spec} r={r} />}
      <div className="an-cols">
        <div>
          <SetupBox spec={spec} r={r} run={run} />
          {r && <AccuracyBox spec={spec} r={r} run={run} />}
        </div>
        <div>
          {r && <NotesBox spec={spec} r={r} />}
          {(r || (run && run.trace.length > 1)) && <ConvergenceBox run={run!} r={r} />}
        </div>
      </div>
    </>
  );
}

// ---------- topology optimisation ----------

const pctText = (x: number) => `${fmtNum(x * 100, x < 0.1 ? 1 : 0)} %`;
const gramsText = (g: number) => (g >= 1000 ? `${fmtNum(g / 1000, 2)} kg` : `${fmtNum(g, g < 10 ? 1 : 0)} g`);

function TopologyView({ spec, run }: { spec: StructuralSpec; run?: StructuralRun }) {
  const r = run?.result?.topology ? run.result : undefined;
  return (
    <>
      <TopologyBox spec={spec} run={run} />
      {r && <ResultCards spec={spec} r={r} />}
      <div className="an-cols">
        <div>
          <SetupBox spec={spec} r={r} run={run} />
        </div>
        <div>{r && <NotesBox spec={spec} r={r} />}</div>
      </div>
    </>
  );
}

/** Find the stiffest shape for the loads from a share of the material: run it, watch it, and take the shape away. */
function TopologyBox({ spec, run }: { spec: StructuralSpec; run?: StructuralRun }) {
  const t = spec.topology!;
  const r = run?.result?.topology ? run.result : undefined;
  const topo = r?.topology;
  const busy = run?.status === "running" || run?.status === "waiting";
  const old = !!r && run?.status === "idle";
  const setDraft = useChatDraft((s) => s.set);
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!busy) return;
    const i = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(i);
  }, [busy]);
  const start = () => {
    runTopology(spec.label);
    showResults(spec.label);
  };
  const tx = r ? topologyText(spec, r) : null;
  const dxf = r ? outlineDxf(r) : null;
  const sf = r ? staticSafety(r).value : 0;
  const what = [`keep ${pctText(t.keep)}`, t.cut ? `cut through ${t.cut}` : "", t.symmetry.length ? `mirrored across ${t.symmetry.join(", ")}` : "", t.preserve.length || t.preserveParts.length ? `${t.preserve.length + t.preserveParts.length} kept solid` : ""].filter(Boolean).join(" · ");
  return (
    <div className="an-box" style={{ marginBottom: 12 }}>
      <div className="row" style={{ gap: 8, marginBottom: 6 }}>
        <Icon.Wand size={14} style={{ color: "var(--text-3)" }} />
        <b>Topology optimisation</b>
        <span className="dim mono">{what}</span>
        <div className="grow" />
        {busy ? (
          <button className="btn sm" onClick={() => stopTopology(spec.label)}>
            <Icon.Stop size={13} /> Stop
          </button>
        ) : (
          <button className="btn sm primary" onClick={start} disabled={!run} data-tip="Find the stiffest shape for these loads with this much of the material">
            <Icon.Play size={13} /> {r ? "Run again" : "Find the shape"}
          </button>
        )}
      </div>
      {!r && !busy && (
        <div className="an-note">
          <span className="dim">
            Finds the stiffest shape for these loads that keeps {pctText(t.keep)} of the parts&apos; material, cutting away what carries little. Where the parts are held and loaded stays solid
            {t.preserve.length || t.preserveParts.length ? ", and so does what preserve: names" : ""}. It runs only when asked, about half a minute at the standard resolution, and the shape forms on the model as it goes.
          </span>
        </div>
      )}
      {busy && run && (
        <>
          <div className="mono dim" style={{ fontSize: 11, marginTop: 4 }}>
            {run.status === "waiting" ? "queued" : run.stage.toLowerCase()} · {fmtNum(Math.max(0, (now - run.startedAt) / 1000), 1)} s
          </div>
          <div className="an-progress">
            <div style={{ width: `${Math.round(run.frac * 100)}%` }} />
          </div>
        </>
      )}
      {old && (
        <div className="an-note" style={{ marginBottom: 8 }}>
          <Icon.Alert size={13} />
          <span>The design changed since this shape was found. Run it again to update it.</span>
        </div>
      )}
      {r && topo && (
        <>
          <div className="an-grid" style={{ margin: "6px 0 10px" }}>
            <div className="an-stat">
              <div className="k">Material kept</div>
              <div className="v">
                {fmtNum(topo.kept * 100, 0)}
                <small>%</small>
              </div>
              <div className="s">
                {gramsText(topo.massBefore)} down to {gramsText(topo.massAfter)}
              </div>
            </div>
            <div className="an-stat">
              <div className="k">Stiffness kept</div>
              <div className="v">
                {fmtNum(topo.stiffness * 100, 0)}
                <small>%</small>
              </div>
              <div className="s">of the solid parts&apos;; spread evenly about {pctText(Math.pow(topo.kept, 3))}</div>
            </div>
            <div className="an-stat">
              <div className="k">Openings</div>
              <div className="v">{topo.openings}</div>
              <div className="s">
                {topo.pieces > 1 ? `${topo.pieces} pieces` : "one piece"} · members ≥ {fmtNum(topo.minMember, 1)} mm
              </div>
            </div>
            <div className={`an-stat ${tx?.weak ? "fail" : "pass"}`}>
              <div className="k">The shape&apos;s safety</div>
              <div className="v">
                {sfText(sf)}
                <small>target {fmtNum(spec.safety, 1)}</small>
              </div>
              <div className="s">{tx?.weak ? "too weak as it is: keep more or thicken it" : "as found, under these loads"}</div>
            </div>
          </div>
          <TopologyChart history={topo.history} />
          {tx?.fix && <div className="an-note">{tx.fix}</div>}
          <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            <button className="btn sm" onClick={() => download(shapeStl(r, `Kerf: ${spec.label}`), `${fileStem(spec.label)}.stl`, "model/stl")} data-tip="The shape as a mesh, to print or to model over">
              <Icon.Download size={13} /> STL
            </button>
            {dxf && (
              <button className="btn sm" onClick={() => download(dxf, `${fileStem(spec.label)}.dxf`, "application/dxf")} data-tip={`The profile 1:1 for a laser, waterjet or router (${fmtNum((topo.outline?.to ?? 0) - (topo.outline?.from ?? 0), 1)} mm plate)`}>
                <Icon.Download size={13} /> DXF profile
              </button>
            )}
            <button
              className="btn sm ghost"
              onClick={() =>
                setDraft(
                  `Model the shape the "${spec.label}" topology optimisation found as a real part: follow its members and openings${topo.outline ? " (use its profile outline)" : ""}, round it for making it, keep the mounting faces and holes, then check the new part in its own analysis against the same loads and tell me its mass and safety factor.`,
                )
              }
            >
              <Icon.Sparkle size={13} /> Model it with Claude
            </button>
            <div className="grow" />
            <span className="mono dim" style={{ fontSize: 10.5 }}>
              {topo.converged ? "settled" : "stopped"} after {topo.iterations} steps · {fmtNum(topo.ms / 1000, 1)} s
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/** How the stiffness improved step by step (compliance against the parts left solid), with the material in use. */
function TopologyChart({ history }: { history: NonNullable<StructuralResult["topology"]>["history"] }) {
  const chart = useMemo(() => {
    const n = history.length;
    if (n < 2) return null;
    const c = history.map((h) => Math.log(h.compliance));
    const lo = Math.min(...c),
      hi = Math.max(...c);
    const y = (v: number) => 4 + ((hi - v) / Math.max(hi - lo, 1e-9)) * 42;
    const pts = c.map((v, i) => `${((i / (n - 1)) * 100).toFixed(2)},${(50 - y(v) + 4).toFixed(2)}`).join(" ");
    return { pts, n };
  }, [history]);
  if (!chart) return null;
  return (
    <div style={{ marginBottom: 6 }}>
      <svg className="an-spark" viewBox="0 0 100 54" preserveAspectRatio="none" aria-label="Stiffness over the design steps">
        <polyline points={chart.pts} fill="none" stroke="var(--accent)" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mono dim" style={{ fontSize: 10.5, marginTop: 4 }}>
        stiffness at each of {chart.n} design steps, as the material moves to where it carries the loads
      </div>
    </div>
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

/** Temperatures: each part against its limit, where the heat comes from and goes, and the warm-up over time. */
function HeatBox({ spec, r }: { spec: StructuralSpec; r: StructuralResult }) {
  const t = r.thermal!;
  const field = useAnalysis((s) => s.field);
  const shown = useAnalysis((s) => s.shown);
  const mode = useAnalysis((s) => s.mode);
  const v = temperatureVerdict(r);
  const text = temperatureText(r);
  const on = shown === spec.label && fieldFor(r, field) === "temp" && shownMode(r, mode) === null;
  const show = () => {
    useAnalysis.setState({ field: "temp", mode: null });
    showResults(spec.label);
  };
  const made = t.sources.reduce((a, s) => a + s.watts, 0);
  const tr = t.transient;
  const parts = [...t.parts].sort((a, b) => a.limit - a.max - (b.limit - b.max));
  const b = t.balance;
  const share = (x: number) => (b && b.made > 1e-6 ? Math.round(Math.max(0, (100 * x) / b.made)) : 0);
  const goes = b && b.made > 1e-6 ? [`${share(b.film)} % into the air`, b.radiation > 1e-6 ? `${share(b.radiation)} % radiated` : "", Math.abs(b.held) > 0.01 * b.made ? `${share(b.held)} % into held surfaces` : ""].filter(Boolean).join(" · ") : "";
  return (
    <div className="an-box" style={{ marginBottom: 12 }}>
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <StatusIcon status={v?.status ?? "info"} />
        <b>{spec.thermal ? (r.heatOnly ? "Temperatures" : "Temperatures and thermal stress") : `Everything at ${degC(spec.uniformTemp ?? t.maxTemp.value)}`}</b>
        <span className="dim mono">
          surroundings {degC(t.ambient)}
          {t.cooling ? ` · ${t.cooling}` : ""}
          {!r.heatOnly && t.refTemp !== undefined ? ` · no thermal stress at ${degC(t.refTemp)}` : ""}
        </span>
        <div className="grow" />
        <button className={`an-toggle ${on ? "on" : ""}`} onClick={show} aria-pressed={on} data-tip="Colour the model by temperature">
          {on ? <Icon.Eye size={13} /> : <Icon.EyeOff size={13} />} temperatures
        </button>
      </div>
      <div className="an-grid" style={{ marginBottom: 10 }}>
        <button className={`an-stat ${v?.status ?? ""} ${on ? "active" : ""}`} onClick={show}>
          <div className="k">{tr ? `Hottest after ${duration(tr.time)}` : "Hottest"}</div>
          <div className="v">
            {fmtNum(t.maxTemp.value, 1)}
            <small>°C</small>
          </div>
          <div className="s">
            on {t.maxTemp.part} near {v3(t.maxTemp.at)}
          </div>
        </button>
        {v && (
          <div className={`an-stat ${v.status}`}>
            <div className="k">Closest to its limit</div>
            <div className="v">
              {fmtNum(Math.abs(v.margin), 1)}
              <small>°C {v.margin < 0 ? "over" : "to spare"}</small>
            </div>
            <div className="s">
              {v.worst.name}: limit {degC(v.worst.limit)}, {v.worst.limitWhy}
            </div>
          </div>
        )}
        {t.sources.length > 0 && (
          <div className="an-stat">
            <div className="k">Heat made</div>
            <div className="v">
              {fmtNum(made, made < 10 ? 2 : 1)}
              <small>W</small>
            </div>
            <div className="s">{goes || `${t.sources.length} source${t.sources.length > 1 ? "s" : ""}`}</div>
          </div>
        )}
        {tr && (
          <div className="an-stat">
            <div className="k">Left running</div>
            <div className="v">{tr.settles !== null ? <>{fmtNum(tr.settles, 1)}<small>°C</small></> : <small>keeps heating</small>}</div>
            <div className="s">{tr.overLimit ? `${tr.overLimit.part} passes its limit after ${duration(tr.overLimit.time)}` : `from ${degC(tr.start)}; nothing passes its limit in ${duration(tr.time)}`}</div>
          </div>
        )}
      </div>
      {tr && tr.times.length > 1 && <WarmUpChart t={t} />}
      <table className="an-table">
        <thead>
          <tr>
            <th>Part</th>
            <th className="num">Hottest</th>
            <th className="num">Average</th>
            <th className="num">Limit</th>
            <th>Used of the headroom</th>
          </tr>
        </thead>
        <tbody>
          {parts.slice(0, 12).map((p) => {
            const room = Math.max(p.limit - t.ambient, 1);
            const status = p.max > p.limit ? "fail" : p.limit - p.max < 0.1 * room ? "warn" : "";
            const used = Math.min(1, Math.max(0, (p.max - t.ambient) / room));
            return (
              <tr key={p.name}>
                <td>
                  {p.name}
                  <span className="dim">
                    {" "}
                    · {p.material}
                    {p.assumed ? ", assumed" : ""}
                  </span>
                </td>
                <td className={`num ${status}`}>{degC(p.max)}</td>
                <td className="num">{degC(p.mean)}</td>
                <td className="num" title={p.limitWhy}>
                  {degC(p.limit)}
                </td>
                <td>
                  <span className="an-meter" aria-label={`${Math.round(used * 100)} % of the headroom used`}>
                    <div style={{ width: `${used * 100}%`, background: status === "fail" ? "var(--fail)" : status === "warn" ? "var(--warn)" : "var(--pass)" }} />
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {t.parts.length > 12 && <div className="mono dim" style={{ fontSize: 10.5, marginTop: 4 }}>and {t.parts.length - 12} more parts</div>}
      {t.sources.length > 0 && (
        <div className="an-note" style={{ marginTop: 8 }}>
          <Icon.Bolt size={13} style={{ color: "var(--text-3)" }} />
          <span>
            {t.sources
              .slice(0, 8)
              .map((s) => `${s.label} ${fmtNum(s.watts, 2)} W${s.why ? ` (${s.why})` : ""}`)
              .join("; ")}
            {t.sources.length > 8 ? `; ${t.sources.length - 8} more` : ""}
          </span>
        </div>
      )}
      {text?.fix && (
        <div className="an-note">
          <Icon.Info size={13} style={{ color: "var(--warn)" }} />
          <span>{text.fix}</span>
        </div>
      )}
    </div>
  );
}

/** Current through the parts (Joule heating): each current's resistance, voltage and heat, cold and warm, and how dense it runs. */
function CurrentBox({ spec, r }: { spec: StructuralSpec; r: StructuralResult }) {
  const t = r.thermal!;
  const cs = t.currents!;
  const field = useAnalysis((s) => s.field);
  const shown = useAnalysis((s) => s.shown);
  const mode = useAnalysis((s) => s.mode);
  const on = shown === spec.label && fieldFor(r, field) === "current" && shownMode(r, mode) === null;
  const show = () => {
    useAnalysis.setState({ field: "current", mode: null });
    showResults(spec.label);
  };
  const pk = t.currentPeak;
  const made = cs.reduce((a, c) => a + c.watts, 0);
  const cold = cs.reduce((a, c) => a + c.cold.watts, 0);
  return (
    <div className="an-box" style={{ marginBottom: 12 }}>
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <Icon.Bolt size={14} style={{ color: "var(--text-3)" }} />
        <b>Current through the parts</b>
        <span className="dim mono">Joule heating, I²R</span>
        <div className="grow" />
        <button className={`an-toggle ${on ? "on" : ""}`} onClick={show} aria-pressed={on} data-tip="Colour the model by current density">
          {on ? <Icon.Eye size={13} /> : <Icon.EyeOff size={13} />} current density
        </button>
      </div>
      <div className="an-grid" style={{ marginBottom: 10 }}>
        {pk && (
          <button className={`an-stat ${on ? "active" : ""}`} onClick={show}>
            <div className="k">Densest</div>
            <div className="v">
              {fmtNum(pk.value, pk.value < 10 ? 2 : 1)}
              <small>A/mm²</small>
            </div>
            <div className="s">{pk.value < 1.2 * pk.typical ? "about even through the metal" : `in ${pk.part} near ${v3(pk.at)}, ${fmtNum(pk.value / pk.typical, 1)}× its typical ${density(pk.typical)}`}</div>
          </button>
        )}
        <div className="an-stat">
          <div className="k">Heat made</div>
          <div className="v">
            {fmtNum(made, made < 10 ? 2 : 1)}
            <small>W</small>
          </div>
          <div className="s">{Math.abs(made - cold) > 0.005 * Math.max(cold, 1e-12) ? `${watts(cold)} at 20 °C, before it warms` : "barely warms, so the same cold"}</div>
        </div>
      </div>
      <table className="an-table">
        <thead>
          <tr>
            <th>Current</th>
            <th className="num">Through</th>
            <th className="num">Across</th>
            <th className="num">Resistance</th>
            <th className="num">Heat</th>
          </tr>
        </thead>
        <tbody>
          {cs.map((c) => (
            <tr key={c.label}>
              <td>
                {c.label}
                <span className="dim">
                  {" "}
                  · {c.from} to {c.to}
                  {c.parts.length > 1 ? ` · ${c.parts.slice(0, 3).map((p) => `${Math.round(p.share * 100)} % ${p.name}`).join(", ")}` : ""}
                </span>
              </td>
              <td className="num">{amps(c.amps)}</td>
              <td className="num">{volts(c.volts)}</td>
              <td className="num" title={`${ohms(c.cold.ohms)} at 20 °C`}>
                {ohms(c.ohms)}
              </td>
              <td className="num" title={`${watts(c.cold.watts)} at 20 °C`}>
                {watts(c.watts)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mono dim" style={{ fontSize: 10.5, marginTop: 4 }}>
        at the temperatures the parts reach; {cs.some((c) => c.driven === "volts") ? "a set voltage drives less current as the metal warms" : "a set current makes more heat as the metal warms"}
      </div>
    </div>
  );
}

/** The hottest temperature over the warm-up, with the tightest part limit when it is in view. */
function WarmUpChart({ t }: { t: ThermalResult }) {
  const tr = t.transient!;
  const chart = useMemo(() => {
    const times = [0, ...tr.times];
    const temps = [tr.start, ...tr.max];
    const end = times[times.length - 1] || 1;
    const lo = Math.min(...temps);
    const top = Math.max(...temps);
    const limit = Math.min(...t.parts.map((p) => p.limit));
    // the limit only when it is near enough to read against the curve
    const showLimit = Number.isFinite(limit) && limit <= top + 0.6 * Math.max(top - lo, 1);
    const hi = Math.max(top, showLimit ? limit : -Infinity) + 0.04 * Math.max(top - lo, 1);
    const y = (v: number) => 4 + ((hi - v) / Math.max(hi - lo, 1e-6)) * 46;
    const pts = times.map((x, i) => `${((x / end) * 100).toFixed(2)},${y(temps[i]).toFixed(2)}`).join(" ");
    return { pts, end, lo, hi, limit, limitY: showLimit ? y(limit) : null };
  }, [t, tr]);
  return (
    <div style={{ marginBottom: 10 }}>
      <svg className="an-spark" viewBox="0 0 100 54" preserveAspectRatio="none" aria-label="Hottest temperature over the warm-up">
        {chart.limitY !== null && <line x1={0} x2={100} y1={chart.limitY} y2={chart.limitY} stroke="var(--fail)" strokeDasharray="3 3" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
        <polyline points={chart.pts} fill="none" stroke="var(--warn)" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mono dim" style={{ fontSize: 10.5, marginTop: 4 }}>
        hottest point over {duration(chart.end)} · {degC(chart.lo)} to {degC(chart.hi)}
        {chart.limitY !== null ? ` · dashed: the tightest limit, ${degC(chart.limit)}` : ""}
      </div>
    </div>
  );
}

/** Fatigue: the lowest fatigue safety factor, the shortest life, the S-N curves and what does the damage. */
function FatigueBox({ spec, r }: { spec: StructuralSpec; r: StructuralResult }) {
  const f = r.fatigue!;
  const field = useAnalysis((s) => s.field);
  const shown = useAnalysis((s) => s.shown);
  const v = fatigueVerdict(spec, r);
  const text = fatigueText(spec, r);
  const pick = (fl: ResultField) => {
    useAnalysis.setState({ field: fl, mode: null });
    showResults(spec.label);
  };
  const on = (fl: ResultField) => shown === spec.label && field === fl;
  const sfv = f.minSafety.value;
  const lifeShort = Number.isFinite(f.life.value) && f.life.value < f.design;
  return (
    <div className="an-box" style={{ marginBottom: 12 }}>
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <StatusIcon status={v?.status ?? "info"} />
        <b>Fatigue</b>
        <span className="dim mono">
          {designWords(f)} · {MEAN_STRESS[f.meanStress]}
          {f.reliability > 0.5 ? ` · ${fmtNum(f.reliability * 100, 2)} % reliability` : ""}
        </span>
      </div>
      <div className="an-grid" style={{ marginBottom: 8 }}>
        <button className={`an-stat ${sfStatus(sfv, spec.safety)} ${on("safety") ? "active" : ""}`} onClick={() => pick("safety")}>
          <div className="k">Fatigue safety</div>
          <div className="v">
            {sfText(sfv)}
            <small>target {fmtNum(spec.safety, 1)}</small>
          </div>
          <div className="s">the factor on the loads that breaks it at the end of its life{f.minSafety.mode === "layer fatigue" ? ", between print layers" : ""}</div>
        </button>
        <button className={`an-stat ${lifeShort ? "fail" : ""} ${on("life") ? "active" : ""}`} onClick={() => pick("life")}>
          <div className="k">Shortest life</div>
          <div className="v" style={{ fontSize: Number.isFinite(f.life.value) ? undefined : 15 }}>
            {Number.isFinite(f.life.value) ? count(f.life.value) : "no limit"}
            <small>{f.unit === "cycles" ? "cycles" : "passes"}</small>
          </div>
          <div className="s">at {v3(f.life.at)} · target {count(f.design)}</div>
        </button>
        <div className="an-stat">
          <div className="k">Damage</div>
          <div className="v">
            {Number.isFinite(f.life.value) ? fmtNum(f.damage, f.damage < 0.01 ? 4 : 3) : "0"}
            <small>Miner</small>
          </div>
          <div className="s">over the life asked for; 1 breaks it</div>
        </div>
      </div>
      <SnChart f={f} />
      {(f.cycles.length > 1 || f.repeats > 1) && (
        <table className="an-table" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th className="num">Count</th>
              <th>Cycle</th>
              <th className="num">Share of the damage</th>
            </tr>
          </thead>
          <tbody>
            {f.cycles.slice(0, 8).map((c, i) => {
              const share = f.shares.find((s) => s.cycle.max === c.max && s.cycle.min === c.min && s.cycle.count === c.count)?.share ?? 0;
              return (
                <tr key={i}>
                  <td className="num mono">{count(c.count * f.repeats)}</td>
                  <td>{cycleWords(c)}</td>
                  <td className="num mono">{share > 0 ? `${fmtNum(share * 100, share < 0.1 ? 1 : 0)} %` : "none"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {text && (
        <div className="an-note" style={{ marginTop: 8 }}>
          {text.detail}
        </div>
      )}
      {text?.fix && <div className="an-note">{text.fix}</div>}
    </div>
  );
}

/** The S-N curves used, on log-log axes, with the design life marked. */
function SnChart({ f }: { f: NonNullable<StructuralResult["fatigue"]> }) {
  const chart = useMemo(() => {
    const curves = f.curves.slice(0, 3);
    const top = Math.max(...curves.map((c) => c.su));
    const bottom = Math.min(...curves.map((c) => c.se)) * 0.6;
    const n0 = 1,
      n1 = 9;
    const x = (logN: number) => ((logN - n0) / (n1 - n0)) * 100;
    const y = (s: number) => 4 + ((Math.log10(top) - Math.log10(Math.max(s, bottom))) / Math.max(Math.log10(top) - Math.log10(bottom), 1e-6)) * 46;
    const lines = curves.map((c) => {
      const curve: SnCurve = { su: c.su, sy: c.su, s3: c.s3, se: c.se, ka: c.ka, ke: c.ke, tail: c.tail, finish: c.finish };
      const pts: string[] = [];
      for (let k = 0; k <= 60; k++) {
        const s = top * Math.pow(bottom / top, k / 60);
        const n = cyclesAt(curve, s);
        const ln = Number.isFinite(n) ? Math.log10(Math.max(n, 1)) : n1;
        if (ln > n1) {
          pts.push(`${x(n1).toFixed(2)},${y(s).toFixed(2)}`);
          break;
        }
        pts.push(`${x(ln).toFixed(2)},${y(s).toFixed(2)}`);
      }
      if (c.tail === "flat") pts.push(`${x(n1).toFixed(2)},${y(c.se).toFixed(2)}`);
      return { pts: pts.join(" "), label: `${c.material}${c.layers ? " (layers)" : ""}` };
    });
    const design = Math.log10(Math.max(f.unit === "cycles" ? f.design : f.cycles.reduce((a, c) => a + c.count, 0) * f.repeats, 1));
    return { lines, designX: Math.min(100, x(design)), top, bottom };
  }, [f]);
  const colors = ["var(--accent)", "var(--warn)", "var(--pass)"];
  return (
    <div>
      <svg className="an-spark" viewBox="0 0 100 54" preserveAspectRatio="none" aria-label="S-N curves">
        <line x1={chart.designX} x2={chart.designX} y1={0} y2={54} stroke="var(--fail)" strokeDasharray="3 3" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {chart.lines.map((l, i) => (
          <polyline key={i} points={l.pts} fill="none" stroke={colors[i % colors.length]} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <div className="mono dim" style={{ fontSize: 10.5, marginTop: 4 }}>
        S-N: stress amplitude {fmtNum(chart.bottom, 0)} to {fmtNum(chart.top, 0)} MPa against 10 to 10⁹ cycles · {chart.lines.map((l) => l.label).join(", ")} · dashed: the cycles in the life asked for ({lifeText(f.unit === "cycles" ? f.design : f.cycles.reduce((a, c) => a + c.count, 0) * f.repeats, { ...f, unit: "cycles" })})
      </div>
    </div>
  );
}

/** Buckling: the load factors and their shapes; picking one swings that shape on the model. */
function BucklingBox({ spec, r }: { spec: StructuralSpec; r: StructuralResult }) {
  const b = r.buckling!;
  const picked = useAnalysis((s) => s.mode);
  const shown = useAnalysis((s) => s.shown);
  const active = shown === spec.label ? shownMode(r, picked) : null;
  const v = bucklingVerdict(spec, r);
  const text = bucklingText(spec, r);
  const target = spec.buckling?.safety ?? 3;
  return (
    <div className="an-box" style={{ marginBottom: 12 }}>
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <StatusIcon status={v?.status ?? "info"} />
        <b>Buckling</b>
        <span className="dim mono">
          target {fmtNum(target, 1)}× the loads{b.converged ? "" : " · rough: the solver stopped early"}
        </span>
      </div>
      {b.factors.length > 0 && (
        <table className="an-table">
          <thead>
            <tr>
              <th>Shape</th>
              <th className="num">Buckles at</th>
              <th>Moves most near</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {b.factors.map((f, i) => (
              <tr
                key={i}
                className={`an-mode ${active === i ? "active" : ""}`}
                onClick={() => {
                  showResults(spec.label);
                  useAnalysis.setState({ mode: active === i ? null : i });
                }}
                style={{ cursor: "pointer" }}
                aria-pressed={active === i}
              >
                <td className="mono">{i + 1}</td>
                <td className={`num ${f < 1 ? "fail" : f < target ? "warn" : ""}`}>{fmtNum(f, 2)}× the loads</td>
                <td className="mono">{v3(b.peaks[i])}</td>
                <td className="dim">{active === i ? "on the model" : "show"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {text && (
        <div className="an-note" style={{ marginTop: 8 }}>
          {text.detail}
        </div>
      )}
      {text?.fix && <div className="an-note">{text.fix}</div>}
    </div>
  );
}

/** The accuracy check: the answers from two element sizes side by side, and whether they have settled. */
function AccuracyBox({ spec, r, run }: { spec: StructuralSpec; r: StructuralResult; run?: StructuralRun }) {
  const c = r.convergence;
  const busy = run?.status === "running" || run?.status === "waiting";
  if (!c)
    return (
      <div className="an-box">
        <h4>
          Accuracy
          <div className="grow" />
          <button className="btn sm ghost" style={{ height: 20 }} disabled={busy} onClick={() => runAccuracyCheck(spec.label)}>
            <Icon.Target size={12} /> check
          </button>
        </h4>
        <div className="an-note">
          <span className="dim">
            Solved once with {fmtNum(r.mesh.h, 2)} mm elements. Check accuracy solves it again with smaller elements and shows how far each answer moves, so you know which numbers to trust.
          </span>
        </div>
      </div>
    );
  const text = accuracyText(r)!;
  const rows: { name: string; a?: number; b?: number; moved?: number; fmt: (x: number) => string }[] = [
    ...(r.heatOnly
      ? []
      : [
          { name: "Deflection", a: c.coarse.disp, b: c.fine.disp, moved: c.change.disp, fmt: (x: number) => `${fmtNum(x, x < 0.1 ? 4 : 3)} mm` },
          { name: "Stress", a: c.coarse.stress, b: c.fine.stress, moved: c.change.stress, fmt: (x: number) => `${fmtNum(x, x < 10 ? 2 : 1)} MPa` },
          { name: "Safety factor", a: c.coarse.safety, b: c.fine.safety, moved: c.change.safety, fmt: sfText },
        ]),
    ...(c.change.temp !== undefined ? [{ name: "Hottest", a: c.coarse.temp, b: c.fine.temp, moved: c.change.temp, fmt: degC }] : []),
    ...(c.change.buckling !== undefined ? [{ name: "Buckling factor", a: c.coarse.buckling, b: c.fine.buckling, moved: c.change.buckling, fmt: (x: number) => `${fmtNum(x, 2)}×` }] : []),
  ];
  return (
    <div className="an-box">
      <h4>
        Accuracy
        <div className="grow" />
        <span className={`chip ${text.status}`} style={{ height: 18, letterSpacing: 0, textTransform: "none" }}>
          {c.verdict === "converged" ? "settled" : c.verdict === "close" ? "close to settled" : "not settled"}
        </span>
      </h4>
      <table className="an-table">
        <thead>
          <tr>
            <th />
            <th className="num">{fmtNum(c.coarse.h, 2)} mm</th>
            <th className="num">{fmtNum(c.fine.h, 2)} mm</th>
            <th className="num">Moved</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td>{row.name}</td>
              <td className="num">{row.a !== undefined ? row.fmt(row.a) : "–"}</td>
              <td className="num">{row.b !== undefined ? row.fmt(row.b) : "–"}</td>
              <td className={`num ${(row.moved ?? 0) > 0.15 ? "fail" : (row.moved ?? 0) > 0.05 ? "warn" : ""}`}>{fmtNum((row.moved ?? 0) * 100, (row.moved ?? 0) < 0.1 ? 1 : 0)} %</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="an-note" style={{ marginTop: 8 }}>
        <span className="dim">{text.detail}</span>
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
        <span style={{ fontSize: 12.5 }}>{updating ? "Updating the results for your latest change" : run.check ? "Checking accuracy: solving twice" : "Running the analysis"}</span>
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
  const stat = staticSafety(r);
  const sf = stat.value;
  const st = strengthVerdict(spec, r).status;
  const away = stat.nearBoundary ? stat.away : null;
  const dispStatus: Status | "" = spec.maxDeflection === undefined ? "" : r.maxDisp.value <= spec.maxDeflection ? "pass" : "fail";
  const sfBar = safetyColor(safetyT(sf, spec.safety)).map((c) => Math.round(c * 255)).join(",");
  const exag = autoDeform(r);
  return (
    <div className="an-grid">
      <button className={`an-stat ${st} ${on("safety") ? "active" : ""}`} onClick={() => pick("safety")}>
        <div className="k">{r.fatigue ? "Static safety" : "Safety factor"}</div>
        <div className="v">
          {sfText(sf)}
          <small>target {fmtNum(spec.safety, 1)}</small>
        </div>
        <div className="s">
          against {modeText(r, spec.cycles, stat)}
          {r.fatigue && Math.abs(r.fatigue.peak - 1) > 1e-6 ? ` at ${fmtNum(r.fatigue.peak, 2)}× the loads` : ""}
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
    if (l.t === "bearing")
      return `${fmtNum(Math.hypot(...l.f), 1)} N along ${v3(l.f.map((x) => x / (Math.hypot(...l.f) || 1)))} on ${describeRegion(l.region)}, spread round the side it presses${info?.pressure ? ` (peak ${fmtNum(info.pressure, 2)} MPa)` : ""}`;
    return `${fmtNum(l.torque / 1000, 2)} N·m about ${v3(l.axis)} on ${describeRegion(l.region)}`;
  };
  const supportTag = (s: StructuralSpec["supports"][number]) => (s.spring ? "spring" : s.pin ? "pin" : s.move ? "moved" : s.contact ? "contact" : s.dir ? "roller" : "fixed");
  const supportText = (i: number) => {
    const s = spec.supports[i];
    const info = r?.supports[i];
    if (s.spring) {
      const k = s.spring.rate !== undefined ? `${fmtNum(s.spring.rate, 1)} N/mm` : `${fmtNum(s.spring.perArea ?? 0, 3)} N/mm per mm²`;
      return `${describeRegion(s.region)} · ${k}${s.dir ? ` along ${v3(s.dir)}` : ""}${info?.spring ? ` · gives ${fmtNum(info.spring.give, 3)} mm` : ""}`;
    }
    if (s.pin)
      return `${describeRegion(s.region)} · ${s.pin.tight ? "tight all round" : "bears where pressed"}${s.pin.slide ? ", slides along it" : ""}${info?.pin ? ` · ${fmtNum(info.pin.pressure, 2)} MPa bearing pressure${s.pin.tight ? "" : `, ${fmtNum(info.pin.share * 100, 0)} % of the bore pressing`}` : ""}`;
    if (s.move) return `${describeRegion(s.region)} · moved ${v3(info?.moved ?? s.move)} mm${s.dir ? " (free the other ways)" : ""}`;
    return `${describeRegion(s.region)}${s.dir ? ` · held along ${v3(s.dir)}` : ""}`;
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
            <span className="tag">{supportTag(s)}</span>
            {supportText(i)}
            {r?.supports[i] ? <span className="dim"> · {s.move ? "takes" : "reaction"} {fmtNum(Math.hypot(...r.supports[i].reaction), 1)} N</span> : null}
          </div>
        ))}
        {spec.loads.map((_, i) => (
          <div key={`l${i}`}>
            <span className="tag">{spec.loads[i].t}</span>
            {loadText(i)}
          </div>
        ))}
        {spec.preload && <BoltsSetup spec={spec} r={r} />}
        {(spec.touching || spec.preload) && <TouchingSetup spec={spec} r={r} />}
        {spec.accel && (
          <div>
            <span className="tag">accel</span>
            {v3(spec.accel)} g
          </div>
        )}
        {spec.thermal && <HeatSetup spec={spec} r={r} />}
        {spec.uniformTemp !== undefined && (
          <div>
            <span className="tag">temp</span>
            everything at {degC(spec.uniformTemp)}, no thermal stress at {degC(spec.refTemp ?? 20)}
          </div>
        )}
        {spec.buckling && (
          <div>
            <span className="tag">buckling</span>
            {spec.buckling.modes} shape{spec.buckling.modes > 1 ? "s" : ""}, target {fmtNum(spec.buckling.safety, 1)}× the loads
          </div>
        )}
        {r?.printing?.length
          ? r.printing.map((p) => (
              <div key={p.part}>
                <span className="tag">printed</span>
                {p.part}: {p.words}, layers along {dirWords(p.build)}
                {p.from === "bed" ? " (as it lies on the bed)" : p.from === "process" ? " (its process's build:)" : ""}
                <span className="dim">
                  {" "}
                  · {fmtNum(p.solid * 100, 0)} % solid walls and skin
                  {p.infillStiffness < 0.999 ? ` · infill ${fmtNum(p.infillStiffness * 100, 0)} % as stiff, ${fmtNum(p.infillStrength * 100, 0)} % as strong` : ""}
                  {p.across < 0.999 ? ` · ${fmtNum(p.across * 100, 0)} % as stiff across its layers` : ""}
                </span>
              </div>
            ))
          : (spec.printed || r?.materials.some((m) => m.layerFactor < 1)) && (
              <div>
                <span className="tag">printed</span>
                layers stacked along {v3(spec.buildDir)}
              </div>
            )}
        {spec.fatigue ? (
          <div>
            <span className="tag">fatigue</span>
            {spec.fatigue.unit === "cycles" ? `${count(spec.fatigue.cycles[0].count)} cycles, ` : `${spec.fatigue.repeats > 1 ? `${count(spec.fatigue.repeats)} × ` : ""}`}
            {spec.fatigue.loading} · {MEAN_STRESS[spec.fatigue.meanStress]}
            {spec.fatigue.finish ? ` · ${spec.fatigue.finish}` : " · finish from how each part is made"}
          </div>
        ) : (
          spec.cycles !== undefined && (
            <div>
              <span className="tag">cycles</span>
              {spec.cycles.toExponential(0)}
            </div>
          )
        )}
        <div>
          <span className="tag">mesh</span>
          {run?.resolution ?? (typeof spec.resolution === "string" ? spec.resolution : `${spec.resolution.h} mm`)}
        </div>
      </div>
    </div>
  );
}

/** The heat set-up: where heat is made, how the parts are cooled, held temperatures and the warm-up. */
function HeatSetup({ spec, r }: { spec: StructuralSpec; r?: StructuralResult }) {
  const th = spec.thermal!;
  // the result knows the heat worked out from the parts (heat: "auto"); the spec only that it was asked for
  const sources = r?.thermal?.sources ?? th.heat;
  const ambient = r?.thermal?.ambient ?? th.ambient;
  return (
    <>
      {sources.map((s, i) => (
        <div key={`h${i}`}>
          <span className="tag">heat</span>
          {s.label} · {fmtNum(s.watts, 2)} W{s.why ? <span className="dim"> · {s.why}</span> : null}
        </div>
      ))}
      {!r?.thermal &&
        (th.currents ?? []).map((c, i) => (
          <div key={`c${i}`}>
            <span className="tag">current</span>
            {c.label} · {c.amps !== undefined ? `${fmtNum(c.amps, 2)} A` : `${fmtNum(c.volts ?? 0, 2)} V`} from {describeRegion(c.from)} to {describeRegion(c.to)}
          </div>
        ))}
      {th.auto && !r?.thermal && (
        <div>
          <span className="tag">heat</span>
          every electronic part&apos;s loss at its working current
        </div>
      )}
      <div>
        <span className="tag">cooling</span>
        {th.coolingText} ({fmtNum(th.cooling, 0)} W/m²K){th.films.length ? ` · ${th.films.length} surface${th.films.length > 1 ? "s" : ""} cooled differently` : ""}
        {th.emissivity !== undefined ? ` · radiation, emissivity ${fmtNum(th.emissivity, 2)}` : ""}
      </div>
      {th.fixed.map((f, i) => (
        <div key={`f${i}`}>
          <span className="tag">held</span>
          {degC(f.temp)} on {describeRegion(f.region)}
        </div>
      ))}
      <div>
        <span className="tag">air</span>
        {ambient !== undefined ? degC(ambient) : "the brief's hottest, else 25 °C"}
        {r?.thermal?.ambientWhy ? <span className="dim"> · {r.thermal.ambientWhy}</span> : null}
      </div>
      {th.time !== undefined && (
        <div>
          <span className="tag">time</span>
          warm-up over {duration(th.time)}
          {th.start !== undefined ? ` from ${degC(th.start)}` : " from the surroundings"}
        </div>
      )}
      {th.maxTemp !== undefined && (
        <div>
          <span className="tag">limit</span>
          {degC(th.maxTemp)} for every part
        </div>
      )}
    </>
  );
}

function NotesBox({ spec, r }: { spec: StructuralSpec; r: StructuralResult }) {
  const h = fmtNum(r.mesh.h, 2);
  const heat = spec.thermal
    ? `${spec.thermal.time !== undefined ? "Heat conduction over time" : "Steady heat conduction"} on the same grid: heat flows through the parts where they touch and leaves their outer surfaces by convection and radiation. Film coefficients are typical values for the cooling named; real airflow, gaps and contact between parts change the answer, so leave margin and measure a prototype.`
    : "";
  return (
    <div className="an-box">
      <h4>What to keep in mind</h4>
      {r.warnings.map((w, i) => (
        <div key={i} className="an-note">
          <Icon.Alert size={13} style={{ color: "var(--warn)" }} />
          <span>{w}</span>
        </div>
      ))}
      {largeText(r) && (
        <div className="an-note">
          <Icon.Info size={13} style={{ color: "var(--cyan)" }} />
          <span>Large deflection: {largeText(r)}</span>
        </div>
      )}
      <div className="an-note">
        <Icon.Info size={13} style={{ color: "var(--text-3)" }} />
        <span className="dim">
          {r.heatOnly ? (
            `Temperatures on a ${h} mm voxel grid. ${heat}`
          ) : (
            <>
              {r.large?.converged ? `Elastic analysis on a ${h} mm voxel grid with large deflection (parts turn as they bend; strains small)` : `Linear elastic analysis on a ${h} mm voxel grid: small deflections`}, {spec.touching ? "contact only where touching: says (other touching parts glued)" : "no contact"} or creep
              {r.buckling ? "; buckling assumes a perfect shape, so real parts buckle somewhat sooner" : ", and buckling only when buckling: is set"}. {heat}
              {spec.thermal || spec.uniformTemp !== undefined ? " Hot plastics are softened and weakened at their temperature. " : ""}
              Peaks are smoothed at sharp corners and fillets smaller than a cell. Use it to compare designs and find weak spots; test a printed part before relying on it{spec.safety < 2 ? ", especially with a safety target under 2" : ""}.
            </>
          )}
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

// ---------- design study ----------

const studyNum = (v: number) => fmtNum(v, Math.abs(v) < 10 ? 3 : 1);

/** A design study: run it, see the best design against the current one, every design it tried, and use any of them. */
function StudyView({ spec, st }: { spec: StudySpec; st?: StudyState }) {
  const source = useDesign((s) => s.source);
  const r = st?.result;
  const busy = st?.status === "running";
  const unit = MEASURE_UNIT[spec.goal.what];
  const withUnit = (v: number | null) => (v === null ? "–" : `${studyNum(v)}${unit && unit !== "×" ? ` ${unit}` : unit}`);
  const best = r && r.best !== null ? r.runs[r.best] : null;
  const cur = r?.runs.find((x) => x.current);
  const sign = spec.goal.sense === "min" ? 1 : -1;
  const rows = r ? [...r.runs].sort((a, b) => Number(b.feasible) - Number(a.feasible) || sign * ((a.goal ?? Infinity * sign) - (b.goal ?? Infinity * sign)) || a.index - b.index) : [];
  const change = best && cur && best.goal !== null && cur.goal ? ((best.goal - cur.goal) / Math.abs(cur.goal)) * 100 : null;
  return (
    <>
      <div className="an-box" style={{ marginBottom: 12 }}>
        <div className="row" style={{ gap: 8, marginBottom: 6 }}>
          <StatusIcon status={busy || !r ? "pending" : best ? "pass" : "fail"} />
          <b>Design study: {spec.goal.text}</b>
          <span className="dim mono">
            {spec.vary.map((v) => `${v.name} ${studyNum(v.min)}–${studyNum(v.max)}${v.step ? ` by ${studyNum(v.step)}` : ""}`).join(" · ")}
          </span>
          <div className="grow" />
          {busy ? (
            <button className="btn sm" onClick={() => stopStudy(spec.label)}>
              <Icon.Stop size={13} /> Stop
            </button>
          ) : (
            <button className="btn sm primary" onClick={() => void startStudy(spec.label)} data-tip={`Build, check and solve up to ${spec.runs} designs`}>
              <Icon.Play size={13} /> {r ? "Run again" : "Run study"}
            </button>
          )}
        </div>
        <div className="an-note">
          <span className="dim">
            Tries up to {spec.runs} designs: a spread across the ranges, then the ones a fitted model of the results says are most promising. Every design must meet each analysis&apos;s own targets
            {spec.limits.length ? `, ${spec.limits.map((l) => l.text).join(", ")}` : ""} and keep passing every check that passes now. Each run builds the whole design and solves its analyses at draft resolution, and the best is confirmed at full resolution.
          </span>
        </div>
        {busy && (
          <>
            <div className="mono dim" style={{ fontSize: 11, marginTop: 6 }}>
              {st?.progress?.stage ?? "Starting"} · {st?.progress?.done ?? 0} of {spec.runs}
            </div>
            <div className="an-progress">
              <div style={{ width: `${Math.round(((st?.progress?.done ?? 0) / spec.runs) * 100)}%` }} />
            </div>
          </>
        )}
        {st?.status === "error" && (
          <div className="an-note" style={{ color: "var(--fail-ink)", marginTop: 6 }}>
            <Icon.Alert size={13} />
            <span>{st.error}</span>
          </div>
        )}
      </div>
      {r && (
        <>
          <div className="an-grid" style={{ marginBottom: 12 }}>
            <div className={`an-stat ${best ? "pass" : "fail"}`}>
              <div className="k">Best that passes</div>
              <div className="v">
                {best ? studyNum(best.goal ?? 0) : "none"}
                <small>{best ? unit : ""}</small>
              </div>
              <div className="s">{best ? `${Object.entries(best.values).map(([k, v]) => `${k} ${studyNum(v)}`).join(", ")}${change !== null ? ` · ${change <= 0 ? "−" : "+"}${fmtNum(Math.abs(change), 0)} % against now` : ""}` : "no design met every target"}</div>
            </div>
            <div className="an-stat">
              <div className="k">The design now</div>
              <div className="v">
                {cur?.goal !== null && cur?.goal !== undefined ? studyNum(cur.goal) : "–"}
                <small>{unit}</small>
              </div>
              <div className="s">{cur ? (cur.feasible ? "passes" : "does not meet every target") : ""}</div>
            </div>
            <div className="an-stat">
              <div className="k">Designs tried</div>
              <div className="v">
                {r.runs.length}
                <small>{r.runs.filter((x) => x.feasible).length} pass</small>
              </div>
              <div className="s">
                {fmtNum(r.ms / 1000, 0)} s{r.using.length ? ` · solving ${r.using.map((l) => `"${l}"`).join(", ")}` : " · mass only"}
              </div>
            </div>
            {r.confirmed && (
              <div className={`an-stat ${r.confirmed.feasible ? "pass" : "warn"}`}>
                <div className="k">At full resolution</div>
                <div className="v">
                  {r.confirmed.goal !== null ? studyNum(r.confirmed.goal) : "–"}
                  <small>{unit}</small>
                </div>
                <div className="s">{r.confirmed.feasible ? "the best design still passes" : "no longer meets every target"}</div>
              </div>
            )}
          </div>
          {r.base !== source && (
            <div className="an-note" style={{ marginBottom: 8 }}>
              <Icon.Info size={13} style={{ color: "var(--warn)" }} />
              <span>The design changed since this study ran. Use still writes those parameter values; run the study again to measure them on the design as it is now.</span>
            </div>
          )}
          <StudyChart spec={spec} runs={r.runs} />
          {r.sensitivity.length > 0 && (
            <div className="an-setup" style={{ margin: "8px 0" }}>
              {r.sensitivity.map((x) => (
                <div key={x.name}>
                  <span className="tag">{x.name}</span>
                  {x.effect >= 0 ? "+" : "−"}
                  {withUnit(Math.abs(x.effect))} across its range
                </div>
              ))}
            </div>
          )}
          <table className="an-table">
            <thead>
              <tr>
                <th>#</th>
                {spec.vary.map((v) => (
                  <th key={v.name} className="num">
                    {v.name}
                  </th>
                ))}
                <th className="num">{spec.goal.what}</th>
                <th>Result</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <StudyRow key={x.index} spec={spec} run={x} best={x.index === r.best} withUnit={withUnit} />
              ))}
            </tbody>
          </table>
          {r.notes.map((n, i) => (
            <div key={i} className="an-note" style={{ marginTop: 6 }}>
              <Icon.Info size={13} style={{ color: "var(--text-3)" }} />
              <span>{n}</span>
            </div>
          ))}
        </>
      )}
    </>
  );
}

function StudyRow({ spec, run, best, withUnit }: { spec: StudySpec; run: StudyRun; best: boolean; withUnit: (v: number | null) => string }) {
  const bad = run.checks.filter((c) => c.margin < 0);
  const why = run.status === "error" ? run.error : [...bad.map((c) => c.text), ...run.newFails.map((t) => `fails ${t}`)].join("; ");
  return (
    <tr className={best ? "an-mode active" : ""}>
      <td className="mono">
        {run.index}
        {run.current ? " now" : ""}
      </td>
      {spec.vary.map((v) => (
        <td key={v.name} className="num">
          {studyNum(run.values[v.name])}
        </td>
      ))}
      <td className={`num ${run.feasible ? "" : "dim"}`}>{withUnit(run.goal)}</td>
      <td className={run.feasible ? "" : run.status === "error" ? "fail" : "warn"} title={why || undefined}>
        {best ? "best" : run.feasible ? "passes" : run.status === "error" ? "did not build" : (why ?? "").slice(0, 60) || "fails a check"}
      </td>
      <td>
        {!run.current && run.status === "done" && (
          <button className="btn sm ghost" style={{ height: 20 }} onClick={() => applyStudyRun(spec.label, run.index)} data-tip="Write these values into the design (undo takes them back)">
            Use
          </button>
        )}
      </td>
    </tr>
  );
}

/** The goal of each design in the order tried: passing ones filled, the rest hollow, and the best so far as a line. */
function StudyChart({ spec, runs }: { spec: StudySpec; runs: StudyRun[] }) {
  const pts = runs.filter((x) => x.goal !== null);
  if (pts.length < 2) return null;
  const ys = pts.map((x) => x.goal!);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 1;
  const X = (i: number) => (runs.length > 1 ? (i / (runs.length - 1)) * 100 : 50);
  const Y = (v: number) => 4 + ((hi + pad - v) / (hi - lo + 2 * pad)) * 46;
  const sign = spec.goal.sense === "min" ? 1 : -1;
  let bestSoFar: number | null = null;
  const line: string[] = [];
  for (const x of runs) {
    if (x.feasible && x.goal !== null && (bestSoFar === null || sign * x.goal < sign * bestSoFar)) bestSoFar = x.goal;
    if (bestSoFar !== null) line.push(`${X(x.index).toFixed(2)},${Y(bestSoFar).toFixed(2)}`);
  }
  return (
    <div style={{ marginBottom: 8 }}>
      <svg className="an-spark" viewBox="0 0 100 54" preserveAspectRatio="none" aria-label={`${spec.goal.what} of each design tried`}>
        {line.length > 1 && <polyline points={line.join(" ")} fill="none" stroke="var(--pass)" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />}
        {pts.map((x) => (
          <line key={x.index} x1={X(x.index)} x2={X(x.index)} y1={Y(x.goal!)} y2={Y(x.goal!)} stroke={x.feasible ? "var(--pass)" : "var(--fail)"} strokeOpacity={x.feasible ? 1 : 0.6} strokeWidth={x.current ? 8 : 6} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <div className="mono dim" style={{ fontSize: 10.5, marginTop: 4 }}>
        {spec.goal.what} of each design in the order tried · green passes, red does not · line: best so far
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

/** The preload: bolts of an analysis, with what each was tightened to and carries in the last result. */
function BoltsSetup({ spec, r }: { spec: StructuralSpec; r?: StructuralResult }) {
  const p = spec.preload!;
  const kN = (v: number) => (Math.abs(v) >= 1000 ? `${fmtNum(v / 1000, 2)} kN` : `${fmtNum(v, 0)} N`);
  const how = (w: { force?: number; torque?: number }) => (w.force !== undefined ? `to ${kN(w.force)}` : w.torque !== undefined ? `by ${fmtNum(w.torque / 1000, 2)} N·m on its thread` : "as it usually is");
  type B = NonNullable<StructuralResult["bolts"]>[number];
  const line = (b: B) =>
    !(b.preload > 0)
      ? "left untightened"
      : `${b.size}${b.grade ? ` ${b.grade}` : ""} into ${b.into}: ${kN(b.preload)} (${b.why}), ${kN(b.force)} under the loads${b.proof > 0 ? `, ${fmtNum((100 * b.force) / b.proof, 0)} % of its proof load` : ""}`;
  const base = (b: B) => b.part.replace(/ #\d+$/, "");
  const named = new Set(p.bolts.map((w) => w.part));
  const others = r?.bolts?.filter((b) => !named.has(base(b))) ?? [];
  return (
    <>
      {p.bolts.map((w, i) => {
        const done = r?.bolts?.filter((b) => base(b) === w.part) ?? [];
        return (
          <div key={`b${i}`}>
            <span className="tag">preload</span>
            {w.part} · tightened {how(w)}
            {done.length ? <span className="dim"> · {done.map((b) => `${done.length > 1 ? `${b.part}: ` : ""}${line(b)}`).join("; ")}</span> : null}
          </div>
        );
      })}
      {p.all && (
        <div>
          <span className="tag">preload</span>
          {p.bolts.length ? "every other" : "every"} screw and bolt · tightened {how(p.all)}
          {others.length ? <span className="dim"> · {others.map((b) => `${b.part}: ${line(b)}`).join("; ")}</span> : null}
        </div>
      )}
    </>
  );
}

/** The touching: pairs of an analysis (and the parts its tightened bolts clamp), with what each pressed, parted and slid in the last result. */
function TouchingSetup({ spec, r }: { spec: StructuralSpec; r?: StructuralResult }) {
  const t = spec.touching ?? { pairs: [] };
  const how = (mu: number | "rough" | "glued", lift: boolean) => `${mu === "rough" ? "rough" : mu === "glued" ? "glued" : mu === 0 ? "frictionless" : `μ ${fmtNum(mu, 2)}`}${lift || mu === "glued" ? "" : ", never parting"}`;
  const pc = (v: number) => `${fmtNum(v * 100, 0)} %`;
  const res = (a: string, b: string) => r?.touching?.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
  const line = (x: NonNullable<StructuralResult["touching"]>[number]) =>
    !x.cells
      ? " · not touching"
      : x.held
        ? x.held === "apart"
          ? " · pulled apart: held together for the answer"
          : " · slides away: held for the answer"
        : ` · pressed ${pc(x.pressed)}${x.open > 0.005 ? `, apart ${pc(x.open)}` : ""}${x.sliding > 0.005 ? `, sliding ${pc(x.sliding)}` : ""} · ${fmtNum(x.force, 1)} N, peak ${fmtNum(x.peak.value, 2)} MPa`;
  const auto = r?.touching?.filter((x) => x.auto) ?? [];
  return (
    <>
      {t.pairs.map((p, i) => {
        const x = res(p.a, p.b);
        return (
          <div key={`t${i}`}>
            <span className="tag">touching</span>
            {p.a} and {p.b} · {how(p.mu, p.lift)}
            {x ? <span className="dim">{line(x)}</span> : null}
          </div>
        );
      })}
      {t.all ? (
        <div>
          <span className="tag">touching</span>
          every other pair that touches · {how(t.all.mu, t.all.lift)} (screws, nuts and inserts stay glued)
          {auto.length ? <span className="dim"> · {auto.map((x) => `${x.a} and ${x.b}${line(x)}`).join("; ")}</span> : null}
        </div>
      ) : spec.preload ? (
        <div>
          <span className="tag">touching</span>
          what the tightened bolts clamp · {how(0.3, true)}
          {auto.length ? <span className="dim"> · {auto.map((x) => `${x.a} and ${x.b}${line(x)}`).join("; ")}</span> : null}
        </div>
      ) : null}
    </>
  );
}
