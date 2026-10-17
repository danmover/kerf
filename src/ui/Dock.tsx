// The bottom dock. It opens on the overview (status, brief, the design at a
// glance, the selected part and recent changes); the brief, checks, strength,
// build and simulate (for machines and scenarios), the parts list and the
// graph sit next to it, and design.kerf sits at the end of the row as the
// file behind it all, one click (or C) away. Features add a tab with an
// entry in DOCK_TABS, the way they add left-panel tabs through LEFT_TABS.

import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { useDesign } from "../core/engine";
import { useView } from "../app/view";
import { CodeEditor } from "./CodeEditor";
import { ChecksPanel } from "./ChecksPanel";
import { AnalysisPanel } from "./AnalysisPanel";
import { useAnalysis } from "../analysis/runtime";
import { GraphView } from "./GraphView";
import { BomTable } from "./BomTable";
import { BriefPanel } from "./BriefPanel";
import { Overview, OverviewGlyph } from "./Overview";
import { BIcon } from "./briefIcons";
import { briefData, openAssumptions } from "../core/brief";
import { MachinePanel } from "./MachinePanel";
import { SimPanel } from "./sim/SimPanel";
import { MakePanel } from "./make/MakePanel";
import { useSim } from "../sim/runtime";
import { Icon } from "./icons";
import { lineCol } from "../lang/lexer";

export interface DockTabDef {
  id: string;
  label: string;
  icon: ReactNode;
  /** badge after the label: a count and its tone */
  useBadge?: () => { count?: number; tone?: "fail" | "warn" } | null;
  /** hide the tab when this returns false (a hook) */
  useShown?: () => boolean;
  Body: () => JSX.Element | null;
  /** the source file: drawn as a file tab at the end of the row and kept mounted so the editor keeps its state */
  file?: boolean;
}

function useBriefBadge() {
  const report = useDesign((s) => s.report);
  const model = useDesign((s) => s.model);
  const briefFails = report?.items.filter((i) => i.category === "brief" && i.status === "fail").length ?? 0;
  const toConfirm = openAssumptions(briefData(model?.brief)).length;
  if (briefFails) return { count: briefFails, tone: "fail" as const };
  return toConfirm ? { count: toConfirm, tone: "warn" as const } : null;
}

function useChecksBadge() {
  const report = useDesign((s) => s.report);
  if (!report) return null;
  return report.counts.fail ? { count: report.counts.fail, tone: "fail" as const } : { count: report.counts.pass };
}

function useCodeBadge() {
  const errors = useDesign((s) => s.model?.diagnostics.filter((d) => d.severity === "error").length ?? 0);
  return errors ? { count: errors, tone: "fail" as const } : null;
}

function useStrengthBadge() {
  const analyses = useDesign((s) => s.model?.analyses.length ?? 0);
  const fails = useDesign((s) => s.report?.items.filter((i) => i.category === "analysis" && i.status === "fail").length ?? 0);
  if (!analyses) return null;
  return fails ? { count: fails, tone: "fail" as const } : { count: analyses };
}

/** the strength tab's icon turns into a spinner while an analysis runs */
function StrengthIcon() {
  const analysing = useAnalysis((s) => [...s.runs.values()].some((r) => r.status === "running" || r.status === "waiting"));
  return analysing ? <span className="spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} /> : <Icon.Stress size={13} />;
}

function useBuildBadge() {
  const fails = useDesign((s) => s.report?.items.filter((i) => i.status === "fail" && (i.category === "electrical" || i.category === "engineering")).length ?? 0);
  return fails ? { count: fails, tone: "fail" as const } : null;
}

const useIsMachine = () => useDesign((s) => !!s.model?.machine);

function useSimBadge() {
  const scenarios = useDesign((s) => s.model?.scenarios?.length ?? 0);
  const fails = useDesign((s) => s.report?.items.filter((i) => i.category === "simulation" && i.status === "fail").length ?? 0);
  if (!scenarios) return null;
  return fails ? { count: fails, tone: "fail" as const } : { count: scenarios };
}

/** the simulate tab's icon turns into a spinner while a scenario runs */
function SimIcon() {
  const simulating = useSim((s) => [...s.runs.values()].some((r) => r.status === "running" || r.status === "waiting"));
  return simulating ? <span className="spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} /> : <Icon.Flask size={13} />;
}

const useHasMadeParts = () => useDesign((s) => !!s.model?.parts.some((p) => p.kind === "part" && !p.imported));

const useHasSims = () => useDesign((s) => !!s.model?.machine || !!s.model?.scenarios?.length);

