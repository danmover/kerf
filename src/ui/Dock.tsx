// The bottom dock: source code, checks, dependency graph and parts list.

import { motion } from "framer-motion";
import { useDesign } from "../core/engine";
import { useView, type DockTab } from "../app/view";
import { CodeEditor } from "./CodeEditor";
import { ChecksPanel } from "./ChecksPanel";
import { AnalysisPanel } from "./AnalysisPanel";
import { useAnalysis } from "../analysis/runtime";
import { GraphView } from "./GraphView";
import { BomTable } from "./BomTable";
import { Icon } from "./icons";
import { lineCol } from "../lang/lexer";

export function Dock({ projectKey }: { projectKey: string }) {
  const tab = useView((s) => s.dockTab);
  const open = useView((s) => s.dockOpen);
  const report = useDesign((s) => s.report);
  const model = useDesign((s) => s.model);
  const source = useDesign((s) => s.source);
  const errors = model?.diagnostics.filter((d) => d.severity === "error") ?? [];
  const fails = report?.counts.fail ?? 0;
  const analyses = model?.analyses.length ?? 0;
  const analysisFails = report?.items.filter((i) => i.category === "analysis" && i.status === "fail").length ?? 0;
  const analysing = useAnalysis((s) => Object.values(s.runs).some((r) => r.status === "running" || r.status === "waiting"));
  const set = (t: DockTab) => useView.setState({ dockTab: t, dockOpen: true });
  const tabs: { id: DockTab; label: string; icon: JSX.Element; count?: number; bad?: boolean }[] = [
    { id: "code", label: "design.kerf", icon: <Icon.Code size={13} />, count: errors.length || undefined, bad: errors.length > 0 },
    { id: "checks", label: "checks", icon: <Icon.Shield size={13} />, count: report ? fails || report.counts.pass : undefined, bad: fails > 0 },
    { id: "analysis", label: "strength", icon: analysing ? <span className="spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} /> : <Icon.Stress size={13} />, count: analyses ? analysisFails || analyses : undefined, bad: analysisFails > 0 },
    { id: "graph", label: "graph", icon: <Icon.Graph size={13} /> },
    { id: "bom", label: "parts list", icon: <Icon.List size={13} /> },
  ];
  return (
    <div className="dock">
      <div className="dock-head">
        <div className="tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id && open ? "active" : ""}`} onClick={() => (tab === t.id && open ? useView.setState({ dockOpen: false }) : set(t.id))}>
              {t.icon}
              {t.label}
              {t.count !== undefined && <span className={`count ${t.bad ? "fail" : ""}`}>{t.count}</span>}
              {tab === t.id && open && <motion.div layoutId="dock-tab" className="tab-line" />}
            </button>
          ))}
        </div>
        <div className="grow" />
        {tab === "code" && errors[0] && (
          <button className="btn ghost sm" style={{ color: "#ff9aa4", alignSelf: "center" }} onClick={() => useView.setState({ reveal: { span: { start: errors[0].start, end: errors[0].end }, nonce: Date.now() } })}>
            <Icon.Alert size={13} /> line {lineCol(source, errors[0].start).line}: {errors[0].message.slice(0, 70)}
          </button>
        )}
        <button className="icon-btn sm" style={{ alignSelf: "center" }} onClick={() => useView.setState({ dockOpen: !open })} aria-label={open ? "Collapse panel" : "Expand panel"} data-tip={open ? "Collapse" : "Expand"}>
          <span style={{ transform: open ? "rotate(0)" : "rotate(180deg)", display: "inline-grid", transition: "transform .2s" }}>
            <Icon.ChevronDown size={14} />
          </span>
        </button>
      </div>
      {open && (
        <div className="dock-body">
          <div style={{ display: tab === "code" ? "block" : "none", position: "absolute", inset: 0 }}>
            <CodeEditor key={projectKey} />
          </div>
          {tab === "checks" && <ChecksPanel />}
          {tab === "analysis" && <AnalysisPanel />}
          {tab === "graph" && <GraphView />}
          {tab === "bom" && <BomTable />}
        </div>
      )}
    </div>
  );
}
