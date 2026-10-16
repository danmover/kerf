// The bottom dock. It opens on the overview (status, brief, the design at a
// glance, the selected part and recent changes); the brief, checks, parts
// list and graph sit next to it, and design.kerf sits at the end of the row
// as the file behind it all, one click (or C) away. Features add a tab with
// an entry in DOCK_TABS, the way they add left-panel tabs through LEFT_TABS.

import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { useDesign } from "../core/engine";
import { useView } from "../app/view";
import { CodeEditor } from "./CodeEditor";
import { ChecksPanel } from "./ChecksPanel";
import { GraphView } from "./GraphView";
import { BomTable } from "./BomTable";
import { BriefPanel } from "./BriefPanel";
import { Overview, OverviewGlyph } from "./Overview";
import { BIcon } from "./briefIcons";
import { briefData, openAssumptions } from "../core/brief";
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

export const DOCK_TABS: DockTabDef[] = [
  { id: "overview", label: "overview", icon: <OverviewGlyph size={13} />, Body: Overview },
  { id: "brief", label: "brief", icon: <BIcon.Brief size={13} />, useBadge: useBriefBadge, Body: BriefPanel },
  { id: "checks", label: "checks", icon: <Icon.Shield size={13} />, useBadge: useChecksBadge, Body: ChecksPanel },
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
  const known = DOCK_TABS.some((t) => t.id === tab);
  const current = known ? tab : "overview";
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