export const DOCK_TABS: DockTabDef[] = [
  { id: "overview", label: "overview", icon: <OverviewGlyph size={13} />, Body: Overview },
  { id: "brief", label: "brief", icon: <BIcon.Brief size={13} />, useBadge: useBriefBadge, Body: BriefPanel },
  { id: "checks", label: "checks", icon: <Icon.Shield size={13} />, useBadge: useChecksBadge, Body: ChecksPanel },
  { id: "analysis", label: "strength", icon: <StrengthIcon />, useBadge: useStrengthBadge, Body: AnalysisPanel },
  { id: "build", label: "build", icon: <Icon.Wrench size={13} />, useBadge: useBuildBadge, useShown: useIsMachine, Body: MachinePanel },
  { id: "sim", label: "simulate", icon: <SimIcon />, useBadge: useSimBadge, useShown: useHasSims, Body: SimPanel },
  { id: "make", label: "make", icon: <Icon.Factory size={13} />, useShown: useHasMadeParts, Body: MakePanel },
  { id: "bom", label: "parts list", icon: <Icon.List size={13} />, Body: BomTable },
  { id: "graph", label: "graph", icon: <Icon.Graph size={13} />, Body: GraphView },
  { id: "code", label: "design.kerf", icon: <Icon.Code size={13} />, useBadge: useCodeBadge, Body: () => null, file: true },
];

function TabButton({ t, active, onClick }: { t: DockTabDef; active: boolean; onClick: () => void }) {
  const shown = t.useShown?.() ?? true;
  const badge = t.useBadge?.() ?? null;
  if (!shown) return null;
  return (
    <button role="tab" aria-selected={active} className={`tab ${t.file ? "file-tab" : ""} ${active ? "active" : ""}`} onClick={onClick}>
      {t.icon}
      {t.label}
      {badge?.count !== undefined && (
        <span key={badge.count} className={`count ${badge.tone ?? ""}`}>
          {badge.count}
        </span>
      )}
      {active && <motion.div layoutId="dock-tab" className="tab-line" transition={{ type: "spring", stiffness: 520, damping: 40 }} />}
    </button>
  );
}

export function Dock({ projectKey }: { projectKey: string }) {
  const tab = useView((s) => s.dockTab);
  const open = useView((s) => s.dockOpen);
  const model = useDesign((s) => s.model);
  const source = useDesign((s) => s.source);
  const errors = model?.diagnostics.filter((d) => d.severity === "error") ?? [];
  // DOCK_TABS never changes, so these hooks always run in the same order
  const shown = DOCK_TABS.map((t) => t.useShown?.() ?? true);
  const current = DOCK_TABS.some((t, i) => t.id === tab && shown[i]) ? tab : "overview";
  const set = (t: string) => useView.setState({ dockTab: t, dockOpen: true });
  const main = DOCK_TABS.filter((t) => !t.file);
  const files = DOCK_TABS.filter((t) => t.file);
  const def = DOCK_TABS.find((t) => t.id === current)!;
  const Body = def.Body;
  const click = (id: string) => (current === id && open ? useView.setState({ dockOpen: false }) : set(id));
  return (
    <div className="dock">
      <div className="dock-head">
        <div className="tabs" role="tablist">
          {main.map((t) => (
            <TabButton key={t.id} t={t} active={current === t.id && open} onClick={() => click(t.id)} />
          ))}
        </div>
        <div className="grow" />
        {current === "code" && open && errors[0] && (
          <button className="btn ghost sm dock-error" onClick={() => useView.setState({ reveal: { span: { start: errors[0].start, end: errors[0].end }, nonce: Date.now() } })}>
            <Icon.Alert size={13} /> line {lineCol(source, errors[0].start).line}: {errors[0].message.slice(0, 70)}
          </button>
        )}
        <div className="tabs file-tabs" role="tablist">
          {files.map((t) => (
            <TabButton key={t.id} t={t} active={current === t.id && open} onClick={() => click(t.id)} />
          ))}
        </div>
        <button className="icon-btn sm" style={{ alignSelf: "center" }} onClick={() => useView.setState({ dockOpen: !open })} aria-label={open ? "Collapse panel" : "Expand panel"} data-tip={open ? "Collapse" : "Expand"}>
          <span style={{ transform: open ? "rotate(0)" : "rotate(180deg)", display: "inline-grid", transition: "transform .2s" }}>
            <Icon.ChevronDown size={14} />
          </span>
        </button>
      </div>
      {open && (
        <div className="dock-body">
          <div className={`dock-file ${current === "code" ? "shown" : ""}`} style={{ display: current === "code" ? "block" : "none", position: "absolute", inset: 0 }}>
            <CodeEditor key={projectKey} />
          </div>
          {!def.file && (
            <div key={current} className="dock-pane">
              <Body />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
